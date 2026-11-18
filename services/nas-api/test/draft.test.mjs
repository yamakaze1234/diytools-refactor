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
