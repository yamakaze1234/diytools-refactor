/** 模板区域和调用弹窗共享旧业务选择/导入逻辑，React 负责所有列表与表单节点。 */
import {Button,Input,type Row} from './editor-controls';
/** 左栏按模板显示卡片，点开后在表格里选择配置。 */
export function TemplateArea({model:m}:{model:Row}){
 return <section className="template-library-section">
  <Button id="template-section-toggle" type="button" aria-expanded={m.opened}>
   <span className="zone-arrow" aria-hidden="true"/><strong>主机模板</strong><small>{m.count} 张</small>
  </Button>
  {m.opened&&<div className="template-library-content">
   {m.cards.map((card:Row)=><Button key={card.kind+':'+card.id} type="button" className="host-template-card"
    data-template-kind={card.kind} data-template-id={card.id}
    data-template-product-toggle={card.kind==='group'?card.id:undefined}
    data-template-snapshot={card.kind==='saved'?card.id:undefined}
    data-template-platform={card.platform} data-template-color={card.color}
    data-template-dirty={card.dirty} data-template-active={card.active}>
    <span className="host-template-card-tags" aria-hidden="true"/>
    <strong title={card.name}>{card.name}</strong><small>{card.count} 套</small>
   </Button>)}
   {!m.count&&<p className="hint">本店还没有主机模板</p>}
   <div className="template-library-toolbar">
    {m.actions.map(([action,label,enabled]:[string,string,boolean])=><Button key={action} type="button" data-template-area-action={action} disabled={!enabled}>{label}</Button>)}
   </div>
  </div>}
 </section>;
}
export function TemplatePicker({model:m}:{model:Row}){return <><p className="hint">当前店铺：<strong>{m.shopName}</strong>；添加到：<strong>{m.targetName}</strong>。模板不会跨店混用，导入后使用当前链接 SPU，SKU 留空。</p><div className="compact-toolbar"><Input type="search" id="template-search" placeholder="搜索模板或配置名称" aria-label="搜索模板"/><Button id="template-expand-all">全部展开</Button><Button id="template-collapse-all">全部收起</Button></div><div id="templates-list">{m.live.length?m.live.map((t:Row)=><details className="template-card" key={t.id}><summary className="template-heading"><label><Input type="checkbox" data-template-all={t.id} aria-label={'全选模板 '+t.name}/><span><strong>{t.name}</strong><small>{t.configs.length} 套配置 · <span data-template-picked={t.id}>已选 0</span></small></span></label><Button type="button" data-template-fold="" aria-expanded="false">展开</Button><Button className="danger" data-template-delete={t.id} aria-label={'删除模板 '+t.name}>删除</Button></summary><div className="template-configs">{t.configs.map((c:Row,i:number)=><label className="template-config" key={c.id||i}><Input type="checkbox" className="template-choice" value={t.id+':'+i} data-owner={t.id} checked={c.picked}/><span>{c.label}<small>{c.parts.length} 项配件</small></span></label>)}</div></details>):<p className="hint">本店还没有模板。可以先将当前链接“整组存为模板”。</p>}</div>{m.deleted.length>0&&<details className="template-deleted"><summary>已删除模板（{m.deleted.length}）· 可恢复</summary>{m.deleted.map((t:Row)=><div className="list-card" key={t.id}><span>{t.name}</span><Button data-template-restore={t.id}>恢复</Button></div>)}</details>}<div className="actions"><span id="template-selection-count" className="hint"/><Button id="template-use" className="primary" disabled>添加所选配置</Button></div></>;}
export function TemplateSave({model:m}:{model:Row}){return <><p className="hint">保存“{m.name}”的全部 {m.count} 套配置及图片样式。调用时可以勾选其中需要的配置。</p><label className="field">模板名称<Input id="template-name" value={m.name}/></label><div className="actions"><Button id="template-save" className="primary">保存整组模板</Button></div></>;}
