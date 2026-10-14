import {saveImageFolder} from './folder-export.js';

// 桌面端等待实际落盘回执；浏览器才使用下载链接，取消和失败不能提示成功。
export async function exportSingleImage(blob,name,{download,saveFolder=saveImageFolder,draft=false}={}){
 const result=await saveFolder([{name,bytes:new Uint8Array(await blob.arrayBuffer())}],name.replace(/\.png$/i,''));
 if(result?.cancelled)return '已取消图片导出';
 if(result){
  if(!result.ok||!result.files?.includes(name))throw Error(result.error||'图片未保存，请重试');
  return `PNG 已保存到：${result.directory}${draft?'；图片使用当前草稿，配置保存另行进行':''}`;
 }
 if(!download)throw Error('当前环境不支持图片下载');
 await download(blob,name);
 return `PNG 已${draft?'按当前草稿生成并':''}开始下载，请查看浏览器下载记录`;
}
