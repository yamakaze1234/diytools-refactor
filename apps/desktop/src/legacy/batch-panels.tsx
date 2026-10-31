/** 批量对话框只负责呈现；选择顺序、校验、检查点与保存沿用工作台处理函数。 */
import {Frame,FramePanel} from '@/components/reui/frame';
import {Badge} from '@/components/reui/badge';
import {Button,Input,Textarea,Select,type Row} from './editor-controls';

export function BatchDescription({model}:{model:Row}){
 return <div className="batch-description-layout compact-tool-layout">
  <div className="batch-description-toolbar">{model.hasScope&&<label className="field">修改范围<Select id="upgrade-batch-scope" value="link"><option value="link">当前链接全部配置</option><option value="selected">勾选配置（本店，可跨链接）</option></Select></label>}<div id="upgrade-batch-shortcuts"/></div>
  <p id="upgrade-batch-hint" className="hint">按配件或加购描述查找，只修改范围内符合搜索条件的逐项升级说明。手动添加的“加购与选配”、实际配置和输出源均保留。</p>
  {model.multiTask&&<section id="upgrade-batch-tasks" aria-label="加购描述修改任务"/>}
  <div className="batch-description-filters">
  <label className="field">查找原配件<Input id="upgrade-batch-query" placeholder="输入配件名称或 ERP ID"/></label>
  <label className="field">只搜索加购描述<Input id="upgrade-batch-description-query" placeholder="输入逐项升级说明关键词，可单独搜索"/></label>
  </div><div className="batch-description-body">
  <section className="batch-description-selection"><h3>选择配件</h3>
  <div id="upgrade-batch-candidates" className="global-list"/>
  </section><section className="batch-description-edit"><p className="batch-description-empty hint">从左侧选择配件后，在这里填写修改内容。</p>
  <div id="upgrade-batch-work" className="hidden">
   <details open><summary>选择影响的链接</summary><label className="global-all"><Input id="upgrade-batch-all" type="checkbox" checked/>全选关联链接</label><div id="upgrade-batch-links" className="global-list"/></details>
   <label className="field">新的配件加购描述<Textarea id="upgrade-batch-text" rows={3} placeholder="留空可清除所选配件的说明"/></label>
   <div className="batch-description-export"><label className="global-export"><Input id="upgrade-batch-export" type="checkbox"/>保存后导出配置清单图和 SKU 图</label>
   <label className="field">导出范围<Select id="upgrade-batch-export-scope" value="all"><option value="all">所选链接全部配置</option><option value="changed">仅本次有变动的配置</option></Select></label>
   </div><p className="hint">保留各套主题；桌面版保存到文件夹，网页版下载 ZIP。</p>
   <details id="upgrade-batch-diff-details"><summary>查看修改明细</summary><pre id="upgrade-batch-diff"/></details>
   <div className="compact-tool-actions"><Button id="upgrade-batch-preview" type="button">预览修改</Button><Button id="upgrade-batch-apply" type="button" variant="default" disabled>应用修改</Button></div>
  </div>
  </section></div>
  <p id="upgrade-batch-status" role="status"/>
  <Button id="upgrade-batch-retry" type="button" className="hidden">导出刚修改的链接图片</Button><Button id="upgrade-batch-undo" type="button" className="hidden">一键还原本次修改</Button>
 </div>;
}

export function BatchAppearance({model:m}:{model:Row}){
 const options=[
  ['colors','全部配色（主题、背景、文字、数量、升级说明及服务承诺）',true],
  ['format','全部编辑格式（文字框宽高与位置、字体、局部样式、模块布局、新增图片及其位置大小、顺序和显示开关）',true],
  ['images','仅同步机箱位置、大小和显示开关（已包含在全部格式内）',false],
  ['asset','批量更换机箱图片',false],
  ['addons','同步加购与选配（整组商品、数量、加购总价、描述和说明）',false],
  ['version',`同步版本（${m.reference.version||'空白版本'}）`,false],
  ['benefits','同步福利点',false],
 ] as const;
 return <div className="batch-appearance-layout compact-tool-layout">
  <p>以当前配置 <strong>{m.reference.product} / {m.reference.name}</strong> 为基准。</p>
  <label className="flex flex-col gap-2 text-sm">应用范围<Select id="style-scope" value="selected"><option value="selected">左侧已勾选 {m.selectedCount} 套</option><option value="all">全部 {m.totalCount} 套配置</option></Select></label>
  <Frame spacing="sm"><FramePanel><div className="flex flex-col gap-3">{options.map(([key,label,checked])=><label key={key} className="flex items-start gap-2 text-sm"><Input id={`style-${key}`} type="checkbox" checked={checked}/><span>{label}</span></label>)}</div></FramePanel></Frame>
  <p id="style-content-preview" className="text-sm text-muted-foreground" role="status"/>
  <div id="style-asset-panel" className="hidden"><div className="batch-case-preview"><img id="style-asset-preview" alt="将应用的机箱图片"/><span id="style-asset-name" className="hint"/></div><div className="flex flex-wrap gap-2"><Button id="style-asset-current" type="button">使用当前配置图片</Button><Button id="style-asset-upload" type="button">选择新机箱图片</Button><Input id="style-asset-file" type="file" accept="image/png,image/jpeg" hidden/></div><p className="text-sm text-muted-foreground">支持 PNG、JPG，最大 24MB。所有目标使用同一张图片；位置、大小及显示状态由全部格式或机箱格式选项控制。</p></div>
  <p className="text-sm text-muted-foreground">保留各配置的主机配件、数量、售价及 SPU/SKU。版本、加购与福利仅在勾选时替换，未勾选的文案保留。未勾选更换图片时保留原机箱素材；目标独有的文字模块和新增图片保留。两种版式的文本框与自由布局一起同步；勾选全部格式时，基准配置新增的图片也会复制到目标并保留图层顺序。</p>
  <div id="style-scope-preview" className="text-sm text-muted-foreground"/>
  <div className="flex justify-end"><Button id="style-apply" type="button" variant="default">应用到所选配置</Button></div>
 </div>;
}

export function BatchIds({model}:{model:Row}){
 return <div className="batch-ids-layout compact-tool-layout">
  <Frame spacing="sm"><FramePanel>
   <div className="flex items-center gap-2"><strong>按下方配置顺序填写</strong><Badge variant="info-light">{model.configs.length} 套配置</Badge></div>
   <ol className="mt-3 flex flex-col gap-2 text-sm">{model.configs.map((c:Row,i:number)=><li key={c.id}>{i+1}. {c.name}</li>)}</ol>
  </FramePanel></Frame>
  <label className="flex flex-col gap-2 text-sm">SPU（留空保留原值）<Input id="ids-spu" inputMode="numeric" value={model.configs[0]?.spu||''}/></label>
  <label className="flex flex-col gap-2 text-sm">SKU ID，每行一个<Textarea id="ids-values" rows={6} aria-describedby="ids-order-hint"/></label>
  <p id="ids-order-hint" className="text-sm text-muted-foreground">SKU ID 与上方配置顺序一一对应，保留完整数字；SPU 应用到这些勾选配置。</p>
  <div className="flex justify-end"><Button id="ids-apply" type="button" variant="default">核对并应用</Button></div>
 </div>;
}
