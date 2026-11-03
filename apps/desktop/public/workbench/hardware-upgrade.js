import {boardType,boardCaseIssue,copyHardware} from './component-hardware.js';
/** 手动展示只确认当前文案、选项与机箱；内容或机箱变化后重新提示。 */
export const hardwareUpgradeKey=(item,config)=>JSON.stringify([item.sourceId,item.goodsId,item.upgrade,item.text,item.choices,item.items,config?.parts?.filter(p=>p.slot==='机箱').map(p=>[p.goodsId,p.name,p.hardwareOverrides,p.hardwareFacts])]);
export const hardwareUpgradeSelected=(item,config)=>item.hardwareUpgradeConfirmed===hardwareUpgradeKey(item,config);
export function selectHardwareUpgrade(item,config,show){if(show)item.hardwareUpgradeConfirmed=hardwareUpgradeKey(item,config);else delete item.hardwareUpgradeConfirmed;}
/** 比较默认结果，确保手动展示后仍保留提示和切回默认的入口。 */
export const partHardwareWarning=(part,config)=>partUpgradeText({...part,hardwareUpgradeConfirmed:undefined},config)!==(part.upgrade||'');
export const addonHardwareWarning=(addon,config)=>displayedAddon({...addon,hardwareUpgradeConfirmed:undefined},config).text!==(addon.text||'');
/** 只隐藏已知不兼容项；原始文案与用户勾选状态均不改变。 */
export function upgradeHiddenReason(item,config){
 const box=config?.parts?.find(p=>p.slot==='机箱'&&p.goodsId);if(!box)return '';
 const candidates=item.items?.length?item.items:[item];
 for(const p of candidates){
  // 非主板配件不参与板型判断；自由文案不能仅凭类似型号的字符串猜测。
  const name=p.hardwareName||p.name||p.label||p.text||'';
  const category=p.slot||p.erpCategory;
  if(category&&category!=='主板')continue;
  if(!/主板/.test(name)&&/水冷|散热|冷头/.test(name))continue;
  const boardContext=category==='主板'||/主板|大板|小板/.test(name)||!!p.hardwareName;
  const explicit=String(p.label||p.text||'').toUpperCase().match(/(E-ATX|M-ATX|MATX|ITX|ATX)\s*(?:大板|小板|主板)/);
  const type=p.hardwareOverrides?.boardType||p.hardwareFacts?.boardType||(boardContext?boardType({name}):null)||(explicit?explicit[1].replace('M-ATX','MATX'):null);
  if(type){const issue=boardCaseIssue({hardwareOverrides:{boardType:type}},box);if(issue.status==='error')return issue.message+'，此加购不展示';}
 }return '';
}
export function compatibleUpgradeText(value,config,slot){
 // 每个【加购选项】独立过滤；没有分段的文字作为一个整体保留或隐藏。
 return String(value||'').split(/(【[^】]*】)/g).filter(segment=>!upgradeHiddenReason({text:segment,slot},config)).join('');
}
export function displayedAddon(a,config){
 if(a.choices){const choices=a.choices.filter(c=>c.enabled&&(hardwareUpgradeSelected(a,config)||!upgradeHiddenReason(c,config)));return {...a,note:choices.length?a.note:'',text:choices.map(c=>!c.goodsId||c.customText?c.label||'':`【+${c.priceCents==null?'待填':Number((c.priceCents/100).toFixed(2))}元${c.label||'升级商品'}】`).join('')};}
 const text=hardwareUpgradeSelected(a,config)?a.text:upgradeHiddenReason(a,config)?'':compatibleUpgradeText(a.text,config);return {...a,text,note:text?a.note:''};
}
export function attachAddonHardware(config,catalog){
 const shop=config.shopId||'intel',rows=catalog.filter(r=>(r.shopId||'intel')===shop&&!r.deletedAt),byId=new Map();
 for(const r of rows){const list=byId.get(r.goodsId)||[];list.push(r);byId.set(r.goodsId,list);}
 for(const a of config.addons||[])for(const item of a.choices||a.items||[a]){const matches=byId.get(item.goodsId)||[];if(matches.length===1){copyHardware(matches[0],item);item.hardwareName=matches[0].name;}}
}

export function partUpgradeText(part,config){let value=part.upgrade||'';if(hardwareUpgradeSelected(part,config))return value;for(const a of config?.addons||[]){if(!part.sourceId||a.sourceId!==part.sourceId)continue;const visible=displayedAddon(a,config);if(a.text&&value.includes(a.text))value=value.replace(a.text,visible.text);}return compatibleUpgradeText(value,config,part.slot);}
