import test from 'node:test';
import assert from 'node:assert/strict';
import {linkPartsExportScope,createLinkPartsExportSession} from '../../public/workbench/link-parts.js';
import {applyReplacement,exportBatchImages,exportEntries} from '../../public/workbench/global-batch.js';

const config=(id,productId='a',shopId='intel')=>({id,productId,shopId,product:'链接'+productId,spu:'888888888888888888',name:'配置'+id,parts:[{slot:'CPU',name:'旧CPU',goodsId:'1',qty:1}],actualParts:[],theme:'paper',skuMode:'full',modules:[{text:'原版式'}]});
const batch=configs=>({productIds:['a','b'],changes:[{id:configs[0].id,before:structuredClone(configs[0]),after:{...structuredClone(configs[0]),parts:[{slot:'CPU',name:'新CPU',goodsId:'2',qty:1}]}}]});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const renderer=async c=>({overflow:false,canvas:{toBlob:callback=>callback(new Blob([JSON.stringify(c)]))}});

test('导出范围只取有实际变化的链接，包含全部未删除兄弟配置并隔离店铺',()=>{
 const configs=[config('1'),config('2'),config('3','b'),{...config('4'),deletedAt:'now'},config('5','a','jonsbo')],plan=batch(configs);
 applyReplacement(plan,configs);
 const scope=linkPartsExportScope(plan,configs);
 assert.deepEqual(scope.productIds,['a']);assert.deepEqual(scope.changedConfigIds,['1']);assert.deepEqual(scope.exportConfigIds,['1','2']);
 configs[0].parts[0].name='后续编辑';configs[1].modules[0].text='已编辑';
 assert.equal(scope.snapshots[0].parts[0].name,'新CPU');assert.equal(scope.snapshots[1].modules[0].text,'原版式');
 assert.equal(linkPartsExportScope({changes:[]},configs),null);
 assert.equal(linkPartsExportScope({changes:[{id:'1',before:configs[0],after:configs[0]}]},configs),null);
 assert.throws(()=>linkPartsExportScope(plan,[]),/当前店铺/);
});

test('保存成功优先捕获保存回执，忽略实时未保存编辑并保留样式与SKU模式',async()=>{
 const saved=[config('1'),config('2')],plan=batch(saved),draft=structuredClone(saved);let calls=0;
 const session=createLinkPartsExportSession({getConfigs:()=>draft,apply:async approved=>{calls++;applyReplacement(approved,saved);saved[0].modules.push({normalized:true});draft[1].parts[0].name='未保存';return {configs:saved};},exportImages:async(scope,kind)=>{
  assert.equal(scope.snapshots[1].parts[0].name,'旧CPU');assert.equal(scope.snapshots[0].modules[1].normalized,true);assert.equal(scope.snapshots[0].theme,'paper');assert.equal(scope.snapshots[0].skuMode,'full');assert.equal(kind,'square');scope.snapshots[0].parts[0].name='渲染修改';
 }});
 await session.save(plan);saved[1].parts[0].name='后续已保存';await session.export('square',()=>{});await session.export('square',()=>{});
 assert.equal(calls,1);assert.equal(session.scope().snapshots[0].parts[0].name,'新CPU');
});

test('无变化不保存或导出，保存失败也不会准备导出范围',async()=>{
 let saves=0,exports=0;const configs=[config('1')];
 const session=createLinkPartsExportSession({getConfigs:()=>configs,apply:async()=>{saves++;throw Error('磁盘错误');},exportImages:async()=>exports++});
 assert.equal(await session.save({changes:[]}),null);assert.equal(saves,0);
 await assert.rejects(session.export('both',()=>{}),/先保存/);
 await assert.rejects(session.save(batch(configs)),/磁盘错误/);assert.equal(session.scope(),null);
 await assert.rejects(session.export('both',()=>{}),/先保存/);assert.equal(saves,1);assert.equal(exports,0);
});

test('导出失败保留已保存更换，重试只导出相同快照',async()=>{
 const configs=[config('1'),config('2')];let saves=0,exports=0;
 const session=createLinkPartsExportSession({getConfigs:()=>configs,apply:async p=>{saves++;applyReplacement(p,configs);},exportImages:async scope=>{exports++;assert.equal(scope.snapshots[0].parts[0].name,'新CPU');if(exports===1)throw Error('渲染失败');}});
 await session.save(batch(configs));await assert.rejects(session.export('long',()=>{}),/渲染失败/);assert.equal(configs[0].parts[0].name,'新CPU');
 configs[0].parts[0].name='后续编辑';await session.export('both',()=>{});assert.equal(saves,1);assert.equal(exports,2);
});

test('取消导出停止后续状态，允许重新导出且不重复更换',async()=>{
 const configs=[config('1')],pending=deferred();let saves=0,signal,statusCallback,exports=0;const status=[];
 const session=createLinkPartsExportSession({getConfigs:()=>configs,apply:async p=>{saves++;applyReplacement(p,configs);},exportImages:async(_scope,_kind,update,options)=>{exports++;signal=options.signal;statusCallback=update;if(exports===1)await pending.promise;update('完成');}});
 await session.save(batch(configs));const first=session.export('both',message=>status.push(message));session.cancel();assert.equal(signal.aborted,true);statusCallback('迟到状态');pending.resolve();await assert.rejects(first,{name:'AbortError'});assert.deepEqual(status,[]);
 await session.export('long',message=>status.push(message));assert.deepEqual(status,['完成']);assert.equal(saves,1);assert.equal(signal.aborted,false);
});

test('关闭旧面板后导出继续但不污染新会话',async()=>{
 const configs=[config('1')],pending=deferred(),messages=[];let oldSignal;
 const old=createLinkPartsExportSession({getConfigs:()=>configs,apply:async p=>applyReplacement(p,configs),exportImages:async(_scope,_kind,status,{signal})=>{oldSignal=signal;await pending.promise;status('旧会话完成');}});
 await old.save(batch(configs));const exporting=old.export('both',m=>messages.push(m));old.close();assert.equal(oldSignal.aborted,false);assert.equal(old.scope(),null);
 const current=createLinkPartsExportSession({getConfigs:()=>configs,apply:async()=>{},exportImages:async()=>{}});pending.resolve();await exporting;assert.deepEqual(messages,[]);assert.equal(current.scope(),null);
});

test('关闭时尚在保存，保存继续完成但不会捕获新弹窗的数据或启动导图',async()=>{
 const configs=[config('1')],pending=deferred();let reads=0,exports=0;
 const session=createLinkPartsExportSession({getConfigs:()=>{reads++;return configs;},apply:async p=>{await pending.promise;applyReplacement(p,configs);},exportImages:async()=>exports++});
 const saving=session.save(batch(configs));session.close();pending.resolve();assert.equal(await saving,null);assert.equal(configs[0].parts[0].name,'新CPU');assert.equal(reads,0);assert.equal(exports,0);await assert.rejects(session.export('both',()=>{}),{name:'AbortError'});
});

test('保存回执范围准备失败明确标记已保存，不回退或导出上次批次',async()=>{
 const configs=[config('1')];const session=createLinkPartsExportSession({getConfigs:()=>[],apply:async p=>applyReplacement(p,configs),exportImages:async()=>{throw Error('不应导出');}});
 await assert.rejects(session.save(batch(configs)),error=>error.saved===true&&/当前店铺/.test(error.message));assert.equal(configs[0].parts[0].name,'新CPU');assert.equal(session.scope(),null);
});

test('指定单一图种保留命名、完整SPU与每套样式，旧入口默认两张',()=>{
 const configs=[config('1'),config('2')];
 for(const kind of ['long','square','both']){const entries=exportEntries(configs,['a'],kind);assert.equal(entries.length,kind==='both'?4:2);assert.ok(entries.every(e=>e.name.startsWith('链接a_')));assert.ok(entries.every(e=>e.config.theme==='paper'&&e.config.skuMode==='full'));if(kind!=='both')assert.ok(entries.every(e=>e.config.layout===kind));}
 assert.equal(exportEntries(configs,['a']).length,4);assert.throws(()=>exportEntries(configs,['a'],'bad'),/请选择/);
});

test('快照导图跳过再次保存，以1400px渲染选定图种并写出导出清单',async()=>{
 const snapshots=[config('1'),config('2')],rendered=[],messages=[];let folderFiles,saves=0,downloads=0;
 await exportBatchImages({save:async()=>saves++,getConfigs:()=>{throw Error('不能读后续编辑');},renderImage:async(c,width)=>{rendered.push({c,width});return renderer(c);},saveFolder:async files=>{folderFiles=files;return {directory:'测试文件夹'};},download:()=>downloads++},['a'],message=>messages.push(message),{snapshots,imageKind:'square'});
 assert.equal(saves,0);assert.equal(downloads,0);assert.equal(rendered.length,2);assert.ok(rendered.every(r=>r.width===1400&&r.c.layout==='square'&&r.c.theme==='paper'&&r.c.skuMode==='full'));
 assert.deepEqual(folderFiles.map(f=>f.name),['1_配置1.png','2_配置2.png','导出清单.json']);assert.match(messages.at(-1),/导出 2 张图片/);
});

test('原批量入口仍先保存并默认导出两种图片',async()=>{
 const configs=[config('1')];let saves=0,renders=0,downloads=0;
 await exportBatchImages({getConfigs:()=>configs,save:async()=>saves++,renderImage:async c=>{assert.equal(saves,1);renders++;return renderer(c);},saveFolder:async()=>null,download:(_blob,name)=>{downloads++;assert.match(name,/\.zip$/);}},['a'],()=>{});
 assert.equal(saves,1);assert.equal(renders,2);assert.equal(downloads,1);
});

test('导图中途取消不打开文件夹或下载，后续配置不再渲染',async()=>{
 const controller=new AbortController();let renders=0,folders=0,downloads=0;
 await assert.rejects(exportBatchImages({renderImage:async c=>{renders++;controller.abort();return renderer(c);},saveFolder:async()=>folders++,download:()=>downloads++},['a'],()=>{},{snapshots:[config('1'),config('2')],signal:controller.signal}),{name:'AbortError'});
 assert.equal(renders,1);assert.equal(folders,0);assert.equal(downloads,0);
});

test('文件夹选择取消后不下载ZIP，失败详情与可重试状态保留',async()=>{
 const messages=[];let downloads=0;
 await exportBatchImages({renderImage:renderer,saveFolder:async()=>({cancelled:true}),download:()=>downloads++},['a'],m=>messages.push(m),{snapshots:[config('1')]});assert.equal(downloads,0);assert.match(messages.at(-1),/已取消.*重新导出/);
});

test('部分图片失败仍交付成功图片与失败清单，全部失败不写文件',async()=>{
 const configs=[config('1'),config('2')];let files,folders=0;
 const api={renderImage:async c=>c.id==='1'?{overflow:true}:renderer(c),saveFolder:async output=>{folders++;files=output;return {directory:'测试'};}};
 await exportBatchImages(api,['a'],()=>{},{snapshots:configs,imageKind:'long'});assert.equal(folders,1);const manifest=JSON.parse(new TextDecoder().decode(files.at(-1).bytes));assert.equal(manifest.success.length,1);assert.equal(manifest.failures.length,1);
 await assert.rejects(exportBatchImages({...api,renderImage:async()=>({overflow:true})},['a'],()=>{},{snapshots:configs}),/全部图片生成失败/);assert.equal(folders,1);
});

 test('同名配置导出统一使用链接内序号避免冲突',()=>{const rows=[config('1'),{...config('2'),name:'配置1'}];assert.equal(exportEntries(rows,['a']).length,4);const entries=exportEntries(rows,['a'],'both',{deduplicateNames:true});assert.equal(entries.length,4);assert.equal(new Set(entries.map(e=>e.name)).size,4);assert.equal(entries.filter(e=>e.name.endsWith('/2_配置1.png')).length,2);assert.deepEqual(entries.filter(e=>e.config.id==='2').map(e=>e.config.layout),['long','square']);});
