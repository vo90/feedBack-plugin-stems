import test from 'node:test';
import assert from 'node:assert/strict';
import { readSongPreferences, preferredStemState, refreshSongPreferences } from '../src/song-preferences.js';

function harness() {
    const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
    const options={filename:'A',key:'final',stems:[{id:'guitar',default:true,on:true,vol:1}],
        edits:new Map(),claims:new Map(),pending:new Set(),apply(s,on,vol){s.on=on;s.vol=vol;}};
    const put=(key,value)=>storage.set(key,JSON.stringify(value));
    return {options,storage,put,refresh:()=>refreshSongPreferences(options)};
}
test('final-key saved mix takes precedence; legacy filename remains a fallback',()=>{
    const h=harness();h.put('stemsVol:A',{guitar:.3});h.put('stemsMute:A',['guitar']);
    assert.deepEqual(preferredStemState(h.options.stems[0],readSongPreferences('A','final')),{on:false,vol:.3});
    h.put('stemsVol:final',{guitar:.7});h.put('stemsMute:final',[]);h.refresh();
    assert.equal(h.options.stems[0].vol,.7);assert.equal(h.options.stems[0].on,true);
});
test('current-session manual choices survive and follow the final key',()=>{
    const h=harness();h.put('stemsVol:final',{guitar:.7});h.put('stemsMute:final',['guitar']);
    h.options.edits.set('guitar',{on:true,vol:.2});h.refresh();
    assert.equal(h.options.stems[0].vol,.2);assert.equal(h.options.stems[0].on,true);
    assert.deepEqual(JSON.parse(h.storage.get('stemsVol:final')),{guitar:.2});
    assert.deepEqual(JSON.parse(h.storage.get('stemsMute:final')),[]);
});
test('key promotion leaves temporary claims in force, then applies saved settings on release',()=>{
    const h=harness();h.put('stemsVol:final',{guitar:.7});h.put('stemsMute:final',[]);
    h.options.stems[0].on=false;h.options.claims.set('claim',{id:'guitar'});h.refresh();
    assert.equal(h.options.stems[0].on,false);assert.equal(h.options.pending.has('guitar'),true);
    h.options.claims.clear();h.options.onlyPending=true;h.refresh();
    assert.equal(h.options.stems[0].on,true);assert.equal(h.options.stems[0].vol,.7);
    assert.equal(h.options.pending.size,0);
});
