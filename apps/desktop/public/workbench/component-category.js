// 以库存查询的大分类为准；历史工作台标签也沿用同一套归类规则。
import rules from './component-category-rules.js';
const erpCategories=new Map(Object.entries(rules.aliases));
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().trim();
// 附件名称常带适配型号，按共享规则中的商品识别优先级匹配。
const categoryPatterns=rules.patterns.map(([category,source])=>[category,new RegExp(source,'i')]);

// 精确枚举优先；历史分类和缺分类商品可按名称补识别。
export function categoryFromName(value){
 const name=normalize(value);
 return categoryPatterns.find(([,pattern])=>pattern.test(name))?.[0];
}
export function categoryFromErp(value){
 return erpCategories.get(normalize(value))||categoryFromName(value);
}

/** 按新到旧查找 ERP 大类；明确清空后改用部位或名称，不再取更老的分类。 */
export function observedErpCategory(...values){
 for(const value of values){
  if(value===null)return undefined;
  if(value===undefined)continue;
  const category=categoryFromErp(value);
  if(category)return category;
 }
}
