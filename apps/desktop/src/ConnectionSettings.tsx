/** 首次连接和更多菜单共用设置页；凭据始终交给原登录页，不写入连接文件。 */
import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import './ConnectionSettings.css';

export type ConnectionConfig={version:number;name:string;api_url:string;deployment_id:string;ca_pem:string|null};
const empty:ConnectionConfig={version:1,name:'DIY工作台',api_url:'',deployment_id:'',ca_pem:null};
export default function ConnectionSettings({firstUse,onClose,onSave}:{firstUse:boolean;onClose:()=>void;onSave:(config:ConnectionConfig)=>Promise<void>}){
  const [config,setConfig]=useState<ConnectionConfig>(empty),[tab,setTab]=useState<'connection'|'tls'>('connection');
  const [custom,setCustom]=useState(false),[busy,setBusy]=useState(true),[error,setError]=useState(''),[tested,setTested]=useState(false);
  const [message,setMessage]=useState(''),[initial,setInitial]=useState<ConnectionConfig|null>(null);
  const live=useRef(true);
  useEffect(()=>{live.current=true;void invoke<{config:ConnectionConfig|null;error:string}>('nas_connection_settings').then(result=>{
    if(!live.current)return;setConfig(result.config??empty);setInitial(result.config);setCustom(Boolean(result.config?.ca_pem));
    if(result.error)setMessage('尚未配置可用连接，请填写下列信息。');
  }).catch(e=>{if(live.current)setError(String(e));}).finally(()=>{if(live.current)setBusy(false);});return()=>{live.current=false;};},[]);
  function change(patch:Partial<ConnectionConfig>){setConfig(value=>({...value,...patch,deployment_id:''}));setTested(false);setMessage('');setError('');}
  async function choose(){setBusy(true);setError('');try{const pem=await invoke<string|null>('nas_connection_certificate');if(pem)change({ca_pem:pem});}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function test(){setBusy(true);setError('');setTested(false);setMessage('正在验证 HTTPS 和工作台服务…');try{
    if(custom&&!config.ca_pem)throw Error('请选择 CA 证书。');
    const result=await invoke<ConnectionConfig>('nas_connection_test',{config:{...config,ca_pem:custom?config.ca_pem:null}});
    setConfig(result);setTested(true);setMessage(`连接成功 · ${result.deployment_id}`);
  }catch(e){setMessage('');setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function save(){if(!tested||busy)return;setBusy(true);setError('');try{await onSave(config);}catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}}
  const switched=initial&&(initial.api_url!==config.api_url||initial.deployment_id!==config.deployment_id);
  return <div className={firstUse?'connection-shell':'connection-overlay'}>
    <section className="connection-card" role="dialog" aria-modal="true" aria-labelledby="connection-title" aria-busy={busy}>
      <header><div><p className="connection-eyebrow">DIY 配置工作台</p><h1 id="connection-title">{firstUse?'连接你的服务端':'连接设置'}</h1></div>{!firstUse&&<Button variant="ghost" disabled={busy} onClick={onClose} aria-label="关闭连接设置">关闭</Button>}</header>
      <p className="connection-intro">{firstUse?'先连接公司服务端，再使用原来的账号登录。':'修改后重启生效，原连接的本机草稿会保留。'}</p>
      <nav className="connection-tabs" aria-label="连接设置分类"><Button variant={tab==='connection'?'secondary':'ghost'} aria-pressed={tab==='connection'} onClick={()=>setTab('connection')}>连接信息</Button><Button variant={tab==='tls'?'secondary':'ghost'} aria-pressed={tab==='tls'} onClick={()=>setTab('tls')}>TLS / SSL</Button></nav>
      <fieldset disabled={busy}>
        {tab==='connection'?<div className="connection-fields">
          <label htmlFor="connection-name">连接名称</label><Input id="connection-name" value={config.name} maxLength={80} onChange={e=>change({name:e.target.value})}/>
          <label htmlFor="connection-url">服务端地址</label><div><Input id="connection-url" placeholder="https://192.168.1.10:19443/" value={config.api_url} onChange={e=>change({api_url:e.target.value})} spellCheck={false}/><p className="connection-help">填写正式工作台的局域网 HTTPS 地址，无需数据库密码。</p></div>
          <span>证书方式</span><Button className="connection-link" variant="ghost" onClick={()=>setTab('tls')}>{custom?'自定义 CA 证书':'标准 HTTPS 信任'} · 修改</Button>
          <span>部署标识</span><span className="connection-detail">{config.deployment_id||'测试连接后自动识别'}</span>
        </div>:<div className="connection-tls">
          <label><input type="checkbox" checked={custom} onChange={e=>{setCustom(e.target.checked);change({ca_pem:e.target.checked?config.ca_pem:null});}}/>使用自定义 CA</label>
          <p className="connection-help">公司自建证书需要导入 CA；未勾选时使用标准 HTTPS 信任。证书验证始终开启。</p>
          {custom&&<div className="connection-certificate"><span>{config.ca_pem?'已载入 CA 证书':'尚未选择证书'}</span><Button variant="outline" onClick={()=>void choose()}>选择证书</Button></div>}
          {custom&&<p className="connection-help">选择管理员提供的 nas-ca.pem。只导入公开证书，不导入私钥。</p>}
        </div>}
      </fieldset>
      <div className="connection-result" aria-live="polite">{error?<p role="alert" className="connection-error">{error}</p>:<p>{message||'测试连接通过后即可保存。登录账号与密码在下一步填写。'}</p>}
      {tested&&switched&&<p>保存后将切换服务端；原连接的数据不会发送到新服务端。</p>}</div>
      <footer><Button variant="outline" disabled={busy} onClick={()=>void test()}>{busy?'处理中…':'测试连接'}</Button><Button disabled={busy||!tested} onClick={()=>void save()}>保存并重启</Button></footer>
    </section>
  </div>;
}
