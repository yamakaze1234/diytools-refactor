import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceKind} from '../../public/workbench/source-maintenance-view.js';
test('优先使用 ERP 分类，配置引用补足未标明类型的商品',()=>{
 const row={sourceId:'s',goodsId:'10',shopId:'intel',name:'X400'};
 const configs=[{shopId:'intel',parts:[{sourceId:'s',slot:'机箱'}]},{shopId:'gigabyte',parts:[{sourceId:'s',slot:'主板'}]}];
 assert.equal(maintenanceKind(row,configs),'case');
 assert.equal(maintenanceKind({...row,erpCategory:'主板'},configs),'board');
 assert.equal(maintenanceKind(row,[],[{goodsId:'10',erpCategory:'机箱'}]),'case');
 assert.equal(maintenanceKind({...row,specialComponent:true},configs),'other');
});
test('名称补足六类资料，不把主板 DDR、机箱型号或散热配件识别为 CPU',()=>{
 for(const [name,kind]of [['i5 14600KF','cpu'],['Ultra 7 270K Plus','cpu'],['技嘉 B760M DDR5','board'],['乔思伯 Z20 MATX 机箱','case'],['RTX5060Ti 16GB','vramGb'],['DDR5 6000 32GB','memoryGb'],['SSD NVMe 1TB','storageGb'],['CPU 散热器 14600KF 专用','other'],['750W 电源','other'],['未知型号','other']])assert.equal(maintenanceKind({name}),kind,name);
});
