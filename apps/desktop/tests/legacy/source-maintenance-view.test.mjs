import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceKind,updateMaintenanceVisibility} from '../../public/workbench/source-maintenance-view.js';
test('优先使用 ERP 分类，配置引用补足未标明类型的商品',()=>{
 const row={sourceId:'s',goodsId:'10',shopId:'intel',name:'X400'};
 const configs=[{shopId:'intel',parts:[{sourceId:'s',slot:'机箱'}]},{shopId:'gigabyte',parts:[{sourceId:'s',slot:'主板'}]}];
 assert.equal(maintenanceKind(row,configs),'case');
 assert.equal(maintenanceKind({...row,erpCategory:'主板'},configs),'board');
 assert.equal(maintenanceKind(row,[],[{goodsId:'10',erpCategory:'机箱'}]),'case');
 for(const erpCategory of ['线材','其他','灯光灯效','散热风扇'])
  assert.equal(maintenanceKind({...row,erpCategory:'主板',slot:'显卡'},configs,[{goodsId:'10',erpCategory}]),'other');
 assert.equal(maintenanceKind({...row,specialComponent:true},configs),'other');
});
test('名称补足六类资料，不把主板 DDR、机箱型号或散热配件识别为 CPU',()=>{
 for(const [name,kind]of [['i5 14600KF','cpu'],['Ultra 7 270K Plus','cpu'],['技嘉 B760M DDR5','board'],['乔思伯 Z20 MATX 机箱','case'],['RTX5060Ti 16GB','vramGb'],['DDR5 6000 32GB','memoryGb'],['SSD NVMe 1TB','storageGb'],['CPU 散热器 14600KF 专用','other'],['750W 电源','other'],['未知型号','other']])assert.equal(maintenanceKind({name}),kind,name);
});

test('新建空白配件展示所有维护项，已有配件仍只显示适用项，特殊配件保持隐藏',()=>{
 const nodes=['vramGb','memoryGb','storageGb','cpu','vramGb','board','case','color'].map(kind=>({dataset:{maintenanceKind:kind}}));
 const labels=new Map(['legend','.hardware-intro','.hardware-footnote'].map(key=>[key,{textContent:''}]));
 const hardware={querySelector:key=>labels.get(key)},capacity={};
 const root={querySelectorAll:()=>nodes,querySelector:key=>key==='#source-hardware'?hardware:capacity};
 updateMaintenanceVisibility(root,{},[],[],{isNew:true});
 assert.ok(nodes.every(node=>!node.hidden));assert.equal(hardware.hidden,false);assert.equal(capacity.hidden,false);
 const visible=()=>nodes.filter(node=>!node.hidden).map(node=>node.dataset.maintenanceKind);
 for(const [name,expected] of [
  ['DDR5 内存 32GB',['memoryGb','color']],['乔思伯 Z20 MATX 机箱',['case','color']],
  ['乔思伯 ZE-240B 风扇',['color']],['750W 电源',['color']],['CPU 散热器',['color']],
 ]){
  updateMaintenanceVisibility(root,{name});
  assert.deepEqual(visible(),expected,name);assert.equal(hardware.hidden,false,name);
 }
 updateMaintenanceVisibility(root,{name:'SSD 固态硬盘 1TB'});
 assert.deepEqual(visible(),['storageGb']);assert.equal(hardware.hidden,true);assert.equal(capacity.hidden,false);
 updateMaintenanceVisibility(root,{name:'SSD 固态硬盘 1TB'},[],[],{isNew:true});
 assert.ok(!visible().includes('color'));
 updateMaintenanceVisibility(root,{specialComponent:true},[],[],{isNew:true});
 assert.ok(nodes.every(node=>node.hidden));assert.equal(hardware.hidden,true);assert.equal(capacity.hidden,true);
});

test('新建配件手工维护后，未知名称也能按已填字段继续维护',()=>{
 for(const [fields,kind]of [[{hardwareOverrides:{cpuName:'14600KF'}},'cpu'],[{hardwareOverrides:{boardType:'M-ATX'}},'board'],[{hardwareOverrides:{caseBoards:['M-ATX']}},'case'],[{capacityOverrides:{memoryGb:48}},'memoryGb'],[{capacityOverrides:{storageGb:2048}},'storageGb']]){
  assert.equal(maintenanceKind({name:'测试新品',...fields}),kind);
 }
});
