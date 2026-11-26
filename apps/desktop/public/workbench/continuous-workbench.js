import {resetConfigCost} from './config-cost.js';
import {configHardwareIssues} from './component-hardware.js';
/** 连续编辑只编排现有领域操作；业务保存、批量、同步仍由原工作台持有。 */
import {projectedRows,copyRows,planPasteRows,continuousSlotsFor,appendAccessoryRow,planRemoveRow,removeLastAccessoryRow} from './continuous-parts.js';
import {totals} from './core.js';
import {priceForTarget,snap99} from './batch-profit-price.js';
import {pricing,productInstallment} from './pricing.js';
import {actualParts} from './actual-parts.js';
import {parseArrival} from './price-profit-model.js';
import {replaceSourcePart} from './source.js';
import {markSourceFieldManual} from './source-follow.js';
import {componentStockView} from './component-stock-view.js';
import {erpDescription} from './erp-part-description.js';
import {isSpecialComponent} from './special-components.js';
import {taxOverrideLines} from './tax-override-model.js';
import {changeOverviewTax,differentTax,overviewTableTotals,overviewTaxDifferenceCount,readOverviewFeeRate} from './overview-table-model.js';
const blank=(slot,lineId)=>({slot,lineId:lineId||crypto.randomUUID(),name:'',goodsId:'',qty:1,erp:null,tax:null,upgrade:''});
const ensure=(c,slot,actual)=>{const key=actual?'actualParts':'parts';c[key]??=actual?structuredClone(actualParts(c)):[];let i=c[key].findIndex(p=>p.slot===slot);if(i<0){i=c[key].length;c[key].push(blank(slot));}return i;};
// 空白展示行和同型号展示行随实际型号变动，独立选择的展示配件保留。
function sameModel(a,b){
 if(a.sourceId&&b.sourceId)return a.sourceId===b.sourceId;
 if(a.goodsId&&b.goodsId)return String(a.goodsId)===String(b.goodsId);
 return !!a.name&&a.name===b.name;
}
export function changeActual(config,slot,source){
 const index=ensure(config,slot,true),old=config.actualParts[index];
 if(!source){
  // 清空实际型号时同槽位的展示名称和逐项加购也一并清空。
  config.actualParts[index]={...blank(slot,old.lineId),qty:old.qty};
  const displayIndex=ensure(config,slot,false);
  config.parts[displayIndex]=blank(slot,config.parts[displayIndex].lineId);
  return;
 }
 const display=config.parts?.find(part=>part.slot===slot);
 const empty=!display||(!display.sourceId&&!display.goodsId&&!display.name);
 const follows=empty||sameModel(display,old);
 const qty=old.qty,oldUpgrade=old.upgrade;
 if(!old.sourceId||old.sourceId!==source.sourceId)replaceSourcePart({...config,parts:config.actualParts,addons:[]},index,source);
 if(!follows)return;
 const pos=ensure(config,slot,false),part=config.parts[pos];
 if(source.sourceId===part.sourceId&&part.name)return;
 const manualName=part.displayName||(part.sourceFollow?.name?.mode==='manual'?part.name:'');
 const manualUpgrade=part.sourceFollow?.upgrade?.mode==='manual'||(!part.sourceFollow?.upgrade&&part.upgrade&&part.upgrade!==oldUpgrade);
 const upgrade=part.upgrade;
 replaceSourcePart(config,pos,source);
 const next=config.parts[pos];
 if(empty)next.qty=qty;
 if(manualName){next.displayName=manualName;markSourceFieldManual(next,'name');}
 if(manualUpgrade){next.upgrade=upgrade;markSourceFieldManual(next,'upgrade');}
}
// 展示数量仅在型号和原数量都相同时跟随。
export function changeQuantity(config,slot,qty){
 const index=ensure(config,slot,true),part=config.actualParts[index],display=config.parts?.find(row=>row.slot===slot);
 if(display&&display.qty===part.qty&&sameModel(display,part))display.qty=qty;
 part.qty=qty;
}

export function createContinuousWorkbench(api){
 const host=document.createElement('section');host.id='continuous-workbench';document.querySelector('.tabs').after(host);
 let epoch=0,clipboard=null,loading=false,lastError='',disposed=false;
 let renderedCanUndo,renderedCanRedo,historySyncQueued=false;
 // 11-19：总表显示时，在页面任意位置按 Ctrl/⌘+Z 撤销、Ctrl+Y 或 Ctrl/⌘+Shift+Z 重做；输入框里交给浏览器自己处理。
 host.ownerDocument.addEventListener('keydown',event=>{
   if(disposed||host.hidden||document.querySelector('.workspace:is(.price-profit-active,.source-sheet-active)')||document.body.classList.contains('host-template-mode')||event.defaultPrevented||event.isComposing||event.altKey||!(event.ctrlKey||event.metaKey))return;
  const target=event.target;if(target instanceof HTMLElement&&(target.isContentEditable||target.closest('input, textarea, select')))return;
  const key=event.key.toLowerCase(),redo=key==='y'||key==='z'&&event.shiftKey;
  if(key!=='z'&&key!=='y')return;
  if(document.querySelector('dialog[open]'))return;
  event.preventDefault();if(event.repeat)return;
  if(redo){if(api.canRedo())api.redo();}else if(api.canUndo())api.undo();
 });
 const configs=()=>api.available().filter(c=>c.productId===api.current()?.productId);
 const find=id=>api.configs().find(c=>c.id===id);
 const safe=fn=>{try{const result=fn();return result?.then?result.catch(e=>{api.toast(api.errorText?.(e)||e.message);return false;}):result;}catch(e){api.toast(api.errorText?.(e)||e.message);return false;}};
 function pickSource(id,slot,actual,sourceId){
  const row=api.catalog(find(id)?.shopId).find(p=>p.sourceId===sourceId&&!p.deletedAt);
  if(!row)throw Error('配件来源已变化，请重新搜索');
  api.update(id,c=>{if(actual)changeActual(c,slot,row);else replaceSourcePart(c,ensure(c,slot,false),row);},
   actual?'更换实际配件':'更换展示配件',actual);
  return true;
 }
 const lookupErp=api.erpSearch?async query=>(await api.erpSearch(query)).map(row=>({
  ...row,sourceId:'erp-only:'+row.goodsId,erpOnly:true,stock:componentStockView(row,[row]),
 })):null;
 let catalogVersion,catalogRows=[],stockCosts=new Map(),sourcesById=new Map();const projections=new Map();
 const project=(summary,settings,term)=>{const c=find(summary.id);if(!c)return {id:summary.id,name:summary.name,loading:true};const selected=api.selected().has(c.id),version=JSON.stringify([c,settings,selected,term]),cached=projections.get(c.id);if(cached?.version===version)return cached.value;const rows=projectedRows(c),raw=totals(c,settings),quote=pricing(c,{...settings,linkInstallment:term===null?null:undefined}),value={...c,hardwareIssues:configHardwareIssues(c),rows,extras:rows.extras,raw,totals:overviewTableTotals(c,raw,quote),pricing:quote,selected};projections.set(c.id,{version,value});return value;};
 // 一次构建库存索引和共享候选；每个输入框不再复制整份目录或逐条扫描成本表。
 const pickerCatalog=shop=>{const version=api.catalogVersion()+':'+shop;if(catalogVersion===version)return catalogRows;const costs=new Map();for(const row of api.costs()){if(!costs.has(row.goodsId))costs.set(row.goodsId,[]);costs.get(row.goodsId).push(row);}stockCosts=costs;catalogRows=api.catalog(shop).map(p=>({...p,value:p.sourceId,label:p.name,searchText:[p.name,p.goodsId,p.erpName,costs.get(p.goodsId)?.[0]?.name].filter(Boolean).join(' ').normalize('NFKC').toLowerCase(),stock:componentStockView(p,costs)}));sourcesById=new Map(catalogRows.map(row=>[row.sourceId,row]));catalogVersion=version;return catalogRows;};
 // 读取当前来源的人工字段，包括清空后为空，避免旧配置副本盖回原颜色。
 const withLiveHardware=(part,sources=sourcesById)=>{
  const source=sources.get(part?.sourceId);
  return source&&source.goodsId===part?.goodsId?{...part,hardwareOverrides:source.hardwareOverrides,hardwareFacts:source.hardwareFacts}:part;
 };
 const model=(cardId=null)=>{const editing=cardId?find(cardId):api.current(),visible=cardId?(api.cardAvailable?.()??api.available()).filter(c=>c.productId===editing?.productId&&c.shopId===editing?.shopId):configs(),details=visible.map(c=>find(c.id)).filter(Boolean),term=details.length===visible.length?productInstallment(details):undefined,settings=api.settings(editing?.shopId),ids=new Set(visible.map(c=>c.id));const catalog=pickerCatalog(editing?.shopId),cardCosts=stockCosts,cardSources=sourcesById,sharedIndex=new Map([...cardCosts].map(([id,rows])=>[id,rows[0]]));const cost=part=>isSpecialComponent(part)?null:cardCosts.get(String(part?.goodsId??''))?.[0];return {portalContainer:host.ownerDocument.body,cardId,active:editing?.id,productId:editing?.productId,loading,error:lastError,retry:()=>render(),configs:visible.map(c=>({...project(c,settings,term),taxOverrides:find(c.id)?taxOverrideLines(find(c.id),sharedIndex):[]})),
 restoreTaxes:id=>safe(()=>api.restoreTaxes(taxOverrideLines(find(id),sharedIndex).map(line=>({configId:id,lineKey:line.lineKey})))),
 catalog,manualTax:part=>cost(part)?.nasManualTax===true,stock:part=>componentStockView(part,cardCosts),different:part=>differentTax(part,cost(part)),globalTax:part=>cost(part)?.globalTax||null,baseTax:part=>cost(part)?.tax??part.taxOverride?.base??null,
 describePart:(part,shown,slot)=>erpDescription(withLiveHardware(part,cardSources),withLiveHardware(shown,cardSources),
  cost(part)?.nasErpOverride?cost(part).name:part?.erpName||cost(part)?.erpName||cost(part)?.name,slot),
 erpSearch:lookupErp,
 adoptErp:(id,slot,item)=>safe(async()=>pickSource(id,slot,true,await api.adoptErp(id,slot,item))),
 configurationBenefits:api.configurationBenefits,
 canUndo:api.canUndo(),canRedo:api.canRedo(),undo:api.undo,redo:api.redo,
 diffCount:overviewTaxDifferenceCount(details,new Map([...stockCosts].map(([id,rows])=>[id,rows[0]]))),
 manualTaxConfigCount:details.filter(config=>actualParts(config).some(part=>cost(part)?.nasManualTax===true)).length,term,
 installment:enabled=>safe(async()=>{await api.loadScope?.([...ids]);return api.updateMany([...ids],c=>{c.installment=enabled?24:0;},enabled?'开启整链分期':'关闭整链分期');}),
 fee:(id,value,all=false)=>safe(async()=>{const rate=readOverviewFeeRate(value);await api.loadScope?.(all?[...ids]:[id]);const selected=(all?[...ids]:[id]).map(find).filter(c=>c&&c.overviewFeeRate!==rate);if(selected.length)return api.updateMany(selected.map(c=>c.id),c=>{c.overviewFeeRate=rate;},all?'应用全部运营费率':'修改运营费率');}),
 activate:id=>{if(!cardId&&api.current()?.id!==id)api.activate(id);},
 select:(id,value)=>{api.select(id,value);draw();},
 removeRow:(id,slot)=>safe(()=>{const c=find(id);if(!c)throw Error('目标配置已变化');const after=planRemoveRow(c,slot);api.update(id,target=>Object.assign(target,after),'删除配件行',true);api.toast('配件已移除，可撤销');return true;}),
 addRow:id=>safe(()=>api.update(id,c=>appendAccessoryRow(c),'增加配件行')),
 removeLastRow:id=>safe(()=>api.update(id,c=>removeLastAccessoryRow(c),'减少配件行')),
 duplicate:id=>safe(()=>api.duplicate(id)),
 insertBlank:id=>safe(()=>api.insertBlank(id)),
 remove:id=>safe(()=>api.remove(id)),
 // 快捷入口仍使用输出源维护会话，商品关联与计价不从展示文字反推。
 editSource:(id,slot)=>safe(()=>api.editSource(id,slot)),
 // 11-19：到手价 ±100、取 99 结尾。
 priceStep:(id,delta)=>safe(()=>{const c=find(id);if(!c)throw Error('配置已变化');const now=Number(c.price);if(c.price==null||c.price===''||!Number.isFinite(now))throw Error('请先填写到手价');let next=now+delta;if(c.overviewPrice99)next=snap99(next);if(next<0)throw Error('到手价不能小于 0');api.update(id,x=>{x.price=next;},delta>0?'到手价 +100':'到手价 −100');}),
 // 整链取 99：和整链分期一样，一开整个链接的配置都按 99 结尾。
 price99:enabled=>safe(async()=>{await api.loadScope?.([...ids]);return api.updateMany([...ids],c=>{c.overviewPrice99=!!enabled;if(enabled&&c.price!=null&&Number.isFinite(Number(c.price))&&c.price!=='')c.price=snap99(Number(c.price));},enabled?'整链到手价取 99 结尾':'取消整链取 99');}),
 price99On:details.length>0&&details.every(c=>c.overviewPrice99===true),
 field:(id,key,value)=>safe(()=>{if(!['name','version','price'].includes(key))throw Error('不支持的配置字段');let next=key==='price'?parseArrival(String(value).replace(/[,，]/g,'')):value;if(key==='price'&&next!=null&&find(id)?.overviewPrice99&&Number.isFinite(Number(next)))next=snap99(Number(next));if(find(id)?.[key]!==next)api.update(id,c=>{c[key]=next;},'连续编辑配置');}),
 partField:(id,slot,actual,key,value)=>safe(()=>{if(!find(id)||!continuousSlotsFor(find(id)).includes(slot)||!['qty','displayName','upgrade','posterVisible','overviewAddonHidden'].includes(key))throw Error('不支持的配件字段');if(key==='qty'&&(!Number.isInteger(Number(value))||Number(value)<1||Number(value)>1000))throw Error('数量必须为 1–1000 的整数');api.update(id,c=>{if(actual&&key==='qty'){changeQuantity(c,slot,Number(value));return;}const i=ensure(c,slot,actual),p=c[actual?'actualParts':'parts'][i];// 新增加购时清除旧描述遗留的隐藏状态，两项记录在同一次编辑里。
 if(key==='upgrade'&&!String(p.upgrade??'').trim()&&value)delete p.overviewAddonHidden;
 if(key==='displayName'&&(!value||value===p.name))delete p.displayName;else p[key]=key==='qty'?Number(value):value;if(key==='displayName'||key==='upgrade')markSourceFieldManual(p,key==='displayName'?'name':'upgrade');},'连续编辑配件',actual);}),
 pick:(id,slot,actual,sourceId)=>safe(()=>pickSource(id,slot,actual,sourceId)),
 // 与粘贴空型号共用逻辑，把同槽位两列的修改记为一次编辑。
 clearActual:(id,slot)=>safe(()=>{
  api.update(id,c=>{
   const part=actualParts(c).find(row=>row.slot===slot);
   if(!part||!(part.name||part.goodsId||part.sourceId))throw Error('实际配件已变化，请重新编辑');
   changeActual(c,slot);
  },'清空实际配件',true);
  api.toast('已清空实际配件，可撤销');
  return true;
 }),
 tax:(id,slot,value)=>safe(()=>{api.update(id,c=>{const p=c.actualParts?.find(p=>p.slot===slot);if(!p?.goodsId)throw Error('请先选择实际配件');changeOverviewTax(p,value,cost(p));},'修改配置独立核算价',true);}),
 taxReset:(id,slot)=>safe(()=>{api.update(id,c=>{const p=c.actualParts?.find(p=>p.slot===slot);if(!p?.goodsId)throw Error('请先选择实际配件');resetConfigCost(p,api.costs());},'恢复成本表核算价',true);api.toast('已恢复成本表价格，可撤销');}),
 taxGlobalRestore:(id,slot)=>safe(()=>{const c=find(id),p=c?.actualParts?.find(p=>p.slot===slot);if(!p?.goodsId)throw Error('请先选择实际配件');api.applyGlobalTax(p.goodsId,null,p.name,true);}),
 upgradeScope:(id,slot,scope)=>safe(()=>{const c=find(id),p=c?.parts?.find(p=>p.slot===slot);if(!p||!(p.sourceId||p.goodsId||p.name))throw Error('请先选择展示配件');if(!String(p.upgrade??'').trim())throw Error('请先填写加购描述');api.applyUpgrade(id,slot,scope);}),
 taxGlobal:(id,slot)=>safe(()=>{const c=find(id),p=c?.actualParts?.find(p=>p.slot===slot);if(!p?.goodsId)throw Error('请先选择实际配件');api.applyGlobalTax(p.goodsId,p.tax,p.name);}),
 pasteActual:(id,start,column,text)=>safe(()=>{
  const target=find(id);if(!target||!text)throw Error('请先复制有效的型号或数量');
  const lines=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();
  const slots=continuousSlotsFor(target),sources=api.catalog(target.shopId).filter(row=>!row.deletedAt);
  const clean=value=>value.normalize('NFKC').trim().toLowerCase();
  const plan=lines.map((line,index)=>{
   const slot=slots[start+index],cells=line.split('\t');
   const startCol=cells.length===2?0:column;
   if(!slot||startCol+cells.length>2)throw Error('粘贴区域超出本套配置');
   return cells.map((value,offset)=>{
    const col=startCol+offset,typed=clean(value);
    if(col===1){const qty=typed===''?1:Number(typed);if(!/^\d*$/.test(typed)||!Number.isInteger(qty)||qty<1||qty>1000)throw Error(slot+'数量必须为 1–1000 的整数');return {slot,qty};}
    if(!typed)return {slot,clear:true};
    // 11-19：工作台内部复制会带上输出源 ID，先按 ID 精确对应（价格、GoodID 随之带过去）；外部粘贴再按 GoodID 或名称匹配。
    const bySource=sources.filter(row=>row.sourceId&&clean(String(row.sourceId))===typed);
    const matches=bySource.length?bySource:sources.filter(row=>clean(String(row.goodsId||''))===typed||clean(String(row.name||''))===typed);
    if(matches.length!==1)throw Error(slot+'无法唯一匹配该型号或 GoodID');
    return {slot,source:matches[0]};
   });
  }).flat();
  api.update(id,c=>{
   for(const item of plan){
    if(item.clear||item.source)changeActual(c,item.slot,item.source);
    else changeQuantity(c,item.slot,item.qty);
   }
  },'粘贴实际配件',true);
  api.toast('已粘贴 '+lines.length+' 行 · 可撤销');
 }),
 copy:(id,indexes)=>safe(()=>{clipboard=copyRows(find(id),indexes);return clipboard;}),
 paste:(id,start,payload=clipboard)=>safe(()=>{const c=find(id);if(!c)throw Error('目标配置已变化');const after=planPasteRows(c,start,payload,api.catalog());api.update(id,target=>Object.assign(target,after),'按位置粘贴配件',true);return true;}),
 detail:async(id,target)=>{await api.activate(id);if(api.current()?.id===id)api.tab(target);},
 notice:api.toast,
 // 11-19：在利润格填目标利润，反推到手价（四舍五入到元；勾了取 99 再按 99 规则取整）。
 priceForProfit:(id,kind,target)=>priceForProfit(find(id),kind,target),
 targetProfit:(id,kind,value)=>safe(()=>{
  const text=String(value??'').normalize('NFKC').replace(/[,，\s]/g,'').replace(/^[−–]/,'-'),target=Number(text);
  if(text===''||text==='-'||!Number.isFinite(target))throw Error('请输入目标利润，可为负数');
  const c=find(id);if(!c)throw Error('配置已变化，请重新选择');
  const price=priceForProfit(c,kind,target);
  if(price==null)throw Error('成本不完整，无法反推到手价');
  if(price<0)throw Error('目标利润过低，反推出的到手价小于 0');
  if(c.price!==price)api.update(id,next=>{next.price=price;},(kind==='tax'?'按核算利润':'按 ERP 利润')+'反推到手价');
 }),
 };};
 // 反推公式与 overviewTableTotals 同口径：
 // 核算利润 = 到手价 − 核算成本 − 分期费；ERP 利润 = 到手价 × 98% − ERP 总价（不扣分期）；分期费 = 到手价 × 分期费率。
 function priceForProfit(c,kind,target){
  if(!c||!Number.isFinite(target))return null;
  return priceForTarget(c,api.settings(c.shopId),kind,target);
 }
 function draw(){
  if(disposed||!api.current()||api.tab()!=='parts')return;
  const data=model(),title=document.querySelector('#product-panel .product-heading small');
  if(title){
   let count=title.querySelector('.overview-tax-count');if(!count){count=document.createElement('span');count.className='overview-tax-count';count.setAttribute('role','status');title.append(' · ',count);}
   count.textContent=data.loading||data.configs.some(c=>c.loading)?'核算价差异统计中…':data.diffCount+' 套配置核算价有差异';
   count.toggleAttribute('data-has-difference',data.diffCount>0);
   let manual=title.querySelector('.overview-manual-tax');
   if(!manual){manual=document.createElement('span');manual.className='overview-manual-tax';manual.setAttribute('role','status');title.append(manual);}
   manual.hidden=!data.manualTaxConfigCount;
   manual.textContent=data.manualTaxConfigCount+' 套配置含手动核算价 · 同步成本表时保留';

  }
  renderedCanUndo=data.canUndo;
  renderedCanRedo=data.canRedo;
  api.render(host,data);
 }
 // 批量保存回执可能在表格绘制之后更新历史栈。同一轮只刷新一次，并跳过已由普通渲染更新的状态。
 const historyNeedsDraw=()=>!disposed&&!host.hidden&&api.current()&&api.tab()==='parts'&&
  !document.body.classList.contains('host-template-mode')&&
  (renderedCanUndo!==api.canUndo()||renderedCanRedo!==api.canRedo());
 function syncHistory(){
  if(historySyncQueued||!historyNeedsDraw())return;
  historySyncQueued=true;
  queueMicrotask(()=>{
   historySyncQueued=false;
   if(historyNeedsDraw())draw();
  });
 }
 // 加购福利页沿用总表外壳，只展示文字编辑区，不重复出现身份和核算表单。
 async function render(){const hasConfig=!!api.current(),tab=api.tab(),visible=hasConfig&&tab==='parts';document.body.classList.toggle('overview-mode',hasConfig&&(visible||['style','perks','addon-packs','benefits'].includes(tab)));document.body.classList.toggle('continuous-mode',visible);host.hidden=!visible;if(!visible)return;const token=++epoch;loading=configs().some(c=>!find(c.id));lastError='';draw();try{for(const c of configs()){await api.load(c.id);if(token!==epoch||disposed)return;}loading=false;draw();}catch(e){if(token===epoch){loading=false;lastError=api.errorText?.(e)||e.message;draw();}}}
 const locate=id=>host.dispatchEvent(new CustomEvent('workbench-locate-config',{detail:id}));
 // 单卡与写配置总表共用模型、组件和所有领域写入动作，根由调用方按配置身份释放。
 return {render,draw,syncHistory,locate,host,renderCard:(container,id)=>api.renderCard(container,model(id)),releaseCard:container=>api.release(container),dispose(){disposed=true;epoch++;api.release(host);host.remove();}};
}
