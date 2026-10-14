/** 云同步快照缓存：以已接受快照为基准构造差量提交，减少重复传输完整工作区。 */
// Each reuse checks native identity plus both persisted versions. A stale read
// can only lead to a rejected CAS; it never bypasses native send authorization.
/** 包装快照读取和提交接口，维护可用于下一次差量提交的本地基线。 */
export function createCloudCheckpointCache(request,{patch=false}={}){
 let cached=null;
 const detached=()=>({...cached,state:{...cached.state}});
 async function load(){
  if(cached){
   const {session,checkpoint}=await request('status');
   if(!session?.authenticated||session.member?.uid!==cached.document.uid||session.member?.workspaceId!==cached.document.workspaceId){cached=null;throw Error('登录成员已变化，请重新登录数据所属账号');}
   if(checkpoint?.initialized&&checkpoint.uid===cached.document.uid&&checkpoint.workspaceId===cached.document.workspaceId&&checkpoint.cloudVersion===cached.cloudVersion&&checkpoint.workspaceRevision===cached.state.revision)return detached();
  }
  cached=await request('load');return detached();
 }
 async function commit(input){
  try{
   let payload=input;
   if(patch&&cached&&input.baseRevision===cached.state.revision&&input.cloudVersion===cached.cloudVersion){
    const difference=checkpointPatch(cached.document,input.document);
    if(difference){
     payload={baseRevision:input.baseRevision,cloudVersion:input.cloudVersion,documentPatch:difference};
     const keys=Object.keys(input.state),unchanged=keys.length===Object.keys(cached.state).length&&keys.every(key=>input.state[key]===cached.state[key]);
     if(!unchanged)payload.state=input.state;
    }
   }
   const result=await request('commit',payload);
   if(!Number.isSafeInteger(result.revision)||!Number.isSafeInteger(result.cloudVersion)||result.cloudVersion<=input.cloudVersion)throw Error('本机同步保存回执无效');
   cached={state:{...input.state,revision:result.revision,...(result.updatedAt===undefined?{}:{updatedAt:result.updatedAt})},cloudVersion:result.cloudVersion,document:{...input.document,localRevision:result.revision}};return result;
  }catch(error){cached=null;throw error;}
 }
 return{load,commit,invalidate:()=>{cached=null;}};
}

/** 比较同步快照前后内容，只返回变化的部分。 */
function checkpointPatch(before,after){
 if(!Array.isArray(before.records)||!Array.isArray(after.records))return null;
 const permitted=new Set(['format','workspaceId','uid','deviceId','cursor','outbox','materializedProjection','lastSyncedAt']),set={};
 for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
  if(before[key]===after[key])continue;
  if(key==='records'||key==='localRevision')continue;
  if(!permitted.has(key)||!Object.hasOwn(after,key))return null;
  set[key]=after[key];
 }
 const key=row=>JSON.stringify([row.type,row.id]),old=new Map(before.records.map(row=>[key(row),row])),seen=new Set(),records=[];
 for(const row of after.records){const id=key(row);if(seen.has(id))return null;seen.add(id);if(old.get(id)!==row)records.push(row);}
 if([...old.keys()].some(id=>!seen.has(id)))return null;
 return{set,records};
}
