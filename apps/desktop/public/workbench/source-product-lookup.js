import {componentStockHtml} from './component-stock-view.js';

/** 绑定输出源表单，先显示同步记录，按需使用公司 ERP 只读查询。 */
export function mountSourceProductLookup(root,{draft,getCosts,onChange,nas=false,lookupProduct,isNew=false,showObservation}){
 const id=root.querySelector('#source-id'),name=root.querySelector('#source-name');
 const price=root.querySelector('#source-erp-price'),stock=root.querySelector('#source-stock');
 const status=root.querySelector('#source-erp-status'),refresh=root.querySelector('#source-erp-refresh');
 const canLookup=nas&&!!lookupProduct;
 let edited=!!name.value.trim(),lastId=id.value.trim(),liveRow=null,pending=false,generation=0,disposed=false;

 const validId=()=>/^[1-9]\d{0,19}$/.test(lastId);
 const cached=()=>lastId&&getCosts().find(row=>row.goodsId===lastId);
 const updateButton=()=>{refresh.disabled=!canLookup||pending||!validId();};
 const show=(row,message,fillName=false)=>{
  const stockRows=liveRow?[liveRow]:getCosts();
  if(showObservation)showObservation(row,stockRows);
  else{
   const value=row?.erp;
   price.value=value!=null&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value).toFixed(2):'暂无';
   stock.innerHTML=componentStockHtml({goodsId:lastId},stockRows);
  }
  if(fillName&&!edited&&(row?.erpName||row?.name))name.value=row.erpName||row.name;
  status.textContent=message;
  onChange();
 };
 const showCached=(fillName=false)=>{
  const row=cached(),scope=nas?'工作区':'本机';
  const message=!lastId?'请输入 ERP ID':row?`${scope}已同步的 ERP 记录，非实时查询`:
   canLookup&&validId()?`${scope}暂无同步记录，可查询公司 ERP。`:`${scope}暂无此商品的 ERP 记录`;
  show(row||(lastId===draft.goodsId?draft:null),message,fillName);
 };

 name.addEventListener('input',()=>{edited=true;});
 id.addEventListener('input',()=>{
  const next=id.value.trim();
  if(next===lastId)return;
  lastId=next;edited=false;name.value='';liveRow=null;pending=false;generation++;
  updateButton();showCached(true);
 });
 refresh.title=canLookup?'查询公司 ERP；未保存本店连接时可选用原工作台保存的连接。':'当前环境未启用 ERP 实时查询。';
 if(canLookup){
  refresh.textContent='查询 ERP 名称与单价';
  refresh.onclick=async()=>{
   if(refresh.disabled)return;
   const token=++generation;
   const current=()=>!disposed&&token===generation&&root.contains(id);
   pending=true;updateButton();status.textContent='正在查询公司 ERP…';
   try{
    const {row,cancelled}=await lookupProduct(lastId);
    if(!current())return;
    if(cancelled){status.textContent='未选择已保存的连接。也可在 ERP 同步中设置本店只读连接。';return;}
    // 放弃已经失效的输入结果，也不把实时数据写入工作区成本源。
    liveRow=row?{...row,stockUpdatedAt:new Date().toISOString()}:null;
    if(liveRow)show(liveRow,`公司 ERP · ${liveRow.name}`,true);
    else show(cached(),`公司 ERP 未查到商品 ${lastId}。`);
   }catch(error){
    if(current())status.textContent='查询 ERP 失败。'+(error?.message||'请检查公司数据库连接。');
   }finally{
    if(current()){pending=false;updateButton();}
   }
  };
 }
 updateButton();showCached();
 return {
  // 新增时保留原 ERP 名称，供排除规则和输出源导出使用。
  observation:()=>isNew&&liveRow?{erpName:liveRow.name}:null,
  isPending:()=>pending,
  dispose:()=>{disposed=true;},
 };
}
