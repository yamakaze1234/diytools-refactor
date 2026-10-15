import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {wpsExport} from '../../public/workbench/wps-export.js';

const fixture=()=>({name:'配置一',price:8899,parts:[
 {slot:'内存',name:'原始名称',displayName:'展示内存',qty:2},
 {slot:'CPU',name:'测试 CPU',qty:1},
 {slot:'显卡',name:'不含显卡',qty:1,specialComponent:true},
 {slot:'风扇',name:'测试风扇',qty:8},
 {slot:'配件1',name:'模组线',qty:1},
]});
test('重构入口等待完整配置并重新读取当前链接',async()=>{
 const source=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
 const start=source.indexOf('function renderProduct(){'),end=source.indexOf('\n',start);
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
 const initial={name:'测试链接',configs:[{id:'a'}]},complete={...initial,configs:[{id:'a',...fixture()}]};
 let product=initial,exported,loaded=false;
 const context={$ ,currentProduct:()=>product,esc:String,openProduct(){},openOverview(){},openCopy(){},openTemplates(){},openSaveProductTemplate(){},openPosterTitles(){},openDialog(){},
  fullAction:fn=>async()=>{await Promise.resolve();product=complete;loaded=true;return fn();},
  openWpsExport:configs=>{assert.equal(loaded,true);exported=configs;}};
 vm.runInNewContext(source.slice(start,end)+'\nrenderProduct();',context);
 await nodes.get('#wps-export-open').onclick();assert.equal(exported,complete.configs);
});
test('F:H 保留19行、槽位、数量与展示名称，不修改配置',()=>{
 const c=fixture(),before=structuredClone(c),out=wpsExport([c,c]);
 assert.equal(out.rows.length,38);assert.ok(out.rows.every(r=>r.values.length===3));
 assert.deepEqual(out.rows[2].values,[1,'CPU','测试 CPU']);
 assert.deepEqual(out.rows[5].values,[2,'内存','展示内存']);
 assert.deepEqual(out.rows[7].values,[1,'显卡','不含显卡']);
 assert.deepEqual(out.rows[11].values,[8,'风扇','测试风扇']);
 assert.equal(out.blocks[1].startRow,20);assert.equal(out.rows[10].kind,'separator');
 assert.equal(out.rows[17].kind,'separator');assert.equal(out.rows[18].kind,'blank');
 assert.ok(!out.tsv.includes('原始名称'));assert.ok(!out.tsv.includes('0.98'));assert.deepEqual(c,before);
});
test('E:H 公式按目标行与配置块移动，保留空F列与单元格格式',()=>{
 const defaults=wpsExport([fixture(),fixture(),fixture()],{layout:'EH'});
 assert.deepEqual(defaults.rows.filter(r=>r.formula).map(r=>r.values[0]),['=G2*0.98-A2','=G21*0.98-A21','=G40*0.98-A40']);
 const out=wpsExport([fixture(),fixture()],{layout:'EH',startRow:20});
 assert.deepEqual(out.rows[1].values,['=G21*0.98-A21','',8899,'']);
 assert.deepEqual(out.rows[20].values,['=G40*0.98-A40','',8899,'']);
 assert.ok(out.rows.every(r=>r.values.length===4&&r.values[1]===''));
 assert.match(out.html,/x:f="=RC\[2\]\*0.98-RC\[-4\]"/);
 assert.match(out.html,/background:#ffffcc/);assert.match(out.html,/background:#000/);
 assert.equal(out.endRow,57);
});
test('超出六项附件不截断，后续公式同步偏移',()=>{
 const c=fixture();c.parts.push(...Array.from({length:6},(_,i)=>({slot:`配件${i+2}`,name:`额外${i}`,qty:1})));
 const out=wpsExport([c,fixture()],{layout:'EH'});
 assert.equal(out.blocks[0].rowCount,21);assert.equal(out.blocks[1].startRow,22);
 assert.equal(out.rows[22].values[0],'=G23*0.98-A23');assert.match(out.tsv,/额外5/);
});
test('非法数量和行号阻止导出，文本转义且不会成为公式',()=>{
 assert.throws(()=>wpsExport([]),/没有/);
 for(const startRow of [0,1.5,1048576])assert.throws(()=>wpsExport([fixture()],{startRow}));
 const c=fixture();c.parts[0].qty=0;assert.throws(()=>wpsExport([c]),/数量/);
 c.parts[0].qty=2;c.parts[0].displayName='=CMD("<&>")\n名称';
 const out=wpsExport([c],{layout:'EH'});assert.match(out.tsv,/'=CMD/);assert.match(out.html,/&lt;&amp;&gt;/);
 assert.equal((out.html.match(/x:f=/g)||[]).length,1);
});
