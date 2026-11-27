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

test('NAS 活动按人、类型和日期筛选，批量与单件定位分流，清理先预览',async()=>{
 const nodes=new Map(),requests=[],errors=[],positions=[],purges=[];
 const button=dataset=>({dataset});
 const locateButtons=[button({activityLocate:'0'}),button({activityLocate:'1'}),button({activityLocate:'2'})];
 const rowPerson=button({activityPerson:'other'}),ownButton=button({activityOperator:'own'});
 const context=vm.createContext({URLSearchParams,recentActivity:()=>assert.fail('NAS 不读本机记录'),
  document:{querySelector:key=>nodes.get(key),querySelectorAll:()=>[]}});
 vm.runInContext(source,context);
 const base={actor_uid:'other',operator:'当班人员',next_version:'21',created_at:'2026-11-16T16:08:00Z'};
 const rows=[
  {...base,kind:'configurations',resource_id:'config-a',resource_name:'配置 A',product_name:'测试链接',action:'replace'},
  {...base,kind:'costs',resource_id:'batch',action:'tax_sync',updated_count:842,skipped_count:15,samples:[{name:'样本显卡',id:'1002'}]},
  {...base,kind:'costs',resource_id:'1001',action:'global_tax',resource_name:'测试内存'},
  {...base,kind:'sources',resource_id:'deleted',action:'purge',object_exists:false},
 ];
 const operators=[{uid:'own',name:'我',own:true},{uid:'other',name:'当班人员',own:false}];
 context.openActivity({esc:String,toast:error=>errors.push(error),locate:target=>positions.push({...target}),shop:{id:'jonsbo',name:'乔思伯'},
  openDialog:(_title,html,{headerHtml})=>{for(const match of (html+headerHtml).matchAll(/id="([^"]+)"/g))nodes.set('#'+match[1],{
   value:'',hidden:true,isConnected:true,setAttribute(){},focus(){},querySelectorAll:selector=>({
    '[data-activity-locate]':locateButtons,'[data-activity-person]':[rowPerson],'[data-activity-operator]':[ownButton],
   }[selector]??[])});},
  loadNasPage:async query=>{requests.push({...query});return {...query,total:221,rows,operators,supportsPurge:true};},
  purgeNas:async body=>{purges.push(body);return {audit_count:842,receipt_count:1};}});
 await settle();
 assert.deepEqual(requests[0],{page:0,pageSize:30,from:'',to:''});
 assert.equal(nodes.get('#activity-count').textContent,'共 221 条记录');
 assert.match(nodes.get('#activity-operators').innerHTML,/全部人员.+本人（我）.+当班人员/);
 const records=nodes.get('#activity-list').innerHTML;
 for(const label of ['测试链接 · 配置 A · 版本 21','当班人员','2026-11-17','更新 842 项，跳过 15 项手动核算价','样本显卡','三店改共用核算价','彻底清理','已永久清理'])assert.ok(records.includes(label),label);
 assert.equal((records.match(/data-activity-locate=/g)||[]).length,3);
 for(const locateButton of locateButtons)await locateButton.onclick();
 assert.deepEqual(positions,[
  {id:'config-a',type:'configuration',shopId:'jonsbo'},
  {id:'batch',type:'price-changes',shopId:'jonsbo'},
  {id:'1001',type:'component',shopId:'jonsbo',goodsId:'1001'},
 ]);
 nodes.get('#activity-next').onclick();await settle();assert.equal(requests.at(-1).page,1);
 ownButton.onclick();await settle();assert.equal(requests.at(-1).actor,'own');
 rowPerson.onclick();await settle();assert.equal(requests.at(-1).actor,'other');
 nodes.get('#activity-kind').value='costs';nodes.get('#activity-from').value='2026-11-17';nodes.get('#activity-to').value='2026-11-18';
 nodes.get('#activity-kind').onchange();await settle();
 assert.deepEqual(requests.at(-1),{page:0,pageSize:30,from:'2026-11-17',to:'2026-11-18',actor:'other',kind:'costs'});
 nodes.get('#activity-cleanup-open').onclick();
 nodes.get('#activity-cleanup-scope').value='selected';nodes.get('#activity-cleanup-scope').onchange();
 await nodes.get('#activity-cleanup-confirm').onclick();assert.equal(purges.length,0);
 await nodes.get('#activity-cleanup-preview').onclick();
 assert.match(nodes.get('#activity-cleanup-status').textContent,/预计清理 842.+1 份过期回执/);
 await nodes.get('#activity-cleanup-confirm').onclick();
 assert.deepEqual(purges.map(body=>({...body})),[true,false].map(dry_run=>({from:'2026-11-17',to:'2026-11-18',actor:'other',kind:'costs',dry_run})));
 nodes.get('#activity-to').value='2026-11-16';nodes.get('#activity-to').onchange();await settle();
 assert.deepEqual(errors,['开始日期不得晚于结束日期。']);
});
