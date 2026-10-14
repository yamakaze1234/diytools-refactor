/** 海报渲染调度：协调编辑预览与批量导出，并在等待和绘制边界响应取消。 */
// Input-priority admission for the existing DOM/font/canvas renderer. This is
// cooperative scheduling before each image, not a Worker or per-glyph slicing.
export class RenderSupersededError extends Error {
 constructor(){super('图片对应配置已变化，保留任务等待重新生成');this.name='RenderSupersededError';}
}
const aborted=signal=>signal?.reason??new DOMException('图片生成已取消','AbortError');
const delay=(milliseconds,signal)=>new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(aborted(signal));return;}
 const abort=()=>{clearTimeout(timer);reject(aborted(signal));};
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},milliseconds);
 signal?.addEventListener('abort',abort,{once:true});
});
/** 带取消信号让出当前任务；调用方在恢复后再次核验任务是否仍有效。 */
const yieldTask=signal=>globalThis.scheduler?.postTask
 ?globalThis.scheduler.postTask(()=>{},{priority:'background',signal})
 :delay(0,signal);

/** 建立输入优先的绘图准入检查；交互繁忙时等待，允许绘图前再次检查取消和配置版本。 */
export function createPosterRenderGate(options={}){
 const now=options.now??(()=>performance.now()),pause=options.delay??delay,yieldToBrowser=options.yieldTask??yieldTask;
 const quietMs=Math.max(0,Number.isFinite(options.quietMs)?options.quietMs:160);
 const heldPointerTimeoutMs=Math.max(quietMs,Number.isFinite(options.heldPointerTimeoutMs)?options.heldPointerTimeoutMs:2000);
 const pendingInput=options.inputPending??(()=>Boolean(globalThis.navigator?.scheduling?.isInputPending?.({includeContinuous:true})));
 const lifetime=new AbortController(),pointers=new Set();let root=null,lastInput=-Infinity,lastPointerActivity=-Infinity,composing=false,unlisten=[];
 const clearInteraction=()=>{pointers.clear();composing=false;};
 const touch=()=>{lastInput=now();};
 function bind(nextRoot){
  if(lifetime.signal.aborted)throw aborted(lifetime.signal);
  unlisten.forEach(remove=>remove());unlisten=[];clearInteraction();root=nextRoot;
  const listen=(target,type,callback)=>{if(!target?.addEventListener)return;target.addEventListener(type,callback,{capture:true,passive:true});unlisten.push(()=>target.removeEventListener(type,callback,true));};
  listen(root,'pointerdown',event=>{pointers.add(event.pointerId);lastPointerActivity=now();touch();});
  listen(root,'pointermove',event=>{
   // A mouse released outside the iframe may return without a pointerup event.
   if(event.buttons===0&&(!event.pointerType||event.pointerType==='mouse'))pointers.delete(event.pointerId);
   if(pointers.has(event.pointerId)||event.buttons){lastPointerActivity=now();touch();}
  });
  const release=event=>{pointers.delete(event.pointerId);touch();};
  for(const type of ['pointerup','pointercancel','lostpointercapture'])listen(root,type,release);
  for(const type of ['pointerup','pointercancel'])listen(root.defaultView,type,release);
  for(const type of ['input','keydown','wheel','scroll'])listen(root,type,touch);
  listen(root,'compositionstart',()=>{composing=true;touch();});listen(root,'compositionend',()=>{composing=false;touch();});
  listen(root,'visibilitychange',()=>{if(root.hidden)clearInteraction();});listen(root.defaultView,'blur',clearInteraction);
  return()=>{unlisten.forEach(remove=>remove());unlisten=[];clearInteraction();root=null;};
 }
 function scope(external){
  const controller=new AbortController(),removers=[];
  for(const source of [lifetime.signal,external].filter(Boolean)){
   const relay=()=>controller.abort(aborted(source));
   if(source.aborted)relay();else{source.addEventListener('abort',relay,{once:true});removers.push(()=>source.removeEventListener('abort',relay));}
  }
  return{signal:controller.signal,release:()=>removers.forEach(remove=>remove())};
 }
 function check({signal,isCurrent}){if(signal.aborted)throw aborted(signal);if(isCurrent&&!isCurrent())throw new RenderSupersededError();}
 function interactionBusy(){
  // Missing end events cannot strand a job forever. Real drag movement refreshes
  // this timestamp continuously, so the watchdog never admits an active drag.
  if(pointers.size&&now()-lastPointerActivity>=heldPointerTimeoutMs)pointers.clear();
  return!root?.hidden&&(pointers.size>0||composing||now()-lastInput<quietMs||pendingInput());
 }
 async function admit(context){
  for(;;){
   check(context);
   if(interactionBusy()){await pause(50,context.signal);continue;}
   // A real task boundary lets queued input and paint run even when font/image
   // Promises are already resolved. Microtask-only yields do not offer that.
   await yieldToBrowser(context.signal);check(context);
   if(!interactionBusy())return;
  }
 }
 async function run(task,{signal,isCurrent}={}){
  const owned=scope(signal),context={signal:owned.signal,isCurrent};
  try{await admit(context);const value=await task({signal:owned.signal,beforeDraw:()=>admit(context)});check(context);return value;}finally{owned.release();}
 }
 return{bind,run,wait:options=>run(()=>{},options),dispose(){unlisten.forEach(remove=>remove());unlisten=[];root=null;clearInteraction();lifetime.abort(new DOMException('图片调度已关闭','AbortError'));}};
}
