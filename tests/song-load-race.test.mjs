import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the real orchestration function with controlled asynchronous seams.
// main.js is an IIFE with DOM startup side effects, so extract only this function;
// no copy of its implementation or timing-dependent sleeps in the test.
const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('async function onSongReady()');
const end = source.indexOf('    function songInfoSignature(', start);
assert.ok(start >= 0 && end > start);
const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};

function harness() {
    const worklet = deferred();
    const S = { loadGeneration: 0, pendingPlay: false, sloppakActive: false, stemState: [] };
    const calls = { pauses: 0, loads: [], builds: [], ready: 0, plays: 0 };
    let filename = 'old';
    const scope = {
        S, SH: { shimsUsable: true }, transport: { baseOffset: 0 }, AbortController,
        console: { warn() {}, error() {} },
        teardown() { S.loadGeneration++; S.sloppakActive = false; S.pendingPlay = false; },
        currentSongInfo: () => ({ stems: [{ id: filename, url: filename }] }),
        ensureCtx() {}, ensureWorklet: () => worklet.promise, installAudioShims() {},
        document: { getElementById: () => ({}) },
        nativeCorePaused: () => false, nativeCoreTime: () => 1.5,
        nativeCorePause() { calls.pauses++; },
        streamingSupported: () => false,
        loadStems: async stems => { calls.loads.push(stems[0].id); return stems; },
        buildGraphFromBuffers(results) { calls.builds.push(results[0].id); return true; },
        hideOverlay() {}, injectUI() {}, installSongFaderBridge() {}, stemsMetaPayload: () => [],
        emitStemsState() { calls.ready++; }, transportPlay() { calls.plays++; },
    };
    return { S, calls, worklet, teardown: scope.teardown,
        select: name => { filename = name; },
        load: vm.runInNewContext(`(${source.slice(start, end)})`, scope) };
}

test('only the newest load may take over after shared cold worklet registration', async () => {
    const h = harness();
    const old = h.load();
    h.select('new');
    const current = h.load();
    h.worklet.resolve(true);
    await Promise.all([old, current]);
    assert.deepEqual(h.calls.loads, ['new']);
    assert.deepEqual(h.calls.builds, ['new']);
    assert.equal(h.calls.pauses, 1);
    assert.equal(h.calls.plays, 1);
    assert.equal(h.calls.ready, 1);
});

test('leaving during worklet registration cannot reclaim the audio element', async () => {
    const h = harness();
    const pending = h.load();
    h.teardown();
    h.S.useWorklet = false;
    h.worklet.resolve(true);
    await pending;
    assert.equal(h.S.sloppakActive, false);
    assert.equal(h.S.useWorklet, false);
    assert.equal(h.calls.pauses, 0);
    assert.deepEqual(h.calls.builds, []);
    assert.equal(h.calls.ready, 0);
});

for (const available of [true, false]) {
    test(`a current load preserves play intent with worklet available=${available}`, async () => {
        const h = harness();
        const pending = h.load();
        h.worklet.resolve(available);
        await pending;
        assert.equal(h.S.useWorklet, available);
        assert.equal(h.S.buffersReady, true);
        assert.equal(h.calls.plays, 1);
        assert.deepEqual(h.calls.builds, ['old']);
    });
}
