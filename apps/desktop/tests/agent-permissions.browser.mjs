/** 用真实宿主组件检查 iframe 菜单、权限依赖、MCP 配置及原生保存失败后的恢复。 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base=process.env.REACT_TEST_URL||'http://127.0.0.1:5289';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext({bypassCSP:true,permissions:['clipboard-read','clipboard-write'],viewport:{width:1100,height:760}});
 const page=await context.newPage(),errors=[];
 page.setDefaultTimeout(8000);
 page.on('pageerror',err=>{errors.push(err.message);console.error(err.message);});
 page.on('response',res=>{if(res.status()>=400)console.error(res.status(),res.url());});
 await page.route('**/p1-permissions',route=>route.fulfill({contentType:'text/html',body:`<!doctype html>
  <html data-theme="light" lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/workbench/endfield/endfield.css">
  <link rel="stylesheet" href="/src/App.css"><link rel="stylesheet" href="/workbench/endfield-workbench.css"></head>
  <body><main></main><iframe title="工作台"></iframe><script type="module">
  import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
  const React=(await import('/node_modules/.vite/deps/react.js')).default;
  const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const {createPortal}=(await import('/node_modules/.vite/deps/react-dom.js')).default;
  const {default:Menu}=await import('/src/AgentPermissionsDialog.tsx');
  const permissions={readConfigs:true,readSources:true,readInventoryActivity:true,writeDraftConfigs:false,writeConfigs:false,writeSources:false,writeSourcesShared:false,writeSourcesFollowConfigs:false,allowExport:false,allowSync:false};
  window.probe={scope:'member-a',writeFail:false,available:true,patches:[],attempts:[],gates:{},writing:0,maxWriting:0};
  const byAccount={'member-a':permissions,'member-b':{...permissions}};
  const view={available:true,enabled:true,scopeKey:'member-a',account:{uid:'a',name:'测试运营'},permissions,
   instance:'desktop-local',cliPath:'C:/isolation/agent.exe',connectionPath:'C:/isolation/agent-connection.json',shops:[{id:'intel',name:'英特尔',configurationWrites:true,workspaceWrites:true,catalogWrites:true}]};
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   if(!probe.available)return {available:false};
   const snapshot=()=>{
    const flags=byAccount[probe.scope],shops=probe.scope==='member-a'?view.shops:['intel','gigabyte','jonsbo'].map(id=>({...view.shops[0],id,name:id,sharedSources:true}));
    const writes={writeDraftConfigs:'draft.apply',writeConfigs:'changes.apply',writeSources:'sources.apply',allowExport:'export.start',allowSync:'sync.run'};
    const methods=view.enabled?['status',...Object.entries(writes).filter(([key])=>flags[key]).map(([,method])=>method)]:[];
    return structuredClone({...view,permissions:flags,shops,scopeKey:probe.scope,capabilities:methods,shopCapabilities:Object.fromEntries(shops.map(s=>[s.id,methods]))});
   };
   if(command==='agent_permissions_get'){
    const saved=snapshot();
    if(probe.gates.get)await probe.gates.get.wait;
    return saved;
   }
   if(command!=='agent_permissions_set')throw Error(command);
   probe.attempts.push(args);probe.maxWriting=Math.max(probe.maxWriting,++probe.writing);
   try{
    if(probe.gates.set)await probe.gates.set.wait;
    if(args.scopeKey!==probe.scope||probe.writeFail)throw Error('MEMBER_CHANGED：账号已切换，请重新读取');
    if(probe.failField&&Object.hasOwn(args.patch,probe.failField))throw Error('指定批次保存失败');
    for(const [key,value] of Object.entries(args.patch)){if(key==='enabled')view.enabled=value;else byAccount[probe.scope][key]=value;}
    probe.patches.push(args);
    return snapshot();
   }finally{probe.writing--;}
  }};
  const doc=document.querySelector('iframe').contentDocument;
  doc.documentElement.dataset.workbenchDesign='endfield';
  doc.head.innerHTML='<link rel="stylesheet" href="/workbench/endfield-workbench.css">';
  doc.body.innerHTML='<div id="desktop-host-actions"><details class="app-more"><summary>更多</summary><div class="app-more-menu"></div></details></div>';
  createRoot(document.querySelector('main')).render(createPortal(React.createElement(Menu),doc.querySelector('.app-more-menu')));
  </script></body></html>`}));
 await page.goto(base+'/p1-permissions');
 const frame=page.frameLocator('iframe'),more=frame.getByText('更多'),entry=frame.getByRole('button',{name:/AI 接口权限/});
 // 锁住实际编辑区后，运营仍能从 iframe 打开宿主对话框，撤回下一步写入。
 await frame.locator('.agent-permission-entry').waitFor({state:'attached'});
 await page.evaluate(async()=>{
  const workbench=document.querySelector('iframe').contentWindow,button=workbench.document.createElement('button');
  button.id='business-action';workbench.document.body.append(button);
  const {lockAgentEditor}=await import('/workbench/agent-editor-lock.js');
  window.releaseAgentLock=lockAgentEditor(true,workbench);
 });
 assert.equal(await frame.locator('#business-action').evaluate(el=>el.inert),true);
 await more.click();await entry.getByText('仅只读').waitFor();await entry.hover();
 assert.equal(await entry.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 250, 0)');
 // 手动释放原生响应，保证所有“立即”断言都发生在回执返回之前。
 const hold=kind=>page.evaluate(key=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});probe.gates[key]={wait,release};
 },kind);
 const release=kind=>page.evaluate(key=>{probe.gates[key].release();delete probe.gates[key];},kind);
 await hold('get');
 await entry.click();
 const dialog=page.getByRole('dialog'),get=name=>dialog.getByRole('checkbox',{name,exact:true});
 const button=name=>dialog.getByRole('button',{name,exact:true}),readonly=button('纯只读'),full=button('完整维护'),done=button('完成');
 const draft=get('新建 NAS 草稿链接与配置'),configs=get('修改已有配置'),sources=get('输出源维护写入（单店）');
 const master=dialog.getByRole('checkbox',{name:/启用本机/}),reset=button('恢复默认（仅只读）');
 const saved=dialog.getByText('已保存并生效',{exact:true}),badge=dialog.locator('.ap-status');
 assert.deepEqual(await dialog.getByRole('group',{name:'快捷预设'}).getByRole('button').allTextContents(),['纯只读','完整维护']);
 assert.equal(await button('同事写草稿').count(),0);
 assert.equal(await readonly.getAttribute('aria-pressed'),'true');
 assert.equal(await draft.isEnabled(),true);
 assert.equal(await get('允许修改三店共用输出源与新建特殊配件').isDisabled(),true);
 await hold('set');await draft.check();
 assert.equal(await draft.isChecked(),true);assert.equal(await badge.textContent(),'含写入(1)');
 for(const control of [configs,sources,master,readonly,full,reset,done])assert.equal(await control.isEnabled(),true);
 await configs.check();await sources.check();
 assert.equal(await badge.textContent(),'含写入(3)');
 await release('get');assert.equal(await draft.isChecked(),true);
 assert.deepEqual(await page.evaluate(()=>probe.attempts.map(a=>a.patch)),[{writeDraftConfigs:true}]);
 await release('set');await saved.waitFor();
 assert.deepEqual(await page.evaluate(()=>probe.patches.map(a=>a.patch)),[{writeDraftConfigs:true},{writeConfigs:true,writeSources:true}]);
 assert.equal(await page.evaluate(()=>probe.maxWriting),1);
 for(const control of [draft,configs,sources])assert.equal(await control.isChecked(),true);
 await hold('set');await full.click();
 assert.equal(await full.getAttribute('aria-pressed'),'true');assert.equal(await badge.textContent(),'含写入(5)');
 const follow=get('允许输出源保存后联动更新关联配置');
 assert.equal(await draft.isChecked(),true);assert.equal(await follow.isChecked(),true);
 await page.mouse.move(0,0);
 const buttonStyle=el=>{const s=getComputedStyle(el);return [s.backgroundColor,s.color,s.transitionDuration];};
 // 在宿主实际全局样式及工作台主题通用按钮规则同时生效时检查两套主题。
 await page.evaluate(()=>document.documentElement.dataset.workbenchDesign='endfield');
 for(const theme of ['light','dark']){
  await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.classList.toggle('dark',t==='dark');},theme);
  for(const item of [done,full])assert.deepEqual(await item.evaluate(buttonStyle),['rgb(255, 250, 0)','rgb(22, 22, 22)','0s']);
  assert.deepEqual(await draft.evaluate(el=>[getComputedStyle(el).backgroundColor,getComputedStyle(el).opacity]),['rgb(255, 250, 0)','1']);
 }
 await configs.uncheck();
 assert.equal(await follow.isChecked(),false);assert.equal(await follow.isDisabled(),true);
 await release('set');await saved.waitFor();
 await dialog.getByText('MCP 接入配置与当前生效能力').click();
 await dialog.getByRole('button',{name:'复制 MCP 配置'}).click();
 const snippet=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()));
 assert.deepEqual(snippet.mcpServers['diy-workbench'],{command:'C:/isolation/agent.exe',args:['mcp','--connection','C:/isolation/agent-connection.json','--follow-workbench']});
 await page.evaluate(()=>delete document.documentElement.dataset.workbenchDesign);
 assert.equal(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(34, 34, 34)');
 await hold('set');
 const readConfigs=get('配置清单与搜索'),beforeError=await page.evaluate(()=>probe.attempts.length);
 await readConfigs.uncheck();await draft.uncheck();
 assert.equal(await readConfigs.isChecked(),false);assert.equal(await draft.isChecked(),false);
 await page.evaluate(()=>{probe.scope='member-b';probe.writeFail=true;});
 await release('set');
 await dialog.getByRole('alert').waitFor();assert.equal(await readConfigs.isDisabled(),true);
 assert.equal(await readConfigs.isChecked(),true);assert.equal(await draft.isChecked(),true);
 assert.equal(await page.evaluate(()=>probe.attempts.length),beforeError+1);
 await page.evaluate(()=>probe.writeFail=false);
 await dialog.getByRole('button',{name:'重新读取'}).click();
 await full.click();await saved.waitFor();
 assert.equal(await page.evaluate(()=>probe.patches.at(-1).scopeKey),'member-b');
 const shared=get('允许修改三店共用输出源与新建特殊配件');
 assert.equal(await shared.isChecked(),true);assert.equal(await follow.isChecked(),true);
 // 第一批关掉来源写入并级联撤权，第二批失败时只撤销尚未确认的输入。
 await hold('set');await sources.uncheck();
 for(const child of [shared,follow]){assert.equal(await child.isChecked(),false);assert.equal(await child.isDisabled(),true);}
 await readConfigs.uncheck();
 await page.evaluate(()=>{probe.failField='readConfigs';});
 await release('set');await dialog.getByRole('alert').waitFor();
 assert.equal(await readConfigs.isChecked(),true);assert.equal(await sources.isChecked(),false);
 assert.equal(await shared.isChecked(),false);assert.equal(await follow.isChecked(),false);
 await page.evaluate(()=>{probe.failField='';});await button('重新读取').click();await reset.click();await saved.waitFor();
 await hold('set');await master.uncheck();
 assert.equal(await badge.textContent(),'已停用');assert.equal(await master.isEnabled(),true);
 await release('set');await saved.waitFor();
 await page.evaluate(()=>releaseAgentLock());assert.equal(await frame.locator('#business-action').evaluate(el=>el.inert),false);
 assert.equal(await get('配置清单与搜索').isDisabled(),true);
 await page.keyboard.press('Escape');
 await dialog.waitFor({state:'detached'});
 await page.evaluate(()=>probe.available=false);await more.click();
 await entry.waitFor({state:'detached'});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({menuHover:true,theme:true,permissionLocks:true,copyMcp:true,staleIdentity:true,disabledBuild:true,
  presets:2,optimistic:true,serialized:true,rollback:true,silentRefresh:true}));
}finally{await browser.close();}
