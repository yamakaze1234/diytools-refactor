import {boardType,boardCaseIssue,copyHardware} from './component-hardware.js';
/** 只隐藏已知不兼容项；原始文案与用户勾选状态均不改变。 */
export function upgradeHiddenReason(item,config){
 const box=config?.parts?.find(p=>p.slot==='机箱'&&p.goodsId);if(!box)return '';
 const candidates=item.items?.length?item.items:[item];
 for(const p of candidates){
  const explicit=String(p.label||p.text||'').toUpperCase().match(/(E-ATX|M-ATX|MATX|ITX|ATX)\s*(?:大板|小板|主板)/);
  const type=p.hardwareOverrides?.boardType||p.hardwareFacts?.boardType||boardType({name:p.hardwareName||p.name||p.label||p.text||''})||(explicit?explicit[1].replace('M-ATX','MATX'):null);
  if(type){const issue=boardCaseIssue({hardwareOverrides:{boardType:type}},box);if(issue.status==='error')return issue.message+'，此加购不展示';}
 }return '';
}
export function compatibleUpgradeText(value,config){
 // 每个【加购选项】独立过滤；没有分段的文字作为一个整体保留或隐藏。
 return String(value||'').split(/(【[^】]*】)/g).filter(segment=>!upgradeHiddenReason({text:segment},config)).join('');
}
export function displayedAddon(a,config){
 if(a.choices){const choices=a.choices.filter(c=>c.enabled&&!upgradeHiddenReason(c,config));return {...a,note:choices.length?a.note:'',text:choices.map(c=>!c.goodsId||c.customText?c.label||'':`【+${c.priceCents==null?'待填':Number((c.priceCents/100).toFixed(2))}元${c.label||'升级商品'}】`).join('')};}
 const text=upgradeHiddenReason(a,config)?'':compatibleUpgradeText(a.text,config);return {...a,text,note:text?a.note:''};
}
export function attachAddonHardware(config,catalog){
 const shop=config.shopId||'intel',rows=catalog.filter(r=>(r.shopId||'intel')===shop&&!r.deletedAt),byId=new Map();
 for(const r of rows){const list=byId.get(r.goodsId)||[];list.push(r);byId.set(r.goodsId,list);}
 for(const a of config.addons||[])for(const item of a.choices||a.items||[a]){const matches=byId.get(item.goodsId)||[];if(matches.length===1){copyHardware(matches[0],item);item.hardwareName=matches[0].name;}}
}

export function partUpgradeText(part,config){let value=part.upgrade||'';for(const a of config?.addons||[]){if(!part.sourceId||a.sourceId!==part.sourceId)continue;const visible=displayedAddon(a,config);if(a.text&&value.includes(a.text))value=value.replace(a.text,visible.text);}return compatibleUpgradeText(value,config);}
