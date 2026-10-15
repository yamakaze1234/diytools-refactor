/** 图片任务独立于业务弹窗：固定输入快照，记录实际交付，失败重试不重复成功文件。 */
import {renderPoster} from './poster.js';
import {saveImageFolder} from './folder-export.js';
import {makeZip} from './zip.js';

const tasks=new Map(),listeners=new Set();let serial=0;
const copy=value=>JSON.parse(JSON.stringify(value));
const cancelled=()=>new DOMException('图片导出已取消','AbortError');
const delivered=item=>['saved','downloaded'].includes(item.state);
const emit=()=>{for(const listener of listeners)listener();};
export const imageExportTasks=()=>[...tasks.values()];

/** 任务只在当前工作台会话保留，不把业务快照或图片写入浏览器存储。 */
export function startImageExportTask({entries,name,title='批量图片导出',width=1400,renderImage=renderPoster,saveFolder=saveImageFolder,download,status=()=>{},signal,report={}}){
 if(!entries.length)throw Error('本次没有可导出的链接配置');
 const task={id:++serial,title,name,phase:'queued',message:'等待生成',items:entries.map(entry=>({...copy(entry),state:'pending',error:'',bytes:null})),busy:false,attempt:0,controller:null};
 // 后续执行只持有任务自己的副本，不额外延长调用方整批配置的生命周期。
 entries=null;
 const notify=message=>{task.message=message;try{status(message);}catch{/* 旧弹窗已卸载时仍继续任务。 */}emit();};
 const active=()=>{if(task.controller.signal.aborted)throw cancelled();};
 async function run(mode){
  if(task.busy)return task.done;
  const selected=task.items.filter(item=>mode==='failed'?item.state==='failed':!delivered(item));
  if(!selected.length)return task;
  task.busy=true;task.controller=new AbortController();task.attempt++;task.phase='rendering';
  // 外部取消只约束首次运行；重试由任务中心创建新的取消控制器。
  const abort=()=>task.controller.abort();if(task.attempt===1){if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});}
  try{
   for(const [index,item] of selected.entries()){
    active();if(item.bytes){item.state='generated';continue;}
    item.state='rendering';item.error='';notify(`正在生成 ${index+1}/${selected.length}：${item.name}`);
    try{
     // 渲染器获得副本，避免第三方绘图修改任务保存的起始快照。
     const result=await renderImage(copy(item.config),width);active();
     if(result.overflow)throw Error('图片内容超出，请调整模块或字号');
     const blob=await new Promise(resolve=>result.canvas.toBlob(resolve,'image/png'));active();if(!blob)throw Error('图片生成失败');
     item.bytes=new Uint8Array(await blob.arrayBuffer());active();item.state='generated';
    }catch(error){active();item.state='failed';item.error=error.message;}
    emit();
   }
   const ready=selected.filter(item=>item.state==='generated');
   if(!ready.length)throw Error('全部图片生成失败：'+selected.map(item=>item.error).join('；'));
   const failures=task.items.filter(item=>item.state==='failed').map(item=>({name:item.name,error:item.error}));
   const files=ready.map(item=>({name:item.name,bytes:item.bytes}));
   // 重试清单使用独立名称；已交付的图片不会再进入本次输出。
   files.push({name:task.attempt===1?'导出清单.json':`导出清单_重试${task.attempt-1}.json`,bytes:new TextEncoder().encode(JSON.stringify({...report,createdAt:new Date().toISOString(),success:ready.map(item=>item.name),failures},null,2))});
   active();task.phase='saving';notify('正在选择图片导出位置…');
   let folder;
   try{folder=await saveFolder(files,name,{signal:task.controller.signal});}
   catch(error){for(const item of ready){item.state='failed';item.error='保存未确认：'+error.message;}throw error;}
   // 原生写入一旦返回成功即如实记账，不能因迟到取消而把已交付文件列入重试。
   if(folder?.cancelled){task.phase='cancelled';notify('已取消图片导出，未保存的图片已保留，可在任务中心重新导出。');return task;}
   if(!folder){active();try{if(!download)throw Error('当前环境不支持下载');await download(makeZip(files),name.replace(/\.zip$/i,'')+'.zip');}catch(error){for(const item of ready){item.state='failed';item.error='下载未启动：'+error.message;}throw error;}}
   // 原生部分写出回执以逐文件清单为准，仅把未交付项交给失败重试。
   const written=folder&&Array.isArray(folder.files)?new Set(folder.files):null;
   for(const item of ready){
    if(folder&&(written?!written.has(item.name):folder.ok===false)){item.state='failed';item.error=folder.error||'图片未写出';}
    else{item.state=folder?'saved':'downloaded';item.bytes=null;item.config=null;item.error='';}
   }
   const failed=task.items.filter(item=>item.state==='failed').length,succeeded=ready.filter(delivered).length;
   task.directory=folder?.directory;task.phase=failed?'partial':'completed';
   notify(folder?`已导出 ${succeeded} 张图片，失败 ${failed} 张。文件夹：${folder.directory}`:`已发起 ${succeeded} 张图片的 ZIP 下载，失败 ${failed} 张；下载是否保存请查看浏览器。`);return task;
  }catch(error){
   if(task.controller.signal.aborted){for(const item of selected)if(item.state==='rendering')item.state=item.bytes?'generated':'pending';task.phase='cancelled';notify('已取消图片导出，可在任务中心继续未完成项。');throw cancelled();}
   task.phase='failed';notify(error.message);throw error;
  }finally{task.busy=false;signal?.removeEventListener('abort',abort);emit();}
 }
 task.cancel=()=>{if(task.busy&&task.phase!=='saving')task.controller.abort();};
 // 保存阶段不能打断原生文件写入，以免误报未保存；按钮明确展示此边界。
 task.retryFailed=()=>launch('failed');task.resume=()=>launch('unfinished');
 function launch(mode){task.done=run(mode);task.done.catch(()=>{});return task.done;}
 tasks.set(task.id,task);ensureTaskCenter();launch('unfinished');return task;
}

/** 使用独立的非模态侧面板，关闭或替换业务弹窗不会卸载任务。 */
function ensureTaskCenter(){
 if(typeof document==='undefined'||document.querySelector('#image-task-center-toggle'))return;
 const toggle=document.createElement('button');toggle.id='image-task-center-toggle';toggle.style.cssText='position:fixed;right:18px;bottom:88px;z-index:10020;padding:10px 16px;background:#1769aa;color:white;border-radius:8px';
 const panel=document.createElement('section');panel.id='image-task-center';panel.hidden=true;panel.setAttribute('aria-label','后台图片任务');panel.style.cssText='position:fixed;right:18px;bottom:134px;width:min(440px,90vw);max-height:min(65vh,calc(100vh - 180px));overflow:auto;z-index:10020;background:white;color:#172b4d;padding:18px;border:1px solid #ccd7e3;border-radius:10px;box-shadow:0 8px 32px #0003';
 toggle.onclick=()=>{panel.hidden=!panel.hidden;};document.body.append(toggle,panel);
 const draw=()=>{
  const all=imageExportTasks();toggle.textContent=`图片任务 ${all.filter(task=>task.busy).length} 进行中 / ${all.length}`;
  panel.replaceChildren();const heading=document.createElement('strong');heading.textContent='后台图片任务';const close=document.createElement('button');close.textContent='收起';close.onclick=()=>panel.hidden=true;
  const clear=document.createElement('button');clear.textContent='一键清空记录';clear.disabled=!all.some(task=>!task.busy);clear.title='清空未运行的任务记录，正在执行的任务保留';
  clear.onclick=()=>{for(const task of imageExportTasks())if(!task.busy)tasks.delete(task.id);emit();};
  panel.append(heading,close,clear);
  if(!all.length){const empty=document.createElement('p');empty.textContent='暂无图片任务记录';panel.append(empty);}
  for(const task of all.slice().reverse()){
   const section=document.createElement('div');section.style.cssText='border-top:1px solid #e2e8f0;margin-top:12px;padding-top:12px';
   const title=document.createElement('strong');title.textContent=task.title;const message=document.createElement('p');message.textContent=task.message;
   const progress=document.createElement('p');progress.textContent=`共 ${task.items.length} 张 · 已交付 ${task.items.filter(delivered).length} · 待保存 ${task.items.filter(item=>item.state==='generated').length} · 失败 ${task.items.filter(item=>item.state==='failed').length}`;
   section.append(title,message,progress);
   const action=(label,run,disabled=false)=>{const button=document.createElement('button');button.textContent=label;button.disabled=disabled;button.onclick=()=>Promise.resolve(run()).catch(()=>{});section.append(button);};
   if(task.busy)action(task.phase==='saving'?'正在保存，等待完成':'取消任务',task.cancel,task.phase==='saving');
   else{
    if(task.items.some(item=>item.state==='failed'))action('只重试失败项',task.retryFailed);
    if(task.items.some(item=>!delivered(item)&&item.state!=='failed'))action('继续未完成项',task.resume);
    action('移除记录',()=>{tasks.delete(task.id);emit();});
   }
   const failures=task.items.filter(item=>item.error);if(failures.length){const detail=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');summary.textContent='失败详情';text.textContent=failures.map(item=>`${item.name}：${item.error}`).join('；');detail.append(summary,text);section.append(detail);}
   panel.append(section);
  }
 };
 listeners.add(draw);draw();
}
