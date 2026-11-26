// 只使用合成成员和独立的内存 IndexedDB 驱动，可在事务完成前注入配额错误。
import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {createNasDraftStorage} from '../../../apps/desktop/public/workbench/nas-draft-storage.js';
import {createNasDraftController} from '../../../apps/desktop/public/workbench/nas-draft-controller.js';
import {createNasMainWorkspace} from '../../../apps/desktop/public/workbench/nas-main-workspace.js';

const quota=()=>{throw new DOMException('测试配额不足','QuotaExceededError');};
const unavailable={code:'DRAFT_STORAGE_UNAVAILABLE'};
const doc={id:'c',name:'配置',shopId:'intel',parts:[],actualParts:[],addons:[]};
const prefix=shop=>'diy-nas-draft:'+JSON.stringify(['test:main'+(shop==='intel'?'':':'+shop),'w','owner'])+':';
function fixture(){
 const indexedDB=new IDBFactory(),old=new Map();
 const legacyStorage={get length(){return old.size;},key:i=>[...old.keys()][i],getItem:k=>old.get(k)??null,removeItem:k=>old.delete(k)};
 const storage=()=>createNasDraftStorage({indexedDB,legacyStorage,keyRange:IDBKeyRange});
 const draftStorage=storage(),events=[];
 const shops=['intel','gigabyte'];
 const client={bindIdentity(){},async me(){return {uid:'owner',workspace_id:'w',shops:shops.map(shop_id=>({shop_id,role:'operations'})),
  shop_capabilities:Object.fromEntries(shops.map(shop=>[shop,{configuration_writes:true,data_source:shop+'_live'}]))};},
  async detail(){return {document:doc,version:'1',dependencies:{sources:{s:'1'},costs:{}}};}};
 const controller=(driver=draftStorage)=>createNasDraftController({client,draftStorage:driver,endpointId:'test:main',onStorageError:(id,error)=>events.push([id,error])});
 return {old,storage,draftStorage,legacyStorage,client,controller,events,key:prefix('intel')+JSON.stringify(doc.id)};
}

test('旧键仅在整批迁移提交后清理，保留较新 IndexedDB 值，失败可以重试',async t=>{
 const {old,draftStorage:s,key,storage}=fixture(),other=key+'2',p=prefix('intel');
 old.set(key,'旧值');old.set(other,'待迁移');old.set('无关','保留');await s.setNow(key,'新值');
 const add=t.mock.method(IDBObjectStore.prototype,'add',quota);
 await assert.rejects(s.migrateLegacy(p),unavailable);assert.equal(old.size,3);
 assert.equal(await storage().getFresh(other),null);add.mock.restore();
 await s.migrateLegacy(p);await s.loadPrefix(p);
 assert.deepEqual([...old],[['无关','保留']]);assert.equal(s.getCached(key),'新值');assert.equal(s.getCached(other),'待迁移');
 const first=s.enqueueSet(other,'修改');s.enqueueSet(other,'最终');assert.equal(s.getCached(other),'最终');
 await first;await s.flush();const reopened=storage();await reopened.loadPrefix(p);assert.equal(reopened.getCached(other),'最终');
 await s.enqueueRemove(other);assert.equal(await reopened.getFresh(other),null);
});

test('单条旧草稿请求成功但事务最终中止时，旧键仍可恢复',async t=>{
 const {old,key,draftStorage:s,storage}=fixture(),p=prefix('intel');old.set(key,'原始 JSON');
 const original=IDBObjectStore.prototype.add;
 const fault=t.mock.method(IDBObjectStore.prototype,'add',function(...args){
  const request=original.apply(this,args);
  request.addEventListener('success',()=>this.transaction.abort(),{once:true});
  return request;
 });
 await assert.rejects(s.migrateLegacy(p),unavailable);assert.equal(old.get(key),'原始 JSON');
 assert.equal(await storage().getFresh(key),null);fault.mock.restore();
 await s.migrateLegacy(p);assert.equal(old.size,0);assert.equal(await storage().getFresh(key),'原始 JSON');
});

test('普通编辑乐观可见，配额失败通知与 flush 拦截可通过同键重试解除',async t=>{
 const {controller,events,draftStorage:s,key,storage}=fixture(),ctrl=controller();await ctrl.open('c');
 const put=t.mock.method(IDBObjectStore.prototype,'put',quota);
 const edit={...doc,name:'修改'};ctrl.edit(edit);
 assert(s.hasPendingWrites());assert.equal(JSON.parse(s.getCached(key)).document.name,'修改');
 await assert.rejects(ctrl.flush(),{...unavailable,details:{quota:true}});assert.equal(events[0][0],'c');
 assert.equal(events[0][1].code,'DRAFT_STORAGE_UNAVAILABLE');assert.equal(await storage().getFresh(key),null);
 // 弱写失败后再点保存也不能发出请求或丢失首次落盘的比较基线。
 await assert.rejects(ctrl.save(),unavailable);assert.equal(ctrl.read().pending,null);
 put.mock.restore();ctrl.edit(edit);await ctrl.flush();assert.deepEqual(events.at(-1),['c',null]);
 assert.deepEqual((await controller(storage()).open('c')).record.document,edit);
});

test('清理缓存可检查并放弃未落盘草稿，关闭前仍严格报告写盘失败',async t=>{
 const {controller,draftStorage,key,storage,events}=fixture(),ctrl=controller();
 await ctrl.open('c');
 t.mock.method(IDBObjectStore.prototype,'put',quota);
 ctrl.edit({...doc,name:'未落盘的草稿'});
 assert(draftStorage.hasPendingWrites());
 await draftStorage.settle();
 assert.equal(draftStorage.hasPendingWrites(),false);
 assert.equal(events.length,1);assert.equal(events[0][0],'c');assert.equal(events[0][1].code,unavailable.code);
 assert.deepEqual(ctrl.drafts().map(row=>row.id),['c']);
 await assert.rejects(draftStorage.flush(),unavailable);
 // 从另一个连接确认磁盘上没有该键，再走用户明确放弃草稿的入口。
 assert.equal(await storage().getFresh(key),null);
 await ctrl.discardLocalDrafts(['c']);
 assert.deepEqual(events[1],['c',null]);assert.equal(draftStorage.hasFailure(key),false);
 assert.deepEqual(ctrl.drafts(),[]);await draftStorage.flush();
});

test('pending 提交后才发请求，确认回执后删除失败仍可重开查回执',async t=>{
 const {client,controller,storage,key}=fixture(),ctrl=controller();await ctrl.open('c');ctrl.edit({...doc,name:'草稿'});await ctrl.flush();
 let sends=0,confirmed;
 client.save=async(action,id,body)=>{
  sends++;assert.deepEqual(JSON.parse(await storage().getFresh(key)).pending,{action,body});
  confirmed={configuration_id:id,shop_id:'intel',operation_id:body.operation_id,version:'2',archived:false};return confirmed;
 };
 const put=t.mock.method(IDBObjectStore.prototype,'put',quota);
 await assert.rejects(ctrl.save(),unavailable);assert.equal(sends,0);assert.equal(ctrl.read().pending,null);put.mock.restore();
 const del=t.mock.method(IDBObjectStore.prototype,'delete',quota);
 await assert.rejects(ctrl.save(),unavailable);assert.equal(sends,1);assert.equal(ctrl.read().pending.body.operation_id,confirmed.operation_id);
 del.mock.restore();client.receipt=async id=>{assert.equal(id,confirmed.operation_id);return confirmed;};
 const reopened=controller();assert.deepEqual((await reopened.resume('c')).pending,ctrl.read().pending);
 assert.deepEqual(await reopened.receipt(),confirmed);await reopened.flush();
 assert.equal(await storage().getFresh(key),null);assert.equal(sends,1);
});

test('服务端明确拒绝后，清除 pending 的事务失败仍保留原操作编号',async t=>{
 const {controller,client,storage,key}=fixture(),ctrl=controller();await ctrl.open('c');
 ctrl.edit({...doc,name:'被拒绝的草稿'});await ctrl.flush();
 client.save=async()=>{
  t.mock.method(IDBObjectStore.prototype,'put',quota);
  throw Object.assign(Error('拒绝'),{code:'VALIDATION_FAILED',status:400});
 };
 await assert.rejects(ctrl.save(),unavailable);
 assert(ctrl.read().pending.body.operation_id);
 assert.deepEqual(JSON.parse(await storage().getFresh(key)).pending,ctrl.read().pending);
});

test('编号和来源版本的 CAS 不能覆盖另一窗口的新编辑或未知提交',async()=>{
 const {controller,storage,client,key}=fixture(),a=controller(),b=controller(storage());
 await a.open('c');a.edit({...doc,price:15});await a.flush();await b.open('c');
 b.edit({...doc,name:'另一窗口'});await b.flush();const newer=await storage().getFresh(key);
 const row={configuration_id:'c',before:doc.name,name:'配置1',version:'2',previous_version:'1'};
 await assert.rejects(a.acceptRenumber(row),{code:'UNSAVED_DRAFT'});assert.equal(await storage().getFresh(key),newer);
 client.save=async()=>{throw Error('中断');};await assert.rejects(b.save(),/中断/);
 const unknown=await storage().getFresh(key);assert(JSON.parse(unknown).pending);
 await assert.rejects(a.acceptSourceVersions({s:'3'}),{code:'UNSAVED_DRAFT'});
 assert.equal(await storage().getFresh(key),unknown);assert.equal(a.read().dependencies.sources.s,'1');
});

test('批量放弃整批核对未知提交，归档清理核对草稿版本',async()=>{
 const {controller,draftStorage:s,key,storage}=fixture(),ctrl=controller();
 await ctrl.open('c');ctrl.edit({...doc,name:'草稿'});await ctrl.flush();
 const pending=ctrl.read();pending.id='d';pending.document.id='d';pending.pending={action:'replace'};
 const other=prefix('intel')+'"d"';await s.setNow(other,JSON.stringify(pending));
 await assert.rejects(ctrl.discardLocalDrafts(['c','d']),{code:'SAVE_STATUS_UNKNOWN'});
 assert(await storage().getFresh(key));assert.equal(await ctrl.discardArchived('d','2'),false);
 assert.equal(await ctrl.discardArchived('c','1'),false);assert.equal(await ctrl.discardArchived('c','2'),true);
 assert(await storage().getFresh(other));
});

test('跨店 Agent 同时看到目标店磁盘与未迁移旧草稿，当前店镜像保持隔离',async()=>{
 const f=fixture(),s=f.draftStorage;
 const workspace=createNasMainWorkspace({createClient:()=>f.client,storage:f.legacyStorage,draftStorage:s,planStorage:new Map(),
  nativeRequest:async()=>Response.json({configured:true,main_editor:true,endpoint_id:'test'})});
 const text=(shopId,id)=>JSON.stringify({format:1,id,version:'1',document:{...doc,shopId,id}});
 await s.setNow(f.key,text('intel','c'));await workspace.initialize();
 const p=prefix('gigabyte');await f.storage().setNow(p+'"disk"',text('gigabyte','disk'));f.old.set(p+'"old"',text('gigabyte','old'));
 const agent=await workspace.agentAccess('gigabyte');
 for(const id of ['disk','old'])await assert.rejects(agent.assertDrafts([id]),{code:'UNSAVED_DRAFT'});
 await agent.assertDrafts(['c']);assert.deepEqual(workspace.drafts().map(x=>x.id),['c']);
 assert.equal(s.getCached(p+'"disk"'),null);assert.equal(s.listCached(p).size,0);assert.equal(f.old.size,1);
});
