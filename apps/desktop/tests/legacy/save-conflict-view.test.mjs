import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {saveConflictSections,saveConflictHtml} from '../../public/workbench/save-conflict-view.js';
import {mergeEditorState} from '../../public/workbench/editor-performance.js';
import {completeWorkspaceViews} from '../../public/workbench/lazy-workspace.js';

const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fixture=()=>({revision:1,configs:[{id:'c1',name:'配置一',shop:'示例店铺',product:'主机链接',price:100,parts:[{lineId:'cpu',slot:'CPU',name:'原CPU',qty:1},{lineId:'gpu',slot:'显卡',name:'原显卡',qty:1}]}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}});
test('真实三方合并后的预览包含当前输入与保存版本，独立字段保留远端结果',()=>{
 const base=fixture(),local=structuredClone(base),remote=structuredClone(base);
 local.configs[0].parts[1].name='<本页显卡>';remote.configs[0].parts[1].name='已保存显卡';remote.configs[0].price=120;
 const merged=mergeEditorState(base,local,remote);assert.equal(merged.conflict,true);
 const sections=saveConflictSections(merged.state,remote);assert.equal(sections.length,1);assert.equal(sections[0].differences.length,1);
 assert.match(sections[0].differences[0].field,/展示配件.*显卡.*名称/);
 assert.deepEqual([sections[0].differences[0].local,sections[0].differences[0].remote],['<本页显卡>','已保存显卡']);
 const html=saveConflictHtml(merged.state,remote,esc);assert.match(html,/&lt;本页显卡&gt;/);assert.doesNotMatch(html,/<本页显卡>/);assert.equal(merged.state.configs[0].price,120);
});
test('按需加载的未打开配置不被误报为删除，日志和版本不算业务差异',()=>{
 const remote=fixture();remote.configs.push({...structuredClone(remote.configs[0]),id:'unloaded',name:'未打开配置'});
 const base=fixture(),local=fixture();local.configs[0].price=101;
 const views=completeWorkspaceViews(base,local,remote),merged=mergeEditorState(views.base,views.local,remote).state;
 const sections=saveConflictSections(merged,remote);assert.equal(sections.length,1);assert.equal(sections[0].differences[0].local,'101');
 assert.match(saveConflictHtml({...remote,revision:99,logs:[1]},remote,esc),/没有待保存差异/);
});
test('配置增删、配件增删重排、全局资料及店铺设置都有可读差异',()=>{
 const remote=fixture(),local=fixture();local.configs[0].parts.reverse();local.configs[0].parts.push({lineId:'ram',slot:'内存',name:'32GB'});
 remote.configs.push({id:'removed',name:'删除配置'});local.configs.push({id:'new',name:'新配置'});
 for(const [key,id] of Object.entries({templates:'id',sourceCatalog:'sourceId',costSource:'goodsId',caseGallery:'id'}))local[key]=[{[id]:key,name:key}];
 local.shopSettings={intel:{footer:'新页脚'}};
 const sections=saveConflictSections(local,remote),html=saveConflictHtml(local,remote,esc);
 assert.equal(sections.length,8);for(const value of ['本页将新增此项','本页将移除此项','模板','输出源','成本','图片','店铺设置','32GB','顺序'])assert.ok(html.includes(value),value);
});

const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
const code=app.slice(app.indexOf('function openConflict('),app.indexOf('// 刷新当前配置的标题'));
function harness(){
 const nodes=new Map(),writes=[],base=fixture(),local=fixture(),remote=fixture();local.configs[0].price=110;remote.configs[0].price=120;
 const context=vm.createContext({saveConflictHtml,esc,cloneEditorState:structuredClone,changeCounter:0,state:local,acceptedState:base,conflict:true,dirty:true,fullWorkspace:false,
  $:id=>{if(!nodes.has(id))nodes.set(id,{isConnected:true,disabled:false,textContent:''});return nodes.get(id);},
  openDialog(title,html){context.title=title;context.html=html;},closeDialog(){context.closed=true;},backup(){},toast(message){context.error=message;},
  async completeWorkspaceSnapshot(){return{...mergeEditorState(base,context.state,remote),remote:structuredClone(remote),counter:context.changeCounter};},
  async recoverySnapshot(){return{state:structuredClone(context.state),baseState:base};},
  async request(url,options){writes.push({url,body:JSON.parse(options.body)});await context.onWrite?.();return{ok:true};},
  invalidateSaveScope(){},async save(){context.saved=true;},renderAll(){},
 });vm.runInContext(code,context);context.openConflict('冲突');
 return{context,nodes,writes,async compare(){await nodes.get('#conflict-compare').onclick();},async apply(){await nodes.get('#conflict-apply-local').onclick();}};
}
test('重新比较实际弹窗显示差异，比较及返回编辑均不写数据',async()=>{
 const h=harness();await h.compare();assert.match(h.context.html,/110/);assert.match(h.context.html,/120/);assert.match(h.context.html,/<table>/);
 h.nodes.get('#conflict-cancel').onclick();assert.equal(h.context.closed,true);assert.equal(h.writes.length,0);assert.equal(h.context.state.configs[0].price,110);
});
test('确认前先备份草稿，再按预览快照保存',async()=>{
 const h=harness();await h.compare();await h.apply();assert.equal(h.writes[0].url,'/api/recovery-draft');assert.equal(h.context.saved,true);assert.equal(h.context.acceptedState.configs[0].price,120);assert.equal(h.context.state.configs[0].price,110);
});
for(const stage of ['before','during'])test(`比较后新输入在 ${stage} 备份时仍保留并拒绝旧快照保存`,async()=>{
 const h=harness();await h.compare();const edit=()=>{h.context.state.configs[0].price=130;h.context.changeCounter++;};if(stage==='before')edit();else h.context.onWrite=edit;
 await h.apply();assert.equal(h.context.saved,undefined);assert.equal(h.context.state.configs[0].price,130);assert.match(h.context.error,/重新比较/);assert.equal(h.context.conflict,true);
});
test('备份失败不替换基线或丢弃草稿',async()=>{
 const h=harness();await h.compare();h.context.onWrite=()=>{throw Error('磁盘失败');};await h.apply();assert.equal(h.context.acceptedState.configs[0].price,100);assert.equal(h.context.state.configs[0].price,110);assert.equal(h.context.saved,undefined);assert.equal(h.context.error,'磁盘失败');
});
