/** Single mount sync surface. Existing controller owns status leaves and native
 * checked/disabled/hidden properties; this panel never renders progress updates. */
import {Frame,FramePanel} from '@/components/reui/frame';
import {Badge} from '@/components/reui/badge';
import {Button,Input,type Row} from './editor-controls';

export function WorkspaceSyncPanel({model:m}:{model:Row}){
 const authenticated=m.mode==='authenticated';
 return <section className="flex flex-col gap-4 text-sm" aria-label="数据与同步">
  <div className="flex flex-wrap items-center justify-between gap-2"><p>选择需要同步的店铺，配置先保存在本机。</p><Badge variant={authenticated?'success-light':'outline'}>{authenticated?'成员已登录':m.mode==='local'?'本机保存':m.mode==='expired'?'登录已失效':'桌面同步'}</Badge></div>
  {m.mode==='local'&&<Frame><FramePanel><p>云同步未配置，当前使用本机保存。</p></FramePanel></Frame>}
  {m.mode==='unavailable'&&<Frame><FramePanel><p>请在 Windows 工作台中使用同步。</p></FramePanel></Frame>}
  {m.mode==='expired'&&<Frame><FramePanel className="flex flex-col items-start gap-3"><p>登录已失效，当前输入仍保留。</p><Button type="button" id="cloud-logout" variant="default">保存并重新登录</Button></FramePanel></Frame>}
  {authenticated&&<>
   <Frame><FramePanel>
    <fieldset className="min-w-0"><legend className="mb-2 font-medium">同步店铺 <span id="cloud-shop-count" className="ml-2 text-xs font-normal text-muted-foreground" aria-live="polite">已选 {m.selectedShops.length} 家</span></legend>
     <p id="cloud-selection-help" className="mb-3 text-xs text-muted-foreground">可多选，手动与自动同步使用同一选择。</p>
     <div className="grid gap-2 sm:grid-cols-3">{m.shops.map((shop:Row)=><label key={shop.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-accent">
      <Input type="checkbox" data-cloud-shop={shop.id} data-cloud-idle aria-describedby="cloud-selection-help" checked={m.selectedShops.includes(shop.id)}/>
      <span className="flex min-w-0 flex-col gap-1"><strong className="text-sm">{shop.shortName}</strong><span className="text-xs text-muted-foreground">{shop.name}</span></span>
     </label>)}</div>
    </fieldset><p className="mt-3 text-xs text-muted-foreground">公用配件成本和图库随同步更新。</p>
   </FramePanel></Frame>
   <Frame><FramePanel className="grid gap-3 sm:grid-cols-3">
    <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">最近同步</span><strong id="cloud-recent" className="text-sm"/></div>
    <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">待同步</span><strong id="cloud-pending" className="text-sm"/></div>
    <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">当前成员</span><strong className="text-sm">{m.memberName}</strong></div>
   </FramePanel></Frame>
   <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2"><Button type="button" id="cloud-sync-now" variant="default" data-cloud-idle>立即同步</Button><Button type="button" id="cloud-pause">{m.automatic?'暂停同步':'继续同步'}</Button><Button type="button" id="cloud-conflicts" data-cloud-idle hidden={!m.conflicts}>处理冲突</Button></div><span id="cloud-auto-note" className="text-xs text-muted-foreground"/></div>
  </>}
  <p id="cloud-message" role="status"/>
  <p className="text-xs text-muted-foreground">同步在后台进行，可关闭此窗口继续编辑。</p>
  <Frame><FramePanel><details><summary className="cursor-pointer font-medium">历史、缓存与诊断</summary><p className="my-3 text-xs text-muted-foreground">本机缓存每 3 天自动清理；还原和清理需等待本轮同步完成。</p><div className="flex flex-wrap gap-2">
   <Button type="button" id="local-cache">清理本机缓存</Button><Button type="button" id="offline-history">本机历史版本</Button><Button type="button" id="offline-restore">还原配置</Button><Button type="button" id="offline-legacy-history">旧版历史归档</Button><Button type="button" id="cloud-diagnostics">导出诊断日志</Button><Button type="button" id="cloud-diagnostic-text">查看诊断文本</Button>
  </div></details></FramePanel></Frame>
  <div className="flex items-center justify-between gap-3">{authenticated?<Button type="button" id="cloud-logout">退出登录</Button>:<span/>}<Button type="button" id="cloud-close">关闭</Button></div>
 </section>;
}
