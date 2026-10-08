import test from 'node:test';
import assert from 'node:assert/strict';
import { S, ST, transport } from '../src/state.js';
import { configureNativePlayback, tryNativePlayback, releaseNativePlayback,
    nativePlaybackActive, nativePlay, nativePause, nativeSeek, nativeRate, syncNativeGain, requireBrowserPlayback,
    playAfterNativePreparation, cancelPreparedPlay } from '../src/native-playback.js';
import { makeStemGainHandle } from '../src/mix.js';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(predicate) {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await Promise.resolve(); }
    assert.fail('expected asynchronous operation did not complete');
}
function harness() {
    S.loadGeneration++; releaseNativePlayback();
    const calls = [], restored = [], events = [];
    let request, position = 12, browserStopped = false;
    const lease = {
        currentTime: 12, duration: 100,
        seek: async p => { calls.push(['seek', p]); lease.currentTime = p; return true; },
        setRate: async r => { calls.push(['rate', r]); return true; },
        setGain: async g => { calls.push(['gain', g]); return true; },
        play: async () => { calls.push(['play']); return true; },
        pause: async () => { calls.push(['pause']); return true; },
        release: async reason => {
            calls.push(['release', reason]);
            if (reason === 'failed' || reason === 'browser-required') request.onLost({ position: lease.currentTime, stopped: true });
            return true;
        },
    };
    const host = { version: 1, acquire: async value => { request = value; return lease; } };
    globalThis.window = { feedBack: { audioSession: { nativeBacking: host } } };
    Object.assign(S, { sloppakActive: true, liveInfoReady: true, buffersReady: true, useWorklet: true,
        masterGain: { gain: { value: .8 } }, workletNode: null, workletPostReady: false,
        pendingPlay: false, fullTrackIndex: -1, browserPlaybackRequired: false, browserHasPlayed: false });
    S.stemState = [{ id: 'full', url: '/full.ogg', gain: makeStemGainHandle(0), on: true, vol: .5 }];
    S.stemState[0].gain.gain.value = .5;
    Object.assign(transport, { playing: false, baseOffset: 12, duration: 100, rate: .75 }); ST.streaming = false;
    configureNativePlayback({ browserTime: () => position, stopBrowser: () => { browserStopped = true; },
        event: type => events.push(type), ended: () => events.push('ended'), playCurrent: () => nativePlay(),
        restoreBrowser: (...args) => { browserStopped = false; restored.push(args); } });
    return { host, lease, calls, restored, events, request: () => request,
        stopped: () => browserStopped, position: p => { position = p; } };
}

test('handoff preserves controls and combines song gain with stem gain and mute automation', async () => {
    const h = harness(); assert.equal(await tryNativePlayback(), true);
    assert.equal(h.stopped(), true); assert.equal(nativePlaybackActive(), true);
    assert.deepEqual(h.calls, [['seek', 12], ['rate', .75], ['gain', .4]]);
    assert.deepEqual(h.events, [], 'transparent migration must not duplicate play lifecycle events');
    await nativePause(); assert.equal(transport.playing, false);
    await nativeSeek(31); await nativeRate(.5); await nativePlay();
    assert.equal(h.lease.currentTime, 31); assert.equal(transport.playing, true);
    S.stemState[0].gain.gain.value = 0;
    await until(() => h.calls.at(-1)?.[0] === 'gain' && h.calls.at(-1)[1] === 0);
    S.stemState[0].gain.gain.value = .5; S.masterGain.gain.value = .2; syncNativeGain();
    await until(() => h.calls.at(-1)?.[0] === 'gain' && h.calls.at(-1)[1] === .1);
});

test('native preparation uses the latest browser playhead, and teardown cancels an in-flight acquisition', async () => {
    for (const cancel of [false, true]) {
        const h = harness(), gate = deferred(); h.host.acquire = () => gate.promise;
        const pending = tryNativePlayback(); h.position(24);
        assert.equal(h.stopped(), false, 'preparation does not touch browser resources');
        if (cancel) { S.loadGeneration++; releaseNativePlayback(); }
        gate.resolve(h.lease); await pending;
        if (cancel) { assert.equal(h.stopped(), false); assert.equal(nativePlaybackActive(), false); }
        else assert.deepEqual(h.calls[0], ['seek', 24]);
    }
});

test('unsupported decoder/host, multistem, streaming and legacy graphs keep browser playback', async () => {
    for (const setup of [h => { h.host.acquire = async () => null; }, h => { h.host.version = 0; },
        () => S.stemState.push({}), () => { ST.streaming = true; }, () => { S.useWorklet = false; },
        () => { S.fullTrackIndex = 1; }, () => requireBrowserPlayback(),
        () => { transport.playing = true; }, () => { S.browserHasPlayed = true; }]) {
        const h = harness(); setup(h);
        assert.equal(await tryNativePlayback(), false); assert.equal(h.stopped(), false);
        assert.equal(nativePlaybackActive(), false);
    }
});

test('confirmed native loss resumes browser at the latest seek/rate and honors a user pause', async () => {
    for (const paused of [false, true]) {
        const h = harness(); await tryNativePlayback(); await nativePlay(); await nativeSeek(47);
        if (paused) await nativePause(); transport.rate = .5;
        h.request().onLost({ position: 47, stopped: true });
        assert.deepEqual(h.restored, [[47, !paused, .5]]); assert.equal(nativePlaybackActive(), false);
    }
});

test('failed stop never enables a competing browser source', async () => {
    const h = harness(); await tryNativePlayback();
    h.request().onLost({ position: 12, stopped: false });
    assert.equal(h.stopped(), true); assert.equal(h.restored.length, 0);
    assert.equal(transport.playing, false);
});

test('pause during initialization cancels automatic start; late callbacks cannot touch another song', async () => {
    const h = harness(), gate = deferred(); h.lease.setRate = () => gate.promise;
    const pending = tryNativePlayback(); await until(nativePlaybackActive);
    await nativePause(); gate.resolve(true); await pending;
    assert.equal(h.calls.some(c => c[0] === 'play'), false);
    S.loadGeneration++; releaseNativePlayback();
    h.request().onEnded(); h.request().onLost({ position: 12, stopped: true });
    assert.equal(h.events.includes('ended'), false); assert.equal(h.restored.length, 0);
});

test('seek failure uses retained browser buffers and does not leave both routes active', async () => {
    const h = harness(); await tryNativePlayback(); await nativePlay(); h.lease.seek = async () => { throw Error('decoder'); };
    assert.equal(await nativeSeek(39), false);
    await until(() => h.restored.length > 0);
    assert.deepEqual(h.restored, [[39, true, .75]]); assert.equal(nativePlaybackActive(), false);
});

test('an analyser/graph request restores browser playback and prevents repeated native handoffs', async () => {
    const h = harness(); await tryNativePlayback(); requireBrowserPlayback();
    await until(() => h.restored.length > 0);
    assert.equal(nativePlaybackActive(), false); assert.equal(S.browserPlaybackRequired, true);
    assert.equal(await tryNativePlayback(), false);
});

test('a play during native preparation waits, and pause cancels it before any source starts', async () => {
    for (const cancel of [false, true]) {
        const h = harness(), gate = deferred(); h.host.acquire = () => gate.promise;
        const prepared = tryNativePlayback(); const played = playAfterNativePreparation();
        if (cancel) cancelPreparedPlay();
        assert.equal(h.calls.some(c => c[0] === 'play'), false);
        gate.resolve(h.lease); await prepared; await played;
        assert.equal(h.calls.some(c => c[0] === 'play'), !cancel);
    }
});
