/** 批量配件界面只接管节点；范围、计划、校验、保存与导出均由 link-parts.js 驱动。 */
import {Button,Input,Select,type Row} from './editor-controls';
import {Frame,FramePanel,FrameHeader,FrameTitle} from '../components/reui/frame';
import {Badge} from '../components/reui/badge';

export function LinkPartsPanel({model}:{model:Row}) {
 return <div className="link-parts-layout" data-reui-link-parts="">
  <p className="text-sm text-muted-foreground"><strong>{model.product.name}</strong> · 可添加多条规则，按列表顺序执行。查找替换时，未选择新配件即删除原配件；统一预览后保存。</p>
  <section className="link-parts-scope" aria-label="修改范围">
   <label className="field">修改范围<Select id="link-part-scope" value="link"><option value="link">当前链接全部配置</option><option value="selected">按左侧勾选配置修改（本店，可跨链接）</option></Select></label>
   <div className="flex flex-wrap gap-4" role="group" aria-label="修改内容"><label className="flex items-center gap-2"><Input id="link-part-display" type="checkbox" checked/>展示配件</label><label className="flex items-center gap-2"><Input id="link-part-actual" type="checkbox" checked/>实际配件</label></div>
   <p id="link-part-scope-summary" className="text-sm text-muted-foreground"/>
  </section>
  <div id="link-part-rules" className="flex flex-col gap-3"/>
  <div className="flex flex-wrap gap-2"><Button type="button" id="link-part-add-replace">＋ 查找替换</Button><Button type="button" id="link-part-add-new">＋ 新增配件</Button></div>
  <div className="link-part-preview-bar flex flex-wrap items-center gap-3"><Button type="button" id="link-part-preview">预览全部修改</Button><Button type="button" id="link-part-apply" variant="default" disabled>应用到本链接</Button><label className="flex items-center gap-2"><Input id="link-part-show-all" type="checkbox"/>显示全部配件</label></div>
  <p id="link-part-status" role="status" aria-live="polite" className="text-sm"/>
  <div id="link-part-diff"><p className="text-sm text-muted-foreground">设置规则后，点击“预览全部修改”查看各配置的修改前后总览。</p></div>
  <section id="link-part-export-panel" className="hidden">
   <Frame spacing="sm"><FrameHeader><FrameTitle>导出本次修改的链接图片</FrameTitle></FrameHeader><FramePanel><div className="flex flex-col gap-3">
    <p id="link-part-export-summary" className="text-sm text-muted-foreground"/>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="field">导出范围<Select id="link-part-export-scope" value="changed"><option value="changed">仅本次有变动的配置</option><option value="all">有变动链接内全部配置</option></Select></label><label className="field">图片类型<Select id="link-part-export-kind" value="both"><option value="long">配置清单图</option><option value="square">SKU 图</option><option value="both">配置清单图和 SKU 图</option></Select></label></div>
    <div className="flex flex-wrap gap-2"><Button type="button" id="link-part-export">导出已保存配置图片</Button><Button type="button" id="link-part-export-cancel" className="hidden">取消导出</Button></div>
    <p className="text-sm text-muted-foreground">按所选范围导出已保存配置，默认仅导出本次有变动的配置。后续编辑不影响本次导出；图片保留链接内序号。可重新选择范围和类型再次导出。</p>
   </div></FramePanel></Frame>
  </section>
 </div>;
}

export function LinkPartsRule({model}:{model:Row}) {
 const id=(name:string)=>`link-part-${name}${model.suffix}`;
 // 外层规则已提供边框，避免再嵌套容器和拉伸字段。
 return <>
  <header className="link-part-rule-heading"><strong data-rule-title=""/><Button type="button" data-rule-remove="">移除</Button></header>
  <div className="link-part-rule-grid">
   <label className="field">操作<Select id={id('mode')} data-rule-mode="" value="replace"><option value="replace">查找替换配件</option><option value="add">新增配件</option></Select></label>
   <div id={id('old')} data-rule-old="" className="flex flex-col gap-2"><label className="field">查找原配件<Input id={id('query')} data-rule-query="" placeholder="配件名称或 ERP ID"/></label><Select id={id('match')} data-rule-match="" aria-label="原配件" value=""><option value="">请选择原配件</option></Select></div>
   <div id={id('new')} data-rule-new=""/>
   <label id={id('slot-field')} className="field hidden" data-rule-slot-field="">添加到槽位<Select id={id('slot')} data-rule-slot="" value={model.slots[0]}>{model.slots.map((slot:string)=><option key={slot}>{slot}</option>)}</Select></label>
   <label className="field">数量<Input id={id('qty')} data-rule-qty="" type="number" min="1" step="1" placeholder="留空保留原数量"/></label>
  </div>
 </>;
}

export function LinkPartsOverview({model}:{model:Row}) {
 const partText=(part:Row|null)=>part&&(part.name||part.goodsId)?`${part.displayName||part.name||'未命名'} ×${part.qty??1}`:'空';
 return <div className="flex flex-col gap-3">
  <h3>修改结果总览</h3><p className="text-sm text-muted-foreground">{model.summary}</p>
  <div className="flex flex-wrap gap-2">{model.rules.map((rule:Row,i:number)=><Badge key={i} variant="info-light">规则 {i+1} · {rule.mode==='add'?'新增':rule.mode==='delete'?'删除':'替换'} {rule.name}：{rule.count} 套</Badge>)}</div>
  {model.rows.length?<div className="link-part-overview-wrap" tabIndex={0} aria-label="修改结果总览"><table className="link-part-overview"><thead><tr>{['配置','修改内容','槽位','修改前','修改后'].map(title=><th key={title}>{title}</th>)}</tr></thead><tbody>{model.rows.map((row:Row,index:number)=><tr key={`${row.id}:${row.field}:${row.slot}:${index}`} className={row.changed?'is-changed':''}><th scope="row">{row.name}<small>{row.product}</small></th><td>{row.field==='parts'?'展示配件':'实际配件'}</td><td>{row.slot}</td><td>{partText(row.before)}<small>{row.before?.goodsId?'ERP ID '+row.before.goodsId:''}</small></td><td>{row.after?partText(row.after):'删除'}<small>{row.after?.goodsId?'ERP ID '+row.after.goodsId:''}{row.changed?' · 已修改':''}</small></td></tr>)}</tbody></table></div>:<p className="text-sm text-muted-foreground">没有需要修改的配件。可勾选“显示全部配件”查看当前配置。</p>}
 </div>;
}
