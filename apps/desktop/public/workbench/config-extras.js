/** 配置图底部的独立加购、选配和福利；配件来源维护仍由原同步流程负责。 */
import {modulesDefault} from './core.js';
export function posterExtraRows(config,kind){
 return (config[kind]||[]).flatMap((entry,index)=>kind==='benefits'||!entry.sourceId&&entry.choices===undefined?[{...entry,index}]:[]);
}
function editable(config,kind,index){
 if(!['addons','benefits'].includes(kind)||!Number.isInteger(index)||!config[kind]?.[index])throw Error('内容已变化，请重新打开当前配置');
 const entry=config[kind][index];
 if(kind==='addons'&&(entry.sourceId||entry.choices!==undefined))throw Error('请在配置总表中编辑这项配件加购');
 return entry;
}
/** 编辑文字时不重建旧对象，保留历史商品、价格、数量、身份和未展示字段。 */
export function editPosterExtra(config,kind,index,field,value){
 if(!['text','note'].includes(field)||typeof value!=='string')throw Error('文案字段无效');
 editable(config,kind,index)[field]=value;
}
export function addPosterExtra(config,kind){
 if(!['addons','benefits'].includes(kind))throw Error('未知内容类型');
 (config[kind]??=[]).push({text:'',note:'',...(kind==='addons'?{items:[]}:{})});
 setPosterExtraVisible(config,kind,true);
}
/** 旧配置可能缺少文字模块；显式显示时补入默认模块，保留其它模块及未知字段。 */
export function setPosterExtraVisible(config,kind,visible){
 if(!['addons','benefits'].includes(kind)||typeof visible!=='boolean')throw Error('内容显示设置无效');
 let module=config.modules?.find(module=>module.type===kind);
 if(!module&&visible){
  const defaults=modulesDefault(config.shopId,config.theme);
  // 未保存模块数组时原先隐式使用全套默认模块，不能因补一项而隐藏其它默认内容。
  config.modules??=defaults;
  module=config.modules.find(module=>module.type===kind);
  if(!module){
   module={...defaults.find(module=>module.type===kind)};
   while(config.modules.some(other=>other.id===module.id))module.id+='-new';
   const order=defaults.findIndex(other=>other.type===kind);
   const next=config.modules.findIndex(other=>defaults.findIndex(item=>item.type===other.type)>order);
   config.modules.splice(next<0?config.modules.length:next,0,module);
  }
 }
 if(module)module.visible=visible;
 return module??null;
}
export function removePosterExtra(config,kind,index){editable(config,kind,index);config[kind].splice(index,1);}
