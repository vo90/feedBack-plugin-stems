import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LoadIdentity } from '../src/load-identity.js';

const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function fn(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    let i = source.indexOf('(', start) + 1, depth = 1;
    while (depth) { if(source[i] === '(') depth++; if(source[i] === ')') depth--; i++; }
    i = source.indexOf('{', i) + 1; depth = 1;
    while (depth) { if(source[i] === '{') depth++; if(source[i] === '}') depth--; i++; }
    return source.slice(start, i);
}
function harness() {
    const S = { currentSongKey: null, currentFilename: null, stemState: [], preloadGen: 0, loadGeneration: 0 };
    const calls = { builds: 0, preloads: [], refreshes: 0 };
    let live = {};
    const window = { __slopsmithStemsHooks: { installed: true }, slopsmith: { currentSong: null } };
    const scope = { tryNativePlayback: () => Promise.resolve(false), S, window, LoadIdentity, loadIdentity: new LoadIdentity(),
        preferenceEdits: new Map(), pendingPreferences: new Set(), console,
        highway: { getSongInfo: () => live },
        teardown() { S.loadGeneration++; S.stemState=[]; },
        refreshPreferences() { calls.refreshes++; },
        preloadSong(filename) { calls.preloads.push(filename); },
        startReadyPoll() {}, lightStop() {},
        onSongReady() { calls.builds++; S.stemState=[{ id:'full' }]; },
    };
    const ctx = vm.createContext(scope);
    for (const name of ['songInfoSignature','songRefFromDetail','currentSongInfo','tryInitForCurrentSong',
        'acceptLoad','endCurrentLoad','installHooks']) vm.runInContext(fn(name), ctx);
    vm.runInContext('installHooks()', ctx);
    const hooks = window.__slopsmithStemsHooks.impl;
    const media = name => ({ filename:name, stems:[{ id:'full',url:`/${name}.ogg`,default:true }] });
    return { S, calls, hooks,
        preload(name) { S.preloadInfo=media(name);vm.runInContext('tryInitForCurrentSong()',ctx); },
        live(name, fullUrl) { window.slopsmith.currentSong={filename:name};live=media(name);
            if(fullUrl)Object.assign(live,{has_full_mix:true,full_mix_url:fullUrl}); },
    };
}
const canonical = (id, key) => ({ payload: { sessionId:id,target:{settingsKey:key,targetId:id} } });

for(const reverse of [false,true]) test(`real hooks coalesce aliases, key promotion reuses graph (reverse=${reverse})`,()=>{
    const h=harness();
    const load=[canonical('one','provisional'),{filename:'A'}];
    if(reverse)load.reverse();for(const event of load)h.hooks.onPlaybackLoading(event);
    assert.equal(h.S.loadGeneration,1);assert.deepEqual(h.calls.preloads,['A']);
    assert.equal(h.S.currentSongKey,'provisional');
    h.preload('A');h.live('A');
    h.hooks.onPlaybackReady(canonical('one','final'));
    h.hooks.onPlaybackReady({filename:'A'});h.hooks.onPlaybackReady({});
    assert.equal(h.calls.builds,1);assert.equal(h.calls.refreshes,1);
    assert.equal(h.S.currentSongKey,'final');
    h.hooks.onPlaybackLoading(canonical('two','other'));h.hooks.onPlaybackLoading({filename:'B'});
    assert.equal(h.S.preloadInfo,null);assert.equal(h.S.currentFilename,'B');
    h.hooks.onPlaybackReady(canonical('one','final'));
    h.hooks.onPlaybackReady({filename:'A'});
    assert.equal(h.S.currentFilename,'B');assert.equal(h.calls.builds,1);
    h.preload('B');h.live('B');h.hooks.onPlaybackReady(canonical('two','other-final'));
    assert.equal(h.calls.builds,2);
    h.hooks.onPlaybackReady(canonical('one','final'));h.hooks.onPlaybackReady({filename:'A'});
    assert.equal(h.S.currentFilename,'B');assert.equal(h.calls.builds,2);
});

test('ready-only entry and changed full mix initialize the actual resource',()=>{
    const h=harness();h.live('A');h.hooks.onPlaybackReady(canonical('one','final'));
    assert.equal(h.calls.builds,1);
    h.live('A','/full-new.ogg');h.hooks.onPlaybackReady(canonical('one','final'));
    assert.equal(h.calls.builds,2);
    h.hooks.teardown();const gen=h.S.preloadGen;
    h.hooks.onPlaybackReady(canonical('one','final'));
    h.hooks.onPlaybackReady({filename:'A'});h.hooks.onPlaybackReady({});
    assert.equal(h.S.currentFilename,null);assert.equal(h.S.preloadGen,gen);
});

test('legacy-only real restart and canonical new session both invalidate old loads',()=>{
    const l=new LoadIdentity();
    assert.equal(l.loading({filename:'A'}).newLoad,true);
    l.ready({filename:'A'});
    assert.equal(l.loading({filename:'A'}).newLoad,true);
    assert.equal(l.loading({sessionId:'one'}).newLoad,false);
    assert.equal(l.loading({sessionId:'one'}).newLoad,false);
    assert.equal(l.loading({sessionId:'two'}).newLoad,true);
    assert.equal(l.ready({sessionId:'one'}),null);
});
