/** 原图内存缓存：共享解码结果，最多保留 12 项、估算解码内存不超过 48 MiB；只缓存可安全参与 Canvas 导出的图片。 */
// Share decoded originals between upload, gallery selection and poster rendering.
const images=new Map(),sizes=new Map();let generation=0;
// 同时限制缓存数量和解码像素内存；大图可用于当前绘制，但不长期占用缓存。
const MAX_BYTES=48*1024*1024,MAX_IMAGES=12;
function forget(key){images.delete(key);sizes.delete(key);}
function trim(){let total=[...sizes.values()].reduce((a,b)=>a+b,0);for(const key of images.keys()){if(images.size<=MAX_IMAGES&&total<=MAX_BYTES)break;total-=sizes.get(key)||0;forget(key);}}
export function clearImageCache(){generation++;images.clear();sizes.clear();}
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
 return rememberResolved(resolveAsset(url),image);
}
const resolveAsset=url=>url&&(globalThis.resolveWorkbenchAsset?.(url)||url);
function rememberResolved(key,image){
 if(!key||!image.complete||!image.naturalWidth||!image.naturalHeight)return false;
 if(!canExportImage(image)){forget(key);return false;}
 forget(key);images.set(key,Promise.resolve(image));
 sizes.set(key,image.naturalWidth*image.naturalHeight*4);trim();
 return true;
}
/** 同地址共享加载 Promise；失败或超时清除缓存，使后续重试能够重新加载。 */
export async function getImage(url){
 if(!url)return null;
 const resolved=resolveAsset(url); // 同一个 /uploads 路径不能命中另一个数据源的解码图。
 if(!images.has(resolved)){
  const epoch=generation;
  const pending=new Promise((resolve,reject)=>{
   const image=new Image();image.decoding='async';
   const fail=message=>{clearTimeout(timer);if(images.get(resolved)===pending)forget(resolved);image.onload=image.onerror=null;reject(Error(message));};
   const timer=setTimeout(()=>fail('图片载入超时，请重试或更换素材'),15000);
   image.onload=()=>{if(!(epoch===generation?rememberResolved(resolved,image):canExportImage(image))){fail('图片无法安全导出，请重新选择素材');return;}clearTimeout(timer);image.onload=image.onerror=null;resolve(image);};
   image.onerror=()=>fail('图片载入失败，请重新选择素材');if(/^(?:https?:|(?:nas-)?workbench-asset:)/.test(resolved))image.crossOrigin='anonymous';image.src=resolved;
  });
  images.set(resolved,pending);
 }
 const result=images.get(resolved);
 // 命中后移到末尾，优先淘汰较久未使用的原图。
 if(result){images.delete(resolved);images.set(resolved,result);}
 return result;
}
