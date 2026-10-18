/** 只在所有命令退出后释放已落盘快照；暂停不能打断正在确认的事务。 */
export function createCloudCacheLifecycle(invalidate,{idleMs=60000,schedule=setTimeout,cancel=clearTimeout}={}){
 let active=0,timer=null,stopped=false;
 const clearTimer=()=>{if(timer!==null){cancel(timer);timer=null;}};
 const release=()=>{clearTimer();invalidate();};
 return {
  begin({resume=false}={}){clearTimer();if(resume)stopped=false;active++;},
  end(){active--;if(active)return;if(stopped)release();else timer=schedule(()=>{timer=null;if(!active)release();},idleMs);},
  stop(){stopped=true;clearTimer();if(!active)release();},
 };
}
