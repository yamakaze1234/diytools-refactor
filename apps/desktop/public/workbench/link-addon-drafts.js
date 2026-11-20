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
  try{write(prefix+id);failures.delete(id);}
  catch{failures.add(id);}
 }
 return {
  get size(){return rows.size;},
  get:id=>rows.get(id),
  values:()=>rows.values(),
  has:id=>rows.has(id),
  failed:id=>failures.has(id),
  hasFailure:()=>failures.size>0,
  set(id,row){rows.set(id,row);persist(id,key=>storage.setItem(key,JSON.stringify(row)));},
  delete(id){const removed=rows.delete(id);if(removed||failures.has(id))persist(id,key=>storage.removeItem(key));return removed;}
 };
}
