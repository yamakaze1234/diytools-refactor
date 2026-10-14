/** 预览配置翻页：按当前链接或本店范围切换上一套、下一套配置，保留编辑器模式。 */
// Navigation switches the active draft, without replacing its state or editor mode.
/** 将翻页和配置选择事件绑定到容器，通过 API 切换当前配置。 */
export function mountPreviewNavigation(root,api){
 root.innerHTML='<select data-preview-scope aria-label="翻页范围"><option value="link">当前链接</option><option value="shop">本店配置</option></select><button type="button" data-preview-prev>上一配置</button><select data-preview-config aria-label="正在检查的配置"></select><span data-preview-position aria-live="polite"></span><button type="button" data-preview-next>下一配置</button>';
 const $=selector=>root.querySelector(selector);let menu='';
 const items=()=>{const current=api.current();return api.configs().filter(c=>!c.deletedAt&&c.shopId===current?.shopId&&($('[data-preview-scope]').value==='shop'||c.productId===current?.productId));};
 function render(){
  const rows=items(),current=api.current(),index=rows.findIndex(c=>c.id===current?.id);
  const signature=JSON.stringify(rows.map(c=>[c.id,c.product,c.name,c.version]));
  if(signature!==menu){menu=signature;$('[data-preview-config]').replaceChildren(...rows.map(c=>{const option=document.createElement('option');option.value=c.id;option.textContent=[c.product,c.name,c.version].filter(Boolean).join(' · ');return option;}));}
  $('[data-preview-config]').value=current?.id||'';
  $('[data-preview-config]').disabled=!rows.length;
  $('[data-preview-position]').textContent=`${index<0?0:index+1} / ${rows.length}`;
  $('[data-preview-prev]').disabled=index<=0;
  $('[data-preview-next]').disabled=index<0||index>=rows.length-1;
 }
 function move(id){if(id&&id!==api.current()?.id&&items().some(c=>c.id===id)){api.activate(id);render();}}
 $('[data-preview-prev]').onclick=()=>{const rows=items(),index=rows.findIndex(c=>c.id===api.current()?.id);move(rows[index-1]?.id);};
 $('[data-preview-next]').onclick=()=>{const rows=items(),index=rows.findIndex(c=>c.id===api.current()?.id);move(rows[index+1]?.id);};
 $('[data-preview-config]').onchange=event=>move(event.target.value);
 $('[data-preview-scope]').onchange=render;
 render();return{render};
}
