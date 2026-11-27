/** 加购包草稿按当前 NAS、账号和店铺保存在本机，基线随草稿保留。 */
export function createAddonPackDrafts(storage,scope){
 const prefix='diy-nas-addon-pack:'+scope+':',rows=new Map(),failures=new Set();
 for(let i=0;i<storage.length;i++){
  const key=storage.key(i);
  if(!key?.startsWith(prefix))continue;
  try{
   const row=JSON.parse(storage.getItem(key));
   if(row?.pack?.id===key.slice(prefix.length)&&typeof row.pack.productId==='string'&&
     ['parts','text'].includes(row.pack.mode)&&(row.base===null||row.base?.id===row.pack.id))rows.set(row.pack.id,row);
  }catch{/* 单条损坏草稿不影响其余方案。 */}
 }
 function persist(id,write){
  try{write(prefix+id);failures.delete(id);return true;}
  catch{failures.add(id);return false;}
 }
 return {
  get size(){return rows.size;},
  get:id=>rows.get(id),
  values:()=>rows.values(),
  has:id=>rows.has(id),
  failed:id=>failures.has(id),
  hasFailure:()=>failures.size>0,
  set(id,row){rows.set(id,row);persist(id,key=>storage.setItem(key,JSON.stringify(row)));},
  delete(id){
   // 本机删除失败时保留草稿明细，仍能从缓存清理或维护总览再次尝试。
   if(!rows.has(id)&&!failures.has(id))return false;
   if(!persist(id,key=>storage.removeItem(key)))return false;
   return rows.delete(id);
  }
 };
}

export const addonDraftName=pack=>(typeof pack.name==='string'&&pack.name.trim())||'未命名草稿';
export function describeAddonDrafts(drafts,configs){
 const links=new Map(configs.map(config=>[config.productId,config]));
 return [...drafts.values()].map(({pack})=>{
  const link=links.get(pack.productId);
  return {id:pack.id,productId:pack.productId,productName:link?(link.product||'未命名链接'):'链接已无在用配置',
   name:addonDraftName(pack),mode:pack.mode,canLocate:Boolean(link),failed:drafts.failed(pack.id)};
 });
}

export function mergeAddonPackDrafts(saved,drafts){
 const packs=new Map(saved.map(pack=>[pack.id,pack]));
 for(const {pack} of drafts.values())packs.set(pack.id,{...pack,unsaved:true});
 return [...packs.values()];
}
