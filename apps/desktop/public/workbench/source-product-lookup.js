/** 来源商品绑定控件：在输出源草稿里搜索并选择 ERP 商品。 */
// Offline editor may use imported ERP fields, but never queries SQL or ERP.
/** 将商品搜索结果写入当前来源草稿，再通知外层刷新相关字段。 */
export function mountSourceProductLookup(root,{draft,getCosts,onChange}){
 const id=root.querySelector('#source-id'),name=root.querySelector('#source-name'),price=root.querySelector('#source-erp-price'),status=root.querySelector('#source-erp-status'),refresh=root.querySelector('#source-erp-refresh');
 let edited=!!name.value.trim(),lastId=id.value.trim();
 const show=(row,fillName=false)=>{
  const value=row?.erp;price.value=value!==null&&value!==undefined&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value).toFixed(2):'暂无';
  if(fillName&&!edited&&(row?.erpName||row?.name))name.value=row.erpName||row.name;
  status.textContent=row?'本机已导入的 ERP 记录，非实时查询':'本机暂无此商品的 ERP 记录';onChange();
 };
 name.addEventListener('input',()=>{edited=true;});
 id.addEventListener('input',()=>{const next=id.value.trim();if(next!==lastId){lastId=next;edited=false;name.value='';}show(getCosts().find(row=>row.goodsId===next),true);});
 refresh.disabled=true;refresh.title='离线版尚未接入实时 ERP / SQL 查询';
 show(getCosts().find(row=>row.goodsId===lastId)||draft);
 return {observation:()=>null,isPending:()=>false,dispose:()=>{}};
}
