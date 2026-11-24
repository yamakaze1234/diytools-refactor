import assert from 'node:assert/strict';
import test from 'node:test';
import {createNasAutosave,NAS_AUTOSAVE_INTERVAL as interval} from '../../public/workbench/nas-autosave.js';

const memoryStorage=()=>{
 const values=new Map();
 return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
};
const fakeClock=()=>{
 let time=0,seq=0;
 const tasks=new Map();
 return {now:()=>time,advance:ms=>{time+=ms;},setTimer:(fn,delay)=>{const id=++seq;tasks.set(id,{fn,due:time+delay});return id;},
  clearTimer:id=>tasks.delete(id),count:()=>tasks.size,next:()=>[...tasks.values()][0],
  async fire(){for(const [id,task] of [...tasks])if(task.due<=time){tasks.delete(id);task.fn();}await Promise.resolve();}};
};
const draft=(id,extra={})=>({id,name:id,version:'1',pending:false,...extra});
function setup(options={}){
 const clock=options.clock??fakeClock(),calls=[];
 const scheduler=createNasAutosave({storage:memoryStorage(),scope:'["formal",["shop","operator"]]',now:clock.now,
  setTimer:clock.setTimer,clearTimer:clock.clearTimer,canRun:()=>true,drafts:()=>[draft('a')],
  submit:async rows=>{calls.push(rows.map(row=>row.id));},...options});
 return {scheduler,clock,calls};
}

test('默认开启两小时，关闭立即撤销排程且设置只影响同一服务和账号',async()=>{
 const storage=memoryStorage(),scope='["formal","alice"]';
 const {scheduler,clock,calls}=setup({storage,scope});
 assert.equal(scheduler.enabled(),true);
 assert.equal(clock.count(),1);
 clock.advance(interval-1);await clock.fire();assert.deepEqual(calls,[]);
 scheduler.setEnabled(false);assert.equal(clock.count(),0);
 clock.advance(1);await scheduler.checkDue();assert.deepEqual(calls,[]);
 scheduler.dispose();
 const same=setup({storage,scope});assert.equal(same.scheduler.enabled(),false);assert.equal(same.clock.count(),0);
 const otherAccount=setup({storage,scope:'["formal","bob"]'});assert.equal(otherAccount.scheduler.enabled(),true);
 const otherEndpoint=setup({storage,scope:'["trial","alice"]'});assert.equal(otherEndpoint.scheduler.enabled(),true);
 same.scheduler.setEnabled(true);same.clock.advance(interval);await same.clock.fire();
 assert.deepEqual(same.calls,[['a']]);
 assert.equal(same.clock.count(),1);
 same.scheduler.dispose();assert.equal(same.clock.count(),0);
});

test('休眠后只处理一轮；检查唤醒与原定时器重合时不重复提交',async()=>{
 let finish;
 const calls=[];
 const {scheduler,clock}=setup({submit:rows=>{calls.push(rows);return new Promise(resolve=>{finish=resolve;});}});
 clock.advance(interval*4+7);
 const first=scheduler.checkDue();await scheduler.checkDue();await clock.fire();
 assert.deepEqual(calls.map(rows=>rows.map(row=>row.id)),[['a']]);assert.equal(clock.count(),0);
 finish([]);assert.equal(await first,true);
 assert.equal(clock.count(),1);assert.equal(clock.next().due,clock.now()+interval);
 assert.equal(await scheduler.checkDue(),false);
});

test('忙碌或未就绪不读草稿，无修改不提交，未知回执阻止整轮新写',async()=>{
 const blocked=[];
 let ready=false,rows=[],reads=0;
 const {scheduler,clock,calls}=setup({canRun:()=>ready,drafts:()=>{reads++;return rows;},onBlocked:reason=>blocked.push(reason)});
 clock.advance(interval);await scheduler.checkDue();assert.equal(reads,0);
 ready=true;clock.advance(interval);await scheduler.checkDue();assert.equal(reads,1);assert.deepEqual(calls,[]);
 rows=[draft('new'),draft('old',{pending:true})];clock.advance(interval);await scheduler.checkDue();
 assert.deepEqual(calls,[]);assert.deepEqual(blocked,['pending']);
 rows=[draft('new')];clock.advance(interval-1);await scheduler.checkDue();assert.deepEqual(calls,[]);
 clock.advance(1);await scheduler.checkDue();assert.deepEqual(calls,[['new']]);
});

test('确定的冲突按配置与原版本记住，重开也不反复保存，另一套可继续',async()=>{
 const scope='["formal","alice"]',storage=memoryStorage(),calls=[];
 let rows=[draft('stale'),draft('known')];
 const first=setup({storage,scope,drafts:()=>rows,isConflict:row=>row.id==='known',submit:async values=>{
  calls.push(values.map(row=>row.id));return [{id:'stale',status:'failed',error:{code:'VERSION_CONFLICT'}}];
 }});
 first.clock.advance(interval);await first.scheduler.checkDue();first.scheduler.dispose();
 assert.deepEqual(calls,[['stale']]);
 rows=[draft('stale'),draft('another')];
 const reopened=setup({storage,scope,drafts:()=>rows});
 reopened.clock.advance(interval);await reopened.scheduler.checkDue();assert.deepEqual(reopened.calls,[['another']]);
 rows=[draft('stale',{version:'2'})];reopened.clock.advance(interval);await reopened.scheduler.checkDue();
 assert.deepEqual(reopened.calls,[['another'],['stale']]);
});

test('保存进行中暂停或卸载不会再安排下一次保存',async()=>{
 let finish;
 const {scheduler,clock}=setup({submit:()=>new Promise(resolve=>{finish=resolve;})});
 clock.advance(interval);const running=scheduler.checkDue();
 assert.equal(scheduler.setEnabled(false),false);
 assert.equal(clock.count(),0);
 scheduler.dispose();finish([]);await running;
 clock.advance(interval);assert.equal(await scheduler.checkDue(),false);
 assert.equal(clock.count(),0);
});

// 定时器使用实际草稿保存器，验证依赖重试成功不会进入冲突跳过名单。
test('自动保存自动刷新成本依赖成功，下轮仍可继续保存同一套配置',async()=>{
 const {createNasDraftController}=await import('../../public/workbench/nas-draft-controller.js');
 const {submitNasDraftSet}=await import('../../public/workbench/nas-main-workspace.js');
 const storage=memoryStorage(),values=new Map(),draftStorage={get length(){return values.size;},key:i=>[...values.keys()][i],getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 let version='1',cost='1',writes=0,document={id:'c',shopId:'intel',name:'配置',parts:[{lineId:'p',goodsId:'1'}],actualParts:[],addons:[]};
 const dependencies=()=>({sources:{},costs:{'1':cost}});
 const client={me:async()=>({uid:'A',workspace_id:'w',data_source:'intel_live',configuration_writes:true,shops:[{shop_id:'intel',role:'operations'}]}),
  detail:async()=>({version,document,dependencies:dependencies()}),resource:async()=>({version:cost}),
  async save(action,id,body){writes++;if(body.dependencies.costs['1']!==cost)throw Object.assign(Error('依赖已更新'),{code:'DEPENDENCY_CONFLICT',status:409});
   document=body.document;version=String(Number(version)+1);return {operation_id:body.operation_id,configuration_id:id,shop_id:'intel',version,archived:false};}};
 const controller=createNasDraftController({client,storage:draftStorage,endpointId:'autosave'});
 await controller.open('c');controller.edit({...document,name:'第一轮文案'});cost='2';
 const {scheduler,clock}=setup({storage,drafts:()=>controller.drafts(),submit:rows=>submitNasDraftSet(rows,{isPending:()=>!!controller.read().pending,submit:()=>controller.save()})});
 clock.advance(interval);assert.equal(await scheduler.checkDue(),true);assert.equal(document.name,'第一轮文案');assert.equal(writes,2);
 controller.edit({...document,name:'第二轮文案'});clock.advance(interval);assert.equal(await scheduler.checkDue(),true);
 assert.equal(document.name,'第二轮文案');assert.equal(writes,3);assert.equal(storage.getItem('diy-nas-autosave:["formal",["shop","operator"]]:conflicts'),null);
 scheduler.dispose();
});
