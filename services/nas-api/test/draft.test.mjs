// 提交结果未知、账号切换和本机检查点失败不能重放或丢失原请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasDraftController} from '../../../apps/desktop/public/workbench/nas-draft-controller.js';
import {createNasApiClient,NasApiError} from '../../../apps/desktop/public/workbench/nas-api-client.js';
const doc={id:'c',shopId:'intel',name:'原配置',parts:[],actualParts:[],addons:[]};
const baseline={version:'1',dependencies:{sources:{},costs:{}},document:doc};
const member=uid=>({data_source:'intel_live',workspace_id:'w',uid,configuration_writes:true,shops:[{shop_id:'intel',role:'operations'}]});
const receipt=(body,more={})=>({configuration_id:'c',shop_id:'intel',operation_id:body.operation_id,version:'2',archived:false,...more});
function fixture(){
 let uid='A',save,applied,remove=(key)=>map.delete(key);
 const map=new Map(),calls=[];
 const storage={get length(){return map.size;},key:i=>Array.from(map.keys())[i],getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>remove(k)};
 const client={async me(){return member(uid);},async detail(){return baseline;},async save(action,id,body){calls.push({action,id,body});applied=body;return await save(body);},async receipt(id){assert.equal(id,applied.operation_id);return receipt(applied);}};
 const create=(endpointId='endpoint-a')=>createNasDraftController({client,storage,endpointId,uuid:()=> '7a1378ef-f3de-4017-8d70-a48bdeb868f2'});
 return {client,map,calls,create,setUser:v=>{uid=v;},setSave:fn=>{save=fn;},setRemove:fn=>{remove=fn;}};
}
test('断线不重试；重开查询原回执，隔离不同成员和不同服务器草稿',async()=>{
 const f=fixture(),a=f.create();await a.open('c');assert.equal(f.map.size,0);
 a.edit({...doc,name:'本机修改'});
 f.setSave(()=>{throw new NasApiError('SAVE_STATUS_UNKNOWN');});
 await assert.rejects(a.save(),{code:'SAVE_STATUS_UNKNOWN'});assert.equal(f.calls.length,1);
 const original=a.read().pending.body.operation_id;
 f.setUser('B');await assert.rejects(a.receipt(),{code:'MEMBER_CHANGED'});
 const b=f.create();await b.verify();assert.deepEqual(b.drafts(),[]);
 f.setUser('A');
 const alternate=f.create('endpoint-b');await alternate.verify();assert.deepEqual(alternate.drafts(),[]);
 const reopened=f.create();await reopened.open('c');assert.equal(reopened.read().pending.body.operation_id,original);
 await reopened.receipt();assert.equal(reopened.read().version,'2');assert.equal(f.map.size,0);assert.equal(f.calls.length,1);
});
test('回执写入本地失败保留待查编号，成功恢复后再清',async()=>{
 const f=fixture(),a=f.create();await a.open('c');a.edit({...doc,name:'待提交'});
 f.setSave(body=>receipt(body));
 f.setRemove(()=>{throw Error('磁盘问题');});
 await assert.rejects(a.save(),{code:'DRAFT_STORAGE_UNAVAILABLE'});
 assert.equal(a.read().pending.body.operation_id,f.calls[0].body.operation_id);
 f.setRemove(key=>f.map.delete(key));
 await a.receipt();assert.equal(a.read().version,'2');assert.equal(a.read().pending,null);
});
test('错误格式返回不清原编号，归档不掩盖本地草稿',async()=>{
 const f=fixture(),a=f.create();await a.open('c');a.edit({...doc,name:'待提交'});
 await assert.rejects(a.save('archive'),{code:'UNSAVED_DRAFT'});assert.equal(f.calls.length,0);
 f.setSave(body=>receipt(body,{shop_id:'other',version:'bad'}));
 await assert.rejects(a.save(),{code:'SAVE_STATUS_UNKNOWN'});assert(a.read().pending);
});
test('原生提交携带每个客户端各自的预期成员，失败不自动写第二次',async()=>{
 const sent=[];
 const request=async(path,opts)=>{sent.push({path,opts});return new Response(JSON.stringify({ok:false,error:'SERVICE_UNAVAILABLE'}),{status:503});};
 const a=createNasApiClient({nativeRequest:request}),b=createNasApiClient({nativeRequest:request});
 a.bindIdentity('w','A');b.bindIdentity('w','B');
 await assert.rejects(a.save('replace','c',{}),{code:'SAVE_STATUS_UNKNOWN'});
 assert.equal(sent.length,1);
 assert.deepEqual(JSON.parse(decodeURIComponent(sent[0].opts.headers['x-workbench-nas-owner'])),['w','A']);
 assert(!Object.hasOwn(sent[0].opts.headers,'authorization'));
});

test('确认的自动编号保留价格草稿和手工名称，不接续过期版本或未知提交',async()=>{
 const f=fixture(),a=f.create();await a.open('c');a.edit({...doc,price:123});
 const row={configuration_id:'c',before:doc.name,name:'配置1',previous_version:'1',version:'2'};
 assert.equal(a.acceptRenumber(row),true);
 assert.equal(a.read().document.price,123);assert.equal(a.read().document.name,'配置1');assert.equal(a.read().version,'2');
 assert.equal(a.acceptRenumber(row),false);
 a.edit({...a.read().document,name:'手工套餐'});
 assert.equal(a.acceptRenumber({...row,before:'配置1',name:'配置2',previous_version:'2',version:'3'}),true);
 assert.equal(a.read().base.name,'配置2');assert.equal(a.read().document.name,'手工套餐');
 f.setSave(()=>{throw new NasApiError('SAVE_STATUS_UNKNOWN');});await assert.rejects(a.save(),{code:'SAVE_STATUS_UNKNOWN'});
 const pending=a.read();assert.equal(a.acceptRenumber({...row,before:'配置2',previous_version:'3',version:'4'}),false);assert.deepEqual(a.read(),pending);
});
test('完整来源同步只接续明确确认的依赖，保留价格草稿和其它来源/成本版本',async()=>{
 const f=fixture();f.client.detail=async()=>({...baseline,dependencies:{sources:{s:'1',other:'4'},costs:{a:'7'}}});
 const a=f.create();await a.open('c');a.edit({...doc,price:123});
 assert.equal(a.acceptSourceVersions({s:'2'}),true);
 assert.deepEqual(a.read().dependencies,{sources:{s:'2',other:'4'},costs:{a:'7'}});assert.equal(a.read().document.price,123);assert.equal(a.read().version,'1');
 f.setSave(()=>{throw new NasApiError('SAVE_STATUS_UNKNOWN');});await assert.rejects(a.save(),{code:'SAVE_STATUS_UNKNOWN'});
 const pending=a.read();assert.equal(a.acceptSourceVersions({s:'3'}),false);assert.deepEqual(a.read(),pending);
});

test('来源自保存后接续已读依赖只用于干净配置，不吞掉草稿或未知提交',async()=>{
 const f=fixture();f.client.detail=async()=>({...baseline,dependencies:{sources:{s:'1',other:'4'},costs:{a:'7',untouched:'8'}}});
 const a=f.create();await a.open('c');
 assert.equal(a.acceptObservedDependencies({sources:{s:'2',unrelated:'9'},costs:{a:'9'}}),true);
 assert.deepEqual(a.read().dependencies,{sources:{s:'2',other:'4'},costs:{a:'9',untouched:'8'}});assert.equal(f.map.size,0);assert.equal(a.read().version,'1');
 // 同配置的另一个窗口持有草稿时，当前干净窗口接续来源不得删除共享存储键。
 const other=f.create();await other.open('c');other.edit({...doc,price:200});
 const stored=[...f.map.entries()];assert.equal(stored.length,1);
 assert.equal(a.acceptObservedDependencies({sources:{s:'3'}}),true);assert.deepEqual([...f.map.entries()],stored);
 a.edit({...doc,name:'用户草稿'});const dirty=a.read();assert.equal(a.acceptObservedDependencies({sources:{s:'3'},costs:{a:'10'}}),false);assert.deepEqual(a.read(),dirty);
 f.setSave(()=>{throw new NasApiError('SAVE_STATUS_UNKNOWN');});await assert.rejects(a.save(),{code:'SAVE_STATUS_UNKNOWN'});
 const pending=a.read();assert.equal(a.acceptObservedDependencies({sources:{s:'3'},costs:{a:'10'}}),false);assert.deepEqual(a.read(),pending);
});

test('编号与显式来源版本接续不清除另一窗口的草稿或未知请求',async()=>{
 const f=fixture();f.client.detail=async()=>({...baseline,dependencies:{sources:{s:'1'},costs:{}}});
 const a=f.create(),b=f.create();await a.open('c');await b.open('c');b.edit({...doc,price:200});
 const before=[...f.map.entries()];assert.equal(before.length,1);
 assert.equal(a.acceptRenumber({configuration_id:'c',before:doc.name,name:'配置1',previous_version:'1',version:'2'}),true);
 assert.deepEqual([...f.map.entries()],before);assert.equal(a.read().version,'2');
 assert.equal(a.acceptSourceVersions({s:'2'}),true);assert.deepEqual([...f.map.entries()],before);
 f.setSave(()=>{throw new NasApiError('SAVE_STATUS_UNKNOWN');});await assert.rejects(b.save(),{code:'SAVE_STATUS_UNKNOWN'});
 const unknown=[...f.map.entries()];assert.equal(a.acceptSourceVersions({s:'3'}),true);assert.deepEqual([...f.map.entries()],unknown);
});
