/** Agent 与界面共享的定点变更计划：纯预览、完整基线核验，不保存或导图。 */
import {markSourceFieldManual} from './source-follow.js';
import {ensureActualParts,syncActualParts} from './actual-parts.js';
import {replaceSourcePart,preferredSourceRows} from './source.js';
import {selectableComponents} from './component-policy.js';
import {withSpecialPresets} from './special-components.js';
import {suggestedName} from './legacy-names.js';
import {syncPosterShortName} from './short-name-poster.js';

const copy=value=>structuredClone(value);
const fail=message=>{throw Error(message);};
function object(value,allowed,label){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(`${label}必须为对象`);
 if(Object.keys(value).some(key=>!allowed.includes(key)))fail(`${label}包含未知字段`);
}
function text(value,label,{empty=false,max=4096}={}){
 if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max)fail(`${label}必须为${empty?'':'非空'}字符串，最多 ${max} 个字符`);
 return value;
}
function qty(value){if(!Number.isSafeInteger(value)||value<1)fail('数量必须是可精确表示的正整数');return value;}
// 递归比较完整业务对象，区分缺失字段和显式 undefined，不依赖对象键的插入顺序。
function same(a,b){
 if(Object.is(a,b))return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const x=Object.keys(a).sort(),y=Object.keys(b).sort();
 return x.length===y.length&&x.every((key,i)=>key===y[i]&&same(a[key],b[key]));
}
function requestInput(request){
 object(request,['shopId','targets','action'],'请求');text(request.shopId,'shopId');
 if(!Array.isArray(request.targets)||request.targets.length<1||request.targets.length>64)fail('每次必须选择 1 至 64 个目标');
 const seen=new Set();
 for(const target of request.targets){
  object(target,['configId','partIndex','expectedGoodsId','expectedSourceId'],'目标');text(target.configId,'configId');
  if(!Number.isSafeInteger(target.partIndex)||target.partIndex<0)fail('partIndex 必须为非负整数');
  const key=JSON.stringify([target.configId,target.partIndex]);if(seen.has(key))fail('目标配件位置重复');seen.add(key);
  for(const key of ['expectedGoodsId','expectedSourceId'])if(Object.hasOwn(target,key))text(target[key],key,{empty:true});
 }
 const action=request.action;
 object(action,['type','value','sourceId','quantity'],'操作');
 const allowed={displayName:['type','value'],upgrade:['type','value'],replace:['type','sourceId','quantity'],quantity:['type','quantity']}[action.type];
 if(!allowed||Object.keys(action).some(key=>!allowed.includes(key)))fail('操作类型或字段无效');
 if(action.type==='displayName')text(action.value,'展示名称',{empty:true,max:200});
 if(action.type==='upgrade')text(action.value,'升级描述',{empty:true,max:10000});
 if(action.type==='replace')text(action.sourceId,'sourceId');
 if(action.type==='quantity'||Object.hasOwn(action,'quantity'))qty(action.quantity);
}
function replacement(state,request){
 const shopId=request.shopId,sourceId=request.action.sourceId;
 // 与店铺输出源选择器相同：特殊预设、成本合并及星号禁用规则都由现有模块处理。
 const rows=withSpecialPresets((state.sourceCatalog||[]).filter(row=>(row.shopId||'intel')===shopId),shopId);
 const selected=rows.filter(row=>row.sourceId===sourceId);
 if(selected.length!==1)fail('替换输出源不存在、跨店铺或不唯一');
 const raw=selected[0];
 const effective=preferredSourceRows(selectableComponents(selected,state.costSource||[]),state.costSource||[])[0];
 if(!effective||effective.deletedAt||!effective.name)fail('替换输出源不可选用');
 return {effective:copy(effective),baseline:{row:copy(raw),costs:copy((state.costSource||[]).filter(row=>row.goodsId===raw.goodsId))}};
}

/** 按完整配置生成可审查快照；不会修改 state、request 或输出源。 */
export function buildAgentPlan(state,request){
 requestInput(request);
 if(!state||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.configs))fail('工作区版本或配置无效');
 const action=request.action,groups=new Map();
 for(const target of request.targets){
  const matches=state.configs.filter(config=>config.id===target.configId);
  if(matches.length!==1)fail('目标配置不存在或不唯一');
  const before=matches[0];
  if(before.deletedAt||(before.shopId||'intel')!==request.shopId)fail('目标配置已删除或不属于指定店铺');
  if(!Array.isArray(before.parts)||!before.parts[target.partIndex]||typeof before.parts[target.partIndex]!=='object'||Array.isArray(before.parts[target.partIndex])||!Object.keys(before.parts[target.partIndex]).length)fail('目标配件不存在');
  if(before.__workbenchSummary)fail('目标配置尚未完整加载');
  const part=before.parts[target.partIndex];
  for(const [expected,field] of [['expectedGoodsId','goodsId'],['expectedSourceId','sourceId']]){
   if(Object.hasOwn(target,expected)&&String(part[field]??'')!==target[expected])fail('目标配件身份已变化');
  }
  if(!groups.has(before.id))groups.set(before.id,{before,targets:[]});
  groups.get(before.id).targets.push(target);
 }
 const source=action.type==='replace'?replacement(state,request):null;
 const changes=[],baselines=[];
 for(const {before,targets} of groups.values()){
  const after=copy(before);baselines.push({id:before.id,before:copy(before)});
  // 旧配置先冻结编辑前的实际 BOM，展示文案编辑不能通过 fallback 偷改核算内容。
  if(after.actualParts===null)delete after.actualParts;
  if(!Array.isArray(after.actualParts))ensureActualParts(after);
  for(const target of targets){
   const part=after.parts[target.partIndex];
   if(action.type==='displayName'){
    const value=action.value.trim();
    if(!value||value===part.name)delete part.displayName;else part.displayName=value;
    markSourceFieldManual(part,'name');
   }else if(action.type==='upgrade'){
    part.upgrade=action.value;markSourceFieldManual(part,'upgrade');
   }else if(action.type==='replace'){
    replaceSourcePart(after,target.partIndex,source.effective);
    if(Object.hasOwn(action,'quantity'))part.qty=action.quantity;
   }else part.qty=action.quantity;
  }
  if(action.type==='replace'||action.type==='quantity')syncActualParts(after,before.parts);
  if(after.shortNameAuto){
   const name=suggestedName(after,after.nameFormat||'compact');
   if(after.shortName!==name){after.shortName=name;syncPosterShortName(after);}
  }
  if(!same(before,after))changes.push({id:before.id,productId:before.productId,name:before.name,product:before.product,before:copy(before),after,targets:copy(targets)});
 }
 return {baseRevision:state.revision,shopId:request.shopId,request:copy(request),changes,sources:source?[copy(source.effective)]:[],sourceBaselines:source?[copy(source.baseline)]:[],baselines,summary:{action:action.type,targetCount:request.targets.length,configCount:groups.size,changedConfigCount:changes.length}};
}

/** 保存前拒绝版本、界面配置、输出源或预览计划本身的任何变化。 */
export function validateAgentPlan(state,plan){
 if(!plan||state?.revision!==plan.baseRevision)fail('工作区版本已变化，请重新预览');
 const current=buildAgentPlan(state,plan.request);
 if(!same(current,plan))fail('配置、输出源或变更计划已变化，请重新预览');
 return true;
}
