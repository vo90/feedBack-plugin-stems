import { karaokeDefault, loadDefaultMuted, loadMuted, loadVolumes, saveMuted, saveVolume } from './prefs.js';
import { clampVolume } from './util.js';

export function readSongPreferences(filename, key) {
    const primary = loadVolumes(key || filename);
    return { muted: loadMuted(key || filename) || (key ? loadMuted(filename) : null),
        volumes: Object.keys(primary).length || !key ? primary : loadVolumes(filename),
        defaults: loadDefaultMuted(), karaoke: karaokeDefault() };
}

export function preferredStemState(stem, prefs) {
    return { on: prefs.muted ? !prefs.muted.has(stem.id) :
        !!stem.default && !prefs.defaults.has(stem.id) && !(prefs.karaoke && /vocal/i.test(stem.id)),
        vol: clampVolume(prefs.volumes[stem.id]) ?? 1 };
}

// Reconcile settings without touching decoded buffers, transport or ownership.
// Active claims retain their temporary mix; refresh after their release.
export function refreshSongPreferences({ stems, filename, key, edits, claims, pending, apply, onlyPending = false }) {
    const prefs = readSongPreferences(filename, key);
    const claimed = new Set(Array.from(claims.values(), c => c.id));
    for (const stem of stems) {
        if (onlyPending && !pending.has(stem.id)) continue;
        if (claimed.has(stem.id)) { pending.add(stem.id); continue; }
        const next = { ...preferredStemState(stem, prefs), ...edits.get(stem.id) };
        apply(stem, next.on, next.vol);
        pending.delete(stem.id);
    }
    // A manual edit made under the provisional identity follows this load to
    // its final identity. Never persist default settings or a temporary claim.
    for (const [id, edit] of edits) if ('vol' in edit) saveVolume(key || filename, id, edit.vol);
    if (!claimed.size && Array.from(edits.values()).some(e => 'on' in e)) saveMuted(key || filename, stems);
}
