import {configHardwareIssues} from './component-hardware.js';
/** 连续编辑只编排现有领域操作；业务保存、批量、同步仍由原工作台持有。 */
import {projectedRows,copyRows,planPasteRows,continuousSlotsFor,appendAccessoryRow,planRemoveRow} from './continuous-parts.js';
import {totals} from './core.js';
import {pricing,productInstallment} from './pricing.js';
import {actualParts} from './actual-parts.js';
import {parseArrival} from './price-profit-model.js';
import {replaceSourcePart} from './source.js';
import {markSourceFieldManual} from './source-follow.js';
import {componentStockView} from './component-stock-view.js';
import {changeOverviewTax,differentTax,overviewTableTotals,overviewTaxDifferenceCount,readOverviewFeeRate} from './overview-table-model.js';
export function createContinuousWorkbench(api){
 const host=document.createElement('section');host.id='continuous-workbench';document.querySelector('.tabs').after(host);
 let epoch=0,clipboard=null,loading=false,lastError='',disposed=false;
 const configs=()=>api.available().filter(c=>c.productId===api.current()?.productId);
 const find=id=>api.configs().find(c=>c.id===id);
 const safe=fn=>{try{return fn();}catch(e){api.toast(e.message);return false;}};
 const blank=(slot,lineId)=>({slot,lineId:lineId||crypto.randomUUID(),name:'',goodsId:'',qty:1,erp:null,tax:null,upgrade:''});
 const ensure=(c,slot,actual)=>{const key=actual?'actualParts':'parts';c[key]??=actual?structuredClone(actualParts(c)):[];let i=c[key].findIndex(p=>p.slot===slot);if(i<0){i=c[key].length;c[key].push(blank(slot));}return i;};
 // 空白展示行和同型号展示行随实际型号变动，独立选择的展示配件保留。
 function sameModel(a,b){
  if(a.sourceId&&b.sourceId)return a.sourceId===b.sourceId;
  if(a.goodsId&&b.goodsId)return String(a.goodsId)===String(b.goodsId);
  return !!a.name&&a.name===b.name;
 }
 function changeActual(config,slot,source){
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
 function changeQuantity(config,slot,qty){
  const index=ensure(config,slot,true),part=config.actualParts[index],display=config.parts?.find(row=>row.slot===slot);
  if(display&&display.qty===part.qty&&sameModel(display,part))display.qty=qty;
  part.qty=qty;
 }
 let catalogVersion,catalogRows=[],stockCosts=new Map();const projections=new Map();
 const project=(summary,settings,term)=>{const c=find(summary.id);if(!c)return {id:summary.id,name:summary.name,loading:true};const selected=api.selected().has(c.id),version=JSON.stringify([c,settings,selected,term]),cached=projections.get(c.id);if(cached?.version===version)return cached.value;const rows=projectedRows(c),raw=totals(c,settings),quote=pricing(c,{...settings,linkInstallment:term===null?null:undefined}),value={...c,hardwareIssues:configHardwareIssues(c),rows,extras:rows.extras,raw,totals:overviewTableTotals(c,raw,quote),pricing:quote,selected};projections.set(c.id,{version,value});return value;};
 // 一次构建库存索引和共享候选；每个输入框不再复制整份目录或逐条扫描成本表。
 const pickerCatalog=()=>{const version=api.catalogVersion();if(catalogVersion===version)return catalogRows;const costs=new Map();for(const row of api.costs()){if(!costs.has(row.goodsId))costs.set(row.goodsId,[]);costs.get(row.goodsId).push(row);}stockCosts=costs;catalogRows=api.catalog().map(p=>({...p,value:p.sourceId,label:p.name,searchText:(p.name+' '+p.goodsId).toLowerCase(),stock:componentStockView(p,costs)}));catalogVersion=version;return catalogRows;};
 const model=()=>{const visible=configs(),details=visible.map(c=>find(c.id)).filter(Boolean),term=details.length===visible.length?productInstallment(details):undefined,settings=api.settings(),ids=new Set(visible.map(c=>c.id));for(const id of projections.keys())if(!ids.has(id))projections.delete(id);const catalog=pickerCatalog();const cost=part=>stockCosts.get(String(part?.goodsId??''))?.[0];return {portalContainer:host.ownerDocument.body,active:api.current()?.id,loading,error:lastError,retry:()=>render(),configs:visible.map(c=>project(c,settings,term)),
 catalog,stock:part=>componentStockView(part,stockCosts),different:part=>differentTax(part,cost(part)),baseTax:part=>cost(part)?.tax??part.taxOverride?.base??null,
 canUndo:api.canUndo(),canRedo:api.canRedo(),undo:api.undo,redo:api.redo,
 diffCount:overviewTaxDifferenceCount(details,new Map([...stockCosts].map(([id,rows])=>[id,rows[0]]))),term,
 installment:enabled=>safe(()=>{if(details.length!==visible.length)throw Error('请等当前链接加载完成');api.updateMany([...ids],c=>{c.installment=enabled?24:0;},enabled?'开启整链分期':'关闭整链分期');}),
 fee:(id,value,all=false)=>safe(()=>{const rate=readOverviewFeeRate(value);if(all&&details.length!==visible.length)throw Error('请等当前链接加载完成');const selected=(all?details:details.filter(c=>c.id===id)).filter(c=>c.overviewFeeRate!==rate);if(selected.length)api.updateMany(selected.map(c=>c.id),c=>{c.overviewFeeRate=rate;},all?'应用全部运营费率':'修改运营费率');}),
 activate:id=>{if(api.current()?.id!==id)api.activate(id);},
 select:(id,value)=>{api.select(id,value);draw();},
 removeRow:(id,slot)=>safe(()=>{const c=find(id);if(!c)throw Error('目标配置已变化');const after=planRemoveRow(c,slot);api.update(id,target=>Object.assign(target,after),'删除配件行',true);api.toast('配件已移除，可撤销');return true;}),
 addRow:id=>safe(()=>api.update(id,c=>appendAccessoryRow(c),'新增配件行')),
 field:(id,key,value)=>safe(()=>{if(!['name','version','price'].includes(key))throw Error('不支持的配置字段');const next=key==='price'?parseArrival(String(value).replace(/[,，]/g,'')):value;if(find(id)?.[key]!==next)api.update(id,c=>{c[key]=next;},'连续编辑配置');}),
 partField:(id,slot,actual,key,value)=>safe(()=>{if(!find(id)||!continuousSlotsFor(find(id)).includes(slot)||!['qty','displayName','upgrade','posterVisible','overviewAddonHidden'].includes(key))throw Error('不支持的配件字段');if(key==='qty'&&(!Number.isInteger(Number(value))||Number(value)<1||Number(value)>1000))throw Error('数量必须为 1–1000 的整数');api.update(id,c=>{if(actual&&key==='qty'){changeQuantity(c,slot,Number(value));return;}const i=ensure(c,slot,actual),p=c[actual?'actualParts':'parts'][i];// 新增加购时清除旧描述遗留的隐藏状态，两项记录在同一次编辑里。
 if(key==='upgrade'&&!String(p.upgrade??'').trim()&&value)delete p.overviewAddonHidden;
 if(key==='displayName'&&(!value||value===p.name))delete p.displayName;else p[key]=key==='qty'?Number(value):value;if(key==='displayName'||key==='upgrade')markSourceFieldManual(p,key==='displayName'?'name':'upgrade');},'连续编辑配件',actual);}),
 pick:(id,slot,actual,sourceId)=>safe(()=>{const row=api.catalog().find(p=>p.sourceId===sourceId&&!p.deletedAt);if(!row)throw Error('配件来源已变化，请重新搜索');api.update(id,c=>{if(actual)changeActual(c,slot,row);else replaceSourcePart(c,ensure(c,slot,false),row);},actual?'更换实际配件':'更换展示配件',actual);}),
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
 pasteActual:(id,start,column,text)=>safe(()=>{
  const target=find(id);if(!target||!text)throw Error('请先复制有效的型号或数量');
  const lines=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();
  const slots=continuousSlotsFor(target),sources=api.catalog().filter(row=>!row.deletedAt);
  const clean=value=>value.normalize('NFKC').trim().toLowerCase();
  const plan=lines.map((line,index)=>{
   const slot=slots[start+index],cells=line.split('\t');if(!slot||column+cells.length>2)throw Error('粘贴区域超出本套配置');
   return cells.map((value,offset)=>{
    const col=column+offset,typed=clean(value);
    if(col===1){const qty=typed===''?1:Number(typed);if(!/^\d*$/.test(typed)||!Number.isInteger(qty)||qty<1||qty>1000)throw Error(slot+'数量必须为 1–1000 的整数');return {slot,qty};}
    if(!typed)return {slot,clear:true};
    const matches=sources.filter(row=>clean(String(row.goodsId||''))===typed||clean(String(row.name||''))===typed);
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
 };};
 function draw(){if(!disposed&&api.current()&&api.tab()==='parts'){const data=model();const title=document.querySelector('#product-panel .product-heading small');if(title){
  let count=title.querySelector('.overview-tax-count');if(!count){count=document.createElement('span');count.className='overview-tax-count';count.setAttribute('role','status');title.append(' · ',count);}
  count.textContent=data.loading||data.configs.some(c=>c.loading)?'核算价差异统计中…':data.diffCount+' 套配置核算价有差异';
  count.toggleAttribute('data-has-difference',data.diffCount>0);
 }api.render(host,data);}}
 async function render(){const hasConfig=!!api.current(),tab=api.tab(),visible=hasConfig&&tab==='parts';document.body.classList.toggle('overview-mode',hasConfig&&(visible||tab==='style'));document.body.classList.toggle('continuous-mode',visible);host.hidden=!visible;if(!visible)return;const token=++epoch;loading=configs().some(c=>!find(c.id));lastError='';draw();try{for(const c of configs()){await api.load(c.id);if(token!==epoch||disposed)return;}loading=false;draw();}catch(e){if(token===epoch){loading=false;lastError=e.message;draw();}}}
 const locate=id=>host.dispatchEvent(new CustomEvent('workbench-locate-config',{detail:id}));
 return {render,draw,locate,host,dispose(){disposed=true;epoch++;api.release(host);host.remove();}};
}
