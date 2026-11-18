// 只从独立素材目录读取数据库登记的摘要文件，不接受客户端传入路径。
import {open,link,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {PNG} from 'pngjs';
import jpegCodec from 'jpeg-js';
import {Fault} from './config.mjs';

const allowedLimit=24*1024*1024;
const png=Buffer.from('89504e470d0a1a0a','hex');
const jpeg=Buffer.from('ffd8ff','hex');
/** 识别真正的 PNG/JPEG 头和尺寸；使用端仍会解码校验上传的本地图片。 */
export async function readImageUpload(req){
 const mime=req.headers['content-type'];
 if(!['image/png','image/jpeg'].includes(mime))throw new Fault('INVALID_CONTENT_TYPE',415);
 if(Number(req.headers['content-length']||0)>allowedLimit)throw new Fault('PAYLOAD_TOO_LARGE',413);
 let n=0;const chunks=[];
 for await(const chunk of req){n+=chunk.length;if(n>allowedLimit)throw new Fault('PAYLOAD_TOO_LARGE',413);chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);
 let w=0,h=0;
 if(mime==='image/png'&&n>=45&&bytes.subarray(0,8).equals(png)&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'){
  let offset=8,hasData=false,end=false;const deflate=[];
  while(offset+12<=n){
   const size=bytes.readUInt32BE(offset),tag=bytes.toString('ascii',offset+4,offset+8);
   if(size>n-offset-12)break;
   if(tag==='IDAT')deflate.push(bytes.subarray(offset+8,offset+8+size));
   offset+=size+12;
   if(tag==='IDAT')hasData=true;
   if(tag==='IEND'){end=size===0&&offset===n;break;}
  }
  if(hasData&&end){
   w=bytes.readUInt32BE(16);h=bytes.readUInt32BE(20);
   // pngjs 的交错图也先做有界解压，防止伪造像素流绕过尺寸头限制。
   if(w&&h&&w<=12000&&h<=12000&&w*h<=32000000)try{
    const depth=bytes[24],channels={0:1,2:3,3:1,4:2,6:4}[bytes[25]];
    if(!channels||![1,2,4,8,16].includes(depth))throw Error('invalid PNG');
    inflateSync(Buffer.concat(deflate),{maxOutputLength:(Math.ceil(w*channels*depth/8)+14)*h+1024});
    const decoded=PNG.sync.read(bytes,{checkCRC:true,skipRescale:true});
    if(decoded.width!==w||decoded.height!==h||!decoded.data.length)throw Error('invalid PNG');
   }catch{w=0;h=0;}
  }
 }else if(mime==='image/jpeg'&&n>16&&bytes.subarray(0,3).equals(jpeg)&&bytes[n-2]===0xff&&bytes[n-1]===0xd9){
  for(let off=2;off+9<n;){
   if(bytes[off++]!==0xff)break;
   while(bytes[off]===0xff)off++;
   const marker=bytes[off++];if(marker===0xda||marker===0xd9||off+2>=n)break;
   const length=bytes.readUInt16BE(off);if(length<2||off+length>n)break;
   if([0xc0,0xc1,0xc2,0xc3].includes(marker)&&length>=8){h=bytes.readUInt16BE(off+3);w=bytes.readUInt16BE(off+5);break;}
   off+=length;
  }
  if(w&&h&&w<=12000&&h<=12000&&w*h<=32000000)try{
   const decoded=jpegCodec.decode(bytes,{tolerantDecoding:false,maxResolutionInMP:32,maxMemoryUsageInMB:256,formatAsRGBA:false});
   if(decoded.width!==w||decoded.height!==h||!decoded.data.length)throw Error('invalid JPEG');
  }catch{w=0;h=0;}
 }
 if(!w||!h||w>12000||h>12000||w*h>32000000)throw new Fault('INVALID_IMAGE',400);
 const digest=createHash('sha256').update(bytes).digest('hex'),extension=mime==='image/png'?'png':'jpg';
 return {bytes,mime,digest,extension,width:w,height:h,uri:'/uploads/'+digest+'.'+extension};
}

const tryFile=async(directory,sha)=>open(resolve(directory,sha),constants.O_RDONLY|(constants.O_NOFOLLOW??0)).catch(error=>{
 if(['ENOENT','ENOTDIR'].includes(error.code))return null;
 throw error;
});
/** 新文件只写私有素材目录；原有挂载永远只读。创建临时名后原子登记摘要，不覆盖任何已存在文件。 */
export function createImageWriter(root,legacyRoot){
 if(!root)return null;
 const directory=resolve(root),legacy=legacyRoot?resolve(legacyRoot):null;
 if(directory===legacy)throw new Fault('IMAGE_ROOTS_MUST_DIFFER');
 return async image=>{
  const verify=async file=>{try{
   const stat=await file.stat();
   if(!stat.isFile()||stat.size!==image.bytes.length||!(await file.readFile()).equals(image.bytes))
    throw new Fault('IMAGE_CONFLICT',409);
  }finally{await file.close();}};
  const existing=await tryFile(directory,image.digest)||(legacy?await tryFile(legacy,image.digest):null);
  if(existing){await verify(existing);return;}
  const temporary=resolve(directory,'.incoming-'+randomUUID());
  const file=await open(temporary,'wx',0o600);
  try{
   try{await file.writeFile(image.bytes);await file.sync();}finally{await file.close();}
   try{await link(temporary,resolve(directory,image.digest));}
   catch(error){if(error.code!=='EEXIST')throw error;const race=await tryFile(directory,image.digest);if(!race)throw error;await verify(race);}
  }finally{
   // 只清理本次写入生成的私有临时名；已登记的摘要文件始终保留。
   await unlink(temporary);
  }
 };
}

export function createImageHandler(pool,root,uploads=null){
 const directories=[root,uploads].filter(Boolean).map(dir=>resolve(dir));
 const verified=new Map();
 return async(sha,extension,req,res,{download=false}={})=>{
  const {rows:[asset]}=await pool.query('SELECT byte_count::text FROM intel_live.assets WHERE sha256=$1 AND extension=$2',[sha,extension]);
  if(!asset)throw new Fault('NOT_FOUND',404);
  let file=null;
  for(const dir of directories){file=await tryFile(dir,sha);if(file)break;}
  if(!file)throw new Fault('IMAGE_UNAVAILABLE',404);
  try{
   const stat=await file.stat({bigint:true});
   if(!stat.isFile()||String(stat.size)!==asset.byte_count)throw new Fault('IMAGE_UNAVAILABLE',404);
   const stamp=`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
   if(verified.get(sha+'.'+extension)!==stamp){
    const signature=Buffer.alloc(8);
    await file.read(signature,0,8,0);
    const expected=extension==='png'?'89504e470d0a1a0a':'ffd8ff';
    if(!signature.toString('hex').startsWith(expected))throw new Fault('IMAGE_UNAVAILABLE',404);
    const hash=createHash('sha256');
    for await(const chunk of file.createReadStream({start:0,autoClose:false}))hash.update(chunk);
    const observed=await file.stat({bigint:true});
    if(hash.digest('hex')!==sha||observed.mtimeNs!==stat.mtimeNs||observed.ctimeNs!==stat.ctimeNs||observed.size!==stat.size)
     throw new Fault('IMAGE_UNAVAILABLE',404);
    if(verified.size>=2048)verified.clear();
    verified.set(sha+'.'+extension,stamp);
   }
   const headers={'content-type':extension==='png'?'image/png':'image/jpeg','content-length':String(stat.size),
    'cache-control':'public, max-age=31536000, immutable','access-control-allow-origin':'*','x-content-type-options':'nosniff',etag:'"'+sha+'"'};
   if(download){
    // 无账号下载需要重新检查图库状态，避免回收后仍从浏览器缓存读取。
    headers['content-disposition']='attachment; filename="'+sha+'.'+extension+'"';
    headers['cache-control']='no-store';
    delete headers['access-control-allow-origin'];
   }
   if(req.headers['if-none-match']===headers.etag){
    delete headers['content-length'];res.writeHead(304,headers);res.end();return;
   }
   res.writeHead(200,headers);
   if(req.method==='HEAD'){res.end();return;}
   await pipeline(file.createReadStream({start:0,autoClose:false}),res);
  }finally{await file.close();}
 };
}

export function combineImageHandlers(handlers){
 if(!handlers.length)return undefined;
 if(handlers.length===1)return handlers[0];
 return async(sha,extension,req,res,options)=>{
  let unavailable=null;
  for(const serveImage of handlers){
   try{return await serveImage(sha,extension,req,res,options);}
   catch(error){
    if(res.headersSent)throw error;
    // 同一个公开摘要只会返回校验匹配的字节；登记或目录不可用时继续核对其他店。
    if(!(error instanceof Fault)||error.code!=='NOT_FOUND')unavailable??=error;
   }
  }
  throw unavailable||new Fault('NOT_FOUND',404);
 };
}
