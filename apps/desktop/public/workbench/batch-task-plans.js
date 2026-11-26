import {syncReplacementAddons} from './source.js';
/** 所有任务从同一基线生成差异；合并独立字段，拒绝互相覆盖的任务。 */
export function mergeTaskPlans(plans){
 if(!plans.length)throw Error('请先添加修改任务');
 const changes=new Map(),writes=new Map(),addonGroups=new Map();
 const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 function diff(before,after,path=[]){
  if(equal(before,after))return [];
  if(before&&after&&typeof before==='object'&&typeof after==='object'&&Array.isArray(before)===Array.isArray(after)&&(!Array.isArray(before)||before.length===after.length)){
   return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(key=>diff(before[key],after[key],[...path,key]));
  }
  return [{path,value:after}];
 }
 plans.forEach((plan,index)=>{
  for(const change of plan.changes){
   if(!changes.has(change.id)){changes.set(change.id,{...structuredClone(change),after:structuredClone(change.before)});writes.set(change.id,[]);}
   const merged=changes.get(change.id),previous=writes.get(change.id);
   if(!equal(merged.before,change.before))throw Error('配置基线不一致，请重新预览');
   // 旧配置没有独立 BOM 时，以展示清单为共同基线，避免两条任务互相覆盖整份 BOM。
   let baseline=change.before;
   if(!Array.isArray(baseline.actualParts)&&Array.isArray(change.after.actualParts)){
    baseline={...baseline,actualParts:structuredClone(baseline.parts).map(({displayName,...part})=>part)};
    if(!Array.isArray(merged.after.actualParts))merged.after.actualParts=structuredClone(baseline.actualParts);
   }
   let after=change.after;
   if(plans.length>1&&plan.replacement&&Array.isArray(baseline.addons)){
    // 不同槽位共用一份加购数组；先合并行，再按最终展示来源替换组，避免把数组下标当作组身份。
    const group=addonGroups.get(change.id)??{previous:new Map(),replacements:new Map()};
    const oldSlots=new Map([...(change.before.actualParts??[]),...change.before.parts].map(part=>[part.slot,part.sourceId]));
    for(const part of after.parts){
     const old=oldSlots.get(part.slot);
     if(old&&old!==part.sourceId&&part.sourceId===plan.replacement.sourceId)group.previous.set(old,Boolean(group.previous.get(old)||plan.replacement.sharedSourceId));
    }
    if(plan.replacement.sharedSourceId)group.replacements.set(plan.replacement.sourceId,plan.replacement);
    addonGroups.set(change.id,group);
    after={...after,addons:baseline.addons};
   }
   for(const write of diff(baseline,after)){
    const conflict=previous.find(old=>old.path.slice(0,Math.min(old.path.length,write.path.length)).every((key,i)=>key===write.path[i])&&!(equal(old.path,write.path)&&equal(old.value,write.value)));
    if(conflict)throw Error(`任务 ${conflict.index+1} 与任务 ${index+1} 冲突：${change.product} / ${change.name}，请调整重叠配件`);
    previous.push({...write,index});let target=merged.after;
    for(const key of write.path.slice(0,-1))target=target[key];
    const key=write.path.at(-1);if(write.value===undefined)delete target[key];else target[key]=structuredClone(write.value);
   }
  }
 });
 for(const [id,{previous,replacements}] of addonGroups)syncReplacementAddons(changes.get(id).after,previous,replacements);
 const rows=[...changes.values()].filter(c=>!equal(c.before,c.after));
 return {changes:rows,productIds:[...new Set(plans.flatMap(p=>p.productIds||[]))],taskCount:plans.length};
}

/** 任务切换仅保存弹窗草稿，不调用业务保存。 */
export function mountBatchTasks({root,prefix,esc,capture,restore,blank,describe,invalidate,allowDeleteLast=false,isBusy=()=>false}){
 let tasks=[blank()],index=0;
 root.innerHTML=`<div class="actions"><strong>修改任务</strong><button type="button" id="${prefix}-add-task">＋ 添加修改任务</button></div><p class="hint">每条任务分别选择配件和链接，切换保留已填内容，最后统一预览与保存。</p><div id="${prefix}-task-list"></div>`;
 const save=()=>{tasks[index]=capture();};
 function render(){
  root.querySelector(`#${prefix}-task-list`).innerHTML=tasks.map((task,i)=>`<div class="upgrade-task"><button type="button" data-${prefix}-task="${i}" aria-pressed="${i===index}"><strong>任务 ${i+1}${i===index?' · 编辑中':''}</strong><small>${esc(describe(task))}</small></button><button type="button" data-${prefix}-task-delete="${i}" aria-label="删除任务 ${i+1}" ${tasks.length===1&&!allowDeleteLast?'disabled':''}>×</button></div>`).join('');
  root.querySelectorAll(`[data-${prefix}-task]`).forEach(el=>el.onclick=()=>{if(isBusy())return;save();load(Number(el.getAttribute(`data-${prefix}-task`)));});
  root.querySelectorAll(`[data-${prefix}-task-delete]`).forEach(el=>el.onclick=()=>{if(isBusy())return;
   // 库存页允许清空最后一条任务，保留空白编辑位供继续添加。
   if(tasks.length===1){if(allowDeleteLast){tasks=[blank()];load(0);}return;}
   save();const removed=Number(el.getAttribute(`data-${prefix}-task-delete`));tasks.splice(removed,1);load(Math.min(removed<index?index-1:index,tasks.length-1));});
 }
 function load(next){index=next;restore(structuredClone(tasks[index]));invalidate();render();}
 root.querySelector(`#${prefix}-add-task`).onclick=()=>{if(isBusy())return;save();tasks.push(blank());load(tasks.length-1);};
 render();
 return {snapshot:()=>{save();render();return structuredClone(tasks);},reset:()=>{tasks=[blank()];load(0);},refresh:()=>{save();render();}};
}
