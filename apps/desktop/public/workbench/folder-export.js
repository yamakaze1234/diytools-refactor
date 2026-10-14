/** 提交文件集合和建议目录名，返回原生保存结果。 */
/** 图片文件夹导出适配：把生成结果交给本机接口保存到用户选择的目录。 */
export async function saveImageFolder(files,name,{signal}={}){
 // 文件编码阶段仍可取消，进入原生保存后以逐文件回执确认实际结果。
 const active=()=>{if(signal?.aborted)throw new DOMException('图片导出已取消','AbortError');};active();
 const bridge=globalThis.pywebview?.api?.export_image_folder;
 if(!bridge)return null;
 const entries=await Promise.all(files.map(async file=>({name:file.name,base64:await new Promise((resolve,reject)=>{
  const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('读取导出图片失败'));reader.readAsDataURL(new Blob([file.bytes]));
 })})));
 active();return bridge({name:name.replace(/\.zip$/i,''),files:entries});
}
