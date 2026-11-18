/** 共用来源表单复用原工作台编辑器，按范围保存改变的字段。 */
import {mountAddonChoices} from './addon-choices-ui.js';
import {initialChoices} from './shop-addon-ui.js';
import {addonStatusHtml} from './addon-ui.js';
import {choiceDescription,sourceAddon} from './addon-data.js';
import {sameNasDocument as equal} from './nas-main-workspace.js';
import {sourceFields,withSourceFields,sharedSourceLabels,sharedSourceKeys} from './shared-source-fields.js';
import {shopById} from './shops.js';

const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scopeName = scope => scope==='shared'?'三店共用':shopById(scope).shortName;
const controls = {
 name:'#source-name', tax:'#source-tax', addon:'#source-addon-fields',
 'capacityOverrides.memoryGb':'#source-capacity-memoryGb',
 'capacityOverrides.vramGb':'#source-capacity-vramGb',
 'capacityOverrides.storageGb':'#source-capacity-storageGb',
 'hardwareOverrides.cpuName':'#source-hardware-cpu',
 'hardwareOverrides.gpuName':'#source-hardware-gpu',
 'hardwareOverrides.boardType':'#source-hardware-board',
 'hardwareOverrides.caseBoards':'.hardware-case',
};
const unique = values => values.filter((value,index)=>values.findIndex(other=>equal(other,value))===index);
const display = (name,value) => {
 if (name==='tax') return value==null?'待核算':'¥'+Number(value).toFixed(2);
 if (name==='addon') return value?.addonChoices ? choiceDescription(value.addonChoices)||'无展示项' : value?.addonText||'无加购';
 return Array.isArray(value)?value.join('、'):(value??'空');
};

/** 同一店多个历史来源会分开保留。选择历史值后，该字段才统一到该店。 */
export function fieldState(entry,scope,field,preferredId,edits={}) {
 const common = {...entry?.common,...edits.shared?.values};
 const inherited = Object.hasOwn(common,field);
 if (scope==='shared') return {value:common[field], label:inherited?'共用':'待设共用值'};
 const change = edits[scope];
 const aliases = entry?.stores[scope]??[];
 const ordered = [...aliases].sort((a,b)=>Number(b.sourceId===preferredId)-Number(a.sourceId===preferredId));
 if (Object.hasOwn(change?.values??{},field)) {
  return {value:change.values[field], label:'单店覆盖', restore:inherited};
 }
 if (change?.restore.includes(field)) return {value:common[field],label:'待恢复共用'};
 const values = unique(ordered.map(alias=>Object.hasOwn(alias.fields,field)?alias.fields[field]:common[field]));
 const override = ordered.some(alias=>Object.hasOwn(alias.fields,field));
 if (!override) return {value:common[field],label:inherited?'共用':'待设共用值'};
 const legacy = ordered.some(alias=>alias.legacy.includes(field));
 return {value:values[0], label:values.length>1?'多个店铺原值':legacy?'保留店铺原值':'单店覆盖',
  restore:inherited, alternatives:values.length>1?values:[]};
}

export function sharedScopeRow(row,entry,scope,edits) {
 if (!entry) return row;
 const fields = Object.fromEntries(sharedSourceKeys.map(key=>[key,fieldState(entry,scope,key,row.sourceId,edits).value]));
 return withSourceFields(row,fields);
}

export function sourceFieldPatch(before,after) {
 const current = sourceFields(after);
 if (!before) return after.specialComponent?{name:current.name}:current;
 const baseline = sourceFields(before);
 return Object.fromEntries(Object.entries(current).filter(([key,value])=>!equal(value,baseline[key])));
}

export function mountSharedScope(root,{row,entry,scope,scopes,edits,onScope,onField}) {
 const scopeHost = root.querySelector('#source-shared-scope');
 if (!scopeHost) return;
 const enabledScopes = entry?scopes:['shared'];
 scopeHost.innerHTML = `<label class="field">修改范围<select id="source-edit-scope">${enabledScopes.map(id=>
  `<option value="${id}" ${id===scope?'selected':''}>${esc(scopeName(id))}</option>`).join('')}</select></label>`;
 const input = scopeHost.querySelector('select');
 input.onchange=()=>{const target=input.value;input.value=scope;onScope(target);};
 if (!entry) {input.disabled=true;return;}
 const details = root.querySelector('#source-maintenance-fields');
 const fields = row.specialComponent?['name']:sharedSourceKeys;
 for (const key of fields) {
  const input = root.querySelector(controls[key]);
  if (!input) continue;
  const state = fieldState(entry,scope,key,row.sourceId,edits);
  const host = key==='addon'?input.parentElement:input.closest('label')||input;
  const actions = document.createElement('div');
  actions.className = 'source-shared-field-state';
  actions.innerHTML = `<small class="hint">${state.label}</small>${state.restore?
    '<button type="button">恢复共用</button>':''}${state.alternatives?.length?
    `<select aria-label="${esc(sharedSourceLabels[key])}历史值"><option value="">选用一个历史值</option>${
     state.alternatives.map((value,index)=>`<option value="${index}">${esc(display(key,value))}</option>`).join('')}</select>`:''}`;
  if (key==='addon') input.before(actions);
  else if (host.tagName==='LABEL') host.after(actions);
  else host.prepend(actions);
  const restore = actions.querySelector('button');
  if (restore) {restore.dataset.sourceRestore=key;restore.onclick=()=>onField(key,null,true);}
  const choices = actions.querySelector('select');
  if (choices) choices.onchange=()=>{if (choices.value!=='') onField(key,state.alternatives[Number(choices.value)],false);};
  if (details?.contains(input) && (state.restore || state.alternatives?.length)) details.dataset.hasOverride='true';
 }
 const projection = root.querySelector('#source-shared-preview');
 projection.innerHTML = Object.keys(entry.stores).map(shop=>`<section data-source-projection="${shop}"><strong>${esc(scopeName(shop))}</strong>
  <dl>${['name','tax','addon'].filter(key=>fields.includes(key)).map(key=>{
   const state=fieldState(entry,shop,key,row.sourceId,edits);
   return `<dt>${esc(sharedSourceLabels[key])}</dt><dd data-field="${key}">${state.alternatives?.length?'多个历史值':esc(display(key,state.value))} <small class="hint">${state.label}</small></dd>`;
  }).join('')}</dl></section>`).join('');
}

/** 保留旧加购组合的原始结构，只有实际修改商品卡片时生成新的选项。 */
export function mountSharedAddons(root,{row,getCosts,getOriginal,onChange}) {
 const original = sourceFields(row).addon;
 const normalized = {...original,sourceId:row.sourceId};
 root.innerHTML = '<div data-shared-choices></div><label class="field">加购备注<textarea data-shared-addon-note rows="2"></textarea></label>';
 const note = root.querySelector('[data-shared-addon-note]');
 note.value=original.addonNote??'';
 let ready=false;
 const editor=mountAddonChoices(root.querySelector('[data-shared-choices]'),{
  initial:initialChoices(normalized),sourceId:row.sourceId,getCosts,
  onChange:()=>{if(ready)onChange();}, renderCheck:choice=>addonStatusHtml(choice,getCosts(),[getOriginal()]),
 });
 let baseline;
 try {baseline=editor.read(false);} catch {baseline=null;}
 function read(required=false) {
  const values=editor.read(false);
  const addon={...original,addonNote:note.value.trim()};
  if (!equal(baseline,values)) {
   addon.addonChoices=required?editor.read(true):values;
   addon.addonText=choiceDescription(values);
  }
  return sourceAddon(addon);
 }
 ready=true;
 note.oninput=onChange;
 return {read,isDirty:()=>!equal(baseline,editor.read(false))||note.value.trim()!==(original.addonNote??''),
  changes:()=>[],refresh:editor.refresh};
}
