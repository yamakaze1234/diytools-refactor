/** 配置图底部的独立加购、选配和福利；配件来源维护仍由原同步流程负责。 */
import {modulesDefault,posterModules} from './core.js';
const isPosterExtraRow=(entry,kind)=>kind==='benefits'||!entry.sourceId&&entry.choices===undefined;
export function posterExtraRows(config,kind){
 return (config[kind]||[]).flatMap((entry,index)=>isPosterExtraRow(entry,kind)
  ?[{...(typeof entry==='string'?{text:entry,note:''}:entry),index}]:[]);
}
function editable(config,kind,index){
 if(!['addons','benefits'].includes(kind)||!Number.isInteger(index)||config[kind]?.[index]==null)throw Error('内容已变化，请重新打开当前配置');
 const entry=config[kind][index];
 if(!isPosterExtraRow(entry,kind))throw Error('请在配置总表中编辑这项配件加购');
 return entry;
}
function extraModuleId(config,kind){
 return posterModules(config).find(module=>module.type===kind)?.id;
}
export function clearPosterExtraTextOverride(config,kind,index,field){
 const id=extraModuleId(config,kind);
 if(!id)return;
 const key=id+'.'+index+'.'+field;
 // 页签提交的文字优先，保留自由编辑设置的字号、颜色和位置。
 for(const styles of [config.textStyles,config.skuTextStyles]){
  const style=styles?.[key];
  if(!style||!Object.hasOwn(style,'text'))continue;
  delete style.text;
  if(!Object.keys(style).length)delete styles[key];
 }
}
/** 编辑文字时不重建旧对象，保留历史商品、价格、数量、身份和未展示字段。 */
export function editPosterExtra(config,kind,index,field,value){
 if(!['text','note'].includes(field)||typeof value!=='string')throw Error('文案字段无效');
 const entry=editable(config,kind,index);
 const row=typeof entry==='string'?{text:entry,note:''}:entry;
 config[kind][index]=row;
 row[field]=value;
 clearPosterExtraTextOverride(config,kind,index,field);
}
export function addPosterExtra(config,kind){
 if(!['addons','benefits'].includes(kind))throw Error('未知内容类型');
 (config[kind]??=[]).push({text:'',note:'',...(kind==='addons'?{items:[]}:{})});
 setPosterExtraVisible(config,kind,true);
 for(const field of ['text','note'])clearPosterExtraTextOverride(config,kind,config[kind].length-1,field);
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
export function removePosterExtra(config,kind,index){
 editable(config,kind,index);
 shiftPosterExtraStyles(config,kind,index,-1);
 config[kind].splice(index,1);
}

export function insertPosterExtra(config,kind,index,row){
 const rows=config[kind]??=[];
 if(index<rows.length)shiftPosterExtraStyles(config,kind,index,1);
 rows.splice(index,0,row);
 for(const field of ['text','note'])clearPosterExtraTextOverride(config,kind,index,field);
}

function shiftPosterExtraStyles(config,kind,index,step){
 const id=extraModuleId(config,kind);
 if(!id)return;
 const prefix=id+'.';
 // 渲染器按行号定位样式，插入和删除时让后续行带着各自的排版一起移动。
 for(const map of [config.textStyles,config.skuTextStyles,...Object.values(config.textTransforms||{})]){
  const moved=[];
  for(const [key,value] of Object.entries(map||{})){
   if(!key.startsWith(prefix))continue;
   const match=key.slice(prefix.length).match(/^(\d+)\.(text|note)$/);
   if(!match||Number(match[1])<index)continue;
   delete map[key];
   const row=Number(match[1]);
   if(row<config[kind].length&&(step===1||row>index))moved.push([prefix+(row+step)+'.'+match[2],value]);
  }
  for(const [key,value] of moved)map[key]=value;
 }
}
