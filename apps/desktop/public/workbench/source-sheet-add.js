import {splitErpName,effectivePartColor} from './erp-part-description.js';
import {excludedComponent} from './component-policy.js';
import {boardType,boardTypes,caseSupport,hardwareColors} from './component-hardware.js';
import {autoCapacity} from './component-capacity.js';
import {readCapacityFields} from './source-capacity-ui.js';
import {readHardwareFields} from './source-hardware-ui.js';
import {shortCpu} from './legacy-names.js';
import {gpuSpec} from './host-template-model.js';
import {sourceGoodsId} from './shared-source-fields.js';
import {sheetTaxInput,sourceSheetCategories,sourceSheetCategory,sourceSheetTaxCompare} from './source-sheet-model.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge=(text,type)=>`<span class="badge badge-${type}">${esc(text)}</span>`;
const price=value=>Number.isFinite(value)?'¥'+value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'未知';
function stockBadges(row){
 const available=row.stockAvailable,incoming=row.stockIncomingAvailable;
 // 待入可销包含现货；只有大于现货时才有额外可展示的待入量。
 const stock=badge('现货 '+(available??'未知'),available==null?'unk':available>0?'ok':'out');
 return incoming!=null&&incoming>(available??0)?stock+' '+badge('待入 '+incoming,'transit'):stock;
}
const options=values=>values.map(value=>`<option>${esc(value)}</option>`).join('');
function specsHtml(category){
 const color=`<label>外观颜色<select class="wb-input" id="source-hardware-color"><option value="" data-auto-color>自动识别</option>${options(hardwareColors)}</select></label>`;
 const capacity=(key,title,hint)=>`<label><span class="ss-add-label">${title}<span class="badge badge-ok" data-auto-cap></span></span><input class="wb-input" data-capacity="${key}" type="number" min="0.01" step="any" placeholder="留空自动识别"><small>${hint}</small></label>`;
 const short=(key,title)=>`<label><span class="ss-add-label">${title}（配置简称显示）<span class="badge badge-ok" data-auto-short></span></span><input class="wb-input" id="source-hardware-${key}" maxlength="80" placeholder="留空自动识别，可手动填写简称"><small>用于整机配置简称，清空恢复自动识别</small></label>`;
 switch(category){
  case 'CPU':return short('cpu','CPU 简称识别名称')+'<div class="ss-add-example"><small>配置简称显示效果预览</small><strong data-short-preview></strong><small>人工填写优先，后续 ERP 同步不会覆盖</small></div>';
  case '显卡':return short('gpu','显卡简称')+`<div class="ss-spec-pair">${capacity('vramGb','显存容量 (GB)','')}${color}</div>`;
  case '内存':return capacity('memoryGb','内存容量 (GB) · 配置简称显示','填写单件总容量，如 16G×2 填 32。')+color;
  case '硬盘':return capacity('storageGb','硬盘容量 (GB) · 配置简称显示','1TB = 1024GB，人工值优先，价格同步不覆盖。');
  case '主板':return `<label>主板板型（兼容机箱检查）<select id="source-hardware-board" class="wb-input"><option value="" data-auto-board>自动识别</option>${options(boardTypes)}</select></label>`+color;
  case '机箱':return `<div class="ss-add-cases"><strong>支持主板板型</strong>${boardTypes.map(t=>`<label><input type="checkbox" data-case-board="${t}">${t}</label>`).join('')}<small data-auto-case></small></div>`+color;
  default:return color+'<small>该分类暂无额外简称或兼容必填项</small>';
 }
}

// 普通与特殊模式共用同一宿主弹窗。异步结果只更新仍属于当前货号的表单。
export function mountAddPart(host,{api,shared,adoptOnly,shops,findExisting,locate,submit,isCurrent}){
 const canSpecial=!api.nas||!!api.sharedSources?.canCreate;
 host.classList.add('ss-add-part','wb-shell');
 host.innerHTML=`<header class="ss-add-head"><div><strong>添加配件</strong>${badge(shared?'三店共用新建':'当前店铺新建','cat')}<small>${esc(shared?'保存后同步至'+shops.join(' / '):'仅加入'+shops.join(' / '))}</small></div><button type="button" class="wb-btn wb-btn-sm" data-close aria-label="关闭添加配件">✕</button></header>
 <div class="ss-add-modes"><div role="group" aria-label="配件类型"><button type="button" data-mode="normal" aria-pressed="true">普通配件（绑定 ERP 货号）</button><button type="button" data-mode="special" aria-pressed="false" ${canSpecial?'':'disabled title="新增特殊配件需要三店维护权限"'}>特殊配件（无货号 · 成本 ¥0）</button></div><small data-mode-hint></small></div>
 <div class="ss-add-body">
 <section data-ordinary><div class="ss-add-erp-heading"><label for="ss-part-id" class="ss-add-title">1. ERP 商品定位 <em>*</em></label></div>
 <div class="ss-id-line"><div class="ss-add-query"><input class="wb-input" id="ss-part-id" autocomplete="off" role="combobox" aria-controls="ss-add-results" aria-expanded="false" placeholder="输入 1–20 位 ERP 货号，或输入型号关键词搜索 ERP…"><div id="ss-add-results" role="listbox" hidden></div></div><button type="button" class="wb-btn wb-btn-primary wb-cut" data-lookup ${api.lookupProduct?'':'hidden'}>查询 ERP</button></div>
 <div class="ss-part-feedback" hidden><span data-feedback></span><button type="button" class="wb-btn wb-btn-sm" data-locate hidden>定位到已有记录 →</button></div>
 <div class="ss-part-preview" hidden></div></section>
 <section><strong class="ss-add-title" data-name-title></strong><div class="ss-add-pricing"><div><div class="ss-add-label"><label for="ss-part-name">${shared?'三店共用展示名称':'展示名称'} <em>*</em></label><button type="button" data-reset-name>填入 ERP 精简名</button></div><input class="wb-input" id="ss-part-name" maxlength="512" placeholder="用于配置表和消费者海报展示" autocomplete="off"></div>
 <div data-tax-wrap><div class="ss-add-label"><label for="ss-part-tax">含税核算价(元)</label><span data-delta></span></div><input class="wb-input" id="ss-part-tax" inputmode="decimal" placeholder="选填，留空待填"></div></div>
 <div class="ss-add-category" hidden><label>配件大类<select class="wb-input" data-category><option value="">按名称识别</option>${options(sourceSheetCategories.slice(1,-1))}</select></label><small>未从 ERP 查到分类时，可按展示名称识别或手动指定。</small></div></section>
 <details class="ss-add-specs" open><summary><strong>3. 配置简称显示与硬件识别资料（按 <span data-spec-cat></span> 自动匹配）</strong>${badge('用于配置简称生成 & 兼容校验','sel')}<small></small></summary><div class="ss-add-spec-grid"></div></details>
 <div class="ss-add-scope"><div><b>建源范围：</b>${shops.map(s=>badge(s,'ok')).join(' ')}<small>${adoptOnly?'加入后即可维护本店配件':'加入草稿后可继续编辑，统一保存'}</small></div><label data-open-wrap><input data-open-addons type="checkbox"> 加入草稿后立即配置升级项</label></div></div>
 <footer class="ss-part-actions"><small role="status" aria-live="polite"></small><div><button type="button" data-cancel class="wb-btn">取消</button><button type="button" class="wb-btn wb-btn-primary wb-cut" data-add>${adoptOnly?'加入当前店铺':'加入待保存草稿'}</button></div></footer>`;
 const $=selector=>host.querySelector(selector);
 const id=$('#ss-part-id'),name=$('#ss-part-name'),tax=$('#ss-part-tax'),category=$('[data-category]'),results=$('#ss-add-results'),lookup=$('[data-lookup]'),add=$('[data-add]'),specs=$('.ss-add-spec-grid'),preview=$('.ss-part-preview'),jump=$('[data-locate]');
 let revision=0,timer,special=false,normalName='',specialName='',manualGoodsId='',manualName=false,manualTax=false,candidate=null,blocked=false,loading=false,saving=false,info='',miss=false,currentCat='',choices=[],index=-1;
 const current=token=>isCurrent()&&host.isConnected&&revision===token;
 const duplicate=()=>sourceGoodsId(id.value.trim())&&findExisting(id.value.trim());
 function closeResults(){
  choices=[];index=-1;results.hidden=true;results.replaceChildren();id.setAttribute('aria-expanded','false');id.removeAttribute('aria-activedescendant');
 }
 function resetMatch(goodsId){
  // 同一货号重查时保留人工值；改查或选中其他商品时由新商品重新带入。
  if(manualGoodsId&&manualGoodsId!==goodsId){manualName=false;manualTax=false;manualGoodsId='';}
  candidate=null;blocked=false;loading=false;miss=false;info='';preview.hidden=true;category.value='';currentCat='';
  if(!manualName)name.value='';if(!manualTax)tax.value='';
 }
 function renderSpecs(cat){
  if(currentCat!==cat){currentCat=cat;specs.innerHTML=specsHtml(cat);}
  $('[data-spec-cat]').textContent=cat;
  const row={...candidate,name:name.value||candidate?.erpName||''},product=row.erpName||row.name;
  const write=(selector,value)=>{const node=$(selector);if(node)node.textContent=value;};
  const short=cat==='CPU'?(row.hardwareFacts?.cpuName||shortCpu(product)):cat==='显卡'?gpuSpec(row)?.model:'';
  write('[data-auto-short]','自动：'+(short||'未识别'));
  write('[data-short-preview]',$('#source-hardware-cpu')?.value.trim()||short||'待识别');
  const gb=autoCapacity(product);
  write('[data-auto-cap]','自动：'+(gb==null?'未识别':gb+'G'));
  write('[data-auto-color]','自动识别'+(effectivePartColor(row)?`（${effectivePartColor(row)}）`:''));
  write('[data-auto-board]','自动识别'+(boardType(row)?`（${boardType(row)}）`:''));
  const support=caseSupport(row);
  write('[data-auto-case]','自动：'+(support.exact?.join(' / ')||support.type||'未识别'));
 }
 function update(){
  const goodsId=id.value.trim(),valid=sourceGoodsId(goodsId),existing=!special&&duplicate();
  const display=name.value.trim(),cat=sourceSheetCategory({...candidate,name:display,erpCategory:candidate?.erpCategory||category.value});
  let error='';
  if(!special){
   renderSpecs(cat);
   try{sheetTaxInput(tax.value);readHardwareFields(specs);readCapacityFields(specs);}catch(e){error=e.message;}
   if(goodsId&&!valid&&!api.erpSearch)error='请输入 1–20 位有效 ERP 货号，首位不能为 0';
  }
  if(excludedComponent({name:display}))error='展示名称含禁用字符，不能加入输出源';
  const warning=existing?(existing.base.deletedAt!=null?'该货号在已删除列表中，请前往左侧「已删除」恢复':'该货号已存在输出源'):!special&&(miss||blocked)?info:'';
  $('.ss-part-feedback').hidden=!warning;$('[data-feedback]').textContent=warning;
  jump.hidden=!existing||existing.base.deletedAt!=null;
  lookup.disabled=!valid||!!existing||loading||saving;
  add.disabled=!display||!!error||saving||(!special&&(!valid||!!existing||blocked||loading||(adoptOnly&&!candidate)));
  $('[role=status]').textContent=error||(warning?'请核对 ERP 商品定位':info)||
   (special?'特殊配件无 ERP 货号，成本固定 ¥0':adoptOnly?'请先查询 ERP，再加入当前店铺。':'准备就绪：将创建 1 条待保存输出源草稿');
  const delta=sourceSheetTaxCompare(tax.value,Number.isFinite(candidate?.erp)?Math.round(candidate.erp*100):null);
  const amount=Math.abs(delta.diffCents/100).toFixed(2);
  const label={high:'高于ERP +¥'+amount,low:'低于ERP -¥'+amount,equal:'= 与 ERP 持平'};
  $('[data-delta]').className='badge badge-'+({high:'ok',low:'low',equal:'ok'}[delta.status]||'unk');
  $('[data-delta]').textContent=label[delta.status]||'待对比';
  $('[data-reset-name]').disabled=!candidate||saving;
  $('.ss-add-category').hidden=special||!!candidate?.erpCategory||!!existing||!valid||adoptOnly;
 }
 function layout(){
  host.dataset.partMode=special?'special':'normal';
  for(const b of host.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String((b.dataset.mode==='special')===special));
  for(const selector of ['[data-ordinary]','[data-tax-wrap]','.ss-add-specs','[data-reset-name]','[data-open-wrap]'])$(selector).hidden=special;
  $('[data-name-title]').textContent=special?'展示名称':'2. 展示名称与含税核算价';
  $('[data-mode-hint]').textContent=!canSpecial?'特殊配件需要三店维护权限':special?'成本固定为 ¥0':'支持按名称联想搜索，或直接输货号查 ERP';
  update();
 }
 function renderPreview(row){
  const cat=sourceSheetCategory(row);
  preview.innerHTML=`<div class="ss-add-card-head">${badge('已匹配 ERP','ok')}${badge(cat,'cat')}<strong>${esc(row.erpName)}</strong><small>货号 #${esc(row.goodsId)}</small></div>
  <div class="ss-add-market"><div><small>ERP 最新单价</small><b>${price(row.erp)}</b></div><div><small>现货可销 / 待入可销</small>${stockBadges(row)}</div><div><small>ERP 原分类</small><strong>${esc(row.erpCategory||'未知')} → 归类：${esc(cat)}</strong></div></div>`;
  preview.hidden=false;
 }
 async function applyMatch(row,token){
  const erpName=row.erpName||row.name;
  if(!erpName||row.erpMissing||excludedComponent(row)){blocked=true;info='该 ERP 商品不可加入输出源。';return;}
  candidate={...row,name:erpName,erpName};id.value=String(row.goodsId);miss=false;
  if(manualName||manualTax)manualGoodsId=id.value;
  if(!manualName)name.value=splitErpName(erpName).main;
  renderPreview(candidate);info='正在读取参考核算价…';update();
  const reference=await api.readTaxCurrent?.(id.value);
  if(current(token)){
   if(!manualTax)tax.value=Number.isFinite(reference)?String(reference):'';
   info='已查到 ERP 商品。';
  }
 }
 async function select(row){
  if(!row||saving)return;
  clearTimeout(timer);closeResults();const token=++revision;
  id.value=String(row.goodsId);resetMatch(id.value);if(duplicate()){update();return;}
  loading=true;
  try{await applyMatch(row,token);}catch(e){if(current(token))info='读取 ERP 核算价失败：'+e.message;}
  finally{if(current(token)){loading=false;update();}}
 }
 id.oninput=()=>{
  clearTimeout(timer);closeResults();const token=++revision;resetMatch(id.value.trim());update();
  const query=id.value.trim();if(query.length<2||!api.erpSearch||duplicate())return;
  timer=setTimeout(async()=>{
   try{
    const rows=await api.erpSearch(query,new Set());
    if(!current(token)||document.activeElement!==id)return;
    choices=rows.filter(r=>sourceGoodsId(String(r.goodsId))&&!excludedComponent(r)).slice(0,12);
    results.innerHTML=choices.map((r,i)=>`<button type="button" role="option" id="ss-add-option-${i}" data-choice-index="${i}"><strong>${esc(splitErpName(r.erpName||r.name).main)}</strong><small>#${esc(r.goodsId)} · ERP ${price(r.erp)} · ${stockBadges(r)}</small></button>`).join('');
    results.hidden=!choices.length;id.setAttribute('aria-expanded',String(!!choices.length));
   }catch(e){if(current(token)){info='ERP 联想搜索失败：'+e.message;update();}}
  },160);
 };
 results.onmousedown=e=>e.preventDefault();
 results.onclick=e=>{const b=e.target.closest('[data-choice-index]');if(b)void select(choices[Number(b.dataset.choiceIndex)]);};
 id.onblur=()=>closeResults();
 lookup.onclick=async()=>{
  if(lookup.disabled)return;
  const goodsId=id.value.trim(),token=++revision;
  clearTimeout(timer);closeResults();resetMatch(goodsId);loading=true;info='正在查询 ERP…';update();
  try{
   const result=await api.lookupProduct(goodsId);if(!current(token))return;
   let row=result?.row;
   // 原生连接选择取消时仍可使用当前授权范围内的 ERP 缓存候选。
   if(result?.cancelled&&api.erpSearch){const rows=await api.erpSearch(goodsId,new Set());if(!current(token))return;row=rows.find(r=>String(r.goodsId)===goodsId);}
   if(!row||String(row.goodsId)!==goodsId||row.erpMissing||!(row.erpName||row.name)){
    miss=true;info=adoptOnly?'未查到 ERP 商品，单店建源需要有效候选。':'未查到 ERP 商品，可手动选择大类并填写展示名称。';
   }else await applyMatch(row,token);
  }catch(e){if(current(token)){miss=!candidate;info=(candidate?'参考核算价读取失败：':'ERP 查询失败：')+e.message;}}
  finally{if(current(token)){loading=false;update();}}
 };
 for(const b of host.querySelectorAll('[data-mode]'))b.onclick=()=>{
  const next=b.dataset.mode==='special';if(saving||next===special||next&&!canSpecial)return;
  clearTimeout(timer);revision++;loading=false;closeResults();info='';
  if(next){normalName=name.value;name.value=specialName;}
  else{specialName=name.value;name.value=normalName;}
  special=next;layout();(next?name:id).focus();
 };
 name.oninput=()=>{if(!special){manualName=true;manualGoodsId=id.value.trim();}update();};
 tax.oninput=()=>{manualTax=true;manualGoodsId=id.value.trim();update();};
 specs.oninput=category.onchange=update;
 $('[data-reset-name]').onclick=()=>{if(candidate){manualName=false;name.value=splitErpName(candidate.erpName).main;update();}};
 jump.onclick=()=>{const row=duplicate();if(row&&row.base.deletedAt==null){api.closeDialog();locate(row.id);}};
 $('[data-cancel]').onclick=$('[data-close]').onclick=()=>{if(!saving)api.closeDialog();};
 add.onclick=async()=>{
  update();if(add.disabled)return;
  saving=true;update();host.inert=true;
  try{
   const data=special?{displayName:name.value.trim()}:{...candidate,goodsId:id.value.trim(),erpName:candidate?.erpName||'',erpCategory:candidate?.erpCategory||category.value||undefined,
    displayName:name.value.trim(),hardwareOverrides:readHardwareFields(specs),capacityOverrides:readCapacityFields(specs)};
   await submit(data,special?0:sheetTaxInput(tax.value),special,!special&&$('[data-open-addons]').checked);
  }catch(e){info=e.message||String(e);}
  finally{host.inert=false;saving=false;if(isCurrent())update();}
 };
 // 宿主 form 使用 method=dialog；回车查询或选中联想项时保持弹窗打开。
 host.onkeydown=e=>{
  if(e.isComposing)return;
  if(e.target===id&&!results.hidden){
   if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();index=(index+(e.key==='ArrowDown'?1:-1)+choices.length)%choices.length;
    [...results.children].forEach((b,i)=>b.setAttribute('aria-selected',String(i===index)));const b=results.children[index];b.scrollIntoView({block:'nearest'});id.setAttribute('aria-activedescendant',b.id);return;}
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeResults();return;}
   if(e.key==='Enter'&&index>=0){e.preventDefault();void select(choices[index]);return;}
  }
  if(e.key==='Enter'&&e.target.tagName==='INPUT'&&e.target.type!=='checkbox'){e.preventDefault();if(e.target===id)lookup.click();else add.click();}
 };
 layout();id.focus();
}
