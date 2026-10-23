/** ERP 同步按钮入口：将可用操作绑定到宿主提供的同步流程。 */
import {bindCostSync} from './cost-sync-ui.js';
import {bindSqlSync} from './sql-sync-ui.js';

// 顶部进入成本来源选择，原公司数据库流程保留独立入口。
/** 连接顶部 ERP 操作与统一反馈，不在控件层自行保存业务数据。 */
export function bindErpSync(api){
 const button=document.querySelector('#erp-sync'),last=document.querySelector('#erp-last');
 const refresh=async()=>{try{const response=await fetch('/api/erp-sync/status');const status=await response.json();if(!response.ok)throw Error(status.error||'ERP 状态读取失败');const success=status.lastSuccess;last.textContent=success?.stockUpdatedAt?'SQL 库存 '+new Date(success.stockUpdatedAt).toLocaleString('zh-CN'):success?.updatedAt?'上次同步 '+new Date(success.updatedAt).toLocaleString('zh-CN'):'库存 / ERP 尚未同步';last.title=last.textContent;}catch{last.textContent='库存 / ERP 尚未同步';last.title='公司数据库尚未完成同步';}};
 // 同一窗口上下分区，所有读取和应用共用互斥锁，避免预览互相覆盖。
 const dialog=document.querySelector('#dialog');let owner=null;
 const sectionApi=id=>({...api,inline:true,root:()=>document.querySelector('#'+id),
  canStart:()=>!owner||owner===id,
  busy:value=>{owner=value?id:null;for(const node of dialog.querySelectorAll('.erp-sync-block'))node.disabled=value;const close=dialog.querySelector('.dialog-title .close');if(close)close.disabled=value;},
  openDialog:(_title,html)=>{const root=document.querySelector('#'+id);if(root)root.innerHTML=html;},
 });
 dialog.addEventListener('cancel',event=>{if(owner)event.preventDefault();});
 const sql=bindSqlSync({...sectionApi('erp-stock-content'),receive:async result=>{const accepted=await api.receive(result);await refresh();return accepted;}});
 const costs=bindCostSync(sectionApi('erp-cost-content'));
 const setup=()=>{if(owner)return;api.openDialog('ERP 同步',`<div id="erp-inline-shell" class="erp-sync-stack"><section><header class="erp-sync-heading"><h3>ERP 库存同步</h3><p>更新公司库存与 ERP 成本，保留核算成本。</p></header><fieldset class="erp-sync-block" id="erp-stock-content"></fieldset></section><section><header class="erp-sync-heading"><h3>核算成本更新</h3><p>选择 Excel 表格或云端成本，按 goods_id 更新。</p></header><fieldset class="erp-sync-block" id="erp-cost-content"><p>正在读取成本来源…</p></fieldset></section></div>`);sql.setup();costs.setup();};
 button.disabled=false;button.title='ERP 库存同步与核算成本更新';button.onclick=setup;
 refresh();
 return {setup,refresh};
}
