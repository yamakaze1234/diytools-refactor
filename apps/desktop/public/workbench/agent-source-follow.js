/** 仅在显式请求时规划来源文案跟随，正文、配置版本和预计生效的依赖版本随预览冻结。 */
import {followPendingSourcePlan,sourceFollowPlan} from './source-follow.js';
import {changedSourceText} from './source-diff-alert.js';
import {nasDependencies} from './nas-draft-controller.js';
import {ordinaryConfigs} from './template-library.js';
import {fail,version} from './agent-source-fields.js';

const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const limit=1024*1024;
export function sourceStepSummary(step,request){
 const doc=step.body.document;
 const view={kind:step.kind,shopId:step.shopId,action:step.action,resourceId:step.resourceId,
  ...(step.catalogKind?{catalogKind:step.catalogKind}:{}),...(step.body.changes?{count:step.body.changes.length}:{})};
 // 回执供人复核本次变更，避免返回 ERP 库存观察、完整旧来源或配置正文。
 if(doc?.edits)view.edits=doc.edits;
 else if(doc?.erpAdoption){
  const erp=doc.erpAdoption;
  view.name=doc.name;view.goodsId=doc.id;
  view.proposedTax=Object.hasOwn(erp,'taxOverride')?erp.taxOverride:erp.tableTax??erp.erp;
 }else if(doc&&step.catalogKind==='sources')view.changedFields=Object.keys(request.fields??{});
 if(step.kind==='costs')view.tax=step.body.changes[0].fields.tax;
 return view;
}
export async function planSourceFollow(client,shop,projected){
 const before=projected.map(p=>p.before),after=projected.map(p=>p.after);
 const changed=changedSourceText(before,after,()=>new Set(['name','upgrade']));
 const fieldsBySource=new Map(changed.map(x=>[x.row.sourceId,x.fields]));
 const ids=changed.length?await client.sourceUsage([...fieldsBySource.keys()],[]):[];
 if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id))fail('INVALID_API_RESPONSE','引用配置列表无效');
 const unique=[...new Set(ids)],docs=[];
 for(let i=0;i<unique.length;i+=6){
  docs.push(...await Promise.all(unique.slice(i,i+6).map(async id=>{
   const r=await client.detail(id);
   if(r?.document?.id!==id||r.document.shopId!==shop||!version(r.version)||!r.dependencies?.sources||!r.dependencies?.costs)fail('INVALID_API_RESPONSE','引用配置的身份、依赖或版本无效');
   return r;
  })));
 }
 const configs=ordinaryConfigs(docs.map(r=>r.document));
 const follow=followPendingSourcePlan(configs,after,shop,{fieldsBySource,previousRows:before});
 const manual=follow.fields.length?sourceFollowPlan(configs,after,follow.fields,shop,{kind:'manual',fieldsBySource,
  previousSources:new Map(before.map(r=>[r.sourceId,r]))}):{changes:[]};
 const rows=new Map(docs.map(r=>[r.document.id,r]));
 const parts=new Map(projected.map(p=>[p.before.sourceId,p]));
 const costVersions=new Map(projected.filter(p=>p.costVersion).map(p=>[p.before.goodsId,p.costVersion]));
 // 跟随加购可能带来新商品；用预览后来源投影展开，加上原 NAS 的其他依赖，禁止提交时改为“最新版本”。
 const memo=new Map(),reader={resource:(kind,id)=>{
  const part=parts.get(id);
  return kind==='sources'&&part?Promise.resolve({version:part.sourceVersion,document:part.after}):client.resource(kind,id);
 }};
 const changes=[];
 for(const change of follow.changes){
  const original=rows.get(change.id);
  const deps=await nasDependencies(reader,change.after,original.dependencies,memo);
  for(const [id,p] of parts)if(Object.hasOwn(deps.sources,id))deps.sources[id]=p.sourceVersion;
  for(const [id,v] of costVersions)if(Object.hasOwn(deps.costs,id))deps.costs[id]=v;
  changes.push({action:'replace',id:change.id,expected_version:original.version,document:change.after,dependencies:deps});
 }
 // 当前 NAS 每次事务至多 100 套及 1 MiB，按稳定的配置顺序拆分，不遗漏尾批。
 const steps=[];let batch=[];
 const flush=()=>{if(batch.length)steps.push({kind:'configurations',shopId:shop,action:'follow',body:{changes:batch}});batch=[];};
 for(const row of changes){
  if(bytes(row)+100>limit)fail('PLAN_TOO_LARGE','单套配置正文超过 NAS 限制');
  if(batch.length===100||bytes([...batch,row])+100>limit)flush();
  batch.push(row);
 }
 flush();
 return {steps,summary:{shopId:shop,followConfigCount:follow.followConfigCount,followLinkCount:follow.followLinkCount,
  manualConfigCount:follow.manualConfigCount,manualLinkCount:follow.manualLinkCount,
  manualTextCount:manual.changes.reduce((n,c)=>n+c.details.length,0)}};
}
