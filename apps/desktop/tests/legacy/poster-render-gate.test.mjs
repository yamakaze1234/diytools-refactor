import test from 'node:test';
import assert from 'node:assert/strict';
import {createPosterRenderGate,RenderSupersededError} from '../../public/workbench/poster-render-gate.js';

function events(){const callbacks=new Map();return{hidden:false,defaultView:new EventTarget(),addEventListener(type,callback){callbacks.set(type,callback);},removeEventListener(type,callback){if(callbacks.get(type)===callback)callbacks.delete(type);},emit(type,event={}){callbacks.get(type)?.(event);},callbacks};}
function harness(options={}){
 const root=events(),calls=[];let time=0;
 const gate=createPosterRenderGate({quietMs:160,now:()=>time,delay:async milliseconds=>{calls.push('pause');time+=milliseconds;options.onPause?.(root,time);},yieldTask:async()=>{calls.push('yield');options.onYield?.(root,time);},inputPending:()=>false,...options});gate.bind(root);return{root,gate,calls,time:()=>time};
}
test('wheel and typing defer generation, then yield a browser task before rendering',async()=>{
 for(const type of ['wheel','input','keydown','scroll']){const {root,gate,calls,time}=harness();root.emit(type);await gate.run(()=>calls.push('render'));assert.ok(time()>=160);assert.equal(calls.at(-2),'yield');assert.equal(calls.at(-1),'render');gate.dispose();}
});
test('held pointer and IME composition prevent admission until interaction finishes',async()=>{
 for(const [start,end,event]of [['pointerdown','pointerup',{pointerId:1}],['compositionstart','compositionend',{}]]){
  const {root,gate,calls,time}=harness({onPause:(root,time)=>{if(time===200)root.emit(end,event);}});root.emit(start,event);await gate.run(()=>calls.push('render'));assert.ok(time()>=360);assert.equal(calls.at(-1),'render');gate.dispose();
 }
});
test('hover does not postpone generation and newly queued input is rechecked after yielding',async()=>{
 let yields=0;const {root,gate,calls,time}=harness({onYield:root=>{if(!yields++)root.emit('wheel');}});root.emit('pointermove',{pointerId:1,buttons:0});await gate.run(()=>calls.push('render'));assert.equal(yields,2);assert.ok(time()>=160);assert.equal(calls.at(-1),'render');gate.dispose();
});
test('hidden windows and blur cannot strand a held pointer or composition',async()=>{
 const {root,gate,calls}=harness();root.emit('pointerdown',{pointerId:1});root.emit('compositionstart');root.hidden=true;root.emit('visibilitychange');await gate.run(()=>calls.push('render'));assert.deepEqual(calls,['yield','render']);
 root.hidden=false;root.emit('pointerdown',{pointerId:2});root.defaultView.dispatchEvent(new Event('blur'));await gate.run(()=>calls.push('second'));assert.equal(calls.at(-1),'second');gate.dispose();
});
test('superseded background snapshots do not render or publish after they become stale',async()=>{
 let current=true,renders=0;const {root,gate}=harness({onPause:()=>{current=false;}});root.emit('wheel');await assert.rejects(gate.run(()=>renders++,{isCurrent:()=>current}),RenderSupersededError);assert.equal(renders,0);
 current=true;root.hidden=true;await assert.rejects(gate.run(()=>{renders++;current=false;return 'old image';},{isCurrent:()=>current}),RenderSupersededError);assert.equal(renders,1);gate.dispose();
});
test('pointer cancel and a returning released mouse clear held interaction',async()=>{
 for(const end of ['pointercancel','return']){const {root,gate,calls,time}=harness();root.emit('pointerdown',{pointerId:1});if(end==='return')root.emit('pointermove',{pointerId:1,pointerType:'mouse',buttons:0});else root.emit(end,{pointerId:1});await gate.run(()=>calls.push('render'));assert.ok(time()<2000);assert.equal(calls.at(-1),'render');gate.dispose();}
});
test('missing pointer end recovers, while ongoing pointer movement keeps the watchdog alive',async()=>{
 const stranded=harness();stranded.root.emit('pointerdown',{pointerId:1});await stranded.gate.run(()=>stranded.calls.push('render'));assert.equal(stranded.time(),2000);stranded.gate.dispose();
 const active=harness({onPause:(root,time)=>{if(time<2500)root.emit('pointermove',{pointerId:1,pointerType:'mouse',buttons:1});else if(time===2500)root.emit('pointerup',{pointerId:1});}});active.root.emit('pointerdown',{pointerId:1});await active.gate.run(()=>active.calls.push('render'));assert.ok(active.time()>=2660);active.gate.dispose();
});
test('manual export snapshots keep their exact renderer inputs while live state changes',async()=>{
 const {gate}=harness();const snapshot={id:'a',revision:5,font:'阿里巴巴普惠体',asset:'/uploads/test.png',width:1400};let live={...snapshot};const result=await gate.run(()=>{live={...live,revision:6};return structuredClone(snapshot);});assert.deepEqual(result,snapshot);assert.equal(live.revision,6);gate.dispose();
});
test('abort/dispose cancel pending work and remove every installed listener',async()=>{
 const root=events(),gate=createPosterRenderGate({quietMs:160,inputPending:()=>false});gate.bind(root);root.emit('pointerdown',{pointerId:1});const controller=new AbortController();let renders=0;const pending=gate.run(()=>renders++,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(renders,0);
 const disposed=gate.run(()=>renders++);gate.dispose();await assert.rejects(disposed,{name:'AbortError'});assert.equal(root.callbacks.size,0);assert.equal(renders,0);await assert.rejects(gate.run(()=>{}),{name:'AbortError'});
});
test('canceling a render leaves caller pending work intact and permits rescheduling',async()=>{
 const {root,gate}=harness();const pending=new Set(['a']);let current=false;await assert.rejects(gate.run(()=>pending.delete('a'),{isCurrent:()=>current}),RenderSupersededError);assert.ok(pending.has('a'));current=true;root.hidden=true;await gate.run(()=>pending.delete('a'),{isCurrent:()=>current});assert.equal(pending.size,0);gate.dispose();
});
test('renderer phase callbacks recheck input after asynchronous resource loads',async()=>{
 const {root,gate,calls,time}=harness();await gate.run(async({beforeDraw})=>{calls.push('fonts/assets');root.emit('wheel');await beforeDraw('layout');calls.push('layout');root.emit('input');await beforeDraw('paint');calls.push('paint');});assert.ok(time()>=320);assert.ok(calls.indexOf('layout')>calls.indexOf('fonts/assets'));assert.equal(calls.at(-1),'paint');gate.dispose();
});
test('stale resource loads are rejected before synchronous layout begins',async()=>{
 const {gate}=harness();let current=true,layout=false;await assert.rejects(gate.run(async({beforeDraw})=>{current=false;await beforeDraw('layout');layout=true;},{isCurrent:()=>current}),RenderSupersededError);assert.equal(layout,false);gate.dispose();
});
