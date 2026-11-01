import {ensureActualParts} from './actual-parts.js';
import {replaceSourcePart} from './source.js';

/** 明确的双侧替换按部位定位，不能依赖展示与实际清单的行号相同。 */
export function replaceBothParts(config,slot,replacement,qty=null){
 ensureActualParts(config);
 const display=config.parts.filter(p=>p.slot===slot),actual=config.actualParts.filter(p=>p.slot===slot);
 if(display.length>1||actual.length>1)throw Error(`${config.name} / ${slot} 有重复部位，请先核对配件`);
 if(!display.length&&!actual.length)throw Error(`${config.name} / ${slot} 已不存在，请重新预览`);
 if(!display.length)config.parts.push(structuredClone(actual[0]));
 if(!actual.length)config.actualParts.push(structuredClone(display[0]));
 for(const field of ['parts','actualParts']){
  const rows=config[field],index=rows.findIndex(p=>p.slot===slot);
  replaceSourcePart({...config,parts:rows},index,replacement);
  if(qty!==null)rows[index].qty=qty;
 }
}
