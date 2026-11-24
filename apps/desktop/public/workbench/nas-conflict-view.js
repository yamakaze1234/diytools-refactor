/** NAS 配置三方差异：按配件行号对齐，只展示真实变更，不执行合并或保存。 */
import {equal} from './cloud-protocol.js';
const labels={parts:'展示配件',actualParts:'实际配件',name:'名称',slot:'配件分类',qty:'数量',goodsId:'ERP 商品 ID',sourceId:'输出源 ID',
 erp:'ERP 成本',tax:'含税核算价',taxOverride:'手动核算价',value:'金额',price:'到手价',skuId:'SKU',spu:'SPU',product:'链接名称',
 addons:'加购与选配',benefits:'福利',text:'文案',note:'补充说明',items:'组合商品',choices:'可选商品',variants:'加购方案',
 priceCents:'加购价',originalQty:'原配件数量',followPolicy:'跟随方式',followAll:'跟随全部方案',upgrade:'升级文案',
 sourceFollow:'来源跟随',shortName:'配置简称',shortNameAuto:'自动简称',version:'配置版号',workspaceOrder:'排列顺序'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const format=(value,key)=>{
 if(value===undefined)return '未设置';if(value===null)return '空值';if(value==='')return '空白';
 if(typeof value==='boolean')return value?'是':'否';
 if(key==='priceCents'&&typeof value==='number')return `¥ ${(value/100).toFixed(2)}`;
 if(key==='followPolicy')return value==='follow'?'跟随输出源':value==='snapshot'?'独立快照':String(value);
 return typeof value==='object'?JSON.stringify(value):String(value);
};
export function nasConfigConflictRows({base,draft,remote}){
 const rows=[];
 const add=(field,b,l,r,key)=>{
  if(equal(b,l)&&equal(b,r))return;
  const localChanged=!equal(b,l),remoteChanged=!equal(b,r);
  rows.push({field,base:format(b,key),local:format(l,key),remote:format(r,key),
   kind:localChanged&&remoteChanged?(equal(l,r)?'same':'conflict'):localChanged?'local':'remote'});
 };
 function visit(b,l,r,path='',key=''){
  if(equal(b,l)&&equal(b,r))return;
  const values=[b,l,r],present=values.filter(value=>value!==undefined);
  if(present.every(Array.isArray)){
   const lists=values.map(value=>value??[]);
   // 配件按稳定行号比较，换件、增删、重排不会错配到邻行；旧草稿缺行号时退回位置比较。
   if(['parts','actualParts'].includes(key)&&lists.every(list=>list.every(row=>object(row)&&row.lineId)&&new Set(list.map(row=>row.lineId)).size===list.length)){
    const maps=lists.map(list=>new Map(list.map(row=>[row.lineId,row])));
    const order=lists.map(list=>list.map(row=>row.lineId));
    if(!equal(order[0],order[1])||!equal(order[0],order[2]))add(path+' · 行顺序',...lists.map(list=>list.map(row=>row.slot+' '+(row.name||row.lineId)).join(' → ')),'');
    for(const id of new Set(maps.flatMap(map=>[...map.keys()]))){
     const parts=maps.map(map=>map.get(id)),part=parts.find(Boolean),index=lists[parts.findIndex(Boolean)].findIndex(row=>row.lineId===id);
     const title=`${path} · ${part.slot||'配件'}（第 ${index+1} 项）`;
     if(parts.some(value=>value===undefined))add(title+' · 配件状态',...parts.map(value=>value?'存在':'无此配件'),'');
     visit(...parts.map(value=>value&&Object.fromEntries(Object.entries(value).filter(([field])=>field!=='lineId'))),title);
    }
   }else for(let i=0;i<Math.max(...lists.map(list=>list.length));i++)visit(...lists.map(list=>list[i]),`${path} · 第 ${i+1} 项`);
   return;
  }
  if(present.every(object)){
   const keys=new Set(present.flatMap(value=>Object.keys(value)));
   if(!keys.size){add(path,b,l,r,key);return;}
   for(const field of keys)visit(...values.map(value=>value?.[field]),path?path+' · '+(labels[field]||field):(labels[field]||field),field);
   return;
  }
  add(path||'整套配置',b,l,r,key);
 }
 visit(base,draft,remote.document);return rows;
}
export function nasConfigConflictHtml(value,esc){
 const rows=nasConfigConflictRows(value),labels={local:'本机修改',remote:'服务器修改',same:'双方相同修改',conflict:'双方修改冲突'};
 const count=rows.filter(row=>row.kind==='conflict').length;
 return `<section class="nas-config-conflict"><p class="hint" role="status">共 ${rows.length} 处变化，${count} 处双方修改冲突。按开始编辑时的配置比较；关联来源或成本的版本更新由保存时自动接续。</p>
 <div class="cloud-conflict-table"><table aria-label="配置冲突明细"><thead><tr><th>配件 / 字段</th><th>变更情况</th><th>开始编辑时</th><th>本机草稿</th><th>服务器最新</th></tr></thead><tbody>
 ${rows.map(row=>`<tr data-nas-diff="${row.kind}"><th scope="row">${esc(row.field)}</th><td>${labels[row.kind]}</td><td>${esc(row.base)}</td><td>${esc(row.local)}</td><td>${esc(row.remote)}</td></tr>`).join('')||'<tr><td colspan="5">配置内容没有差异，仅版本或关联依赖已更新。</td></tr>'}
 </tbody></table></div></section>`;
}
