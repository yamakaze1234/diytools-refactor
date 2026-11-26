import {ensureActualParts} from './actual-parts.js';
import {markSourceFieldManual} from './source-follow.js';
import {replaceSourcePart} from './source.js';

/** 明确的双侧替换按部位定位，不能依赖展示与实际清单的行号相同。 */
export function replaceBothParts(config,slot,replacement,qty=null,options=null){
 ensureActualParts(config);
 const display=config.parts.filter(p=>p.slot===slot),actual=config.actualParts.filter(p=>p.slot===slot);
 if(display.length>1||actual.length>1)throw Error(`${config.name} / ${slot} 有重复部位，请先核对配件`);
 if(!display.length&&!actual.length)throw Error(`${config.name} / ${slot} 已不存在，请重新预览`);
 if(!display.length)config.parts.push(structuredClone(actual[0]));
 if(!actual.length)config.actualParts.push(structuredClone(display[0]));
 // 只由展示侧更新配置的加购组；实际侧独立更新型号、价格和原数量。
 const displayIndex=config.parts.findIndex(p=>p.slot===slot),actualIndex=config.actualParts.findIndex(p=>p.slot===slot);
 replaceSourcePart(config,displayIndex,replacement);
 replaceSourcePart({...config,parts:config.actualParts},actualIndex,replacement,{syncAddons:false});
 if(qty!==null){config.parts[displayIndex].qty=qty;config.actualParts[actualIndex].qty=qty;}
 // 自定义名称仅跟随展示行，实际 BOM 继续使用所选输出源。
 const name=typeof options?.displayName==='string'?options.displayName.trim():'';
 if(name&&name!==replacement.name){
  const part=config.parts.find(p=>p.slot===slot);
  part.displayName=name;
  markSourceFieldManual(part,'name');
 }
}
