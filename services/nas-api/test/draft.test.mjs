// 提交结果未知、账号切换和本机检查点失败不能重放或丢失原请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasDraftController,nasDependencies} from '../../../apps/desktop/public/workbench/nas-draft-controller.js';
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
 let sequence=0;
 const create=(endpointId='endpoint-a')=>createNasDraftController({client,storage,endpointId,uuid:()=> `7a1378ef-f3de-4017-8d70-${String(++sequence).padStart(12,'0')}`});
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
test('明确放弃缓存清理草稿仅清当前成员，任一未知回执整批阻断',async()=>{
 const f=fixture(),a=f.create();await a.open('c');a.edit({...doc,name:'A草稿'});
 f.setUser('B');const b=f.create();await b.open('c');b.edit({...doc,name:'B草稿'});
 b.discardLocalDrafts(['c']);assert.equal(f.map.size,1);
 f.setUser('A');f.setSave(()=>{throw new NasApiError('SAVE_STATUS_UNKNOWN');});await assert.rejects(a.save(),{code:'SAVE_STATUS_UNKNOWN'});
 const before=[...f.map.entries()];assert.throws(()=>a.discardLocalDrafts(['c']),{code:'SAVE_STATUS_UNKNOWN'});assert.deepEqual([...f.map.entries()],before);
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

// 依赖冲突只刷新明确被拒绝的新请求；同配置并发修改与未知回执继续拦截。
for(const kind of ['sources','costs'])test(`仅 ${kind} 更新时自动保存，正文与原配置版本保持不变`,async()=>{
 const f=fixture(),document={...doc,parts:[{lineId:'p',sourceId:'s',goodsId:'1'}]};
 let dependencies={sources:{s:'1'},costs:{'1':'1'}};
 f.client.detail=async()=>({...baseline,document,dependencies});
 f.client.resource=async(type,id)=>({version:dependencies[type][id]});
 const a=f.create();await a.open('c');a.edit({...document,name:'我的文案'});
 const before=a.read();dependencies={sources:{s:'1'},costs:{'1':'1'},[kind]:{[kind==='sources'?'s':'1']:'2'}};
 f.setSave(body=>{if(f.calls.length===1)throw new NasApiError('DEPENDENCY_CONFLICT',409);assert.deepEqual(body.dependencies,dependencies);return receipt(body);});
 const result=await a.save();assert.equal(result.dependenciesRefreshed,true);assert.equal(f.calls.length,2);
 assert.notEqual(f.calls[0].body.operation_id,f.calls[1].body.operation_id);
 assert.equal(f.calls[1].body.expected_version,before.version);assert.deepEqual(f.calls[1].body.document,before.document);
 assert.deepEqual(a.read().dependencies,dependencies);assert.equal(a.read().pending,null);assert.equal(f.map.size,0);
});

test('升级前旧草稿沿用已归档来源的权威依赖，同时补齐新配件和跟随加购成本',async()=>{
 const f=fixture(),document={...doc,parts:[{lineId:'old',sourceId:'archived',goodsId:'1'}]};
 let dependencies={sources:{archived:'1'},costs:{'1':'1'}};
 f.client.detail=async()=>({...baseline,document,dependencies});
 const a=f.create();await a.open('c');a.edit({...document,parts:[...document.parts,{lineId:'new',sourceId:'new',goodsId:'2'}],
  addons:[{sourceId:'follow',followPolicy:'follow',followAll:true,text:'',items:[]}]});
 dependencies={sources:{archived:'3'},costs:{'1':'4'}};
 const requested=[];
 f.client.resource=async(type,id)=>{requested.push([type,id]);if(id==='archived')throw new NasApiError('NOT_FOUND',404);
  return {version:'8',document:type==='sources'?{sourceId:id,addonText:'新加购',addonGoodsId:'3'}:{goodsId:id}};};
 const reopened=f.create();await reopened.open('c');
 f.setSave(body=>{if(f.calls.length===1)throw new NasApiError('DEPENDENCY_CONFLICT',409);return receipt(body);});
 await reopened.save();assert.deepEqual(reopened.read().dependencies,{sources:{archived:'3',new:'8',follow:'8'},costs:{'1':'4','2':'8','3':'8'}});
 assert(!requested.some(([,id])=>id==='archived'));assert.equal(f.map.size,0);
});

test('跟随来源的单项、整组和嵌套商品成本都展开，跨配置复用请求且安全忽略来源与成本 404',async()=>{
 const calls=[],memo=new Map();
 const client={async resource(type,id){calls.push([type,id]);if(['archived','missing'].includes(id))throw new NasApiError('NOT_FOUND',404);
  return {version:'7',document:{sourceId:id,addonText:'整组',addonChoices:[{id:'choice',goodsId:'2',label:'升级',enabled:true}],
   addonVariants:[{variantId:'v',text:'单项',items:[{goodsId:'3',qty:1}],variants:[{goodsId:'4'}]}]}};}};
 const document={...doc,addons:[{sourceId:'group',followPolicy:'follow',followAll:true,items:[]},
  {sourceId:'single',variantId:'v',followPolicy:'follow',items:[]},{sourceId:'archived',followPolicy:'follow',items:[]},
  {text:'快照',items:[{goodsId:'missing',qty:1}]}]};
 // 单项使用无 choices 的来源，整组使用 choices 来源。
 const resource=client.resource;client.resource=async(type,id)=>{const row=await resource(type,id);if(id==='single')delete row.document.addonChoices;return row;};
 const expected={sources:{group:'7',single:'7',archived:'5'},costs:{'2':'7','3':'7','4':'7'}};
 assert.deepEqual(await nasDependencies(client,document,{sources:{archived:'5'},costs:{}},memo),expected);
 assert.deepEqual(await nasDependencies(client,document,{sources:{archived:'5'},costs:{}},memo),expected);
 assert.equal(calls.filter(([type,id])=>type==='sources'&&id==='group').length,1);
 assert.equal(calls.filter(([,id])=>id==='archived').length,1);
});

test('依赖冲突后发现同配置版本已变，转为版本冲突并保留原草稿和依赖',async()=>{
 const f=fixture(),a=f.create();await a.open('c');a.edit({...doc,name:'我的草稿'});const before=a.read();
 f.client.detail=async()=>({...baseline,version:'2',dependencies:{sources:{},costs:{'1':'2'}},document:{...doc,name:'同事已保存'}});
 f.setSave(()=>{throw new NasApiError('DEPENDENCY_CONFLICT',409);});
 await assert.rejects(a.save(),{code:'VERSION_CONFLICT',details:{current_version:'2'}});
 assert.equal(f.calls.length,1);assert.deepEqual(a.read(),before);assert.equal(f.map.size,1);
});

test('新选归档来源的无效依赖、普通校验错误和非 409 依赖错误不自动重试',async()=>{
 for(const [code,status] of [['INVALID_DEPENDENCY',400],['VALIDATION_FAILED',400],['QUOTATION_REVIEW_REQUIRED',409],['SKU_ALREADY_USED',409],['DEPENDENCY_CONFLICT',400]]){
  const f=fixture(),a=f.create();await a.open('c');a.edit({...doc,name:'保留草稿'});let reads=0;
  f.client.detail=async()=>{reads++;return baseline;};f.setSave(()=>{throw new NasApiError(code,status);});
  await assert.rejects(a.save(),{code});assert.equal(f.calls.length,1);assert.equal(reads,0);assert.equal(a.read().document.name,'保留草稿');assert.equal(a.read().pending,null);
 }
});

test('新建配置从空依赖刷新，持续冲突最多自动重试两次',async()=>{
 const f=fixture(),a=f.create();await a.create({...doc,parts:[{lineId:'p',sourceId:'s',goodsId:'1'}]});
 let revision=0;f.client.resource=async()=>({version:String(++revision)});
 f.client.detail=async()=>{throw Error('新建不能读取旧配置');};
 f.setSave(()=>{throw new NasApiError('DEPENDENCY_CONFLICT',409);});
 await assert.rejects(a.save(),{code:'DEPENDENCY_CONFLICT'});assert.equal(f.calls.length,3);
 assert.equal(new Set(f.calls.map(call=>call.body.operation_id)).size,3);
 assert.deepEqual(f.calls.map(call=>call.body.dependencies.sources.s),['1','3','5']);
 assert.equal(a.read().pending,null);assert.equal(a.read().version,null);assert.equal(f.map.size,1);
});

test('已有未知回执重放被依赖冲突拒绝时，不刷新依赖、不换编号、不改原提交正文',async()=>{
 const f=fixture(),a=f.create();await a.open('c');a.edit({...doc,name:'原提交'});
 f.setSave(()=>{throw new NasApiError('SAVE_STATUS_UNKNOWN');});await assert.rejects(a.save(),{code:'SAVE_STATUS_UNKNOWN'});
 const pending=structuredClone(a.read().pending);f.client.receipt=async()=>{throw new NasApiError('NOT_FOUND',404);};
 f.client.detail=async()=>{throw Error('禁止为原提交读取新基线');};
 f.setSave(()=>{throw new NasApiError('DEPENDENCY_CONFLICT',409);});
 await assert.rejects(a.retry(),{code:'DEPENDENCY_CONFLICT'});
 assert.deepEqual(f.calls[1].body,pending.body);assert.equal(f.calls.length,2);
});
