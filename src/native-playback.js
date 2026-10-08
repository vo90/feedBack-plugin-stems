// Stems retains control ownership and its decoded browser graph. A single stem
// may borrow Core's native backing player; the graph stays stopped until a
// confirmed native stop permits fallback. Older/browser hosts need no adapter.
import { S, ST, transport } from './state.js';

let hooks = null, pending = null, attemptedGeneration = -1;
export function configureNativePlayback(value) { hooks = value; }
export function nativePlaybackActive() { return !!S.nativePlayback; }
export function nativePreparationPending() { return !!pending; }
export function cancelPreparedPlay() { if (pending) { pending.play = false; pending.intent++; } }
export function playAfterNativePreparation() {
    const token = pending;
    if (!token) return Promise.resolve(false);
    const intent = ++token.intent;
    token.play = true;
    return token.done.then(() => {
        if (!token.play || token.intent !== intent || S.loadGeneration !== token.generation || !S.sloppakActive) return false;
        return hooks.playCurrent();
    });
}
export function requireBrowserPlayback() {
    // An analyser or external graph consumer requires the live browser graph.
    // Retain that behavior until native analysis/tap providers are supported.
    S.browserPlaybackRequired = true;
    const r = S.nativePlayback;
    if (r && !r.failing) { r.failing = true; void r.lease.release('browser-required'); }
}
export function nativePlaybackTime() {
    const r = S.nativePlayback;
    return r ? (r.positionOverride ?? r.lease.currentTime) : transport.baseOffset;
}
function current(r) { return S.nativePlayback === r && S.loadGeneration === r.generation; }
function gain() {
    const master = Number(S.masterGain?.gain.value), stem = Number(S.stemState[0]?.gain?.gain.value);
    return Number.isFinite(master) && Number.isFinite(stem) ? Math.max(0, Math.min(2, master * stem)) : 0;
}
function failed(r) {
    if (!current(r) || r.failing) return;
    r.failing = true;
    void r.lease.release('failed');
}
function run(r, operation) {
    return Promise.resolve().then(operation).then(ok => {
        if (!ok && current(r)) failed(r);
        return !!ok && current(r);
    }, () => { failed(r); return false; });
}
export function syncNativeGain() {
    const r = S.nativePlayback;
    if (!r || r.failing) return;
    // Coalesce fader/automation writes while one IPC is pending.
    r.nextGain = gain();
    if (r.gainBusy) return;
    r.gainBusy = true;
    void (async () => {
        while (current(r) && !r.failing && r.nextGain !== null) {
            const value = r.nextGain; r.nextGain = null;
            if (!await run(r, () => r.lease.setGain(value))) break;
        }
        r.gainBusy = false;
    })();
}
export function nativePlay(emit = true) {
    const r = S.nativePlayback;
    if (!r || r.failing) return Promise.resolve(false);
    if (transport.playing && r.wantsPlay) return Promise.resolve(true);
    const intent = ++r.intent;
    r.wantsPlay = true;
    return r.initialized.then(async ok => {
        if (!ok || !current(r) || intent !== r.intent || !r.wantsPlay) return false;
        if (nativePlaybackTime() >= transport.duration - 0.001) {
            if (!await nativeSeek(0)) return false;
        }
        let played = false;
        try {
            played = await r.lease.play({ guard: () => current(r) && intent === r.intent && r.wantsPlay && !r.failing });
        } catch (_) { /* handled below unless this was a user cancellation */ }
        if (!current(r) || intent !== r.intent || !r.wantsPlay) return false;
        if (!played) { failed(r); return false; }
        transport.playing = true;
        if (emit) hooks.event('play');
        return true;
    });
}
export function nativePause(emit = true) {
    const r = S.nativePlayback;
    if (!r) return Promise.resolve(false);
    ++r.intent; r.wantsPlay = false;
    transport.baseOffset = nativePlaybackTime();
    transport.playing = false;
    if (emit) hooks.event('pause');
    return run(r, () => r.lease.pause());
}
export function nativeSeek(position) {
    const r = S.nativePlayback;
    if (!r || !Number.isFinite(position)) return Promise.resolve(false);
    const sequence = ++r.seek;
    r.positionOverride = transport.baseOffset = position;
    return run(r, () => r.lease.seek(position)).then(ok => {
        if (current(r) && sequence === r.seek) {
            if (ok) r.positionOverride = null;
            hooks.event('seeking'); hooks.event('seeked');
        }
        return ok;
    });
}
export function nativeRate(rate) {
    const r = S.nativePlayback;
    if (r) return run(r, () => r.lease.setRate(rate));
    return Promise.resolve(false);
}

export function releaseNativePlayback() {
    if (pending) { pending.play = false; pending.finish(); }
    pending = null; attemptedGeneration = -1;
    const r = S.nativePlayback;
    S.nativePlayback = null;
    if (r) { ++r.intent; void r.lease.release('song-change'); }
}

export async function tryNativePlayback() {
    const host = globalThis.window?.feedBack?.audioSession?.nativeBacking;
    // Worklet gain handles observe every automation write. Streaming/legacy
    // graphs and multiple stems remain on their existing browser transports.
    if (!hooks || host?.version !== 1 || !S.liveInfoReady || !S.buffersReady || !S.useWorklet
        || ST.streaming || S.fullTrackIndex >= 0 || S.browserPlaybackRequired
        || transport.playing || S.browserHasPlayed
        || S.stemState.length !== 1 || S.nativePlayback || pending
        || attemptedGeneration === S.loadGeneration) return false;
    const generation = S.loadGeneration;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const token = pending = { generation, done, finish, play: false, intent: 0 };
    attemptedGeneration = generation;
    const isCurrent = () => generation === S.loadGeneration && S.sloppakActive;
    let r;
    try {
        const lease = await host.acquire({
            ownerId: 'stems', url: S.stemState[0].url, isCurrent,
            onEnded: () => { if (r && current(r)) hooks.ended(); },
            onLost: ({ position, stopped }) => {
                if (!r || !current(r)) return;
                if (!stopped) {
                    r.failing = true; r.wantsPlay = false; transport.playing = false;
                    hooks.event('pause');
                    console.error('[stems] Native stop failed; browser fallback remains stopped');
                    return;
                }
                const at = r.positionOverride ?? position;
                const play = r.wantsPlay;
                S.nativePlayback = null;
                hooks.restoreBrowser(at, play, transport.rate);
            },
        });
        if (!lease) return false;
        if (!isCurrent() || pending !== token || S.browserPlaybackRequired) { await lease.release('song-change'); return false; }
        // Switch before the first browser start. A running browser source has
        // captured samples still queued downstream; stopping its worklet cannot
        // retract that tail without also dropping unrelated page audio.
        const at = hooks.browserTime();
        hooks.stopBrowser();
        r = S.nativePlayback = { lease, generation, intent: 0, seek: 0, wantsPlay: false,
            positionOverride: at, failing: false, nextGain: null, gainBusy: false };
        transport.playing = false;
        // Queue preparation before exposing controls to the next event turn.
        const initial = [lease.seek(at), lease.setRate(transport.rate), lease.setGain(gain())];
        r.initialized = Promise.all(initial).then(values => {
            const ok = values.every(Boolean) && current(r);
            if (ok && r.seek === 0) r.positionOverride = null;
            if (!ok) failed(r);
            return ok;
        }, () => { failed(r); return false; });
        await r.initialized;
        return current(r) && !r.failing;
    } catch (_) {
        if (r) failed(r);
        return false;
    } finally { if (pending === token) pending = null; token.finish(); }
}
