/** 管道长任务与同源编辑器桥接；回执重试不会重新执行编辑。 */
type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type AgentWindow = Window & {
  workbenchReady?: boolean;
  workbenchAgentExecute?: (job: any) => Promise<unknown>;
  workbenchAgentNative?: (action: string, payload: unknown) => Promise<any>;
};
export function installAgentBridge(target: AgentWindow, invoke: Invoke) {
 let stopped=false,enabled=false,busy=false;
 const sessionId=target.crypto.randomUUID();
 let activeClaim: string|null=null;
 let pending: Record<string,unknown>|null=null;
 let retryAfter=0;
 const call=<T=unknown>(action:string,payload:unknown={})=>invoke<T>('agent_ui',{action,payload:{...(activeClaim?{claimToken:activeClaim}:{}),...(payload as Record<string,unknown>),sessionId}});
 target.workbenchAgentNative=call;
 const pulse=async()=>{
  if(stopped||busy||Date.now()<retryAfter||!target.workbenchReady||!target.workbenchAgentExecute)return;
  busy=true;
  try{
   if(!enabled){await call('ready',{connect:true});enabled=true;}
   if(pending){await call('complete',pending);pending=null;activeClaim=null;return;}
   const job=await call<any>('claim');if(!job)return;
   activeClaim=job.claimToken;
   // 原生回执来自父 React realm；克隆必须使用目标 iframe 的 intrinsic，供其严格对象校验。
   try{pending={id:job.id,claimToken:job.claimToken,result:await target.workbenchAgentExecute(target.structuredClone(job)),error:null};}
   catch(error){const e=error as {code?:string;message?:string};pending={id:job.id,claimToken:job.claimToken,result:null,error:{code:e.code||'OPERATION_FAILED',message:e.message||String(error)}};}
   await call('complete',pending);pending=null;activeClaim=null;
  }catch(error){if(!enabled)stopped=true;else if(String(error).includes('JOBS_CAPACITY'))retryAfter=Date.now()+30000; /* 容量不足时退避，保留原回执且不重复执行写入。 */}
  finally{busy=false;}
 };
 const timer=target.setInterval(()=>void pulse(),750);
 const heartbeat=target.setInterval(()=>{if(enabled&&!stopped)void call('ready').catch(()=>{});},5000);
 target.addEventListener('unload',()=>{stopped=true;target.clearInterval(timer);target.clearInterval(heartbeat);},{once:true});
}
