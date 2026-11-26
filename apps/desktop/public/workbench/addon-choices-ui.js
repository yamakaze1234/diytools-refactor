/** 输出源与配置清单共用的加购方案卡。草稿顺序即海报文案顺序。 */
import {mountProductSearch,destroyProductSearch} from './product-search.js';
import {selectableComponents} from './component-policy.js';
import {componentStock} from './inventory-check-data.js';
import {choiceDescription,choiceText,choiceAddon,addonCheck,addonQuickPrices,validateAddon} from './addon-data.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const amount=cents=>cents==null?'待补充':'¥'+(cents/100).toFixed(2);
const badge=(kind,value)=>`<span class="ac-badge ac-${kind}">${esc(value)}</span>`;
const button=(action,title,extra='')=>`<button type="button" class="wb-btn wb-btn-sm ${extra}" data-choice-${action}>${title}</button>`;

function stockBadge(stock,header=false){
 if(stock.value==null)return badge('unk','库存未知');
 if(stock.value<=0)return badge('out',header?'目标缺货':'无库存 · '+stock.value);
 return badge('ok','现货 '+stock.value);
}

function pickedProduct(row,costs){
 const stock=componentStock(row.goodsId,costs);
 return `<div class="ac-target"><div><strong>${esc(row.name)}</strong> <small>#${esc(row.goodsId)}</small></div>
 <div class="ac-target-stats"><span>ERP <b>${amount(row.erp==null?null:Math.round(row.erp*100))}</b></span>
 <span>核算 <b>${amount(row.tax==null?null:Math.round(row.tax*100))}</b></span>${stockBadge(stock)}
 ${stock.incoming!=null&&stock.incoming>Math.max(stock.value??0,0)?badge('transit','待入 '+stock.incoming):''}</div></div>
 <button type="button" class="wb-btn wb-btn-sm" data-product-reselect>更换商品 ⇄</button>`;
}

function marginCard(field,price){
 const {label,originalPriceCents,costCents,diffCents}=field;
 const tone=diffCents==null?'low':diffCents<0?'out':'ok';
 const status=diffCents==null?'缺价待核对':diffCents<0?'负差价':diffCents===0?'持平':'正差价';
 return `<div class="ac-margin ac-${tone}"><div><small>${label}口径 (${amount(originalPriceCents)} + ${amount(price)} − ${amount(costCents)})</small><b>${status}</b></div><strong>${diffCents==null?'—':(diffCents>=0?'+':'−')+amount(Math.abs(diffCents))}</strong></div>`;
}

/** 备注只作内部交接，收起时保留文本摘要，避免用户误当作海报文案。 */
export function mountAddonNote(host,attribute,value=''){
 host.innerHTML=`<details class="ac-note"><summary><strong>内部加购备注</strong><span data-note-preview></span><small></small></summary><div><textarea class="wb-textarea" rows="2" ${attribute} aria-label="内部加购备注" placeholder="填写内部核价说明或运营交接备注（不会显示在消费者海报上）…"></textarea></div></details>`;
 const note=host.querySelector('textarea'),preview=host.querySelector('[data-note-preview]');
 note.value=value;
 const update=()=>{preview.textContent=note.value.trim()||'（选填，不展示在海报）';};
 note.addEventListener('input',update);update();
 return note;
}

function cardMarkup(choice,only){
 const {priceCents,qty,originalQty,label,enabled}=choice;
 return `<header class="ac-heading"><div class="ac-flags">
 ${button('toggle','<span data-choice-caret></span> 方案 <span data-choice-number></span>','ac-toggle')}
 <label><input type="checkbox" data-choice-enabled ${enabled?'checked':''}> 展示</label>
 <label><input type="checkbox" data-choice-text-only ${only?'checked':''}> 仅文字</label><span data-choice-badges></span></div>
 <div class="ac-actions"><button type="button" class="wb-btn wb-btn-sm" data-choice-up title="上移" aria-label="上移">↑</button>
 <button type="button" class="wb-btn wb-btn-sm" data-choice-down title="下移" aria-label="下移">↓</button>
 ${button('duplicate','复制')}${button('remove','移除','wb-btn-danger')}</div></header>
 <button type="button" class="ac-summary" data-choice-summary hidden><span></span><strong></strong></button>
 <div class="ac-body"><div data-choice-product></div>
 <div class="ac-pricing" data-choice-pricing>
 <label>原配件替换数<input class="wb-input" type="number" min="1" max="100000" step="1" data-choice-original-qty value="${esc(originalQty??1)}"></label>
 <label>新配件数量<input class="wb-input" type="number" min="1" max="100000" step="1" data-choice-qty value="${esc(qty??1)}"></label>
 <label>加购价格 (元)<input class="wb-input" type="number" min="0" step=".01" data-choice-price value="${priceCents==null?'':(priceCents/100).toFixed(2)}"></label></div>
 <div class="ac-chips" data-choice-chips></div>
 <label class="ac-copy"><span><b>展示文案</b><small data-choice-label-hint></small></span>
 <input class="wb-input" data-choice-label value="${esc(label)}" placeholder="例如：升级32G双通道"></label>
 <div class="ac-margins" data-choice-check></div></div>`;
}

/** 外置预览与当前店铺的编辑器一一对应；没有固定栏的入口复用编辑器自带的置顶预览。 */
export function mountAddonChoices(root,{initial=[],getCosts,getOriginals=()=>[],sourceId,onChange=()=>{},previewHost,legacyPreview,preserveSelection=true}){
 root.querySelectorAll('.product-search').forEach(destroyProductSearch);
 root.classList.add('addon-choices-editor');
 root.innerHTML=`<div class="ac-tools"><div><strong>加购升级方案</strong><span data-choice-risks></span></div><div>
 ${button('collapse-all','全部折叠')}${button('add','＋ 添加方案','wb-btn-primary wb-cut')}</div></div><div data-choice-list></div>`;
 const preview=document.createElement('div');
 preview.className='ac-merged';preview.setAttribute('data-addon-merged','');
 preview.innerHTML='<div><strong>合并展示预览</strong><small data-choice-count></small></div><p aria-live="polite" data-choice-preview></p>';
 if(previewHost)previewHost.replaceChildren(preview);else root.prepend(preview);
 const list=root.querySelector('[data-choice-list]'),all=root.querySelector('[data-choice-collapse-all]');
 const cards=[];
 let legacyBaseline;
 function readCard(card,strict){
  const {choice,node}=card,field=name=>node.querySelector('[data-choice-'+name+']');
  const price=field('price'),raw=price.value;
  if(strict&&(price.validity.badInput||raw!==''&&!/^\d+(\.\d{1,2})?$/.test(raw)))throw Error('每项加购价最多两位小数');
  if(strict&&!field('text-only').checked&&!choice.goodsId)throw Error('请选择加购商品，或勾选仅文字说明');
  return {...choice,originalQty:Number(field('original-qty').value),qty:Number(field('qty').value),priceCents:raw===''?null:Math.round(Number(raw)*100),label:field('label').value.trim(),enabled:field('enabled').checked};
 }
 function read(required=true){
  const rows=cards.map(card=>readCard(card,true));
  if(required)validateAddon({text:choiceDescription(rows),choices:rows},{required:true,costs:getCosts()});
  return rows;
 }
 function fold(card,collapsed){
  card.collapsed=collapsed;
  const {node}=card;
  node.querySelector('.ac-body').hidden=collapsed;
  node.querySelector('[data-choice-summary]').hidden=!collapsed;
  node.querySelector('[data-choice-toggle]').setAttribute('aria-expanded',String(!collapsed));
  node.querySelector('[data-choice-caret]').textContent=collapsed?'▸':'▾';
  all.textContent=cards.length&&cards.every(item=>item.collapsed)?'全部展开':'全部折叠';
 }
 function refresh(notify=true){
  const costs=getCosts(),originals=getOriginals(),rows=cards.map(card=>readCard(card,false));
  let out=0,negative=0,unknown=0,products=0;
  cards.forEach((card,index)=>{
   const {node}=card,c=rows[index],$=s=>node.querySelector(s),only=$('[data-choice-text-only]').checked;
   const product=c.goodsId?costs.find(row=>row.goodsId===c.goodsId):null;
   const stock=componentStock(c.goodsId,costs),check=addonCheck(choiceAddon(c,sourceId),costs,originals);
   const erp=check.fields[0],tax=check.fields[1],loss=check.fields.some(f=>f.diffCents!=null&&f.diffCents<0);
   if(!only){products++;if(stock.status==='out')out++;if(loss)negative++;if(stock.value==null||check.fields.some(f=>f.diffCents==null))unknown++;}
   node.classList.toggle('ac-risk',!only&&(stock.status==='out'||loss));
   node.classList.toggle('ac-disabled',!c.enabled);
   $('[data-choice-number]').textContent=index+1;
   $('[data-choice-up]').disabled=index===0;$('[data-choice-down]').disabled=index===cards.length-1;
   $('[data-choice-duplicate]').disabled=cards.length>=30;
   $('[data-choice-badges]').innerHTML=only?badge('unk','纯文案'):stockBadge(stock,true)+(loss?badge('out','负差价'):erp.diffCents==null?badge('low','差价待核对'):badge('ok',erp.diffCents?'正差价 +'+amount(erp.diffCents):'差价持平'));
   $('[data-choice-summary] span').textContent=(only?'纯文字说明':product?.name||'未选商品')+' · '+(choiceText(c)||'未填文案');
   $('[data-choice-summary] strong').textContent=only?'—':c.priceCents==null?'待定价':'+'+amount(c.priceCents);
   $('[data-choice-product]').hidden=only;$('[data-choice-pricing]').hidden=only;
   const prices=sourceId&&!only?addonQuickPrices(erp):[],chips=$('[data-choice-chips]');
   // 只有数量或成本变化时替换按钮，连续操作可保持键盘焦点。
   const pricesKey=prices.join(',');
   if(chips.dataset.prices!==pricesKey){
    chips.dataset.prices=pricesKey;
    chips.innerHTML=prices.length?'快捷定价：'+prices.map((v,i)=>`<button type="button" data-quick-price="${v}">${['ERP保本 ¥'+v,'+¥50利 (¥'+v+')','+¥100利 (¥'+v+')','凑99 (¥'+v+')'][i]}</button>`).join(''):'';
   }
   chips.hidden=!prices.length;
   $('[data-choice-label-hint]').textContent=only?'纯文字原样显示':c.customText?'沿用完整自定义文案（价格仍独立核算）':'金额将自动带出，无需手写价格';
   $('[data-choice-check]').hidden=only;
   if(!only)$('[data-choice-check]').innerHTML=marginCard(tax,c.priceCents)+marginCard(erp,c.priceCents);
  });
  root.querySelector('[data-choice-risks]').innerHTML=(out?badge('out','含 '+out+' 项缺货'):'')+(negative?badge('out','含 '+negative+' 项负差价'):'')+(!out&&!negative&&products?(unknown?badge('low','库存或差价待核对'):badge('ok','差价与库存正常')):'');
  root.querySelector('[data-choice-add]').disabled=cards.length>=30;all.disabled=!cards.length;
  all.textContent=cards.length&&cards.every(card=>card.collapsed)?'全部展开':'全部折叠';
  const savedPreview=legacyPreview&&legacyBaseline===JSON.stringify(rows)?legacyPreview:null;
  const count=savedPreview?.count??rows.length,visible=savedPreview?.visible??rows.filter(c=>c.enabled).length;
  preview.querySelector('[data-choice-count]').textContent=`${count} 个方案 · ${visible} 项展示`;
  preview.querySelector('[data-choice-preview]').textContent=(savedPreview?.text??choiceDescription(rows))||'暂不展示加购';
  if(notify)onChange();
 }
 function insert(choice,only,collapsed,index=cards.length){
  const node=document.createElement('section');node.className='ac-card';node.dataset.choice=choice.id;
  node.innerHTML=cardMarkup(choice,only);
  const card={node,choice,collapsed},$=s=>node.querySelector(s);
  list.insertBefore(node,cards[index]?.node??null);cards.splice(index,0,card);fold(card,collapsed);
  const picker=mountProductSearch($('[data-choice-product]'),{getRows:()=>selectableComponents(getCosts()),getCosts,selected:choice.goodsId,label:'加购商品',compact:true,preserveSelection,renderCompactSelection:pickedProduct,onChange:row=>{
   choice.goodsId=row?.goodsId||'';
   if(row&&!$('[data-choice-label]').value.trim())$('[data-choice-label]').value='升级'+row.name;
   refresh();
  }});
  $('[data-choice-text-only]').onchange=event=>{if(event.target.checked)picker.clear();else refresh();};
  for(const input of node.querySelectorAll('[data-choice-original-qty],[data-choice-qty],[data-choice-price],[data-choice-label],[data-choice-enabled]'))input.oninput=()=>refresh();
  $('[data-choice-toggle]').onclick=()=>fold(card,!card.collapsed);
  $('[data-choice-summary]').onclick=()=>fold(card,false);
  $('[data-choice-chips]').onclick=event=>{
   const chip=event.target.closest('[data-quick-price]');if(!chip)return;
   const price=chip.dataset.quickPrice,label=$('[data-choice-label]');
   $('[data-choice-price]').value=price;
   if(choice.customText)label.value=label.value.replace(/([+＋]\s*)\d+(?:\.\d+)?(\s*元)/,(_,prefix,suffix)=>prefix+price+suffix);
   refresh();
  };
  function move(step){
   const i=cards.indexOf(card),to=i+step;if(to<0||to>=cards.length)return;
   cards.splice(i,1);cards.splice(to,0,card);
   list.insertBefore(node,cards[to+1]?.node??null);refresh();
  }
  $('[data-choice-up]').onclick=()=>move(-1);$('[data-choice-down]').onclick=()=>move(1);
  $('[data-choice-duplicate]').onclick=()=>{
   const copy={...readCard(card,false),id:crypto.randomUUID()};
   const duplicate=insert(copy,$('[data-choice-text-only]').checked,false,cards.indexOf(card)+1);
   refresh();duplicate.node.querySelector('[data-choice-label]').focus();
  };
  $('[data-choice-remove]').onclick=()=>{picker.destroy();cards.splice(cards.indexOf(card),1);node.remove();refresh();};
  return card;
 }
 all.onclick=()=>{const collapse=cards.some(card=>!card.collapsed);cards.forEach(card=>fold(card,collapse));};
 root.querySelector('[data-choice-add]').onclick=()=>{
  const card=insert({id:crypto.randomUUID(),goodsId:'',qty:1,originalQty:1,priceCents:null,label:'',enabled:true},false,false);
  refresh();card.node.querySelector('[data-product-query]').focus();
 };
 initial.forEach((choice,index)=>insert(structuredClone(choice),!choice.goodsId,index>0));
 if(legacyPreview)legacyBaseline=JSON.stringify(cards.map(card=>readCard(card,false)));
 refresh();return {read,refresh};
}
