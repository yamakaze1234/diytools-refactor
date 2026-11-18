/** 自动保存只接收已暂存的配置草稿；成本、报价和目录预览不进入此计时器。 */
export const NAS_AUTOSAVE_INTERVAL=2*60*60*1000;
const conflictCodes=new Set(['VERSION_CONFLICT','DEPENDENCY_CONFLICT','OPERATION_REUSED']);

export function createNasAutosave({storage,scope,canRun,drafts,isConflict=()=>false,submit,
 onBlocked=()=>{},onError=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 if(typeof scope!=='string'||!scope)throw Error('缺少自动保存的工作区和账号。');
 const key='diy-nas-autosave:'+scope,conflictKey=key+':conflicts';
 let enabled=false,disposed=false,running=false,timer=null,nextAt=null,generation=0,conflicts=new Map();
 const notify=(handler,value)=>{try{handler(value);}catch{/* 提示错误不改变计时或提交状态。 */}};
 try{
  // 首次使用默认开启；不能读取已有选择时不擅自开启写入。
  const saved=storage.getItem(key);enabled=saved===null||saved==='on';
 }catch(error){notify(onError,error);}
 try{
  const previous=JSON.parse(storage.getItem(conflictKey)||'[]');
  if(Array.isArray(previous))for(const row of previous){
   if(Array.isArray(row)&&typeof row[0]==='string'&&typeof row[1]==='string')conflicts.set(row[0],row[1]);
  }
 }catch{/* 不能恢复旧冲突时仍使用编辑器当前已知的冲突。 */}

 function cancelTimer(){
  generation++;
  if(timer!==null)clearTimer(timer);
  timer=null;
 }
 function arm(){
  cancelTimer();
  if(disposed||!enabled||running)return;
  const scheduled=generation;
  timer=setTimer(()=>{
   if(scheduled!==generation)return;
   timer=null;void checkDue();
  },Math.max(0,Math.min(NAS_AUTOSAVE_INTERVAL,nextAt-now())));
 }
 function saveConflicts(){
  try{
   if(conflicts.size)storage.setItem(conflictKey,JSON.stringify([...conflicts]));
   else storage.removeItem(conflictKey);
  }catch{/* 本窗口仍会记住冲突；无法持久化不影响配置本身。 */}
 }
 async function checkDue(){
  if(disposed||!enabled||running)return false;
  if(now()<nextAt){if(timer===null)arm();return false;}
  // 取消旧定时器。唤醒只处理当前一轮，不回补休眠期间错过的轮次。
  running=true;cancelTimer();nextAt=null;
  try{
   if(!canRun())return false;
   const rows=drafts();
   // 先处理较早发出的未知请求，不能绕过它继续写入其它配置。
   if(rows.some(row=>row.pending)){notify(onBlocked,'pending');return false;}
   if(!rows.length&&!conflicts.size)return false;
   const versions=new Map(rows.map(row=>[row.id,row.version]));
   let conflictChanged=false;
   for(const [id,version] of conflicts)if(versions.get(id)!==version){conflicts.delete(id);conflictChanged=true;}
   if(conflictChanged)saveConflicts();
   const eligible=rows.filter(row=>!isConflict(row)&&!(conflicts.has(row.id)&&conflicts.get(row.id)===row.version));
   if(!eligible.length)return false;
   // 与手动保存共用确认流程；执行器使用这份名单，遇到新未知回执停止后续。
   const results=await submit(eligible);
   if(disposed)return true;
   conflictChanged=false;
   for(const row of results||[]){
    const version=versions.get(row.id);
    if(row.status==='failed'&&conflictCodes.has(row.error?.code)&&typeof version==='string'&&conflicts.get(row.id)!==version){
     conflicts.set(row.id,version);conflictChanged=true;
    }
   }
   if(conflictChanged)saveConflicts();
   return true;
  }catch(error){if(!disposed)notify(onError,error);return false;}
  finally{
   running=false;
   if(enabled&&!disposed){
    if(nextAt===null||nextAt<=now())nextAt=now()+NAS_AUTOSAVE_INTERVAL;
    arm();
   }
  }
 }
 function setEnabled(value){
  if(disposed)return false;
  const next=Boolean(value);
  if(next===enabled)return enabled;
  enabled=next;nextAt=enabled?now()+NAS_AUTOSAVE_INTERVAL:null;
  // 先把当前窗口切换到新状态；存储失败也应立即停止已安排的自动保存。
  arm();
  try{storage.setItem(key,enabled?'on':'off');}
  catch{throw Error('本窗口已切换自动保存，暂无法记住下次启动的设置。');}
  return enabled;
 }
 function dispose(){disposed=true;cancelTimer();nextAt=null;}

 if(enabled){nextAt=now()+NAS_AUTOSAVE_INTERVAL;arm();}
 return {enabled:()=>enabled,setEnabled,checkDue,dispose};
}
