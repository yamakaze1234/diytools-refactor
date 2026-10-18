import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudCacheLifecycle} from '../../public/workbench/cloud-cache-lifecycle.js';

function fixture(){let released=0,sequence=0;const timers=new Map();const lifecycle=createCloudCacheLifecycle(()=>released++,{schedule:fn=>{timers.set(++sequence,fn);return sequence;},cancel:id=>timers.delete(id)});return{lifecycle,timers,released:()=>released,tick:()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());}};}
test('pause waits for overlapping commands and paused status cannot retain the checkpoint again',()=>{
 const f=fixture(),l=f.lifecycle;l.begin();l.begin();l.stop();assert.equal(f.released(),0);l.end();assert.equal(f.released(),0);l.end();assert.equal(f.released(),1);assert.equal(f.timers.size,0);
 l.begin();l.end();assert.equal(f.released(),2);l.begin({resume:true});l.end();assert.equal(f.released(),2);f.tick();assert.equal(f.released(),3);
});
test('idle commands reuse a brief cache window and never clear a newly active transaction',()=>{
 const f=fixture(),l=f.lifecycle;l.begin();l.end();assert.equal(f.released(),0);assert.equal(f.timers.size,1);l.begin();f.tick();assert.equal(f.released(),0);l.end();f.tick();assert.equal(f.released(),1);l.stop();assert.equal(f.released(),2);
});
