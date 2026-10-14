/** Canvas 文字排版：拆分富文本、计算适配比例并绘制文字及其局部样式。 */
// UTF-16 offsets match textarea selectionStart/selectionEnd.
/** 按可用宽度和富文本范围测量换行，保留各片段的字体样式。 */
export function richTextLayout(ctx,value,max,base,ranges,font,scale=1){
 const lines=[];let line=[],width=0,height=base.size*scale*1.32,offset=0;
 const flush=()=>{lines.push({glyphs:line,width,height});line=[];width=0;height=base.size*scale*1.32;};
 for(const ch of String(value??'')){
  const style={...base};for(const range of ranges||[])if(offset>=range.start&&offset<range.end)Object.assign(style,range.style);
  offset+=ch.length;style.size=Math.max(8,Math.min(72,Number(style.size)||base.size))*scale;
  if(ch==='\n'){flush();continue;}ctx.font=font(style);const w=ctx.measureText(ch).width;
  if(line.length&&width+w>max)flush();line.push({ch,x:width,style});width+=w;height=Math.max(height,style.size*1.32);
 }flush();return lines;
}

// Use the same measured layout for preview and exported canvas.
/** 根据布局尺寸求出能容纳文字的缩放比例。 */
export function fitTextScale(layout,width,height){
 let low=.01,high=12;
 for(let i=0;i<22;i++){
  const mid=(low+high)/2,lines=layout(mid);
  if(lines.reduce((sum,line)=>sum+line.height,0)<=height&&lines.every(line=>line.width<=width))low=mid;else high=mid;
 }
 return low;
}

// Canvas does not support text-decoration; draw it in the same transformed space.
/** 按已解析样式绘制文字，供各类海报模块共用。 */
export function drawPosterText(ctx,text,x,y,style){
 ctx.fillText(text,x,y);
 if(!style.strikethrough||!text)return;
 const metrics=ctx.measureText(text),width=metrics.width;
 const left=x-(ctx.textAlign==='center'?width/2:ctx.textAlign==='right'?width:0);
 const middle=Number.isFinite(metrics.fontBoundingBoxAscent)&&Number.isFinite(metrics.fontBoundingBoxDescent)
  ?y+(metrics.fontBoundingBoxDescent-metrics.fontBoundingBoxAscent)/2
  :y+style.size*(ctx.textBaseline==='top'?.55:ctx.textBaseline==='middle'?0:-.3);
 const thickness=Math.max(1,style.size/16);
 ctx.fillRect(left,middle-thickness/2,width,thickness);
}
