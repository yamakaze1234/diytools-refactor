import test from 'node:test';
import assert from 'node:assert/strict';
import {localDeletedSources,changeLocalDeletedSources,deletedSourceTime,deletedSourceUses,historyReferencesDeletedSource,buildSourceSheet} from '../../public/workbench/source-sheet-model.js';
import {normalizeWorkspaceState,sourcesFor} from '../../public/workbench/shops.js';
import {createNasApiClient} from '../../public/workbench/nas-api-client.js';
import {createNasCatalogController} from '../../public/workbench/nas-catalog-controller.js';

const at='2026-11-01T03:30:00.000Z';
const source=(id,shopId='intel')=>({sourceId:id,goodsId:'22',shopId,name:'合成输出源',deletedAt:at});
test('同店配置、嵌套加购及模板按对象去重，归档引用继续保护，商品码与其他店铺不误计',()=>{
 const state={sourceCatalog:[source('A'),source('B'),source('A','gigabyte')],configs:[
  {id:'c',parts:[{sourceId:'A'}],actualParts:[{sourceId:'A'}],addons:[{items:[{source_id:'A'}]}]},
  {id:'c2',deletedAt:at,addons:[{items:[{source_id:'A',goodsId:'B'}]}]},
  {id:'c3',shopId:'gigabyte',parts:[{sourceId:'A'},{sourceId:'B'}]},
 ],templates:[{deletedAt:at,configs:[{parts:[{sourceId:'A'}],addons:[{sourceId:'A',text:'B'}]}]}]};
 const [used,unused]=localDeletedSources(state,'intel');
 assert.deepEqual(used.references,{configurations:2,templates:1});
 assert.deepEqual(unused.references,{configurations:0,templates:0});
 const before=structuredClone(state);
 assert.throws(()=>changeLocalDeletedSources(state,'intel',[unused,used],'purge'),/2 套配置、1 个模板/);
 assert.deepEqual(state,before);
 changeLocalDeletedSources(state,'intel',[used],'restore');
 assert.equal(state.sourceCatalog[0].deletedAt,undefined);assert.equal(state.sourceCatalog[2].deletedAt,at);
 assert.throws(()=>changeLocalDeletedSources(state,'intel',[used],'purge'),/状态已变化/);
 changeLocalDeletedSources(state,'intel',[unused],'purge');
 assert.deepEqual(state.sourceCatalog.map(row=>row.sourceId),['A','A']);
});
test('已彻底删除的虚拟预设及清空后的种子来源在重新载入时不会复活',()=>{
 const id='special:intel:1',state={sourceCatalog:[{...source(id),goodsId:'',specialComponent:true}],configs:[],templates:[]};
 changeLocalDeletedSources(state,'intel',localDeletedSources(state,'intel'),'purge');
 const next=normalizeWorkspaceState(state,[source('seed')]);
 assert.deepEqual(next.sourceCatalog,[]);assert.ok(!sourcesFor(next,'intel').some(row=>row.sourceId===id));
 assert.ok(sourcesFor(next,'gigabyte').some(row=>row.sourceId==='special:gigabyte:1'));
});
test('30 天到期、最后三天、无效日期以及缺少 NAS 引用计数的边界',()=>{
 const time=Date.parse(at),day=86400000;
 assert.deepEqual(deletedSourceTime(at,time+27*day-1),{days:4,text:'剩余 4 天'});
 assert.equal(deletedSourceTime(at,time+27*day).days,3);
 assert.equal(deletedSourceTime(at,time+30*day).days,0);
 assert.equal(deletedSourceTime('未知',time).days,null);
 assert.equal(deletedSourceTime('2000-02-31',time).days,null);
 for(const value of [null,{}, {configurations:0}, {configurations:-1,templates:1}])assert.equal(deletedSourceUses(value),null);
 assert.equal(deletedSourceUses({configurations:0,templates:0}),0);
});
test('空停用时间仍属于已删除，共用目录别名不会重投影成在用来源',()=>{
 const row={...source('alias'),deletedAt:''};
 const rows=buildSourceSheet({rows:[row],entries:[{id:'22',common:{name:'共用'},stores:{intel:[{sourceId:'alias',fields:{}}]}}]});
 assert.deepEqual(rows.map(r=>r.id),['deleted:alias']);
 assert.equal(localDeletedSources({sourceCatalog:[row]},'intel').length,1);
});
test('历史配置、撤销基线和跨店同名货源各自核验',()=>{
 const ids=new Set(['alias']);
 const intel={shopId:'intel',addons:[{items:[{source_id:'alias'}]}]};
 assert.ok(historyReferencesDeletedSource({configs:[intel]},'intel',ids));
 assert.ok(historyReferencesDeletedSource({configs:[],baseline:{configs:[intel]}},'intel',ids));
 assert.equal(historyReferencesDeletedSource({configs:[{...intel,shopId:'gigabyte'}]},'intel',ids),false);
 assert.equal(historyReferencesDeletedSource({configs:[{parts:[{goodsId:'alias'}]}]},'intel',ids),false);
});
test('缺少 032 时保留可重试状态，物理删除只接受明确匹配的回执',async()=>{
 const storage=new Map(),kv={get length(){return storage.size;},key:i=>[...storage.keys()][i],
  getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 let mode='missing',counter=0;
 const client=createNasApiClient({nativeRequest:async(path,{body})=>{
  assert.equal(path,'/api/v1/operations/catalog/sources/alias/purge?shop_id=intel');
  if(mode==='missing')return Response.json({ok:false,error:'NAS_RETENTION_NOT_INSTALLED'},{status:503});
  const {operation_id}=JSON.parse(body);
  return Response.json({ok:true,data:{operation_id,kind:'sources',resource_id:'alias',shop_id:'intel',
   version:'2',archived:false,document:null,purged:mode==='ok'}});
 }});
 const controller=createNasCatalogController({client,storage:kv,scope:['fixture'],uuid:()=>String(++counter)});
 const purge=()=>controller.save('sources','alias','purge',{expected_version:'1'});
 await assert.rejects(purge(),{code:'NAS_RETENTION_NOT_INSTALLED'});
 assert.equal(controller.pending().length,0);
 mode='ok';assert.equal((await purge()).purged,true);
 mode='malformed';await assert.rejects(purge(),{code:'SAVE_STATUS_UNKNOWN'});
 assert.equal(controller.pending().length,1);
});
