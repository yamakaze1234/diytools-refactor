/** 冲突比较只展示变化字段；整套版本选择与字段展示保持分离，不做隐式合并。 */
import {equal} from './cloud-protocol.js';

const labels={name:'名称',displayName:'展示名称',shortName:'短名称',product:'链接名称',productId:'链接编号',productUrl:'链接地址',shop:'店铺',shopId:'店铺编号',spu:'SPU',skuId:'SKU',parts:'展示配件',actualParts:'实际配件',addons:'加购',slot:'配件分类',qty:'数量',goodsId:'商品编号',lineId:'配件行编号',sourceId:'输出源编号',upgrade:'升级说明',tax:'含税成本',price:'价格',priceCents:'到手价',salePrice:'售价',cost:'成本',text:'内容',addonText:'加购说明',posterVisible:'图中显示',sourceFollow:'来源跟随',sourceSync:'来源同步',deletedAt:'删除时间',updatedAt:'更新时间',createdAt:'创建时间',version:'版本',theme:'主题',palette:'配色',layout:'布局',modules:'模块',benefits:'权益说明',footer:'页脚',brandText:'品牌文字',caseImage:'机箱图片',fontFamily:'字体',showUpgrades:'显示升级说明',showWarranty:'显示质保',installment:'分期',upgradeSize:'升级文字大小',upgradeColor:'升级文字颜色',upgradeWeight:'升级文字粗细',shortNameAuto:'自动短名称',themePalettes:'主题配色',workspaceOrder:'排列顺序',productCategory:'链接分类',productCardColor:'链接颜色',fixedInitialFormat:'初始格式',posterDesignVersion:'图片设计版本',wpsImport:'表格导入信息',textStyles:'文字样式'};
const kindLabels={configuration:'配置',component:'成本',source:'输出源',template:'模板',settings:'店铺设置',gallery:'图片'};
const object=value=>value!==null&&typeof value==='object';
const fieldName=key=>labels[key]||key;
function display(value,key){
 if(value===undefined)return '未设置';if(value===null)return '空值';if(value==='')return '空白';
 if(typeof value==='boolean')return value?'是':'否';
 if(key==='priceCents'&&typeof value==='number')return `¥ ${(value/100).toFixed(2)}`;
 if(Array.isArray(value)&&!value.length)return '无条目';
 if(object(value)&&!Object.keys(value).length)return '无内容';
 return String(value);
}
/** 按稳定行编号对齐配件，增删和重排均单独显示；其他数组按位置比较。 */
export function conflictDifferences(local,remote){
 const result=[];
 const add=(path,a,b,key)=>result.push({field:path||'整项内容',local:display(a,key),remote:display(b,key)});
 function visit(a,b,path='',key=''){
  if(equal(a,b))return;
  if(Array.isArray(a)&&Array.isArray(b)){
   const identity=items=>items.every(v=>object(v)&&typeof v.lineId==='string'&&v.lineId)&&new Set(items.map(v=>v.lineId)).size===items.length;
   if((a.length||b.length)&&identity(a)&&identity(b)){
    const am=new Map(a.map(v=>[v.lineId,v])),bm=new Map(b.map(v=>[v.lineId,v]));
    const commonA=a.filter(v=>bm.has(v.lineId)).map(v=>v.lineId),commonB=b.filter(v=>am.has(v.lineId)).map(v=>v.lineId);
    if(!equal(commonA,commonB))add(`${path} · 顺序`,a.map(v=>v.slot||v.name||v.lineId).join(' → '),b.map(v=>v.slot||v.name||v.lineId).join(' → '));
    for(const id of new Set([...am.keys(),...bm.keys()])){const av=am.get(id),bv=bm.get(id),item=bv||av;visit(av,bv,`${path} · ${item.slot||item.name||'配件'}（第 ${(bv?b:a).indexOf(item)+1} 项）`);}
   }else for(let i=0;i<Math.max(a.length,b.length);i++)visit(a[i],b[i],`${path} · 第 ${i+1} 项`);
   return;
  }
  if(object(a)||object(b)){
   // 类型不同也明确列出，避免空对象与空数组的变化被吞掉。
   if((a!==undefined&&!object(a))||(b!==undefined&&!object(b))||Array.isArray(a)!==Array.isArray(b)&&a!==undefined&&b!==undefined){
    add(`${path} · 内容类型`,a===null?'空值':Array.isArray(a)?'列表':object(a)?'分组':display(a,key),b===null?'空值':Array.isArray(b)?'列表':object(b)?'分组':display(b,key));
   }
   const keys=new Set([...Object.keys(object(a)?a:{}),...Object.keys(object(b)?b:{})]);
   if(!keys.size){add(path,a,b,key);return;}
   for(const child of keys)visit(object(a)?a[child]:undefined,object(b)?b[child]:undefined,path?`${path} · ${fieldName(child)}`:fieldName(child),child);
   return;
  }
  add(path,a,b,key);
 }
 visit(local,remote);return result;
}
export function conflictCard(row,index,esc){
 const local=row.draft,remote=row.conflict.remote.data,info=local||remote||{},diff=conflictDifferences(local,remote);
 const context=[info.shop||info.shopId,info.product||info.productId,info.spu?`SPU ${info.spu}`:''].filter(Boolean).join(' / ');
 return `<article class="cloud-conflict-card"><header><label class="cloud-conflict-select"><input type="checkbox" data-conflict-select="${index}" aria-label="选择${esc(info.name||kindLabels[row.type]||'此项')}"><strong>${esc(info.name||kindLabels[row.type]||'待确认内容')}</strong></label><span class="cloud-conflict-count">${diff.length} 处差异</span></header><p class="cloud-conflict-context">${esc(context||kindLabels[row.type]||'工作区资料')}</p><details ${index===0?'open':''}><summary>查看字段差异</summary><div class="cloud-conflict-table"><table><thead><tr><th>差异字段</th><th>本机版本</th><th>云端版本</th></tr></thead><tbody>${diff.map(d=>`<tr><th scope="row">${esc(d.field)}</th><td>${esc(d.local)}</td><td>${esc(d.remote)}</td></tr>`).join('')||'<tr><td colspan="3">两端当前内容相同，选择任一版本可结束冲突。</td></tr>'}</tbody></table></div></details><div class="actions"><button data-conflict-choice="remote" data-row="${index}">此项采用云端版本</button><button data-conflict-choice="local" data-row="${index}">此项保留本机版本</button></div></article>`;
}
/** 所有批量选择绑定本次比较令牌；保存成功后才移除卡片，失败保留勾选。 */
export function mountCloudConflicts(root,{controller,esc,toast,onBack,isCurrent=()=>root.isConnected}){
 let busy=false,rows=[],total=0,loadId=0;
 const $=selector=>root.querySelector(selector),all=selector=>[...root.querySelectorAll(selector)];
 function update(){
  const boxes=all('[data-conflict-select]'),count=boxes.filter(b=>b.checked).length;
  for(const button of all('button,input'))button.disabled=busy;
  for(const button of all('[data-conflict-batch]')){button.disabled=busy||!count;button.textContent=button.dataset.conflictBatch==='remote'?`所选 ${count} 项采用云端版本`:`所选 ${count} 项保留本机版本`;}
  const select=$('[data-conflict-all]');if(select){select.checked=count>0&&count===boxes.length;select.indeterminate=count>0&&count<boxes.length;select.disabled=busy||!boxes.length;}
 }
 async function load(){
  const id=++loadId;busy=true;if($('[data-conflict-message]'))update();
  try{
   const result=await controller.conflicts();if(!isCurrent()||id!==loadId)return;
   rows=result.rows;total=result.total;
   root.innerHTML=`<div class="cloud-conflict-toolbar"><p><strong>待处理 ${total} 项</strong><span>只列出变化字段；选择后整项采用该版本。</span></p><div class="actions"><label><input type="checkbox" data-conflict-all> 全选本页 ${rows.length} 项</label><button class="primary" data-conflict-batch="remote"></button><button data-conflict-batch="local"></button></div><p data-conflict-message role="status"></p></div>${total>rows.length?`<p class="hint">当前显示前 ${rows.length} 项；处理后继续显示剩余项。</p>`:''}<div class="cloud-conflict-list">${rows.map((row,i)=>conflictCard(row,i,esc)).join('')||'<p class="cloud-conflict-empty">没有待处理冲突。</p>'}</div><div class="actions"><button data-conflict-refresh>刷新比较</button><button data-conflict-back>返回数据与同步</button></div>`;
   $('[data-conflict-all]').onchange=event=>{all('[data-conflict-select]').forEach(b=>b.checked=event.target.checked);update();};
   all('[data-conflict-select]').forEach(b=>b.onchange=update);
   all('[data-conflict-batch]').forEach(b=>b.onclick=()=>apply(all('[data-conflict-select]').filter(n=>n.checked).map(n=>Number(n.dataset.conflictSelect)),b.dataset.conflictBatch));
   all('[data-conflict-choice]').forEach(b=>b.onclick=()=>apply([Number(b.dataset.row)],b.dataset.conflictChoice));
   $('[data-conflict-refresh]').onclick=load;$('[data-conflict-back]').onclick=onBack;
  }catch(error){if(isCurrent()){const message=$('[data-conflict-message]');if(message)message.textContent=error.message;else root.textContent=error.message;toast(error.message);}}
  finally{if(id===loadId){busy=false;if(isCurrent())update();}}
 }
 async function apply(indices,choice){
  if(busy||!indices.length)return;busy=true;update();
  $('[data-conflict-message]').textContent=`正在保存所选 ${indices.length} 项…`;
  try{
   await controller.resolveMany(indices.map(i=>({type:rows[i].type,id:rows[i].id,token:rows[i].token,choice})));
   toast(`已处理 ${indices.length} 项：${choice==='remote'?'采用云端版本':'保留本机版本，等待同步'}`);
   if(isCurrent())await load();
  }catch(error){if(isCurrent())$('[data-conflict-message]').textContent=error.message;toast(error.message);}
  finally{busy=false;if(isCurrent())update();}
 }
 root.innerHTML='<p data-conflict-message role="status">正在读取冲突…</p>';return load();
}
