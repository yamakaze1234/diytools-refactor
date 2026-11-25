/** 缓存清理只协调草稿与派生缓存，不读取或清空登录、连接配置及本机业务存储。 */
export function createCacheCleanupBridge(api){
 async function inspect(){
  await api.flush();
  const result=await api.inspect();
  return {...result,count:result.drafts.length};
 }
 return {
  status:inspect,
  async prepare(choice){
   if(!['check','save','discard'].includes(choice))throw Error('无效的草稿处理方式。');
   let status=await inspect();
   if(status.blocker)throw Error(status.blocker);
   if(status.count&&choice==='check')throw Error('存在未保存的本地草稿，请先保存或明确确认放弃后再清理。');
   if(status.count){
    if(choice==='save')await api.save();
    else await api.discard(status.drafts);
   }
   status=await inspect();
   if(status.blocker||status.count)throw Error(status.blocker||'仍有未保存的本地草稿，尚未清理缓存。');
   return status;
  },
  reload(){api.clearDerived();api.reload();},
 };
}
