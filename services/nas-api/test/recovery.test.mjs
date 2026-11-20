// 总线断开前后都保留原编号：只查不会写，只有用户显式恢复才重放原始请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasDraftController} from '../../../apps/desktop/public/workbench/nas-draft-controller.js';
import {createNasCatalogController} from '../../../apps/desktop/public/workbench/nas-catalog-controller.js';
import {acknowledgeNasPriceDraft,buildNasOperationPlan,createNasOperationQueue} from '../../../apps/desktop/public/workbench/nas-operation-plan.js';
import {NasApiError} from '../../../apps/desktop/public/workbench/nas-api-client.js';
const unknown=()=>new NasApiError('SAVE_STATUS_UNKNOWN');
const missing=()=>new NasApiError('NOT_FOUND',404);
function journal(){
 const rows=new Map();
 return {get length(){return rows.size;},key:i=>Array.from(rows.keys())[i],getItem:k=>rows.get(k),setItem:(k,v)=>rows.set(k,v),removeItem:k=>rows.delete(k)};
}
const document={id:'test',shopId:'intel',name:'服务器原名',parts:[],actualParts:[],addons:[]};
const dependencies={sources:{},costs:{}};
function draftFixture(){
 const storage=journal(),sends=[];let mode='lost',uid='one',reply=null;
 const client={me:async()=>({uid,workspace_id:'w',data_source:'intel_live',configuration_writes:true,shops:[{shop_id:'intel',role:'operations'}]}),
  detail:async()=>({document,version:'1',dependencies}),
  receipt:async()=>{if(!reply)throw missing();return reply;},
  save:async(action,id,body)=>{
   sends.push(structuredClone({action,id,body}));
   if(mode==='denied')throw new NasApiError('FORBIDDEN',403);
   if(mode==='conflict')throw new NasApiError('VERSION_CONFLICT',409);
   if(mode==='lost')throw unknown();
   reply={shop_id:'intel',configuration_id:id,operation_id:body.operation_id,version:'2',archived:false};
   if(mode==='committedLost')throw unknown();return reply;
  }};
 return {sends,mode:value=>{mode=value;},uid:value=>{uid=value;},make:()=>createNasDraftController({storage,client,endpointId:'trial'})};
}
test('普通回执404不写，离线原请求跨重开只按原版本和原正文显式重试',async()=>{
 const f=draftFixture(),first=f.make();await first.open('test');first.edit({...document,name:'离线草稿'});
 await assert.rejects(first.save(),{code:'SAVE_STATUS_UNKNOWN'});
 const old=first.read().pending.body;
 const next=f.make();await next.open('test');
 await assert.rejects(next.receipt(),{code:'RECEIPT_NOT_FOUND'});assert.equal(f.sends.length,1);
 f.uid('two');await assert.rejects(next.retry(),{code:'MEMBER_CHANGED'});assert.equal(f.sends.length,1);
 f.uid('one');f.mode('success');assert.equal((await next.retry()).version,'2');
 assert.deepEqual(f.sends,[f.sends[0],f.sends[0]]);assert.deepEqual(f.sends[1].body,old);assert.equal(next.read().pending,null);
});
test('重试先查已提交回执；权限变化保留编号，旧版本失败保留编辑',async()=>{
 const f=draftFixture(),a=f.make();await a.open('test');a.edit({...document,name:'已提交失回执'});
 f.mode('committedLost');await assert.rejects(a.save(),{code:'SAVE_STATUS_UNKNOWN'});
 assert.equal((await a.retry()).version,'2');assert.equal(f.sends.length,1);
 const g=draftFixture(),b=g.make();await b.open('test');b.edit({...document,name:'仍要保留'});
 await assert.rejects(b.save(),{code:'SAVE_STATUS_UNKNOWN'});
 const operationId=b.read().pending.body.operation_id;
 g.mode('denied');await assert.rejects(b.retry(),{code:'FORBIDDEN'});assert.equal(b.read().pending.body.operation_id,operationId);
 g.mode('conflict');await assert.rejects(b.retry(),{code:'VERSION_CONFLICT'});assert.equal(b.read().pending,null);
 assert.equal(b.read().document.name,'仍要保留');assert.equal(b.read().version,'1');
});
test('目录按冻结正文恢复，重新选文件只有原始摘要匹配才发送原上传编号',async()=>{
 const storage=journal(),sent=[];let online=false;
 const client={catalogReceipt:async()=>{throw missing();},
  saveCatalog:async(kind,id,action,body)=>{sent.push({kind,id,action,body});if(!online)throw unknown();return {shop_id:'intel',kind,resource_id:id,operation_id:body.operation_id,version:'2',archived:false};},
  uploadImage:async body=>{
   sent.push(body);if(!online)throw unknown();const sha256=''+[...new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(body.base64),c=>c.charCodeAt(0))))].map(x=>x.toString(16).padStart(2,'0')).join('');
   const url='/uploads/'+sha256+'.png';return {shop_id:'intel',kind:'assets',resource_id:url,operation_id:body.operationId,version:'1',archived:false,document:{url,sha256}};
  }};
 const build=()=>createNasCatalogController({client,storage,scope:['endpoint','w','one']});
 const first=build();await assert.rejects(first.save('gallery','row','replace',{expected_version:'1',document:{name:'原目录正文'}}),{code:'SAVE_STATUS_UNKNOWN'});
 const file=new File([Uint8Array.from([9,8,7])],'file.png',{type:'image/png'});
 await assert.rejects(first.upload(file,btoa('\t\b\x07')),{code:'SAVE_STATUS_UNKNOWN'});
 const reopened=build(),[gallery,asset]=reopened.pending();online=true;
 await assert.rejects(reopened.receipt(gallery),{code:'RECEIPT_NOT_FOUND'});assert.equal(sent.length,2);
 await assert.rejects(reopened.retry(asset,new File(['changed'],'file.png',{type:'image/png'})),{code:'ORIGINAL_IMAGE_REQUIRED'});
 assert.equal(sent.length,2);assert.equal(reopened.pending().length,2);
 await reopened.retry(gallery);await reopened.retry(asset,file);
 assert.deepEqual(sent[2],sent[0]);assert.deepEqual(sent[3],sent[1]);assert.deepEqual(reopened.pending(),[]);
});
test('批量重放只处理原未知批次，不自动发送后续批次',async()=>{
 const plan=buildNasOperationPlan('costs',Array.from({length:101},(_,i)=>({id:String(i),action:'erp_snapshot'})));
 let stored,online=false;const sent=[];
 const storage={get:async()=>structuredClone(stored),put:async(_,value)=>{stored=structuredClone(value);}};
 const client={workspaceReceipt:async()=>{throw missing();},workspaceWrite:async(kind,body)=>{
  sent.push(structuredClone(body));if(!online)throw unknown();
  return {shop_id:'intel',kind,operation_id:body.operation_id,changes:body.changes.map(x=>({id:x.id,version:'2'}))};
 }};
 const build=()=>createNasOperationQueue({client,storage,key:'endpoint'});
 const first=build();await first.add(plan);await assert.rejects(first.submit(),{code:'SAVE_STATUS_UNKNOWN'});
 const reopened=build();await assert.rejects(reopened.receipt(),{code:'RECEIPT_NOT_FOUND'});assert.equal(sent.length,1);
 online=true;const partially=await reopened.retry();assert.deepEqual(sent,[sent[0],sent[0]]);
 assert.deepEqual(partially.batches.map(row=>row.status),['done','ready']);
 const complete=await reopened.submit();assert.equal(sent.length,3);assert.deepEqual(complete.batches.map(row=>row.status),['done','done']);
});
test('旧价格批次回执不吞掉提交未知后输入的新价格或未发送批次',()=>{
 const plan={batches:[{status:'done',body:{changes:[
  {id:'newer',expected_version:'4',document:{price:11,coupon:0}},
  {id:'confirmed',expected_version:'1',document:{price:22}},
  {id:'other-base',expected_version:'2',document:{price:33}}
 ]},result:{changes:[{version:'5'},{version:'2'},{version:'3'}]}},{status:'ready'}]};
 const drafts=[{id:'newer',expected_version:'4',fields:{price:99,coupon:0}},
  {id:'confirmed',expected_version:'1',fields:{price:22}},
  {id:'other-base',expected_version:'9',fields:{price:33}},
  {id:'not-sent',expected_version:'4',fields:{price:null}}];
 assert.deepEqual(acknowledgeNasPriceDraft(plan,drafts),[
  {id:'newer',expected_version:'5',fields:{price:99}},drafts[2],drafts[3],
 ]);
});

test('编号回执推进尚未发送的后续批次，未知提交重放正文保持一致',async()=>{
 const plan=buildNasOperationPlan('configurations',Array.from({length:101},(_,i)=>({id:'c'+i,action:'archive',expected_version:'1'})));
 let stored,online=false;const sent=[];
 const storage={get:async()=>structuredClone(stored),put:async(_,value)=>{stored=structuredClone(value);}};
 const client={workspaceReceipt:async()=>{throw missing();},workspaceWrite:async(kind,body)=>{
  sent.push(structuredClone(body));if(!online)throw unknown();
  if(body.changes[0].id==='c100')assert.equal(body.changes[0].expected_version,'2');
  const changes=body.changes.map(change=>({configuration_id:change.id,version:'2',archived:true}));
  if(changes.length===100)changes[0].reordered=[{configuration_id:'c100',before:'配置101',name:'配置1',previous_version:'1',version:'2'}];
  return {shop_id:'intel',kind,operation_id:body.operation_id,changes};
 }};
 const queue=createNasOperationQueue({client,storage,key:'rename'});await queue.add(plan);
 await assert.rejects(queue.submit(),{code:'SAVE_STATUS_UNKNOWN'});online=true;
 await queue.retry();assert.deepEqual(sent[0],sent[1]);assert.equal(stored.batches[1].body.changes[0].expected_version,'2');
 await queue.submit();assert.deepEqual(stored.batches.map(row=>row.status),['done','done']);
});
