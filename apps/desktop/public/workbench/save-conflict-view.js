/** 保存冲突预览展示最终待保存内容与最新持久化版本，复用同步冲突的字段格式。 */
import {conflictDifferences} from './cloud-conflict-view.js';
import {sameValue} from './workspace-ui-merge.js';

const collections={configs:['id','配置'],templates:['id','模板'],sourceCatalog:['sourceId','输出源'],costSource:['goodsId','成本'],caseGallery:['id','图片']};
export function saveConflictSections(draft,remote){
 const sections=[];
 const add=(title,context,local,saved)=>{const differences=conflictDifferences(local,saved);if(differences.length)sections.push({title,context,differences});};
 for(const [key,[id,label]] of Object.entries(collections)){
  const local=new Map((draft[key]||[]).map(row=>[row[id],row])),saved=new Map((remote[key]||[]).map(row=>[row[id],row]));
  for(const rowId of new Set([...local.keys(),...saved.keys()])){
   const a=local.get(rowId),b=saved.get(rowId),info=a||b;
   add(`${label} · ${info.name||info.displayName||rowId}`,[info.shop||info.shopId,info.product||info.productId,info.spu?`SPU ${info.spu}`:'',!a?'本页将移除此项':!b?'本页将新增此项':''].filter(Boolean).join(' / '),a,b);
  }
  const a=[...local.keys()],b=[...saved.keys()];
  if(a.length===b.length&&a.every(value=>saved.has(value))&&!sameValue(a,b)){
   const names=(ids,map)=>ids.map(value=>map.get(value).name||value).join(' → ');
   add(`${label}排列顺序`,'',names(a,local),names(b,saved));
  }
 }
 for(const shop of new Set([...Object.keys(draft.shopSettings||{}),...Object.keys(remote.shopSettings||{})]))add(`店铺设置 · ${shop}`,'',draft.shopSettings?.[shop],remote.shopSettings?.[shop]);
 return sections;
}
export function saveConflictHtml(draft,remote,esc){
 const sections=saveConflictSections(draft,remote),count=sections.reduce((sum,row)=>sum+row.differences.length,0);
 return `<p class="hint" role="status">${sections.length} 项资料，共 ${count} 处待保存差异。左侧为合并后的本页待保存内容，右侧为最新已保存内容。</p><div class="cloud-conflict-list">${sections.map(row=>`<article class="cloud-conflict-card"><header><strong>${esc(row.title)}</strong><span class="cloud-conflict-count">${row.differences.length} 处差异</span></header>${row.context?`<p class="cloud-conflict-context">${esc(row.context)}</p>`:''}<div class="cloud-conflict-table"><table><thead><tr><th>差异字段</th><th>本页待保存内容</th><th>最新已保存内容</th></tr></thead><tbody>${row.differences.map(d=>`<tr><th scope="row">${esc(d.field)}</th><td>${esc(d.local)}</td><td>${esc(d.remote)}</td></tr>`).join('')}</tbody></table></div></article>`).join('')||'<p class="cloud-conflict-empty">当前草稿与最新已保存内容一致，没有待保存差异。</p>'}</div>`;
}
