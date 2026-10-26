/** 图库仅迁移展示节点；上传、引用、草稿、软删除与持久化仍由原控制器管理。 */
import {Button,Input,type Row} from './editor-controls';
import {Frame,FramePanel,FrameHeader,FrameTitle} from '../components/reui/frame';
import {Badge} from '../components/reui/badge';

export function CaseGalleryPanel({model:m}:{model:Row}) {return <div className="flex min-h-0 flex-1 flex-col gap-4" data-reui-gallery="">
 <div className="gallery-toolbar"><label className="gallery-search"><span>搜索图库</span><Input id="gallery-search" type="search" placeholder="品牌、型号、颜色、版本或图片名称" aria-label="搜索机箱图片"/></label><Button type="button" id="gallery-trash">回收站</Button><Button type="button" id="gallery-new" variant="default">＋ 新增图片</Button></div>
 <p className="text-sm text-muted-foreground">三店共用 · 按品牌 / 型号 / 颜色 / 版本分类{m.pick?(m.append?' · 选图后添加为独立图片，可拖动和缩放':' · 选图后保留当前配置的位置和大小'):''}</p>
 <div className="gallery-layout"><nav id="gallery-tree" aria-label="机箱图片分类"/><section className="gallery-results"><div id="gallery-count" role="status"/><div id="gallery-grid"/><div className="source-pagination"><Button type="button" id="gallery-prev">上一页</Button><span id="gallery-page"/><Button type="button" id="gallery-next">下一页</Button></div></section><aside id="gallery-detail"/></div>
 <p id="gallery-status" className="text-sm text-muted-foreground" role="status"/>
 </div>;}

export function CaseGalleryGrid({model:m}:{model:Row}) {return <>{m.rows.length?m.rows.map((row:Row)=><article key={row.id} className={'gallery-card '+(m.selected===row.id?'selected':'')}>
 <button type="button" className="gallery-card-open" data-gallery-open={row.id} aria-label={'查看 '+row.name}><img crossOrigin="anonymous" src={row.resolvedUrl} alt={row.name} loading="lazy" decoding="async"/><strong>{row.name}</strong><small>{row.path.join(' / ')}</small></button>
 <div className="gallery-card-footer"><Badge variant="info-light">{row.usageCount} 套配置使用</Badge>{m.pick&&!m.trash&&<Button type="button" variant="default" data-gallery-use={row.id}>使用图片</Button>}</div>
 </article>):<div className="gallery-empty"><strong>{m.query?'没有找到匹配图片':m.trash?'回收站为空':'这个分类还没有图片'}</strong><p>{m.query?'试试其他型号、颜色或版本关键词。':'点击右上角“新增图片”，上传后供三店选用。'}</p></div>}</>;}

export function CaseGalleryDetail({model:m}:{model:Row}) {
 if(m.draft){const draft=m.draft;return <Frame spacing="xs"><FrameHeader><FrameTitle>{draft.id?'编辑图片资料':'新增机箱图片'}</FrameTitle></FrameHeader><FramePanel><div className="gallery-detail-form">
  {!draft.id&&<label className="field gallery-upload-field"><span>上传图片 <small>PNG / JPG · 最大 24MB</small></span><Input id="gallery-file" type="file" accept="image/png,image/jpeg"/></label>}
  <img id="gallery-upload-preview" className={'gallery-detail-image '+(m.previewUrl?'':'hidden')} alt="待保存图片预览" src={m.previewUrl||undefined}/>
  <div className="gallery-metadata-grid"><label className="field gallery-name-field">图片名称<Input id="gallery-name" maxLength={160} value={draft.name||''} placeholder="例如：X400CG 黑色进阶主图"/></label>
  {m.fields.map((field:string,i:number)=><label className="field" key={field}>{['品牌','型号','颜色','版本'][i]}<Input data-gallery-field={field} maxLength={80} value={draft[field]||''} placeholder={['乔思伯','X400CG','黑色 / 白色','进阶 / 豪华 / 通用'][i]} list={'gallery-values-'+field}/><datalist id={'gallery-values-'+field}>{m.values[field].map((value:string)=><option key={value} value={value}/>)}</datalist></label>)}
  </div><p id="gallery-upload-status" className="gallery-upload-status" role="status" aria-live="polite"/><div className="gallery-detail-actions"><Button type="button" id="gallery-save" variant="default">保存图片</Button><Button type="button" id="gallery-cancel">取消</Button></div>
 </div></FramePanel></Frame>;}
 const row=m.row;
 if(!row)return <div className="gallery-empty"><strong>图片资料</strong><p>点击图片查看分类和使用情况，或新增机箱图片。</p></div>;
 return <Frame spacing="xs"><FrameHeader><FrameTitle>{row.name}</FrameTitle></FrameHeader><FramePanel><div className="gallery-detail-form">
  <img className="gallery-detail-image" src={row.url} alt={row.name}/><p className="gallery-path">{m.path.join(' / ')}</p>
  <p className="text-sm text-muted-foreground">维护人：{row.operator||'已有素材'}<br/>{row.updatedAt?new Date(row.updatedAt).toLocaleString('zh-CN'):'从现有配置收录'}</p>
  <details className="gallery-usage"><summary>{m.uses.length} 套配置使用此图片</summary>{m.uses.slice(0,30).map((c:Row,i:number)=><p key={c.id||i}>{c.shop||c.shopId||''} · {c.product||''} / {c.name}</p>)}{m.uses.length>30&&<p>其余配置继续保留引用。</p>}</details>
  <div className="gallery-detail-actions">{row.deletedAt?<Button type="button" id="gallery-restore" variant="default">恢复图片</Button>:<>{m.pick&&<Button type="button" id="gallery-pick" variant="default">使用这张图片</Button>}<Button type="button" id="gallery-edit">编辑资料</Button><Button type="button" id="gallery-delete" variant="destructive">删除图片</Button></>}</div>
  <div id="gallery-delete-confirm"/>
 </div></FramePanel></Frame>;
}

export function CaseGalleryDelete(){return <div className="gallery-confirm"><strong>将这张图片移入回收站？</strong><p>已有配置和模板仍保留原图，可随时恢复。</p><div className="flex flex-wrap gap-2"><Button type="button" id="gallery-delete-yes" variant="destructive">确认移入回收站</Button><Button type="button" id="gallery-delete-no">取消</Button></div></div>;}
