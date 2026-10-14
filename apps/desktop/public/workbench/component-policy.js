/** 统一商品候选排除规则，避免不同选择控件显示不应使用的商品。 */
// ERP asterisk markers exclude components from new selections, not saved configurations.
/** 判断商品是否命中排除条件。 */
export const excludedComponent=row=>[row?.name,row?.originalName,row?.erpName].some(name=>/[＊*]/.test(String(name??'')));
/** 结合商品行与成本资料过滤可选择的配件。 */
export function selectableComponents(rows,costs=[]){const blocked=new Set(costs.filter(excludedComponent).map(r=>r.goodsId));return rows.filter(r=>!excludedComponent(r)&&!blocked.has(r.goodsId));}
