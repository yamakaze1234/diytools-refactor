/** 海报宽度测量：按配件名称、列布局和版式计算绘图所需宽度。 */
import {posterParts} from './core.js';
// Keep measurement and rendering on the same column grid.
/** 计算当前配置在紧凑或详情布局下的列分配。 */
export function posterColumns(config,{tightRows=true,unifiedPanel=true,compact=config.layout==='square'}={}){
 if(unifiedPanel)return config.layout==='square'?{inset:20,categoryWidth:84,rightInset:12,labelGap:20}:{inset:16,categoryWidth:76,rightInset:12,labelGap:16};
 return {inset:tightRows?6:12,categoryWidth:tightRows?48:compact?60:68,rightInset:tightRows?8:12,labelGap:tightRows?4:10};
}
// Measure visible model text at its intended font size, before export scaling.
/** 利用 Canvas 字体测量估算画布宽度，并限制在允许范围内。 */
export function modelCanvasWidth(ctx,config,{minimum=420,maximum=900,tightRows=true,unifiedPanel=true}={}){
 const module=(config.modules||[]).find(m=>m.type==='parts');
 if(module?.visible===false)return minimum;
 let longest=0;
 for(const part of posterParts(config)){
  const style=config.textStyles?.[`part.${part.slot}.name`]||{};
  if(style.hidden)continue;
  const size=Number(style.size)||(Number(module?.size)||19)*(config.layout==='square'?.9:1);
  const weight=Number(style.weight)||Number(module?.weight)||600;
  const family=style.fontFamily||config.fontFamily||'Microsoft YaHei';
  const font=value=>`${value.italic?'italic ':''}${value.weight} ${value.size}px "${value.family}",sans-serif`;
  const base={italic:!!style.italic,weight,size,family};
  ctx.font=font(base);
  const text=style.text??(part.name+(Number(part.qty)>1?` ×${part.qty}`:''));
  if(!style.ranges?.length){for(const line of String(text).split('\n'))longest=Math.max(longest,ctx.measureText(line).width);}
  else{
   let width=0,offset=0;
   for(const ch of String(text)){
    const current={...base};
    for(const range of style.ranges)if(offset>=range.start&&offset<range.end){Object.assign(current,range.style);current.family=range.style?.fontFamily||current.family;}
    offset+=ch.length;
    if(ch==='\n'){longest=Math.max(longest,width);width=0;continue;}
    ctx.font=font(current);width+=ctx.measureText(ch).width;
   }
   longest=Math.max(longest,width);
  }
 }
 // Match the renderer margins, category column and right text padding.
 const {categoryWidth,rightInset}=posterColumns(config,{tightRows,unifiedPanel});
 return Math.ceil(Math.max(minimum,Math.min(maximum,longest+(unifiedPanel?64:tightRows?32:52)+categoryWidth+rightInset)));
}
