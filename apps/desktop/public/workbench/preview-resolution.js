/** 预览分辨率预算：综合显示宽度、设备像素比和总像素上限，降低编辑时的绘图负担。 */
import {defaultPosterWidth,renderPoster} from './poster.js';

// This budget applies only to the disposable preview bitmap. Layout coordinates,
// persisted transforms and explicit export/save-image widths remain unchanged.
export const PREVIEW_PIXEL_BUDGET=Object.freeze({maxPixels:2_000_000,maxWidth:1024,maxSide:4096,maxDpr:1.5});
const positive=(value,fallback)=>Number.isFinite(value)&&value>0?value:fallback;
/** 在清晰度需求和像素预算之间计算预览栅格宽度。 */
export function previewRasterWidth({displayWidth=700,devicePixelRatio=1,exportWidth=1000,geometry,budget=PREVIEW_PIXEL_BUDGET}={}){
 const base=positive(geometry?.base,1),height=positive(geometry?.height,base),ratio=height/base;
 const maxPixels=Math.floor(positive(budget.maxPixels,PREVIEW_PIXEL_BUDGET.maxPixels)),maxSide=Math.floor(positive(budget.maxSide,PREVIEW_PIXEL_BUDGET.maxSide));
 const dpr=Math.min(positive(budget.maxDpr,PREVIEW_PIXEL_BUDGET.maxDpr),Math.max(1,positive(devicePixelRatio,1)));
 let width=Math.max(1,Math.floor(Math.min(positive(displayWidth,700)*dpr,positive(exportWidth,1000),positive(budget.maxWidth,PREVIEW_PIXEL_BUDGET.maxWidth),maxSide,maxSide/ratio,Math.sqrt(maxPixels/ratio))));
 // ceil(canvas.height) must be included in the area guarantee.
 while(width>1&&(width*Math.ceil(width*ratio)>maxPixels||Math.ceil(width*ratio)>maxSide))width--;
 if(width*Math.ceil(width*ratio)>maxPixels||Math.ceil(width*ratio)>maxSide)throw Error('预览长宽比超出像素预算，请减少图片内容');
 return width;
}

/** 使用预算后的分辨率调用海报渲染，导出尺寸不由此函数决定。 */
export async function renderPreviewPoster(config,options={}){
 const exportWidth=positive(options.exportWidth,defaultPosterWidth(config));
 const input={...options,exportWidth};
 // First-ever rendering starts at a viewport-sized bitmap, never at export size
 // just to discover its geometry. Later renders reuse the previous geometry.
 let width=previewRasterWidth(input);
 if(!options.geometry&&config.layout!=='square')width=Math.min(width,160);
 let result=await renderPoster(config,width,{interactive:true});
 const boundedWidth=previewRasterWidth({...input,geometry:result});
 if(boundedWidth!==width){width=boundedWidth;result=await renderPoster(config,width,{interactive:true});}
 return Object.assign(result,{preview:true,previewRasterWidth:width,previewLayout:config.layout,exportWidth});
}
