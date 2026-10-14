/** 原图内存缓存：共享解码结果，最多保留 24 项；只缓存可安全参与 Canvas 导出的图片。 */
// Share decoded originals between upload, gallery selection and poster rendering.
const images=new Map();
// A decoded gallery thumbnail may have loaded without CORS. Reusing it would
// taint every poster that shares the material, even when the normal loader uses CORS.
/** 用 1 像素画布验证来源安全，防止无 CORS 的图库缩略图污染整批海报。 */
function canExportImage(image){
 try{
  const probe=document.createElement('canvas');probe.width=probe.height=1;
  const context=probe.getContext('2d');context.drawImage(image,0,0,1,1);context.getImageData(0,0,1,1);
  return true;
 }catch{return false;}
}
/** 仅接受已完整解码且可导出的图片，并按最近使用顺序淘汰旧项。 */
export function rememberImage(url,image){
 if(!url||!image.complete||!image.naturalWidth||!image.naturalHeight)return false;
 if(!canExportImage(image)){images.delete(url);return false;}
 images.delete(url);images.set(url,Promise.resolve(image));
 while(images.size>24)images.delete(images.keys().next().value);
 return true;
}
/** 同地址共享加载 Promise；失败或超时清除缓存，使后续重试能够重新加载。 */
export async function getImage(url){
 if(!url)return null;
 if(!images.has(url)){
  const pending=new Promise((resolve,reject)=>{
   const image=new Image();image.decoding='async';
   const fail=message=>{clearTimeout(timer);if(images.get(url)===pending)images.delete(url);image.onload=image.onerror=null;reject(Error(message));};
   const timer=setTimeout(()=>fail('图片载入超时，请重试或更换素材'),15000);
   image.onload=()=>{if(!rememberImage(url,image)){fail('图片无法安全导出，请重新选择素材');return;}clearTimeout(timer);image.onload=image.onerror=null;resolve(image);};
   image.onerror=()=>fail('图片载入失败，请重新选择素材');const resolved=globalThis.resolveWorkbenchAsset?.(url)||url;if(/^(?:https?:|workbench-asset:)/.test(resolved))image.crossOrigin='anonymous';image.src=resolved;
  });
  images.set(url,pending);
 }
 return images.get(url);
}
