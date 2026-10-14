/** 大状态处理调度器：同一生成器可同步跑完，也可按时间预算切片让出界面线程。 */
// Work is split between rows, so a browser can process input and paint during
// a large receipt/refresh. Each row is still processed atomically.
export const yieldStateWork=()=>globalThis.scheduler?.yield?.()||new Promise(resolve=>setTimeout(resolve,0));
/** 同步消费全部工作步骤并返回最后结果。 */
export function finishStateWork(work){let step;do{step=work.next();}while(!step.done);return step.value;}
/** 超过 budgetMs 后让出执行权，直到生成器结束；可报告每片执行情况。 */
export async function finishStateWorkAsync(work,{budgetMs=8,yieldWork=yieldStateWork,onSlice}={}){
 let start=performance.now(),step;
 do{
  step=work.next();
  if(!step.done&&performance.now()-start>=budgetMs){onSlice?.(performance.now()-start);await yieldWork();start=performance.now();}
 }while(!step.done);
 onSlice?.(performance.now()-start);return step.value;
}
