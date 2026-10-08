// Optional cross-repository gate: FEEDBACK_CORE_DIR selects the Core source
// worktree paired with this plugin. Exercise its real native lease and player
// against the real plugin transport, shims and gain handles, with fake device IO.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { S, SH, ST, transport } from '../src/state.js';
import { installAudioShims, onWorkletMessage, transportPlay } from '../src/transport.js';
import { tryNativePlayback, releaseNativePlayback, nativePlaybackActive, syncNativeGain } from '../src/native-playback.js';
import { makeStemGainHandle } from '../src/mix.js';
import { publishAudioGraph } from '../src/audio-graph-publish.js';

const require = createRequire(import.meta.url);
const coreDir = process.env.FEEDBACK_CORE_DIR;
async function until(predicate) {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await Promise.resolve(); }
    assert.fail('paired operation did not complete');
}

function pairedHarness() {
    const { nativeHarness } = require(path.join(coreDir, 'tests/js/helpers/native-backing-harness.js'));
    const h = nativeHarness();
    let nativeAudible = false, browserAudible = false;
    const events = [];
    h.api.startBacking = async () => { assert.equal(browserAudible, false); nativeAudible = true; };
    h.api.stopBacking = async () => { nativeAudible = false; };
    class Audio {
        constructor() { this.listeners = new Map(); this.playbackRate = 1; this.pos = 0; }
        get currentTime() { return this.pos; } set currentTime(value) { this.pos = value; }
        get duration() { return 100; } get paused() { return true; }
        play() { throw Error('unowned media element must not play'); } pause() {}
        addEventListener(name, fn) { this.listeners.set(name, fn); }
        dispatchEvent(e) { events.push(e.type); this.listeners.get(e.type)?.(e); }
    }
    const audio = new Audio();
    globalThis.HTMLMediaElement = Audio;
    globalThis.document = { getElementById: id => id === 'audio' ? audio : null };
    globalThis.window = { feedBack: { audioSession: { nativeBacking: h.host } }, slopsmith: { stems: {} } };
    S.loadGeneration++; releaseNativePlayback();
    Object.assign(SH, { shimsInstalled: false, shimsUsable: false }); installAudioShims();
    Object.assign(S, { liveInfoReady: true, buffersReady: true, useWorklet: true, sloppakActive: true,
        pendingPlay: false, fullTrackIndex: -1, browserPlaybackRequired: false, browserHasPlayed: false, latencyOffsetSec: 0,
        audioCtx: { currentTime: 10, state: 'running' }, masterGain: { gain: { value: .8 } },
        workletPostReady: true, workletNode: { port: { postMessage(message) {
            if (message.type === 'stop') browserAudible = false;
            if (message.type === 'start') { assert.equal(nativeAudible, false); browserAudible = true; }
        } } } });
    ST.streaming = false;
    S.stemState = [{ id: 'full', url: h.url, on: true, vol: .5, gain: makeStemGainHandle(0) }];
    S.stemState[0].gain.gain.value = .5;
    Object.assign(transport, { duration: 100, rate: 1, playing: false, baseOffset: 12, baseCtxTime: 10 });

    return { h, audio, events, get nativeAudible() { return nativeAudible; }, get browserAudible() { return browserAudible; } };
}

test('paired Core/Stems preserves exclusive audible ownership, transport controls, mix and fallback', { skip: !coreDir }, async () => {
    const fixture = pairedHarness();
    const { h, audio, events } = fixture;
    assert.equal(await tryNativePlayback(), true);
    assert.equal(fixture.nativeAudible, false); assert.equal(fixture.browserAudible, false);
    assert.equal(audio.currentTime, 12); assert.equal(audio.paused, true);
    assert.equal(events.includes('play'), false, 'handoff is not a second user play');
    await audio.play(); assert.equal(fixture.nativeAudible, true);
    onWorkletMessage({ data: { type: 'ended' } });
    assert.equal(events.includes('ended'), false, 'old worklet cannot end the native song');

    audio.pause(); await until(() => !fixture.nativeAudible); assert.equal(audio.paused, true);
    audio.currentTime = 45;
    await until(() => events.includes('seeked'));
    assert.equal(audio.currentTime, 45);
    audio.playbackRate = .5; audio.dispatchEvent(new Event('ratechange'));
    await until(() => h.player._speed === .5);
    await audio.play(); assert.equal(fixture.nativeAudible, true);
    S.stemState[0].gain.gain.value = 0;
    await until(() => h.calls.at(-1)?.[0] === 'gain' && h.calls.at(-1)[1] === 0);
    S.masterGain.gain.value = .2; S.stemState[0].gain.gain.value = .5; syncNativeGain();
    await until(() => h.calls.at(-1)?.[0] === 'gain' && h.calls.at(-1)[1] === .1);

    const playsBeforeFallback = events.filter(e => e === 'play').length;
    // A consumer needs the live browser graph: restore it after native silence.
    publishAudioGraph(); assert.equal(window.slopsmith.stems.audioGraph.context, S.audioCtx);
    await until(() => !nativePlaybackActive());
    assert.equal(fixture.nativeAudible, false); assert.equal(fixture.browserAudible, true);
    assert.equal(audio.currentTime, 45); assert.equal(transport.rate, .5);
    assert.equal(events.filter(e => e === 'play').length, playsBeforeFallback);
    assert.equal(await tryNativePlayback(), false);
    S.loadGeneration++; releaseNativePlayback();
});

for (const accepts of [true, false]) test(`play requested before decode completes settles after route selection (native=${accepts})`, { skip: !coreDir }, async () => {
    const fixture = pairedHarness();
    S.buffersReady = false;
    const playing = fixture.audio.play();
    assert.equal(S.pendingPlay, true); assert.equal(S.pendingPlayResolvers.length, 1);
    S.buffersReady = true;
    if (!accepts) fixture.h.api.loadBackingTrack = async () => false;
    assert.equal(await tryNativePlayback(), accepts);
    S.pendingPlay = false;
    await transportPlay(); await playing;
    assert.equal(S.pendingPlayResolvers.length, 0);
    assert.equal(fixture.nativeAudible, accepts); assert.equal(fixture.browserAudible, !accepts);
    S.loadGeneration++; releaseNativePlayback(); await fixture.h.queue(() => {});
});

test('engine stopping during native playback restores the browser source with its controls', { skip: !coreDir }, async () => {
    const fixture = pairedHarness(); await tryNativePlayback(); await fixture.audio.play();
    fixture.audio.currentTime = 33;
    await until(() => fixture.events.includes('seeked'));
    fixture.h.setRunning(false); await fixture.h.host.check();
    assert.equal(fixture.nativeAudible, false); assert.equal(fixture.browserAudible, true);
    assert.equal(fixture.audio.currentTime, 33); assert.equal(fixture.audio.paused, false);
    S.loadGeneration++; releaseNativePlayback();
});

test('pause cancels a queued native start without treating cancellation as a route failure', { skip: !coreDir }, async () => {
    const fixture = pairedHarness(); await tryNativePlayback();
    let unblock; const gate = new Promise(resolve => { unblock = resolve; });
    const blocked = fixture.h.queue(() => gate);
    const play = fixture.audio.play();
    await Promise.resolve(); await Promise.resolve();
    fixture.audio.pause(); unblock(); await blocked; await play; await fixture.h.queue(() => {});
    assert.equal(fixture.nativeAudible, false); assert.equal(fixture.browserAudible, false);
    assert.equal(nativePlaybackActive(), true); assert.equal(transport.playing, false);
    assert.equal(fixture.events.includes('play'), false);
    S.loadGeneration++; releaseNativePlayback(); await fixture.h.queue(() => {});
});

test('native completion exposes the exact media endpoint to Core and a later seek clears it', { skip: !coreDir }, async () => {
    const fixture = pairedHarness(); await tryNativePlayback(); await fixture.audio.play();
    let terminal;
    fixture.audio.addEventListener('ended', () => {
        terminal = { time: fixture.audio.currentTime, duration: fixture.audio.duration, paused: fixture.audio.paused };
    });
    fixture.h.player._pos = 100 - 1e-10;
    fixture.h.player._sourcePlaying = false;
    fixture.h.player._sourceEnded = true;
    await fixture.h.host.check();
    assert.deepEqual(terminal, { time: 100, duration: 100, paused: true });
    await fixture.h.queue(() => {});
    assert.equal(fixture.nativeAudible, false);
    fixture.audio.currentTime = 20;
    await until(() => fixture.events.includes('seeked'));
    assert.equal(fixture.audio.currentTime, 20);
    await fixture.audio.play(); assert.equal(fixture.audio.paused, false);
    S.loadGeneration++; releaseNativePlayback(); await fixture.h.queue(() => {});
});
