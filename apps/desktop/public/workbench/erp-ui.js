/** ERP 同步按钮入口：将可用操作绑定到宿主提供的同步流程。 */
import {bindSqlSync} from './sql-sync-ui.js';

// The header opens the existing company-database flow directly.
/** 连接顶部 ERP 操作与统一反馈，不在控件层自行保存业务数据。 */
export function bindErpSync(api){
 const button=document.querySelector('#erp-sync'),last=document.querySelector('#erp-last');
 const refresh=async()=>{try{const response=await fetch('/api/erp-sync/status');const status=await response.json();if(!response.ok)throw Error(status.error||'ERP 状态读取失败');const success=status.lastSuccess;last.textContent=success?.stockUpdatedAt?'SQL 库存 '+new Date(success.stockUpdatedAt).toLocaleString('zh-CN'):success?.updatedAt?'上次同步 '+new Date(success.updatedAt).toLocaleString('zh-CN'):'库存 / ERP 尚未同步';last.title=last.textContent;}catch{last.textContent='库存 / ERP 尚未同步';last.title='公司数据库尚未完成同步';}};
 const sql=bindSqlSync({...api,receive:async result=>{const accepted=await api.receive(result);await refresh();return accepted;}});
 button.disabled=false;button.title='读取公司数据库 ERP 成本与库存，先预览再确认应用';button.onclick=()=>sql.setup();
 refresh();
 return {setup:sql.setup,refresh};
}
