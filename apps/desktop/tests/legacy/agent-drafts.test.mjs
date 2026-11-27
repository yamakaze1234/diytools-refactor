import test from 'node:test';
import assert from 'node:assert/strict';
import {previewAgentDraft,applyAgentDraft} from '../../public/workbench/agent-drafts.js';

const op=()=>crypto.randomUUID(),shop='intel';
const source=(sourceId,goodsId,name,attrs={})=>({shopId:shop,sourceId,goodsId,name,...attrs});
const board=source('board','101','验收主板',{hardwareOverrides:{boardType:'ATX'},erpCategory:'主板'});
const box=source('box','102','验收机箱',{hardwareOverrides:{caseBoards:['ATX','MATX']},erpCategory:'机箱'});
const small=source('small','103','小机箱',{hardwareOverrides:{caseBoards:['ITX']},erpCategory:'机箱'});
const ram=source('ram','104','验收内存',{capacityOverrides:{memoryGb:32}});
const special=source('special:intel:2','','保存的特殊配件',{specialComponent:true});
const part=(slot,sourceId)=>({slot,sourceId,qty:1});
const input=(configs=[{name:'配置一',parts:[part('主板','board'),part('机箱','box'),part('内存','ram')]}])=>({
 shopId:shop,mode:'new_draft_link',productName:'验收草稿',configs
});

function fixture(rows=[board,box,small,ram,special]){
 const costs=rows.filter(s=>s.goodsId).map(s=>({goodsId:s.goodsId,erp:33,tax:35,name:s.name}));
 const summaries=[{id:'other',productId:'other-link',workspaceOrder:1200}],calls={posts:0,lookups:0,preflights:0,confirmations:0};
 let saved=null,loseNextReply=false;
 const client={
  workspaceIndex:async()=>({summaries}),
  workspaceCatalog:async()=>({sourceCatalog:rows,costSource:costs,costVersions:Object.fromEntries(costs.map(s=>[s.goodsId,'9']))}),
  resource:async(kind,id)=>({id,document:kind==='sources'?rows.find(s=>s.sourceId===id):costs.find(c=>c.goodsId===id),version:kind==='sources'?'8':'9'}),
  async workspaceWrite(kind,{operation_id,changes}){
   calls.posts++;assert.equal(kind,'configurations');
   saved={operation_id,kind,shop_id:shop,changes:changes.map(c=>({configuration_id:c.id,version:'1',shop_id:shop,operation_id,archived:false}))};
   if(loseNextReply){loseNextReply=false;throw Error('模拟提交成功后断线');}return saved;
  },
  async workspaceReceipt(){calls.lookups++;return saved;}
 };
 const api={access:async()=>({client,assertWritable(){},assertDrafts:async()=>{}}),refresh:async()=>true,
  native:async action=>{if(action==='preflight')calls.preflights++;else if(action==='step.confirm')calls.confirmations++;else assert.fail(action);}};
 return {api,calls,costs,summaries,loseReply:()=>{loseNextReply=true;},preview:request=>previewAgentDraft({operationId:op(),request},api)};
}

test('新链接和配置由工作台生成，冻结店铺来源、实际 BOM、价格及依赖版本',async()=>{
 const f=fixture(),first=input();
 first.configs[0].actualParts=[{...part('其他配件',special.sourceId),qty:2}];
 first.configs.push({name:'配置二',price:1999.95,parts:[part('内存','ram')]});
 const before=structuredClone(first),preview=await f.preview(first),again=await f.preview(first);
 const changes=preview.plan.steps[0].changes,[a,b]=changes.map(c=>c.document);
 assert.deepEqual(first,before);
 assert.notEqual(again.summary.productId,a.productId);assert.notEqual(a.id,b.id);
 assert.equal(a.workspaceOrder,1300);assert.equal(b.workspaceOrder,1400);
 assert.equal(a.productId,b.productId);assert.equal(a.productId,preview.summary.productId);
 for(const doc of [a,b]){assert.equal(doc.productDraft,true);assert.equal(doc.spu,'');assert.equal(doc.skuId,'');}
 assert.equal(a.parts[2].capacityOverrides.memoryGb,32);
 assert.deepEqual([a.parts[0].erp,a.parts[0].tax],[33,35]);
 assert.deepEqual([a.actualParts[0].sourceId,a.actualParts[0].goodsId,a.actualParts[0].erp,a.actualParts[0].tax],[special.sourceId,'',0,0]);
 assert.equal(b.price,1999.95);assert.ok(b.parts[0].lineId);
 assert.equal(changes[0].dependencies.sources.board,'8');assert.equal(changes[0].dependencies.costs['101'],'9');
 assert.equal(preview.summary.configs[0].parts[0].goodsId,'101');
 assert.deepEqual(preview.summary.configs[0].actualBom[0],{slot:'其他配件',sourceId:special.sourceId,goodsId:'',name:special.name,qty:2});
 assert.ok(changes.every(c=>c.action==='create'&&!('expected_version' in c)));
 assert.deepEqual(preview.summary.hardwareWarnings,[]);
});

test('分别校验展示和实际板型，资料不足仍可保存；不接受绕过字段或外部链接 ID',async()=>{
 const f=fixture(),bad=[part('主板','board'),part('机箱','small')];
 for(const request of [input([{name:'错配',parts:bad}]),input([{name:'实际错配',parts:[part('内存','ram')],actualParts:bad}])]){
  await assert.rejects(f.preview(request),{code:'INCOMPATIBLE_HARDWARE'});
 }
 await assert.rejects(f.preview(input([{name:'错放',parts:[part('配件1','board'),part('机箱','small')]}])),{code:'INVALID_PARAMS'});
 for(const patch of [{productId:'existing'},{mode:'append_draft_link'},{ignoreHardware:true},{configs:[]},{configs:Array(17).fill(input().configs[0])}]){
  await assert.rejects(f.preview({...input(),...patch}),{code:'INVALID_PARAMS'});
 }
 const unknown=fixture([board,source('box','102','待补资料')]);const data=input();
 data.configs[0].parts.pop();
 const result=await unknown.preview(data);
 assert.deepEqual(result.summary.hardwareWarnings.map(w=>w.group),['展示配件','实际配件']);
});

test('拒绝未保存虚拟来源、跨店来源、已归档或带星商品以及超过限制的实际提交正文',async()=>{
 const blocked=fixture([ram,source('deleted','1','已删除',{deletedAt:'2026-01-01'}),source('foreign','2','外店',{shopId:'jonsbo'}),source('star','3','禁用')]);
 blocked.costs.find(c=>c.goodsId==='3').name='禁用*!';
 const one=id=>input([{name:'配置',parts:[part('配件1',id)]}]);
 await assert.rejects(blocked.preview(one('special:intel:1')),{code:'UNSAVED_SOURCE'});
 for(const id of ['deleted','foreign','star'])await assert.rejects(blocked.preview(one(id)),{code:'INVALID_DEPENDENCY'});
 const big=fixture([source('long','1','A'.repeat(1800))]);
 await assert.rejects(big.preview(input([{name:'大配置',parts:Array(160).fill(part('配件1','long'))}])),{code:'PLAN_TOO_LARGE'});
});

test('NAS 已保存但响应丢失，重试原操作读回正式回执，不再发创建请求',async()=>{
 const f=fixture(),{plan}=await f.preview(input()),operationId=op();
 const step={index:0,state:'pending',operationId},job={id:'job',params:{plan,operationId,stepStates:[step]}};
 f.loseReply();
 await assert.rejects(applyAgentDraft(job,f.api),/断线/);
 step.state='submitted';
 const done=await applyAgentDraft(job,f.api);
 assert.equal(done.nasSave,'saved');assert.equal(done.productId,plan.steps[0].changes[0].document.productId);
 assert.deepEqual(f.calls,{posts:1,lookups:1,preflights:1,confirmations:1});
});

test('预览生成的链接 ID 被占用时，草稿不会追加到已有链接',async()=>{
 const f=fixture(),{plan,summary}=await f.preview(input()),operationId=op();
 f.summaries.push({id:'other-config',productId:summary.productId});
 const job={id:'job',params:{plan,operationId,stepStates:[{index:0,state:'pending',operationId}]}};
 await assert.rejects(applyAgentDraft(job,f.api),{code:'REVISION_CONFLICT'});
 assert.equal(f.calls.posts,0);
});
