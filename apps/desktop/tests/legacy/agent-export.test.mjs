import test from 'node:test';
import assert from 'node:assert/strict';
import {exportAgentSnapshot} from '../../public/workbench/agent-export.js';

const config=(id,name)=>({id,name,shopId:'intel',productId:'link',product:'主机',spu:'0012',skuId:null,parts:[{slot:'CPU',name:'展示 CPU',goodsId:'0001',qty:1}],actualParts:[{slot:'CPU',name:'实际 CPU',goodsId:'0002',qty:2}]});
function fixture(){
 const canvases=[],writes=[],finished=[];
 return {canvases,writes,finished,
  render:async(c,width)=>{const canvas={width,height:30,toBlob:callback=>callback(new Blob([`PNG:${c.name}:${c.layout}`],{type:'image/png'}))};canvases.push(canvas);return {canvas,overflow:false};},
  writeFile:async file=>{writes.push({...file});return {ok:true,name:file.name};},
  finish:async payload=>{finished.push(payload);return {ok:true,directory:'C:\\export',zipPath:'C:\\export\\images.zip',manifestPath:'C:\\export\\manifest.json',reportPath:'C:\\export\\report.html'};}
 };
}

test('报告读取真实 ERP 与核算价及匹配手工覆盖，未知不猜测，特殊项保持零成本',async()=>{
 const f=fixture(),c=config('a','成本核验');
 c.parts=[{slot:'CPU',name:'展示成本',goodsId:'0001',qty:1,erp:12.34,tax:23.45,cost:999,costCents:88888,upgrade:'FIRST_DESC_SENTINEL <升级> & "原样"'}];
 c.actualParts=[
  {slot:'CPU',name:'覆盖成本',goodsId:'0002',qty:2,erp:45.67,tax:56.78,taxOverride:{goodsId:'0002',value:67.89,base:56.78}},
  {slot:'主板',name:'失配覆盖',goodsId:'0003',qty:1,erpMissing:true,erp:999,tax:78.91,taxOverride:{goodsId:'wrong',value:888,base:78.91}},
  {slot:'配件',name:'未知成本',goodsId:'0004',qty:1,erpUnknown:true,erp:999,tax:null,cost:777},
  {slot:'显卡',name:'特殊零价',goodsId:'',qty:1,specialComponent:true,erp:null,tax:null},
 ];
 const before=structuredClone(c);await exportAgentSnapshot({...f,configs:[c],revision:1,params:{images:'long',report:true}});
 const html=f.finished[0].reportHtml;
 assert.ok(html.includes('已保存 ERP 单价（元）')&&html.includes('核算含税单价（元）'));
 assert.ok(html.includes('<th>升级描述</th>'));assert.ok(html.includes('FIRST_DESC_SENTINEL &lt;升级&gt; &amp; &quot;原样&quot;'));
 assert.ok(html.includes('<td>12.34</td><td>23.45</td>'));assert.ok(html.includes('<td>45.67</td><td>67.89</td>'));
 assert.ok(html.includes('<td>未填写</td><td>78.91</td>'));assert.ok(html.includes('<td>未填写</td><td>未填写</td>'));
 assert.ok(html.includes('<td>0</td><td>0</td>'));
 for(const wrong of ['<td>999</td>','<td>888</td>','<td>777</td>','<td>888.88</td>'])assert.ok(!html.includes(wrong));
 assert.deepEqual(c,before);
});
test('两种图片逐张写入，保留链接编号，HTML只包含所选保存快照',async()=>{
 const f=fixture(),configs=[config('a','配置1'),config('b','配置2')],seen=[];
 const result=await exportAgentSnapshot({...f,configs,revision:42,params:{images:'both',report:true,configIds:['b']},render:async(c,width)=>{seen.push([c.name,c.layout,width,f.writes.length]);c.name='渲染副本修改';return f.render(c,width);},progress:()=>{configs[1].parts[0].name='UI变化';configs[1].name='UI变化';}});
 assert.deepEqual(seen,[['配置2','long',1000,0],['配置2','square',1400,1]]);
 assert.equal(f.writes.length,2);assert.ok(f.writes.every(w=>w.name.endsWith('/2_配置2.png')));
 assert.equal(Buffer.from(f.writes[0].base64,'base64').toString(),'PNG:渲染副本修改:long');
 assert.equal(result.localSave,'unchanged');assert.equal(result.export,'completed');assert.equal(result.revision,42);
 assert.deepEqual(result.manifest.configs.map(c=>c.id),['b']);
 const html=f.finished[0].reportHtml;
 assert.ok(html.includes('展示 CPU')&&html.includes('实际 CPU')&&html.includes('0012 / 未填写'));
 assert.ok(!html.includes('UI变化')&&!html.includes('渲染副本修改')&&!html.includes('配置1'));
 assert.ok(!html.includes('https://'));assert.ok(html.includes('%E4%B8%BB%E6%9C%BA_'));
 assert.ok(f.canvases.every(c=>c.width===0&&c.height===0));
});
test('报告转义文本与URL，空实际BOM不能回退为展示配件',async()=>{
 const f=fixture(),c=config('a','<script>alert(1)</script>');
 c.productUrl='javascript:alert("x")';c.product='<img onerror=bad>';c.actualParts=[];c.parts[0].name='展示独有';
 await exportAgentSnapshot({...f,configs:[c],revision:1,params:{images:'square',report:true}});
 const html=f.finished[0].reportHtml;
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
 assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('<img onerror'));
 assert.equal((html.match(/展示独有/g)||[]).length,1);assert.ok(html.includes('无配件'));
 assert.equal(f.writes.length,1);
});
test('写盘失败不finish不假成功且释放画布',async()=>{
 const f=fixture();
 await assert.rejects(exportAgentSnapshot({...f,configs:[config('a','配置1')],revision:1,writeFile:async()=>({ok:false,error:'磁盘已满'})}),/磁盘已满/);
 assert.equal(f.finished.length,0);assert.ok(f.canvases.every(c=>c.width===0));
});
test('渲染溢出、编码失败、finish缺失路径均不能返回成功',async()=>{
 for(const mode of ['overflow','blob','finish']){
  const f=fixture();
  if(mode==='finish')f.finish=async()=>({ok:true});
  if(mode==='overflow'||mode==='blob')f.render=async()=>{const canvas={width:10,height:10,toBlob:callback=>callback(null)};f.canvases.push(canvas);return {canvas,overflow:mode==='overflow'};};
  await assert.rejects(exportAgentSnapshot({...f,configs:[config('a','配置1')],revision:1}));
  assert.ok(f.canvases.every(c=>c.width===0&&c.height===0));
 }
});
test('report=false不生成报告；非法选择在写入前拒绝',async()=>{
 const f=fixture();await exportAgentSnapshot({...f,configs:[config('a','配置1')],revision:1,params:{images:'long',report:false}});
 assert.equal(f.finished[0].reportHtml,null);assert.equal(f.writes.length,1);
 for(const params of [{images:'other'},{report:'yes'},{configIds:['unknown']},{configIds:[]}]){
  const fresh=fixture();await assert.rejects(exportAgentSnapshot({...fresh,configs:[config('a','配置1')],revision:1,params}));assert.equal(fresh.writes.length,0);
 }
});

test('旧链接raw兄弟与保存回执的规范化productId混合时仍保留第二项编号',async()=>{
 const f=fixture(),a=config('a','配置1'),b=config('b','配置2');delete a.productId;b.productId='legacy:0012';
 const configs=[a,b],before=structuredClone(configs);
 await exportAgentSnapshot({...f,configs,revision:8,params:{images:'both',configIds:['b']}});
 assert.ok(f.writes.every(file=>file.name.endsWith('/2_配置2.png')));assert.deepEqual(configs,before);
});
