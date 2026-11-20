// 原编辑器与已迁移文档之间的投影，覆盖未知字段、资料覆盖、并发飞行输入和回执。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasMainWorkspace,projectNasEdits,submitNasDraftSet} from '../../../apps/desktop/public/workbench/nas-main-workspace.js';
import {NasApiError} from '../../../apps/desktop/public/workbench/nas-api-client.js';
import {applyStructuredUpgrade,upgradeAddonDefinition} from '../../../apps/desktop/public/workbench/upgrade-addon-sync.js';
import {withCurrentSharedSource} from '../../../apps/desktop/public/workbench/shared-source-fields.js';
import {effectiveNasAddons,detachAddonFollow} from '../../../apps/desktop/public/workbench/addon-data.js';
import {addPosterExtra} from '../../../apps/desktop/public/workbench/config-extras.js';
import {applyBatchContent,syncPosterAddonText} from '../../../apps/desktop/public/workbench/batch-content.js';

test('来源暂时清空方案后编辑独立文案，保存仍保留组跟随并与销售读取一致',()=>{
 const source={sourceId:'s',sharedSourceId:'1',goodsId:'1',addonText:'原方案',addonGoodsId:'2',addonPriceCents:10000};
 const doc={id:'empty-follow',shopId:'intel',parts:[{slot:'CPU',sourceId:'s',goodsId:'1'}],actualParts:[],addons:[]};
 const raw=applyStructuredUpgrade(doc,doc.parts[0],upgradeAddonDefinition(source),{sources:[source],follow:true}),visible=structuredClone(raw);
 withCurrentSharedSource(visible,new Map([['s',{...source,addonChoices:[]}]]));assert.deepEqual(visible.addons,[]);
 const edited=structuredClone(visible);addPosterExtra(edited,'addons');edited.addons[0].text='独立文字';
 const saved=projectNasEdits(raw,visible,edited);assert.equal(saved.addons.filter(a=>a.followAll).length,1);
 const future=new Map([['s',{...source,addonText:'新方案',addonGoodsId:'3',addonPriceCents:20000}]]),server=effectiveNasAddons(saved.addons,future),ui=structuredClone(saved);
 withCurrentSharedSource(ui,future);assert.deepEqual(server.filter(a=>a.available).map(a=>a.addon),ui.addons);assert.equal(ui.addons.at(-1).goodsId,'3');
 const detached=structuredClone(edited);detachAddonFollow(detached,'s');assert.equal(projectNasEdits(raw,visible,detached).addons.some(a=>a.followAll),false);
});

const raw={id:'c',shopId:'intel',name:'原配置',parts:[{lineId:'a',name:'人工配件',oldNull:null},{lineId:'b',name:'第二行',precision:0}],
 actualParts:[],addons:[],privateLegacy:{missing:null,numericZero:0},caseImage:'/uploads/'+'a'.repeat(64)+'.png'};
test('编辑投影不覆盖只用于界面的兼容字段，重排行按行号保留未知内容',()=>{
 const ui=structuredClone(raw);
 delete ui.parts[0].oldNull;ui.parts[0].name='界面默认';ui.generated={layout:'default'};
 const edited=structuredClone(ui);
 edited.name='已编辑配置';edited.parts.reverse();edited.parts[0].name='用户改第二行';
 assert.deepEqual(projectNasEdits(raw,ui,edited),{
  ...raw,name:'已编辑配置',parts:[{lineId:'b',name:'用户改第二行',precision:0},{lineId:'a',name:'人工配件',oldNull:null}]
 });
});
function fixture(){
 const copy=structuredClone,db=new Map(),commands=[];
 let user='owner',remote=copy(raw),version='1',put,receipt;
 let importedAt=null,activity=[],activityError=false;
 const storage={get length(){return db.size;},key:i=>[...db.keys()][i],getItem:key=>db.get(key),setItem:(key,item)=>db.set(key,item),removeItem:key=>db.delete(key)};
 function reply(code,value){return new Response(JSON.stringify(value),{status:code});}
 const handle=async(path,opts)=>{
  const route=new URL(path,'https://fixture.invalid').pathname;
  commands.push({path:route,method:opts.method,owner:opts.headers?.['x-workbench-nas-owner']});
  if(route==='/settings')return reply(200,{configured:true,main_editor:true,endpoint_id:'nas-a'});
  if(route==='/api/v1/me')return reply(200,{ok:true,uid:user,workspace_id:'w',data_source:'intel_live',shops:[{shop_id:'intel',role:'operations'}],configuration_writes:true});
  if(route.endsWith('/workspace-index'))return reply(200,{ok:true,data:{revision:version,updatedAt:importedAt,summaries:[{...remote,nasVersion:version,parts:[]}]}});
  if(route.endsWith('/workspace-catalog'))return reply(200,{ok:true,data:{shopSettings:{intel:{}},sourceCatalog:[],costSource:[]}});
  if(!opts.headers?.['x-workbench-nas-owner']||JSON.parse(decodeURIComponent(opts.headers['x-workbench-nas-owner']))[1]!==user)
   return reply(403,{ok:false,error:'MEMBER_CHANGED'});
  if(route.endsWith('/workspace/activity'))return activityError?reply(503,{ok:false,error:'SERVICE_UNAVAILABLE'}):reply(200,{ok:true,data:activity});
  if(route.includes('/save-receipts/'))return reply(200,{ok:true,data:receipt});
  if(route.endsWith('/configurations/c')&&opts.method==='GET')return reply(200,{ok:true,data:{document:remote,version,dependencies:{sources:{},costs:{}}}});
  if(route.endsWith('/configurations/c')&&opts.method==='PUT'){
   const body=JSON.parse(opts.body);
   if(body.expected_version!==version)return reply(409,{ok:false,error:'VERSION_CONFLICT'});
   remote=copy(body.document);version=String(Number(version)+1);
   receipt={configuration_id:'c',shop_id:'intel',operation_id:body.operation_id,version,archived:false};
   return put?put(reply,receipt):reply(200,{ok:true,data:receipt});
  }
  throw Error(route);
 };
 return {build:()=>createNasMainWorkspace({storage,nativeRequest:handle}),commands,db,setPut:value=>{put=value;},remote:()=>copy(remote),
  setTime:(time,events,fail=false)=>{importedAt=time;activity=copy(events);activityError=fail;},
  setUser:value=>{user=value;},update:value=>{remote=copy(value);version=String(Number(version)+1);}};
}
async function attach(main){
 const index=await main.request('/api/workspace/index');
 const load=await main.request('/api/configs/load',{method:'POST',body:JSON.stringify({ids:['c'],revision:index.revision})});
 const doc=load.configs[0];main.attach(doc);return doc;
}
test('批量底部加购文案提交保留 NAS 原文的配件加购并拒绝未保存的目标',async()=>{
 const t=fixture(),main=t.build();
 const linked={sourceId:'cpu-source',text:'已保存的配件加购',priceCents:1500,items:[],followPolicy:'snapshot'};
 t.update({...raw,addons:[linked]});
 const index=await main.request('/api/workspace/index');
 const loaded=await main.request('/api/configs/load',{method:'POST',body:JSON.stringify({ids:['c'],revision:index.revision})});
 const view=loaded.configs[0];
 view.addons[0].text='界面派生的配件加购';
 view.addons[0].priceCents=3600;
 main.attach(view);
 const reference={addons:[{text:'底部加购新文案',note:'补充说明',items:[]}]};
 const target=applyBatchContent(reference,structuredClone(view),{addons:true});
 const batch=[{id:'c',action:'replace',document:target,posterAddonText:reference.addons}];
 const [change]=await main.configurationChanges(batch);
 assert.deepEqual(change.document.addons,[reference.addons[0],linked]);
 main.stage({...view,name:'尚未保存的修改'});
 await assert.rejects(main.configurationChanges(batch),{code:'UNSAVED_DRAFT'});
 assert.equal(t.commands.filter(c=>c.method==='PUT').length,0);
});
test('新增底部文案保存重读后不会套用原来跟随配件的自由编辑文字',()=>{
 const source={sourceId:'s',addonText:'配件加购',addonGoodsId:'9',addonPriceCents:2100};
 const sources=new Map([['s',source]]);
 const saved={shopId:'intel',parts:[{sourceId:'s',sourceFollow:{upgrade:{mode:'follow',structured:true}}}],actualParts:[],addons:[],
  textStyles:{'addons.0.text':{text:'配件加购自由编辑',size:22}}};
 const visible=structuredClone(saved);
 withCurrentSharedSource(visible,sources);
 assert.equal(visible.addons[0].text,'配件加购');
 const edited=structuredClone(visible);
 const reference={addons:[{text:'底部新文案'}]};
 applyBatchContent(reference,edited,{addons:true});
 const projected=projectNasEdits(saved,visible,edited);
 const rawAddons={addons:[]};
 syncPosterAddonText(reference,rawAddons);
 projected.addons=rawAddons.addons;
 withCurrentSharedSource(projected,sources);
 assert.deepEqual(projected.addons.map(a=>a.text),['底部新文案','配件加购']);
 assert.deepEqual(projected.textStyles,{'addons.1.text':{text:'配件加购自由编辑',size:22}});
});

test('批量底部文案可合入现有草稿并撤销，配件加购不被界面派生值覆盖',async()=>{
 const t=fixture(),main=t.build();
 const linked={sourceId:'cpu-source',text:'原始配件加购',priceCents:1500,items:[],followPolicy:'snapshot'};
 t.update({...raw,addons:[linked]});
 const index=await main.request('/api/workspace/index');
 const load=await main.request('/api/configs/load',{method:'POST',body:JSON.stringify({ids:['c'],revision:index.revision})});
 const view=load.configs[0];
 view.addons[0].text='界面派生加购';
 main.attach(view);
 view.name='应用前未保存的名称';
 main.stage(view);
 const edited=applyBatchContent({addons:[{text:'底部新文案'}]},structuredClone(view),{addons:true});
 const applied=main.stage(edited).document;
 assert.equal(applied.name,view.name);
 assert.deepEqual(applied.addons,[{text:'底部新文案',note:'',items:[]},linked]);
 assert.deepEqual(main.stage(view).document.addons,[linked]);
 assert.deepEqual(main.stage(edited).document.addons,applied.addons);
 assert.equal(t.commands.filter(c=>c.method==='PUT').length,0);
});

test('独立文案新增在用户选定位置，保存时保留已有配件加购的行号',()=>{
 const linked={sourceId:'s',text:'原始方案',priceCents:1500,items:[]};
 const raw={parts:[],addons:[linked],textStyles:{'addons.0.text':{color:'#000000'}}};
 const visible={...raw,addons:[{...linked,text:'界面派生方案'}]};
 const edited=structuredClone(visible);
 addPosterExtra(edited,'addons');
 edited.addons[1].text='追加文案';
 const saved=projectNasEdits(raw,visible,edited);
 assert.deepEqual(saved.addons,[linked,edited.addons[1]]);
 assert.deepEqual(saved.textStyles,raw.textStyles);
});
test('暂存和旧路由不会发写，显式保存以发送时快照确认飞行前的输入',async()=>{
 const t=fixture(),main=t.build(),view=await attach(main);
 view.name='首次提交';main.stage(view);
 assert.equal(t.commands.filter(c=>c.method==='PUT').length,0);
 await assert.rejects(main.request('/api/native-cloud/commit',{method:'POST'}),{code:'NAS_FEATURE_UNAVAILABLE'});
 let release,waitingResolve;
 const waiting=new Promise(r=>{waitingResolve=r;});
 t.setPut((respond,data)=>new Promise(r=>{release=()=>r(respond(200,{ok:true,data}));waitingResolve();}));
 const submitted=main.submit(view);await waiting;
 view.name='提交飞行期间的新编辑';release();await submitted;
 assert.equal(t.remote().name,'首次提交');
 assert.equal((await attach(t.build())).name,'提交飞行期间的新编辑');
 assert.equal(t.commands.filter(c=>c.method==='PUT').length,1);
});
test('重开后直接保存旧草稿时补齐清空行编号，并保留被复制行的原编号',async()=>{
 const t=fixture();
 const cpu={lineId:'original-cpu',slot:'CPU',goodsId:'',name:'CPU 型号',qty:1};
 t.update({...raw,parts:[cpu],actualParts:[cpu]});
 const first=t.build(),view=await attach(first);
 view.parts.unshift({...cpu,slot:'散热'});
 view.actualParts=[{slot:'CPU',goodsId:'',name:'',qty:1}];
 first.stage(view);
 const reopened=t.build();
 await reopened.initialize();
 assert.equal((await reopened.submitDraft('c')).version,'3');
 const saved=t.remote();
 assert.equal(saved.parts[1].lineId,cpu.lineId);
 assert.ok(saved.parts[0].lineId&&saved.parts[0].lineId!==cpu.lineId);
 assert.ok(saved.actualParts[0].lineId);
 assert.equal(saved.actualParts[0].name,'');
 assert.equal(t.db.size,0);
});
test('未知提交在重载后只查询原回执，服务端换账号不能接续原草稿',async()=>{
 const t=fixture(),main=t.build(),view=await attach(main);
 view.name='已提交但回执丢失';main.stage(view);
 t.setPut(respond=>respond(503,{ok:false,error:'SERVICE_UNAVAILABLE'}));
 await assert.rejects(main.submit(view),{code:'SAVE_STATUS_UNKNOWN'});
 const reopened=t.build(),restored=await attach(reopened);
 assert.equal(restored.name,view.name);assert(reopened.pending('c'));
 t.setUser('new-account');await assert.rejects(reopened.submit(restored),{code:'MEMBER_CHANGED'});
 assert.equal(t.commands.filter(c=>c.method==='PUT').length,1);
 t.setUser('owner');const last=t.build(),lastDoc=await attach(last);
 assert.equal((await last.submit(lastDoc)).version,'2');
 assert.equal(t.commands.filter(c=>c.method==='PUT').length,1);
 assert.equal(t.commands.filter(c=>c.path.includes('/save-receipts/')).length,1);
 assert.equal(t.db.size,0);
});
test('重开已变配置使用新原文基线，冲突保留草稿供手动比较',async()=>{
 const t=fixture(),main=t.build(),old=await attach(main);
 t.update({...raw,name:'远端新名',privateLegacy:{tag:'new'}});
 const fresh=await attach(main);
 assert.equal(fresh.name,'远端新名');
 fresh.name='改我的字段';main.stage(fresh);
 t.update({...raw,name:'第二人保存',privateLegacy:{tag:'latest'}});
 await assert.rejects(main.submit(fresh),{code:'VERSION_CONFLICT'});
 const compare=await main.compare('c');
 assert.equal(compare.draft.name,'改我的字段');
 assert.equal(compare.remote.document.privateLegacy.tag,'latest');
 assert.equal(old.name,'原配置');
});
test('重开后未载入的持久草稿仍按原文和版本保存，不借用其他账号草稿',async()=>{
 const t=fixture(),first=t.build(),view=await attach(first);
 view.name='重开后未打开的草稿';first.stage(view);
 t.setUser('另一成员');const other=t.build();await other.initialize();
 assert.deepEqual(other.drafts(),[]);
 await assert.rejects(other.submitDraft('c'),{code:'INVALID_DRAFT'});
 assert.equal(t.commands.filter(x=>x.method==='PUT').length,0);
 t.setUser('owner');
 const newer=t.build();await newer.initialize();
 const calls=t.commands.length;
 assert.equal(newer.drafts()[0].id,'c');
 assert.equal((await newer.submitDraft('c')).version,'2');
 assert.equal(t.remote().name,view.name);
 assert.deepEqual(newer.drafts(),[]);
 assert.deepEqual(t.commands.slice(calls).filter(x=>x.path.endsWith('/configurations/c')).map(x=>x.method),['PUT']);
});
test('全保存报告逐条冲突、已确认、回执未知和未发送；原回执未查明时不提交新草稿',async()=>{
 const rows=['冲突','成功','断开','未发'].map(id=>({id,pending:false}));
 const attempted=[];let pendingId=null;
 const run=rows=>submitNasDraftSet(rows,{
  isPending:id=>id===pendingId?true:null,
  submit:async row=>{
   attempted.push([row.id,row.pending?'查询原回执':'新提交']);
   if(row.id==='冲突')throw new NasApiError('VERSION_CONFLICT',409);
   if(row.id==='断开'){pendingId=row.id;throw new NasApiError(row.pending?'RECEIPT_NOT_FOUND':'SAVE_STATUS_UNKNOWN');}
   return {version:'2'};
  }
 });
 const first=await run(rows);
 assert.deepEqual(first.map(row=>[row.id,row.status]),[['冲突','failed'],['成功','saved'],['断开','pending'],['未发','unsent']]);
 assert.deepEqual(attempted,[['冲突','新提交'],['成功','新提交'],['断开','新提交']]);
 attempted.length=0;
 const second=await run([rows[3],{id:'断开',pending:true}]);
 assert.deepEqual(second.map(row=>[row.id,row.status]),[['断开','pending'],['未发','unsent']]);
 assert.deepEqual(attempted,[['断开','查询原回执']]);
});
test('顶部服务端版本不读取配置商务版号，更新时间区分服务端操作、首次导入、缺失和读取失败',async()=>{
 const t=fixture(),main=t.build();const imported='2026-11-17T01:02:03.000Z',changed='2026-11-17T01:04:05.000Z';
 t.setTime(imported,[]);
 const view=await attach(main);view.version='业务A版';view.name='暂存中';main.stage(view);
 assert.equal(main.serverVersion('c'),'1');assert.equal(main.serverVersion('another'),null);
 assert.deepEqual(await main.serverDataTime(),{updatedAt:imported,firstImport:true});
 t.setTime(imported,[{kind:'settings',created_at:changed},{kind:'configurations',created_at:imported}]);
 assert.deepEqual(await main.serverDataTime(),{updatedAt:changed,firstImport:false});
 await main.submit(view);
 assert.equal(main.serverVersion('c'),'2');
 t.setTime(imported,[],true);
 await assert.rejects(main.serverDataTime(),{code:'SERVICE_UNAVAILABLE'});
 t.setTime(null,[]);await main.request('/api/workspace/index');
 assert.deepEqual(await main.serverDataTime(),{updatedAt:null,firstImport:false});
});

test('删除编号回执接续重开后未打开的价格草稿及独立价格表草稿',async()=>{
 const t=fixture(),first=t.build(),view=await attach(first);view.price=123;first.stage(view);
 const newer=t.build();await newer.initialize();
 newer.priceDraft([{id:'c',expected_version:'1',fields:{price:456}}]);
 t.update({...t.remote(),name:'配置1'});
 assert.deepEqual(newer.acceptRenumber([{configuration_id:'c',before:raw.name,name:'配置1',previous_version:'1',version:'2'}]),['c']);
 assert.deepEqual(newer.priceDraft(),[{id:'c',expected_version:'2',fields:{price:456}}]);
 const loaded=await attach(newer);assert.equal(loaded.name,'配置1');assert.equal(loaded.price,123);
 await newer.submit(loaded);assert.equal(t.remote().name,'配置1');assert.equal(t.remote().price,123);
});
