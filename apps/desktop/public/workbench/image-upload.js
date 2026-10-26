/** 素材读取与上传：使用文件内容预览，避免依赖临时 blob 地址。 */
import {rememberImage} from './image-cache.js';
export async function readImageFile(file){
 if(!file)throw Error('请选择一张图片');
 if(file.size>24*1024*1024)throw Error('图片请小于 24MB');
 if(!['image/png','image/jpeg'].includes(file.type))throw Error('请选择 PNG 或 JPG 图片');
 const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('读取图片失败'));reader.onabort=()=>reject(Error('图片读取已取消'));reader.readAsDataURL(file);});
 const image=new Image();image.decoding='async';image.src=data;
 try{await image.decode();}catch{throw Error('无法读取图片，请选择有效的 PNG 或 JPG');}
 if(!image.naturalWidth||!image.naturalHeight)throw Error('图片尺寸无效');
 return {data,image};
}
/** 将原文件内容提交给本机上传接口，不重新编码或压缩原图。 */
export async function uploadImage(file,request){
 const {data,image}=await readImageFile(file);
 const uploaded=await request('/api/asset',{method:'POST',body:JSON.stringify({base64:data.split(',')[1]})});
 rememberImage(uploaded.url,image);return uploaded.url;
}
