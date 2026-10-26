/** 输出源表单只负责展示，未保存状态和校验始终归 source-editor.js 会话所有。 */
import {Button,Input,Textarea,type Row} from './editor-controls';
import {Frame,FramePanel,FrameHeader,FrameTitle} from '../components/reui/frame';
import {Badge} from '../components/reui/badge';

export function SourceEditorPanel(){return <>
 <section id="source-cost-overrides"/>
 <Frame spacing="sm"><FramePanel><div className="source-batch-bar"><strong id="source-pending">暂无待保存修改</strong><Button type="button" id="source-save-all" variant="default">保存全部更改</Button><Button type="button" id="source-discard-all">放弃全部更改</Button><p className="text-sm text-muted-foreground">切换商品会保留修改；全部编辑完成后统一保存到本机。</p></div></FramePanel></Frame>
 <div className="source-change-entry"><Button type="button" id="source-open-changes">本次变动 <span data-source-change-count="">0</span></Button><Button type="button" id="source-open-pending">待确认差异</Button></div>
 <p className="text-sm text-muted-foreground">显示名称属于当前店铺；加购集中展示三店，勾选要修改的店铺；含税核算单价按 ERP ID 与三店共用。核算价格为单件价，加购文案不计入整机成本。</p>
 <div className="source-toolbar"><Input id="source-search" type="search" placeholder="搜索显示名称、ERP ID 或加购文案" aria-label="搜索输出源"/><Button type="button" id="source-export" title="导出本店全部在用输出源，不受搜索或分页限制，包含当前未保存内容">导出本店表格</Button><Button type="button" id="source-addon-check">一键检查加购差价</Button><Button type="button" id="source-deleted">已删除</Button><Button type="button" id="source-special-list">特殊配件</Button><Button type="button" id="source-new">＋ 新增配件</Button></div>
 <div id="source-addon-report"/>
 <div className="source-workspace"><div className="source-list-panel"><div id="source-count" className="text-sm text-muted-foreground"/><div id="source-list"/><div className="source-pagination"><Button type="button" id="source-prev">上一页</Button><span id="source-page"/><Button type="button" id="source-next">下一页</Button></div></div><div id="source-detail"><p className="text-sm text-muted-foreground">从左侧选择需要维护的配件。</p></div></div>
 <div id="source-message" role="status" className="text-sm text-muted-foreground"/>
 </>;}

export function SourceEditorDetail({model:m}:{model:Row}) {
 const row=m.row;
 if(row.deletedAt)return <Frame spacing="sm"><FrameHeader><FrameTitle>{row.name}</FrameTitle></FrameHeader><FramePanel><p className="text-sm text-muted-foreground">此输出源已删除。已有配置和成本源保留，恢复后可重新选用。</p><Button type="button" id="source-restore" variant="default">恢复输出源</Button></FramePanel></Frame>;
 return <div className="source-detail-form flex flex-col gap-3">
  <div className="source-detail-heading"><h3>{m.selectedId?'编辑配件资料':'新增输出源配件'}</h3><Badge variant="info-light">{m.references} 套本店配置引用</Badge></div>
  {m.isNew&&<fieldset id="source-new-shops" className="source-new-shops"><legend>新增到店铺</legend>{m.shops.map((shop:Row)=><label key={shop.id}><Input type="checkbox" data-source-new-shop={shop.id} checked={m.targetShops.includes(shop.id)} disabled={shop.id===m.shopId}/>{shop.shortName}{shop.id===m.shopId?'（当前）':''}</label>)}<small>默认新增到三店；已有相同 ERP ID 的店铺保留原资料。</small></fieldset>}
  <label className="field"><span><Input id="source-special" type="checkbox" checked={m.special} disabled={!!m.selectedId}/>特殊配件（无 goodsId，成本及维护表导出为 0）</span></label>
  <div className="inline-grid"><label className="field">ERP ID<Input id="source-id" value={row.goodsId} readOnly={!!m.selectedId||m.special} inputMode="numeric"/></label><label className="field">ERP 单价（只读）<Input id="source-erp-price" readOnly value={m.erpPrice}/></label></div>
  <div className="text-sm text-muted-foreground" id="source-erp-status" role="status">当前为已同步价格</div><Button type="button" id="source-erp-refresh">刷新 ERP 名称与单价</Button>
  <div id="source-stock" dangerouslySetInnerHTML={{__html:m.stockHtml}}/>
  <label className="field source-field-name">本店产品显示名称<Textarea id="source-name" rows={2} value={row.name}/></label>
  <label className="field source-field-price">三店共用含税核算单价<Input id="source-tax" readOnly={m.special} type="number" min="0" step=".01" value={row.tax??''} placeholder="留空表示待核算"/></label>
  {/* 容量提示由原模块生成、读取和更新；此处不复制计算及联动规则。 */}
  <div dangerouslySetInnerHTML={{__html:m.capacityHtml}}/>
  <section className="source-addon-editor" hidden={m.special}><h4>三店加购</h4><div id="source-addon-fields"/></section>
  <small className="text-muted-foreground">更新时间：{row.updatedAt?new Date(row.updatedAt).toLocaleString():'尚未人工维护'}</small>
  <div className="source-save-actions"><Button type="button" id="source-reset">重置修改</Button><Button type="button" id="source-save" variant="default">保存全部更改</Button></div>
  <div className="source-bottom-actions"><small className="text-muted-foreground">删除后可在“已删除”中恢复</small><Button type="button" id="source-delete" variant="destructive" disabled={!m.selectedId}>删除输出源</Button></div>
 </div>;
}
