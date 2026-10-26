/** 连续编辑只编排现有领域操作；业务保存、批量、同步仍由原工作台持有。 */
import {projectedRows,copyRows,planPasteRows,continuousSlotsFor,appendAccessoryRow,planRemoveRow} from './continuous-parts.js';
import {totals} from './core.js';
import {pricing} from './pricing.js';
import {overviewProfits} from './part-transfer.js';
import {replaceSourcePart} from './source.js';
import {markSourceFieldManual} from './source-follow.js';
import {componentStockView} from './component-stock-view.js';
import {setConfigCost} from './config-cost.js';
export function createContinuousWorkbench(api){
 const host=document.createElement('section');host.id='continuous-workbench';document.querySelector('.tabs').after(host);
 let epoch=0,clipboard=null,loading=false,lastError='',disposed=false;
 const configs=()=>api.available().filter(c=>c.productId===api.current()?.productId);
 const find=id=>api.configs().find(c=>c.id===id);
 const safe=fn=>{try{return fn();}catch(e){api.toast(e.message);return false;}};
 const blank=slot=>({slot,name:'',goodsId:'',qty:1,erp:null,tax:null,upgrade:''});
 const ensure=(c,slot,actual)=>{const key=actual?'actualParts':'parts';c[key]??=[];let i=c[key].findIndex(p=>p.slot===slot);if(i<0){i=c[key].length;c[key].push(blank(slot));}return i;};
 let catalogVersion,catalogRows=[],stockCosts=new Map();const projections=new Map();
 const project=summary=>{const c=find(summary.id);if(!c)return {id:summary.id,name:summary.name,loading:true};const settings=api.settings(),selected=api.selected().has(c.id),version=JSON.stringify([c,settings,selected]),cached=projections.get(c.id);if(cached?.version===version)return cached.value;const rows=projectedRows(c),t=totals(c),[taxProfit,erpProfit]=overviewProfits(c,settings),value={...c,rows,extras:rows.extras,totals:{erp:t.erp,tax:t.tax,taxProfit,erpProfit,taxProfitBefore:taxProfit===null?null:Math.round(t.taxProfit*100)/100,erpProfitBefore:erpProfit===null?null:Math.round(t.erpProfit*100)/100},pricing:pricing(c,settings),selected};projections.set(c.id,{version,value});return value;};
 // 一次构建库存索引和共享候选；每个输入框不再复制整份目录或逐条扫描成本表。
 const pickerCatalog=()=>{const version=api.catalogVersion();if(catalogVersion===version)return catalogRows;const costs=new Map();for(const row of api.costs()){if(!costs.has(row.goodsId))costs.set(row.goodsId,[]);costs.get(row.goodsId).push(row);}stockCosts=costs;catalogRows=api.catalog().map(p=>({...p,value:p.sourceId,label:p.name,searchText:(p.name+' '+p.goodsId).toLowerCase(),stock:componentStockView(p,costs)}));catalogVersion=version;return catalogRows;};
 const model=()=>{const visible=configs(),ids=new Set(visible.map(c=>c.id));for(const id of projections.keys())if(!ids.has(id))projections.delete(id);return {portalContainer:host.ownerDocument.body,active:api.current()?.id,loading,error:lastError,retry:()=>render(),configs:visible.map(project),
 catalog:pickerCatalog(),stock:part=>componentStockView(part,stockCosts),
 activate:id=>{if(api.current()?.id!==id)api.activate(id);},
 select:(id,value)=>{api.select(id,value);draw();},
 removeRow:(id,slot)=>safe(()=>{const c=find(id);if(!c)throw Error('目标配置已变化');const after=planRemoveRow(c,slot);api.update(id,target=>Object.assign(target,after),'删除配件行',true);api.toast('配件已移除，可撤销');return true;}),
 addRow:id=>safe(()=>api.update(id,c=>appendAccessoryRow(c),'新增配件行')),
 field:(id,key,value)=>safe(()=>{if(!['name','version','price'].includes(key))throw Error('不支持的配置字段');if(key==='price'&&(!Number.isFinite(Number(value))||Number(value)<0))throw Error('到手价必须为非负金额');api.update(id,c=>{c[key]=key==='price'?Number(value):value;},'连续编辑配置');}),
 partField:(id,slot,actual,key,value)=>safe(()=>{if(!find(id)||!continuousSlotsFor(find(id)).includes(slot)||!['qty','displayName','upgrade'].includes(key))throw Error('不支持的配件字段');if(key==='qty'&&(!Number.isInteger(Number(value))||Number(value)<1))throw Error('数量必须是正整数');api.update(id,c=>{const i=ensure(c,slot,actual),p=c[actual?'actualParts':'parts'][i];p[key]=key==='qty'?Number(value):value;if(key==='displayName'||key==='upgrade')markSourceFieldManual(p,key==='displayName'?'name':'upgrade');},'连续编辑配件');}),
 pick:(id,slot,actual,sourceId)=>safe(()=>{const row=api.catalog().find(p=>p.sourceId===sourceId&&!p.deletedAt);if(!row)throw Error('配件来源已变化，请重新搜索');api.update(id,c=>{const i=ensure(c,slot,actual);replaceSourcePart(actual?{...c,parts:c.actualParts,addons:[]}:c,i,row);},actual?'更换实际配件':'更换展示配件');}),
 tax:(id,slot,value)=>safe(()=>{api.update(id,c=>{const p=c.actualParts.find(p=>p.slot===slot);if(!p?.goodsId)throw Error('请先选择实际配件');setConfigCost(p,value);},'修改配置独立核算价');}),
 copy:(id,indexes)=>safe(()=>{clipboard=copyRows(find(id),indexes);return clipboard;}),
 paste:(id,start,payload=clipboard)=>safe(()=>{const c=find(id);if(!c)throw Error('目标配置已变化');const after=planPasteRows(c,start,payload,api.catalog());api.update(id,target=>Object.assign(target,after),'按位置粘贴配件',true);return true;}),
 detail:async(id,target)=>{await api.activate(id);if(api.current()?.id===id)api.tab(target);},
 notice:api.toast,
 };};
 function draw(){if(!disposed&&api.current()&&api.tab()==='parts')api.render(host,model());}
 async function render(){const visible=!!api.current()&&api.tab()==='parts';document.body.classList.toggle('continuous-mode',visible);host.hidden=!visible;if(!visible)return;const token=++epoch;loading=configs().some(c=>!find(c.id));lastError='';draw();try{for(const c of configs()){await api.load(c.id);if(token!==epoch||disposed)return;}loading=false;draw();}catch(e){if(token===epoch){loading=false;lastError=e.message;draw();}}}
 const locate=id=>host.dispatchEvent(new CustomEvent('workbench-locate-config',{detail:id}));
 return {render,draw,locate,host,dispose(){disposed=true;epoch++;api.release(host);host.remove();}};
}
