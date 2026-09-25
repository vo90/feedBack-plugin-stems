// Canonical playback events and legacy song events describe the same load.
// Keep their identity separate from media URLs and the persisted mix key.
export class LoadIdentity {
    constructor() { this.current = null; this.retired = new Set(); }
    end() {
        if (this.current?.sessionId) this.retired.add(this.current.sessionId);
        if (this.retired.size > 64) this.retired.delete(this.retired.values().next().value);
        this.current = null;
    }
    start(ref) {
        this.end();
        this.current = { sessionId: null, filename: null, songKey: null, targetId: null,
            loading: true, canonical: false, legacy: false, preloaded: false };
        return this.merge(ref, true);
    }
    merge(ref, newLoad = false) {
        for (const key of ['sessionId', 'filename', 'songKey', 'targetId']) {
            if (ref[key]) this.current[key] = ref[key];
        }
        return { ...this.current, newLoad };
    }
    loading(ref) {
        if (ref.sessionId && this.retired.has(ref.sessionId)) return null;
        const c = this.current;
        const canonical = !!ref.sessionId;
        const sameSession = canonical && c?.sessionId === ref.sessionId;
        const matchingFile = !ref.filename || !c?.filename || ref.filename === c.filename;
        const otherAlias = c?.loading && matchingFile &&
            (canonical ? c.legacy && !c.canonical : c.canonical && !c.legacy);
        const result = sameSession || otherAlias ? this.merge(ref) : this.start(ref);
        this.current[canonical ? 'canonical' : 'legacy'] = true;
        return result;
    }
    ready(ref) {
        if (ref.sessionId && this.retired.has(ref.sessionId)) return null;
        const c = this.current;
        const differentSession = ref.sessionId && c?.sessionId && ref.sessionId !== c.sessionId;
        const differentFile = ref.filename && c?.filename && ref.filename !== c.filename;
        if (differentFile && c?.sessionId && !ref.sessionId) return null;
        // A ready for another load cannot overtake the load currently in flight.
        if (c?.loading && (differentSession || differentFile)) return null;
        const result = !c || differentSession || differentFile ? this.start(ref) : this.merge(ref);
        this.current.loading = false;
        return result;
    }
}
