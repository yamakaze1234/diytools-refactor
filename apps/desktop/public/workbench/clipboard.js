export async function copyPlainText(text){
 if(navigator.clipboard?.writeText){
  try{await navigator.clipboard.writeText(text);return;}catch{}
 }
 if(globalThis.ClipboardItem&&navigator.clipboard?.write){
  try{await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([text],{type:'text/plain'})})]);return;}catch{}
 }
 let copied=false;
 // 异步剪贴板不可用时，在本次复制事件写入同一份文本。
 const handler=event=>{
  if(!event.clipboardData)return;
  event.preventDefault();
  event.stopPropagation();
  event.clipboardData.setData('text/plain',text);
  copied=true;
 };
 document.addEventListener('copy',handler,true);
 try{if(!document.execCommand('copy')||!copied)throw Error('当前环境未允许复制，请允许剪贴板访问后重试');}finally{document.removeEventListener('copy',handler,true);}
}
