/** 海报附加图片几何：按版式、画布尺寸和图层变换计算实际绘制区域。 */
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

// Positions are stored separately for square and long posters, in 700px canvas units.
/** 将图层保存的相对位置转换为当前画布上的图片区域。 */
export function posterImageRegion(layer,layout,base,height,transform=layer.transforms?.[layout]||{}){
 const ratio=layer.naturalHeight/layer.naturalWidth;
 if(!Number.isFinite(ratio)||ratio<=0)throw Error('添加的图片尺寸无效，请移除后重新添加');
 const free=Number.isFinite(transform.height),maxWidth=free?base:Math.min(base,height/ratio),minWidth=Math.min(16,maxWidth);
 const width=clamp(Number.isFinite(transform.width)?transform.width:Math.min(220,220/ratio),minWidth,maxWidth);
 const imageHeight=free?clamp(transform.height,16,height):width*ratio;
 return{key:'poster-image:'+layer.id,id:layer.id,x:clamp(Number.isFinite(transform.x)?transform.x:(base-width)/2,0,base-width),top:clamp(Number.isFinite(transform.y)?transform.y:(height-imageHeight)/2,0,height-imageHeight),width,height:imageHeight,minWidth,maxWidth,minHeight:16};
}
