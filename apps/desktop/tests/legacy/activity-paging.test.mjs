import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../public/workbench/activity-ui.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export function openActivity','function openActivity');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('activity loads 30-row pages and ignores superseded dates or replaced dialogs',async()=>{
 const nodes=new Map(),requests=[],errors=[];
 const context=vm.createContext({URLSearchParams,recentActivity:rows=>rows,document:{querySelector:key=>nodes.get(key),querySelectorAll:()=>[]}});
 vm.runInContext(source,context);
 context.openActivity({esc:String,toast:error=>errors.push(error),locate(){},openDialog:(_title,html)=>{for(const match of html.matchAll(/id="([^"]+)"/g))nodes.set('#'+match[1],{value:'',textContent:'',innerHTML:'',isConnected:true,disabled:false});},request:url=>{const gate=deferred();requests.push({url,...gate});return gate.promise;}});
 assert.match(requests[0].url,/page=0&pageSize=30/);
 nodes.get('#activity-from').value='2026-10-13';nodes.get('#activity-from').onchange();
 assert.match(requests[1].url,/from=2026-10-13/);
 requests[1].resolve({rows:[],total:60,page:0,pageSize:30});await settle();assert.equal(nodes.get('#activity-count').textContent,'共 60 条记录');
 requests[0].resolve({rows:[],total:999,page:0,pageSize:30});await settle();assert.equal(nodes.get('#activity-count').textContent,'共 60 条记录');
 nodes.get('#activity-next').onclick();assert.match(requests[2].url,/page=1/);
 nodes.get('#activity-list').isConnected=false;requests[2].resolve({rows:[],total:3,page:0,pageSize:30});await settle();
 assert.equal(nodes.get('#activity-count').textContent,'共 60 条记录');assert.deepEqual(errors,[]);
});

test('NAS 操作记录按服务端日期分页，并用明确资源定位到当前配置',async()=>{
 const nodes=new Map(),requests=[],errors=[],positions=[],hint=[];
 const locateButton={dataset:{activityLocate:'0'}};
 const context=vm.createContext({URLSearchParams,recentActivity:()=>assert.fail('NAS 分页不能先取本机记录'),
  document:{querySelector:key=>nodes.get(key),querySelectorAll:()=>[locateButton]}});
 vm.runInContext(source,context);
 const row={kind:'configurations',resource_id:'config-a',resource_name:'配置 A',operator:'当班人员',action:'replace',
  next_version:'21',created_at:'2026-11-16T16:00:00Z'};
 context.openActivity({esc:String,toast:error=>errors.push(error),locate:target=>positions.push({...target}),
  openDialog:(_title,html)=>{hint.push(html);for(const match of html.matchAll(/id="([^"]+)"/g))nodes.set('#'+match[1],{value:'',isConnected:true});},
  request:()=>assert.fail('NAS 不调用本机活动记录'),
  loadNasPage:async query=>{requests.push({...query});return {...query,total:221,rows:[row]};}});
 await settle();
 assert.match(hint[0],/旧工作台本机记录未迁入/);
 assert.deepEqual(requests[0],{page:0,pageSize:30,from:'',to:''});
 assert.equal(nodes.get('#activity-count').textContent,'共 221 条记录');
 assert.match(nodes.get('#activity-list').innerHTML,/修改 · 配置.+配置 A · 版本 21.+操作人：当班人员.+2026\/11\/17/);
 await locateButton.onclick();assert.deepEqual(positions,[{id:'config-a',type:'configuration',shopId:'intel'}]);
 nodes.get('#activity-next').onclick();await settle();assert.equal(requests[1].page,1);
 nodes.get('#activity-from').value='2026-11-17';nodes.get('#activity-to').value='2026-11-18';
 nodes.get('#activity-from').onchange();await settle();
 assert.deepEqual(requests[2],{page:0,pageSize:30,from:'2026-11-17',to:'2026-11-18'});
 nodes.get('#activity-to').value='2026-11-16';nodes.get('#activity-to').onchange();await settle();
 assert.equal(requests.length,3);assert.deepEqual(errors,['开始日期不得晚于结束日期。']);
});
