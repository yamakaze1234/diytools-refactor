/** 选配项编辑控件：管理商品选择、价格及选项变化，通过回调回传草稿。 */
import {mountProductSearch,destroyProductSearch} from './product-search.js';
import {selectableComponents} from './component-policy.js';
import {choiceDescription,choiceAddon,validateAddon} from './addon-data.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** 只调整表单投影，历史 customText 字段按原值保留，不再提供新建该模式的选项。 */
export function mountAddonChoices(root,{initial=[],getCosts,sourceId,onChange=()=>{},renderCheck=()=>'',react,statusModel}){
 let choices=structuredClone(initial);
 const textOnly=new Map(choices.map(c=>[c.id,!c.goodsId]));
 root.classList.add('addon-choices-editor');
 const nodeFor=id=>[...root.querySelectorAll('[data-choice]')].find(node=>node.dataset.choice===id);
 const read=(required=true,excluding=null)=>{
  const rows=choices.filter(choice=>choice.id!==excluding).map(c=>{
   const node=nodeFor(c.id),raw=node.querySelector('[data-choice-price]').value;
   if(raw!==''&&!/^\d+(\.\d{1,2})?$/.test(raw))throw Error('每项加购价最多两位小数');
   if(!node.querySelector('[data-choice-text-only]').checked&&!c.goodsId)throw Error('请选择加购商品，或勾选仅文字说明');
   return {...c,originalQty:Number(node.querySelector('[data-choice-original-qty]').value),qty:Number(node.querySelector('[data-choice-qty]').value),priceCents:raw===''?null:Math.round(Number(raw)*100),label:node.querySelector('[data-choice-label]').value.trim(),enabled:node.querySelector('[data-choice-enabled]').checked};
  });
  if(required)validateAddon({text:choiceDescription(rows),choices:rows},{required:true,costs:getCosts()});
  return rows;
 };
 function refresh(){
  try{
   const rows=read(false);
   root.querySelector('[data-choice-preview]').textContent=choiceDescription(rows)||'暂不展示加购';
   root.querySelector('[data-choice-count]').textContent=`${rows.length} 个方案 · ${rows.filter(c=>c.enabled).length} 项展示`;
   for(const c of rows){
    const node=nodeFor(c.id);node.classList.toggle('is-disabled',!c.enabled);
    node.querySelector('[data-choice-label-title]').textContent='展示文案';
    node.querySelector('[data-choice-label-hint]').textContent=!c.goodsId?'说明原样显示，不参与差价核算。':c.customText?'此项沿用原有完整文案；商品、数量和价格仍独立保存。':'金额自动带出，文案无需重复填写价格。';
    const target=node.querySelector('[data-choice-check]'),value=choiceAddon(c,sourceId);
    if(!react?.status(target,statusModel(value)))target.innerHTML=renderCheck(value);
   }
  }catch(error){root.querySelector('[data-choice-preview]').textContent=error.message;}
  onChange();
 }
 function draw(){
  root.querySelectorAll('.product-search').forEach(destroyProductSearch);react?.release(root);
  const model=choices.map(c=>({...c,textOnly:textOnly.get(c.id)??!c.goodsId}));
  if(!react?.dialog(root,'addon-choices',{choices:model}))root.innerHTML=`
   <div class="addon-choice-intro"><span data-choice-count></span><details><summary>填写说明</summary><p class="hint">每个方案单独绑定商品、填写加购价。内存从 1 根升级到 2 根：原配件替换数量填 1，新配件数量填 2。仅文字说明无需绑定商品。</p></details></div>
   <div data-choice-list>${model.map((c,i)=>`<section class="addon-choice" data-choice="${esc(c.id)}">
    <div class="addon-choice-heading"><strong>加购方案 ${i+1}</strong><label><input type="checkbox" data-choice-enabled ${c.enabled?'checked':''}> 展示</label><label><input type="checkbox" data-choice-text-only ${c.textOnly?'checked':''}> 仅文字说明</label><button type="button" data-choice-remove>移除</button></div>
    <div class="addon-choice-body"><div data-choice-product ${c.textOnly?'hidden':''}></div>
     <div class="inline-grid" data-choice-pricing ${c.textOnly?'hidden':''}><label class="field">原配件替换数量<input type="number" min="1" max="100000" step="1" data-choice-original-qty value="${c.originalQty??1}"></label><label class="field">新配件数量<input type="number" min="1" max="100000" step="1" data-choice-qty value="${c.qty??1}"></label><label class="field">加购价格（元）<input type="number" min="0" step=".01" data-choice-price value="${c.priceCents==null?'':(c.priceCents/100).toFixed(2)}"></label></div>
     <label class="field"><span data-choice-label-title>展示文案</span><input data-choice-label value="${esc(c.label)}" placeholder="例如：升级32G双通道"><small data-choice-label-hint></small></label><div data-choice-check></div>
    </div></section>`).join('')}</div>
   <button type="button" data-choice-add>＋ 添加加购商品 / 说明</button><div class="addon-merged-preview"><span>合并展示预览</span><p data-choice-preview class="addon-choice-preview"></p></div>`;
  for(const c of choices){
   const node=nodeFor(c.id);
   const picker=mountProductSearch(node.querySelector('[data-choice-product]'),{getRows:()=>selectableComponents(getCosts()),getCosts,selected:c.goodsId,label:'加购商品',compact:true,onChange:row=>{
    c.goodsId=row?.goodsId||'';const label=node.querySelector('[data-choice-label]');
    if(!label.value.trim()&&row)label.value='升级'+row.name;
    refresh();
   }});
   node.querySelector('[data-choice-text-only]').onchange=event=>{
    const only=event.target.checked;textOnly.set(c.id,only);
    // 同时清理选择器内部身份，避免从文字说明切回商品后仍保留不可见的旧选择。
    if(only){c.goodsId='';picker.clear();}
    node.querySelector('[data-choice-product]').hidden=only;
    node.querySelector('[data-choice-pricing]').hidden=only;refresh();
   };
   node.querySelector('[data-choice-remove]').onclick=()=>{try{choices=read(false,c.id);textOnly.delete(c.id);draw();refresh();}catch(error){root.querySelector('[data-choice-preview]').textContent=error.message;}};
   for(const input of node.querySelectorAll('[data-choice-price],[data-choice-original-qty],[data-choice-qty],[data-choice-label],[data-choice-enabled]'))input.addEventListener('input',refresh);
  }
  root.querySelector('[data-choice-add]').onclick=()=>{
   try{
    choices=read(false);if(choices.length>=30)throw Error('最多添加 30 个加购商品');
    const id=crypto.randomUUID();choices.push({id,goodsId:'',qty:1,originalQty:1,priceCents:null,label:'',enabled:true});textOnly.set(id,false);draw();refresh();
    nodeFor(id).querySelector('[data-product-query]')?.focus();
   }catch(error){root.querySelector('[data-choice-preview]').textContent=error.message;}
  };
 }
 draw();refresh();return {read,refresh};
}
