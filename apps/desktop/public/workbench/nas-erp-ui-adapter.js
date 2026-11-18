// 原 ERP 页面共用表单及差异表；本适配器只管理受限只读预览和已确认的 NAS 写计划。
import {planNasErpRows} from './nas-cost-overlay.js';
import {REPAIRED_HOST_COST} from './maintenance-workbook.js';

// 输出源查询独立于同步计划，找新品时无需先在工作区建立成本记录。
export async function lookupNasSourceProduct(read,goodsId){
 const {saved}=await read('erp-status');
 // 没有本店连接时，在原生选择器中临时选用已保存的连接。
 const result=await read(saved?'erp':'erp-saved',[goodsId]);
 if(result.cancelled)return {cancelled:true};
 return {row:result.rows.find(row=>row.goodsId===goodsId)};
}

export function createNasErpUiAdapter({read,snapshot,context,apply,shopName='英特尔',now=()=>Date.now(),id=()=>crypto.randomUUID()}){
 const plans=new Map();
 let layout={sheet:REPAIRED_HOST_COST.sheet,goodsColumn:13,taxColumn:26};
 const settings=fields=>({mode:'nas',path:'',...layout,...fields});
 async function preview(kind,mode,input){
  const before=snapshot();
  if(!before.size)throw Error('本店没有可核对的商品 ID。');
  const stamp=context(),source=await read(mode,[...before.keys()],input);
  if(source.cancelled)return {cancelled:true};
  const at=now(),plan=planNasErpRows(source.rows,before,kind,new Date(at).toISOString()),key=id();
  const table=plan.changes.map(row=>{
   const old=before.get(row.id).document;
   return kind==='erp'?{area:shopName,goodsId:row.id,name:row.fields.name||old.name,before:old.stockAvailable??null,
    after:row.fields.stockAvailable,erpBefore:old.erp??null,erpAfter:row.fields.erp}:
    {goodsId:row.id,before:old.tax??null,after:row.fields.tax};
  });
  plans.set(kind,{id:key,at,stamp,changes:plan.changes});
  return {id:key,source:source.settings||input?.settings,total:source.rows.length,matched:source.rows.length,unmatched:plan.missing,
   unknown:kind==='erp'?source.rows.filter(row=>row.stockAvailable===null).length:0,changes:table,
   examples:table.slice(0,80),changed:table.length,invalidCount:source.invalidCount||0};
 }
 async function confirm(kind,input){
  const draft=plans.get(kind);
  if(!draft||draft.id!==input?.id||!draft.changes.length||draft.stamp!==context()||now()-draft.at>=600000)
   throw Error('预览已过期或工作区已变化，请重新读取预览。');
  const outcome=await apply(draft.changes,kind);
  if(!outcome)return {cancelled:true};
  plans.delete(kind);return {committed:true};
 }
 return {
  async sqlRequest(route,data){
   if(route==='credentials')return read('erp-status');
   if(route==='credentials/clear'){plans.delete('erp');return read('erp-clear');}
   if(route==='preview-saved')return preview('erp','erp-saved');
   if(route==='preview')return data.useSaved?preview('erp','erp'):
    preview('erp','erp-form',{settings:data.settings,password:data.password,remember:data.remember});
   if(route==='apply')return confirm('erp',data);
   throw Error('不支持该 ERP 操作。');
  },
  async costRequest(route,data){
   if(route==='/api/cost-sync/settings'){
    if(data){layout={sheet:data.sheet,goodsColumn:data.goodsColumn,taxColumn:data.taxColumn};return settings({path:data.path});}
    const result=await read('tax-status');return settings(result.settings);
   }
   if(route==='/api/sql-sync/cost-file'){
    const result=await read('tax-choose');return result.cancelled?result:{path:result.settings.path};
   }
   if(route==='/api/sql-sync/cost-preview')return preview('tax-file','tax-read',layout);
   if(route==='/api/cost-sync/apply')return confirm('tax-file',data);
   throw Error('不支持该含税成本操作。');
  },
 };
}
