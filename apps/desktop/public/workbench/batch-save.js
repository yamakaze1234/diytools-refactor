/** 增量保存入口的资格检查：识别普通配置编辑，并核验批量预览使用的配件资料。 */
import {sameValue} from './workspace-ui-merge.js';

// Recheck the source rows after flushing earlier edits, before applying a preview.
/** 保存之前重新比对预览里的来源记录，阻止过期预览覆盖更新后的配件资料。 */
export function validateBatchSources(plan,catalog){
 const byId=new Map(catalog.map(row=>[row.sourceId,row]));
 for(const chosen of [...(plan.replacements||[]),...(plan.replacement?[plan.replacement]:[])]){
  if(!chosen?.sourceId||JSON.stringify(byId.get(chosen.sourceId))!==JSON.stringify(chosen))
   throw Error('配件资料已变化，请重新预览');
 }
}

// 对应 Rust ORDINARY_PRESENTATION_FIELDS；契约测试要求两端一致。
// 这里只包括配置自身的海报内容/样式，不包括链接、店铺设置或图库记录。
export const ordinaryPresentationFields=Object.freeze([
 'shop','layout','skuMode','posterDesignVersion','previousSquareLayout','autoWidth',
 'theme','productTheme','palette','themePalettes','fontFamily','modules','textStyles','skuTextStyles',
 'textTransforms','moduleTransforms','freeCanvasLayouts','caseImage','caseVisible',
 'caseTransforms','posterImages','showUpgrades','showWarranty','upgradeColor',
 'upgradeSize','upgradeWeight','posterFields','posterSubtitle','footer'
]);
// 每个 change 仍是完整配置的 base/after：保留未修改的未知字段，供后端核验和三方合并。
// 链接归属、配置顺序、删除和全局数据继续交给完整保存入口。
const ordinaryFields=new Set(['name','version','price','installment','parts','actualParts','addons','shortName','emptyLinkDraft','nameFormat','shortNameAuto',...ordinaryPresentationFields]);
/** 仅当配置顺序、归属和全局数据均未改变时返回完整 base/after；返回 null 表示必须走全量保存。 */
export function ordinarySaveChanges(base,snapshot,targetIds=null){
 if(!base||!snapshot)return null;
 const ignored=new Set(['configs','revision','updatedAt','logs','shops','dataVersion']);
 if([...new Set([...Object.keys(base),...Object.keys(snapshot)])].some(key=>!ignored.has(key)&&!sameValue(base[key],snapshot[key])))return null;
 if(!Array.isArray(base.configs)||!Array.isArray(snapshot.configs)||base.configs.length!==snapshot.configs.length)return null;
 const originals=new Map(base.configs.map(c=>[c.id,c]));
 if(originals.size!==base.configs.length||new Set(snapshot.configs.map(c=>c.id)).size!==snapshot.configs.length)return null;
 const changes=[];
 const targets=targetIds===null?null:new Set(targetIds);
 for(let i=0;i<snapshot.configs.length;i++){
  const after=snapshot.configs[i],before=originals.get(after.id);
  if(!before||before.id!==base.configs[i].id)return null;
  // Target selection is only valid for a capture certified by scoped-save.
  // An unexpected non-target replacement conservatively declines this path.
  if(targets&&!targets.has(after.id)){if(after!==before)return null;continue;}
  if(sameValue(before,after))continue;
  if(before.deletedAt||after.deletedAt||before.shopId!==after.shopId||before.productId!==after.productId)return null;
  if([...new Set([...Object.keys(before),...Object.keys(after)])].some(k=>!ordinaryFields.has(k)&&!sameValue(before[k],after[k])))return null;
  changes.push({id:after.id,base:before,after});
 }
 return changes.length&&changes.length<=1000?changes:null;
}
