/** 快照与回执中的业务文本均按纯文本显示。 */
export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const actions={create:'新建套餐',update:'更新原套餐',already:'已一致',conflict:'异常阻断',reuse:'复用套餐'};
const states={pending:'待读取',previewed:'待确认执行',running:'处理中',verified:'已核验',needs_review:'待人工核验',not_run:'未执行',conflict:'已阻断',failed:'失败'};
const steps={get_code:'获取套餐编码',create_package:'创建套餐',save_bom:'保存套餐明细',set_bom_type:'设置套餐类型',link_sku:'关联网店 SKU',repair_link:'刷新网店关联'};

export function renderMatchRow(row,partName,complete){
 const diff=row.diff??[],expected=Object.entries(row.expected??{}),kind=Object.hasOwn(actions,row.action)?row.action:'loading';
 const qty=expected.reduce((sum,[,count])=>sum+count,0);
 const truncated=!complete&&(row.expectedTotal>expected.length||row.diffTotal>diff.length);
 const difference=diff.map(({goodsId,before,after})=>{
  const type=before===0?'add':after===0?'del':'change';
  const label=before===0?'新增':after===0?'移除':'数量';
  return `<div class="erp-diff ${type}"><span>${esc(partName(goodsId)||'配件')} <small>#${esc(goodsId)}</small></span><strong>${esc(before)} → ${esc(after)}（${label}）</strong></div>`;
 }).join('');
 const parts=expected.map(([id,count])=>`<div class="erp-bom-line"><span>${esc(partName(id)||'配件')}</span><code>#${esc(id)}</code><strong>×${esc(count)}</strong></div>`).join('');
 const operation=row.pendingStep?' · '+(steps[row.pendingStep.operation]??'待核对原提交'):'';
 return `<tr><td><strong>${esc(row.name)}</strong><div class="erp-identities"><span>店铺 ${esc(row.shopId)}</span><span>SPU ${esc(row.spu)}</span><span>SKU ${esc(row.sku)}</span></div></td>
 <td class="erp-action-cell"><b class="erp-badge ${kind}">${actions[kind]??'读取中…'}</b><small>${esc(states[row.state]??'待核对')}</small></td>
 <td>${row.reason?'<div class="erp-reason">'+esc(row.reason)+'</div>':''}${operation?'<div class="erp-reason">'+esc(operation.slice(3))+'</div>':''}
 ${row.nameChanged?'<div>平台名称已变化：'+esc(row.platformName)+'</div>':''}${difference}
 ${expected.length?`<details class="erp-bom" data-bom-id="${esc(row.configId)}"><summary>目标 BOM · <b>${esc(row.expectedTotal??expected.length)} 种配件</b>${truncated?'':' · 共 '+esc(qty)+' 件'}</summary><div>${parts}</div></details>`:''}
 ${truncated?`<button type="button" data-erp-detail="${esc(row.configId)}">查看完整 BOM 差异</button>`:''}</td></tr>`;
}

export function actionCounts(job){
 if(job?.actionCounts)return job.actionCounts;
 const counts={};
 for(const row of job?.items??[])if(row.action)counts[row.action]=(counts[row.action]??0)+1;
 return counts;
}
export const updatePrompt=count=>`本批含 ${count} 套将更新原套餐 BOM，确认执行本次快照？`;
