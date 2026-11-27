import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {invoke} from '@tauri-apps/api/core';
import {Button} from '@/components/ui/button';
import './AgentPermissionsDialog.css';

const defaults={readConfigs:true,readSources:true,readInventoryActivity:true,writeDraftConfigs:false,writeConfigs:false,
 writeSources:false,writeSourcesShared:false,writeSourcesFollowConfigs:false,allowExport:false,allowSync:false};
type Key=keyof typeof defaults;
type Change=Partial<Record<Key|'enabled',boolean>>;
type View={available:true;enabled:boolean;scopeKey:string;permissions:typeof defaults;account:{name:string;uid:string};
 shops:{id:string;name:string;configurationWrites:boolean;workspaceWrites:boolean;catalogWrites:boolean;sharedSources:boolean}[];
 instance:string;cliPath:string;connectionPath:string;capabilities:string[];shopCapabilities:Record<string,string[]>;
 shopSourceScopes?:Record<string,{shared:boolean;followConfigs:boolean}>};
type Response=View|{available:false};
const rows:Record<Key,[string,string,string]>={
 readConfigs:['配置清单与搜索','按链接、配置、SKU 或配件查找已保存的配置。','配置'],
 readSources:['输出源维护资料','查询输出源、核算价、共用资料及单店差异。','输出源'],
 readInventoryActivity:['库存巡检与操作记录','根据实际配件检查 NAS 库存快照，查询店铺操作记录。','库存 / 记录'],
 writeDraftConfigs:['新建 NAS 草稿链接与配置','仅允许新建链接并保存到 NAS 草稿区（同工作区运营可见，禁止写入在售正式链接）。','NAS 草稿区'],
 writeConfigs:['修改已有配置','预览并应用已有配置的换件、数量、售价或展示文案修改。','配置'],
 writeSources:['输出源维护写入（单店）','维护本店输出源的展示资料、核算价与加购。','单店'],
 writeSourcesShared:['允许修改三店共用输出源与新建特殊配件','修改共用基准、恢复共用字段，或在三店新建配件。','三店共用'],
 writeSourcesFollowConfigs:['允许输出源保存后联动更新关联配置','仅在明确请求联动时，更新目标店铺中自动跟随的配置。','关联配置'],
 allowExport:['导出图片与报告','将已保存配置的图片和报告写入指定目录。','本机文件'],
 allowSync:['刷新当前工作台','刷新当前店铺，保留本机配置草稿。','当前店铺']
};
const keys=Object.keys(rows) as Key[];
const writes=['changes.apply','draft.apply','sources.apply','export.start','sync.run'];
function writableFlags(shops:View['shops']){
 const config=(shop:View['shops'][number])=>shop.configurationWrites&&shop.workspaceWrites;
 const canConfig=shops.some(config);
 return {writeDraftConfigs:canConfig,writeConfigs:canConfig,writeSources:shops.some(s=>s.catalogWrites),
  writeSourcesShared:shops.length===3&&shops.every(s=>s.catalogWrites&&s.sharedSources),
  writeSourcesFollowConfigs:shops.some(s=>s.catalogWrites&&config(s)),allowExport:shops.length>0,allowSync:shops.length>0};
}
function writeCount(view:View,optimistic:boolean){
 if(!view.enabled)return 0;
 if(!optimistic)return view.capabilities.filter(method=>writes.includes(method)).length;
 // 保存期间按当前账号可执行的五类写操作预显徽标，回执到达后采用宿主的实际能力。
 const can=writableFlags(view.shops);
 return (['writeConfigs','writeDraftConfigs','writeSources','allowExport','allowSync'] as const)
  .filter(key=>can[key]&&view.permissions[key]).length;
}

/** 菜单挂载于工作台 iframe，原生对话框挂在宿主，覆盖整个桌面窗口。 */
export default function AgentPermissionsMenu(){
 const anchor=useRef<HTMLSpanElement>(null);
 const [confirmed,setConfirmed]=useState<Response|null>(null),[open,setOpen]=useState(false),[error,setError]=useState('');
 const [loading,setLoading]=useState(false),[note,setNote]=useState('');
 // 乐观值涵盖在途及待发变更；pending 只保留下次需要提交的字段。
 const [optimistic,setOptimistic]=useState<Change|null>(null),pending=useRef<Change|null>(null);
 const epoch=useRef(0),writing=useRef(false);
 const {enabled,...flags}=optimistic??{};
 const view=confirmed?.available&&optimistic
  ?{...confirmed,enabled:enabled??confirmed.enabled,permissions:{...confirmed.permissions,...flags}}:confirmed;
 const saving=optimistic!==null,count=view?.available?writeCount(view,saving):0;
 const badge=!view?.available?'读取中':!view.enabled?'已停用':count?`含写入(${count})`:'仅只读';
 async function load(){
  if(writing.current)return;
  const generation=++epoch.current;
  setLoading(true);
  try{
   const data=await invoke<Response>('agent_permissions_get');
   if(generation===epoch.current){setConfirmed(data);setError('');setNote('');}
  }catch(e){if(generation===epoch.current)setError(String(e));}
  finally{if(generation===epoch.current)setLoading(false);}
 }
 useEffect(()=>{
  const menu=anchor.current?.closest('details');
  const toggle=()=>{if(menu?.open)void load();};
  menu?.addEventListener('toggle',toggle);
  if(menu?.open)void load();
  return ()=>{epoch.current++;menu?.removeEventListener('toggle',toggle);};
 },[]);
 async function change(patch:Change){
  if(!confirmed?.available||error)return;
  const scopeKey=confirmed.scopeKey;
  pending.current={...pending.current,...patch};
  setOptimistic(previous=>({...previous,...patch}));
  if(writing.current)return;
  writing.current=true;setLoading(false);setNote('');
  // 第一次点击使较早的静默读取失效，后续点击共用同一条串行队列和账号。
  const generation=++epoch.current;
  try{
   while(pending.current){
    const batch=pending.current;
    pending.current=null;
    const next=await invoke<Response>('agent_permissions_set',{scopeKey,patch:batch});
    if(generation!==epoch.current)return;
    if(!next.available||next.scopeKey!==scopeKey)throw Error('当前接口或账号已变化，请重新读取');
    setConfirmed(next);
    setOptimistic(pending.current);
   }
   setNote('已保存并生效');
  }catch(e){
   // 已确认批次仍然生效；丢弃失败批次和其后的输入，避免用旧账号的设置继续写。
   if(generation===epoch.current){pending.current=null;setOptimistic(null);setError(String(e));}
  }finally{writing.current=false;}
 }
 return <><span hidden ref={anchor}/>{view?.available!==false&&
  <Button type="button" variant="outline" className="agent-permission-entry" onClick={e=>{
   e.currentTarget.closest('details')?.removeAttribute('open');setOpen(true);setNote('');void load();
  }}>AI 接口权限 <small>{error?'需重试':badge}</small></Button>}
  {open&&createPortal(<AgentPermissionsDialog view={view} initialLoading={!view&&loading} saving={saving} badge={badge} count={count} note={note} error={error}
    retry={load} change={change} onClose={()=>setOpen(false)}/>,document.body)}</>;
}

function AgentPermissionsDialog({view,initialLoading,saving,badge,count,note,error,retry,change,onClose}:{
 view:Response|null;initialLoading:boolean;saving:boolean;badge:string;count:number;note:string;error:string;retry:()=>Promise<void>;change:(patch:Change)=>Promise<void>;onClose:()=>void
}){
 const dialog=useRef<HTMLDialogElement>(null),[copyNote,setCopyNote]=useState('');
 useLayoutEffect(()=>{const el=dialog.current;el?.showModal();return ()=>el?.close();},[]);
 const data=view?.available?view:null;
 const p=data?.permissions??defaults;
 const can=writableFlags(data?.shops??[]),unavailable=initialLoading||!!error;
 function locked(key:Key){
  if(!data?.enabled)return '本机 AI 接口已停用';
  if(key==='writeSourcesShared'&&!can.writeSourcesShared)return '需要三店共用目录能力和目录写权限';
  if((key==='writeSourcesShared'||key==='writeSourcesFollowConfigs')&&!p.writeSources)return '请先开启单店输出源维护写入';
  if(key==='writeSourcesFollowConfigs'&&!p.writeConfigs)return '请先开启修改已有配置';
  if(key==='writeSourcesFollowConfigs'&&!can.writeSourcesFollowConfigs)return '需同一店铺具备目录和配置写权限';
  if((key==='writeConfigs'||key==='writeDraftConfigs')&&!can.writeConfigs)return '当前账号没有配置写权限';
  if(key==='writeSources'&&!can.writeSources)return '当前账号没有目录写权限';
  if((key==='allowExport'||key==='allowSync')&&!can[key])return '当前账号没有可用店铺';
  return '';
 }
 function row(key:Key){
  const [name,description,scope]=rows[key],reason=locked(key);
  const child=key==='writeSourcesFollowConfigs'||key==='writeSourcesShared';
  return <label key={key} className="ap-row" data-child={child} data-locked={!!reason} data-write={!key.startsWith('read')&&p[key]}>
   <input type="checkbox" aria-label={name} checked={p[key]} disabled={!!reason||unavailable} onChange={e=>{
    const checked=e.target.checked,patch:Change={[key]:checked};
    if(key==='writeSources'&&!checked)patch.writeSourcesShared=false;
    if((key==='writeConfigs'||key==='writeSources')&&!checked)patch.writeSourcesFollowConfigs=false;
    void change(patch);
   }}/>
   <span className="ap-content"><span className="ap-row-title"><strong>{name}</strong><em>{scope}</em></span>
    <small>{reason||description}{!reason&&key==='readSources'&&!p.readInventoryActivity?' 库存数已隐藏。':''}</small></span>
  </label>;
 }
 const snippet=data&&data.cliPath&&data.connectionPath?JSON.stringify({mcpServers:{'diy-workbench':{
  command:data.cliPath,args:['mcp','--connection',data.connectionPath,'--follow-workbench']
 }}},null,2):'';
 function presetFlags(full:boolean){
  return {...defaults,...(full?can:{}),enabled:true};
 }
 function presetButton(full:boolean){
  const flags=presetFlags(full);
  const selected=data?.enabled&&keys.every(key=>p[key]===flags[key]);
  return <button aria-pressed={!!selected} disabled={unavailable} onClick={()=>void change(flags)}>{full?'完整维护':'纯只读'}</button>;
 }
 return <dialog ref={dialog} className="agent-permission-dialog" aria-labelledby="ap-title" onCancel={e=>{e.preventDefault();onClose();}}>
  <header><h2 id="ap-title">AI 接口权限 {data&&<span className="ap-status" data-active={count>0} data-disabled={!data.enabled}>{badge}</span>}</h2>
   <button type="button" aria-label="关闭" onClick={onClose}>×</button></header>
  <div className="ap-body">
   {error&&<p role="alert">{error} <button onClick={()=>void retry()}>重新读取</button></p>}
   {!data&&!error&&<p role="status">{view?'当前构建未启用本机 AI 接口。':'正在读取当前账号权限…'}</p>}
   {data&&<>
    <section className="ap-master"><div><label><input type="checkbox" disabled={unavailable} checked={data.enabled} onChange={e=>void change({enabled:e.target.checked})}/>启用本机 AI 接口（CLI / MCP · 本机总开关）</label>
     <div className="ap-identity">实例 <b>{data.instance}</b>　当前账号 <b>{data.account.name||data.account.uid}</b>　授权店铺 <b>{data.shops.map(s=>s.name||s.id).join(' / ')}</b></div></div>
     <div className="ap-presets" role="group" aria-label="快捷预设">
      {presetButton(false)}{presetButton(true)}</div>
    </section>
    <section><h3>只读查询权限 <small>默认开启 · 读取 NAS 已保存快照</small></h3><div className="ap-list">{keys.filter(k=>k.startsWith('read')).map(row)}</div></section>
    <section><h3>写入与任务权限 <small>默认关闭 · 入队、领取与提交前复核</small></h3><div className="ap-list">{keys.filter(k=>!k.startsWith('read')).map(row)}</div></section>
    <details className="ap-fold"><summary>MCP 接入配置与当前生效能力</summary><div>
     {snippet&&<><pre>{snippet}</pre><button onClick={async()=>{try{await navigator.clipboard.writeText(snippet);setCopyNote('已复制');}catch{setCopyNote('请选中上方配置并复制');}}}>复制 MCP 配置</button> <small role="status">{copyNote}</small></>}
     {data.shops.map(shop=><p key={shop.id} className="ap-capabilities"><strong>{shop.name||shop.id}</strong>
      {data.shopCapabilities[shop.id]?.length?data.shopCapabilities[shop.id].map(method=><code key={method} data-write={writes.includes(method)}>{method}</code>):'暂无开放能力'}
      {data.shopSourceScopes?.[shop.id]?.shared&&<span>可维护三店共用来源</span>}
      {data.shopSourceScopes?.[shop.id]?.followConfigs&&<span>可联动本店配置</span>}</p>)}
    </div></details>
    <p className="ap-footnote">总开关在本机共用，细项按登录账号保存。关闭权限后，尚未提交的步骤会停止。</p>
   </>}
  </div>
  <footer><button disabled={!data||unavailable} onClick={()=>void change(presetFlags(false))}>恢复默认（仅只读）</button>
   <small role="status">{saving?'正在保存…':initialLoading?'正在读取…':error?'':note||'修改即时生效'}</small><button className="ap-done" onClick={onClose}>完成</button></footer>
 </dialog>;
}
