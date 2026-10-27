import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentPlan,validateAgentPlan} from '../../public/workbench/agent-changes.js';
import {suggestedName} from '../../public/workbench/legacy-names.js';
import {replaceSourcePart} from '../../public/workbench/source.js';
import {ensureActualParts,syncActualParts} from '../../public/workbench/actual-parts.js';

const copy=value=>structuredClone(value);
const part={slot:'CPU',name:'Intel i5 12400F',sourceId:'old',goodsId:'001',qty:1,tax:100,erp:90,upgrade:'原描述'};
function fixture(){return {revision:7,configs:[{id:'c1',shopId:'intel',productId:'p1',name:'配置1',parts:[copy(part),{...copy(part),slot:'配件1'}],actualParts:[{...copy(part),name:'实际型号',tax:66,taxOverride:{goodsId:'001',value:66,base:100}},{...copy(part),slot:'配件1'}],addons:[],shortNameAuto:false},{id:'other',shopId:'jonsbo',parts:[copy(part)]}],sourceCatalog:[{sourceId:'new',shopId:'intel',goodsId:'002',name:'Intel i7 14700F',erp:200,tax:210,upgrade:'新说明'},{sourceId:'foreign',shopId:'jonsbo',goodsId:'003',name:'跨店源'}],costSource:[]};}
const target={configId:'c1',partIndex:0,expectedGoodsId:'001',expectedSourceId:'old'};
const request=action=>({shopId:'intel',targets:[copy(target)],action});

test('展示名仅修改准确位置并解除名称跟随，保留完整实际 BOM 和输入',()=>{
 const state=fixture(),before=copy(state),req=request({type:'displayName',value:'  直播专属型号  '}),original=copy(req);
 state.configs[0].actualParts[0].displayName='旧实际未知字段';before.configs[0].actualParts[0].displayName='旧实际未知字段';
 const plan=buildAgentPlan(state,req),after=plan.changes[0].after;
 assert.equal(after.parts[0].displayName,'直播专属型号');assert.equal(after.parts[0].sourceFollow.name.mode,'manual');
 assert.deepEqual(after.parts[1],before.configs[0].parts[1]);assert.deepEqual(after.actualParts,before.configs[0].actualParts);
 assert.deepEqual(state,before);assert.deepEqual(req,original);assert.equal(validateAgentPlan(state,plan),true);
});

test('清空展示名恢复型号，旧结构先冻结 BOM，升级描述也不改变实际内容',()=>{
 for(const action of [{type:'displayName',value:''},{type:'upgrade',value:'独立文案'}]){
  const state=fixture();delete state.configs[0].actualParts;state.configs[0].parts[0].displayName='旧展示名';
  const before=copy(state),plan=buildAgentPlan(state,request(action)),after=plan.changes[0].after;
  assert.equal(after.actualParts[0].upgrade,'原描述');assert.equal(after.actualParts[0].name,part.name);assert.equal(after.actualParts[0].displayName,undefined);
  if(action.type==='upgrade'){assert.equal(after.parts[0].upgrade,'独立文案');assert.equal(after.parts[0].sourceFollow.upgrade.mode,'manual');}
  else assert.equal(after.parts[0].displayName,undefined);
  assert.deepEqual(state,before);
 }
});

test('数量变化复用实际配件同步，保留独立型号、核算覆盖价和其他位置',()=>{
 const state=fixture(),plan=buildAgentPlan(state,request({type:'quantity',quantity:2})),after=plan.changes[0].after;
 assert.equal(after.parts[0].qty,2);assert.equal(after.actualParts[0].qty,2);assert.equal(after.actualParts[0].name,'实际型号');
 assert.equal(after.actualParts[0].tax,66);assert.deepEqual(after.actualParts[0].taxOverride,state.configs[0].actualParts[0].taxOverride);
 assert.deepEqual(after.parts[1],state.configs[0].parts[1]);assert.deepEqual(after.actualParts[1],state.configs[0].actualParts[1]);
});

test('替换复用来源、成本与加购描述选择，更新 BOM 并解除旧独立价',()=>{
 const state=fixture();state.configs[0].parts[0].displayName='旧手工名';state.costSource=[{goodsId:'002',name:'ERP别名',erp:300,tax:310}];
 const plan=buildAgentPlan(state,request({type:'replace',sourceId:'new',quantity:3})),after=plan.changes[0].after;
 const expected=copy(state.configs[0]);ensureActualParts(expected);replaceSourcePart(expected,0,plan.sources[0]);expected.parts[0].qty=3;syncActualParts(expected,state.configs[0].parts);
 assert.deepEqual(after,JSON.parse(JSON.stringify(expected)));assert.equal(after.parts[0].displayName,undefined);assert.equal(after.actualParts[0].goodsId,'002');
 assert.equal(after.actualParts[0].tax,310);assert.equal(after.actualParts[0].taxOverride,null);assert.equal(after.parts[0].upgrade,'新说明');
 assert.equal(after.parts[0].sourceFollow.name.mode,'follow');
});

test('多个定点同配置合并一条变化，不扩大到相同配件的其他位置',()=>{
 const state=fixture(),req=request({type:'quantity',quantity:4});req.targets.push({...target,partIndex:1});
 const plan=buildAgentPlan(state,req);assert.equal(plan.changes.length,1);assert.equal(plan.summary.targetCount,2);
 assert.equal(plan.changes[0].after.parts[0].qty,4);assert.equal(plan.changes[0].after.parts[1].qty,4);
 assert.equal(state.configs[0].parts[0].qty,1);
});

test('自动简称沿用已有命名与海报联动，手工简称保留',()=>{
 const state=fixture();Object.assign(state.configs[0],{shortNameAuto:true,shortName:'旧简称',posterSubtitle:'旧摘要',textStyles:{'header.subtitle':{text:'旧文字',size:20}}});
 const after=buildAgentPlan(state,request({type:'replace',sourceId:'new'})).changes[0].after;
 assert.equal(after.shortName,suggestedName(after,'compact'));assert.equal(after.posterSubtitle,undefined);assert.deepEqual(after.textStyles['header.subtitle'],{size:20});
 state.configs[0].shortNameAuto=false;assert.equal(buildAgentPlan(state,request({type:'quantity',quantity:2})).changes[0].after.shortName,'旧简称');
});

test('严格拒绝未知字段、缺失对象、非法操作、无效数量与目标范围',()=>{
 const invalid=[null,{}, {...request({type:'quantity',quantity:2}),sql:'x'},request({type:'quantity',quantity:'2'}),request({type:'quantity',quantity:0}),request({type:'quantity',quantity:1.5}),request({type:'quantity',quantity:Number.MAX_SAFE_INTEGER+1}),request({type:'replace',sourceId:'new',quantity:null}),request({type:'displayName',value:'x'.repeat(201)}),request({type:'displayName',value:'x',quantity:2}),request({type:'upgrade',value:null}),request({type:'delete'}),{shopId:'intel',targets:[],action:{type:'quantity',quantity:2}}];
 for(const req of invalid)assert.throws(()=>buildAgentPlan(fixture(),req));
 for(const change of [{configId:'missing'},{configId:'other'},{partIndex:-1},{partIndex:0.1},{partIndex:9},{expectedGoodsId:'1'},{expectedSourceId:'wrong'},{extra:true}]){
  const req=request({type:'quantity',quantity:2});Object.assign(req.targets[0],change);assert.throws(()=>buildAgentPlan(fixture(),req));
 }
 const duplicate=request({type:'quantity',quantity:2});duplicate.targets.push(copy(duplicate.targets[0]));assert.throws(()=>buildAgentPlan(fixture(),duplicate));
 const tooMany=request({type:'quantity',quantity:2});tooMany.targets=Array.from({length:65},(_,partIndex)=>({...target,partIndex}));assert.throws(()=>buildAgentPlan(fixture(),tooMany));
});

test('删除配置、未完整加载与跨店/星号/删除/重复输出源均被拒绝',()=>{
 for(const patch of [{deletedAt:'deleted'},{__workbenchSummary:true},{parts:[]},{parts:[{}]},{parts:[[]]}]){
  const state=fixture();Object.assign(state.configs[0],patch);assert.throws(()=>buildAgentPlan(state,request({type:'quantity',quantity:2})));
 }
 for(const sourceId of ['foreign','missing'])assert.throws(()=>buildAgentPlan(fixture(),request({type:'replace',sourceId})));
 for(const patch of [{name:'禁止*商品'},{deletedAt:'deleted'}]){
  const state=fixture();Object.assign(state.sourceCatalog[0],patch);assert.throws(()=>buildAgentPlan(state,request({type:'replace',sourceId:'new'})));
 }
 const state=fixture();state.costSource=[{goodsId:'002',name:'被禁*ERP'}];assert.throws(()=>buildAgentPlan(state,request({type:'replace',sourceId:'new'})));
 const dup=fixture();dup.sourceCatalog.push(copy(dup.sourceCatalog[0]));assert.throws(()=>buildAgentPlan(dup,request({type:'replace',sourceId:'new'})));
});

test('预览后版本、完整配置、原始输出源、ERP成本或计划被改动均须重做预览',()=>{
 const mutations=[s=>s.revision++,s=>s.configs[0].footer='额外界面修改',s=>s.configs[0].parts[0].goodsId='new-id',s=>s.sourceCatalog[0].addonText='新加购',s=>s.costSource.push({goodsId:'002',tax:333})];
 for(const mutate of mutations){const state=fixture(),plan=buildAgentPlan(state,request({type:'replace',sourceId:'new'}));mutate(state);assert.throws(()=>validateAgentPlan(state,plan));}
 const state=fixture(),plan=buildAgentPlan(state,request({type:'replace',sourceId:'new'}));plan.changes[0].after.price=1;assert.throws(()=>validateAgentPlan(state,plan));
});

test('no-op 目标也冻结完整基线，旧店铺缺失字段仍使用 intel',()=>{
 const state=fixture();delete state.configs[0].shopId;const plan=buildAgentPlan(state,request({type:'quantity',quantity:1}));
 assert.equal(plan.changes.length,0);assert.equal(plan.baselines.length,1);assert.equal(validateAgentPlan(state,plan),true);
 state.configs[0].name='预览后改名';assert.throws(()=>validateAgentPlan(state,plan));
});

test('虚拟特殊输出源沿用现有预设与零成本规则',()=>{
 const state=fixture(),plan=buildAgentPlan(state,request({type:'replace',sourceId:'special:intel:1'}));
 const after=plan.changes[0].after;assert.equal(after.parts[0].specialComponent,true);assert.equal(after.parts[0].goodsId,'');assert.equal(after.actualParts[0].tax,0);assert.equal(validateAgentPlan(state,plan),true);
});

test('真实 JSON 传递后替换计划仍可校验，空容量字段不产生伪冲突',()=>{
 const state=fixture(),before=copy(state),plan=buildAgentPlan(state,request({type:'replace',sourceId:'new'}));
 const transported=JSON.parse(JSON.stringify(plan));
 assert.equal(validateAgentPlan(state,transported),true);
 assert.deepEqual(state,before);
 for(const mutate of [
  p=>{p.changes[0].after.parts[0].goodsId='wrong';},
  p=>{p.changes[0].after.parts[0].capacityOverrides=null;},
  p=>{p.baselines[0].before.price=1;}
 ]){const altered=copy(transported);mutate(altered);assert.throws(()=>validateAgentPlan(state,altered));}
 const changed=copy(state);changed.configs[0].parts[0].upgrade='人工新说明';
 assert.throws(()=>validateAgentPlan(changed,transported));
});
