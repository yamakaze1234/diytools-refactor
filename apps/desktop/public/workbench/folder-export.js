/** 提交文件集合和建议目录名，返回原生保存结果。 */
/** 图片文件夹导出适配：把生成结果交给本机接口保存到用户选择的目录。 */
export async function saveImageFolder(files,name,{signal}={}){
 // 文件编码阶段仍可取消，进入原生保存后以逐文件回执确认实际结果。
 const active=()=>{if(signal?.aborted)throw new DOMException('图片导出已取消','AbortError');};active();
 const api=globalThis.pywebview?.api,bridge=api?.export_image_folder;
 const encode=async file=>({name:file.name,base64:await new Promise((resolve,reject)=>{
  const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('读取导出图片失败'));reader.readAsDataURL(new Blob([file.bytes]));
 })});
 const session=api?.export_image_folder_session;
 if(session){
  // 编码与IPC都分批进行，单次最多8 MiB原始数据（单张大图单独传输）。
  const opened=await session({phase:'begin',name:name.replace(/\.zip$/i,'')});
  if(opened?.cancelled)return opened;
  if(!opened?.token)throw Error('未能创建图片导出会话');
  let receipt={...opened,files:[]},failure;
  try{
   let batch=[],bytes=0;
   const flush=async()=>{if(!batch.length)return;active();receipt=await session({phase:'append',token:opened.token,files:batch});batch=[];bytes=0;if(!receipt?.ok)throw Error(receipt?.error||'图片未完整保存');};
   for(const file of files){
    active();if(file.bytes.byteLength>128*1024*1024)throw Error('单个导出文件超过128 MiB');
    if(batch.length&&(bytes+file.bytes.byteLength>8*1024*1024||batch.length>=64))await flush();
    batch.push(await encode(file));bytes+=file.bytes.byteLength;
   }
   await flush();
  }catch(error){failure=error;}
  // 释放会话并取最终逐文件回执；中途失败也保留已经确认落盘的文件。
  try{receipt=await session({phase:'finish',token:opened.token});}catch(error){failure??=error;}
  if(failure){if(!receipt?.files?.length)throw failure;return {...receipt,ok:false,error:failure.message};}
  if(!Array.isArray(receipt?.files))throw Error('未收到图片保存清单');
  return receipt;
 }
 if(!bridge)return null;
 // 旧桌面桥接不能分批；避免达到运行时字符串上限后给出无意义错误。
 if(files.reduce((n,file)=>n+file.bytes.byteLength,0)>256*1024*1024)throw Error('当前桌面版本不支持大批量图片传输，请更新或选择仅有变动的配置');
 const entries=[];for(const file of files){active();entries.push(await encode(file));}
 active();return bridge({name:name.replace(/\.zip$/i,''),files:entries});
}
