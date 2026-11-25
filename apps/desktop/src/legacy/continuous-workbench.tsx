import {memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent,type KeyboardEvent,type ReactNode} from 'react';
import {useVirtualizer,defaultRangeExtractor} from '@tanstack/react-virtual';
import {Autocomplete,AutocompleteContent,AutocompleteEmpty,AutocompleteInput,AutocompleteItem,AutocompleteList} from '@/components/reui/autocomplete';
import type {Row} from './editor-controls';
import {overviewTableTotals} from '../../public/workbench/overview-table-model.js';

const integers=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
const precise=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2});
const amount=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?integers.format(value):'—';
const normalize=(value:string)=>value.normalize('NFKC').replace(/[,，\s]/g,'');
type Draft={field:'price'|'rate'|'tax';index?:number;value:number}|null;
type Position={row:number;col:0|1};
type RowSelection={slots:string[];anchor:string|null};

/** 编辑以回车或失焦提交，取消或无效输入恢复最后一次已确认的值。 */
function CommitInput({value,label,className='',fallback='',numeric=false,onCommit,onDraft,onAdvance}:
 {value:unknown;label:string;className?:string;fallback?:string;numeric?:boolean;onCommit:(value:string)=>unknown;onDraft?:(value:number|null)=>void;onAdvance?:(direction:number)=>void}){
 const node=useRef<HTMLInputElement>(null),before=useRef(''),cancelled=useRef(false),mouseSelect=useRef(false);
 const text=String(value??'');
 const advance=useRef(0);
 const displayed=numeric?(value==null?'':amount(Number(value))):text;
 const latestDisplay=useRef(displayed);latestDisplay.current=displayed;
 useLayoutEffect(()=>{if(node.current&&node.current!==document.activeElement)node.current.value=displayed;},[displayed]);
 return <input ref={node} className={className} aria-label={label} placeholder={fallback} inputMode={numeric?'decimal':undefined} defaultValue={displayed}
  onPointerDown={e=>{mouseSelect.current=e.currentTarget!==document.activeElement;}}
  onMouseUp={e=>{if(mouseSelect.current){e.preventDefault();e.currentTarget.select();mouseSelect.current=false;}}}
  onFocus={e=>{cancelled.current=false;before.current=text;e.currentTarget.value=text;e.currentTarget.select();}}
  onChange={e=>{const changed=normalize(e.currentTarget.value);onDraft?.(/^\d+(?:\.\d*)?$|^\.\d+$/.test(changed)&&Number.isFinite(Number(changed))?Number(changed):null);}}
  onKeyDown={e=>{if(e.nativeEvent.isComposing||!['Enter','Escape'].includes(e.key))return;e.preventDefault();cancelled.current=e.key==='Escape';advance.current=e.key==='Enter'?(e.shiftKey?-1:1):0;e.currentTarget.blur();}}
  onBlur={async e=>{const input=e.currentTarget,next=input.value.trim(),direction=advance.current;advance.current=0;onDraft?.(null);
   const result=!cancelled.current&&next!==before.current?await onCommit(numeric?normalize(next):next):true;
   input.value=latestDisplay.current;
   // 等异步写入和 React 局部绘制完成后，再进入同列下一条普通配件。
   if(result!==false&&direction&&onAdvance)requestAnimationFrame(()=>onAdvance(direction));
  }} />;
}

/** 总表与候选共用 ERP 标签；展示差异只在实际配件格中提示。 */
function ErpPartName({info}:{info:Row}){
 return <span className="ov-erp-name" title={info.raw||undefined}>
  {info.color&&<span className="ov-erp-color" data-color={info.color}>{info.color}</span>}
  <span>{info.main||'—'}</span>
  {info.tags?.map((tag:string)=><small key={tag} className="ov-erp-tag">{tag}</small>)}
  {info.spec&&<small className="ov-erp-spec">{info.spec}</small>}
  {info.missing&&<small className="ov-erp-spec">暂无 ERP 名称</small>}
  {info.issues?.length>0&&<small className="ov-erp-issue">⚠ {info.issues.join('；')}</small>}
 </span>;
}

const PartPicker=memo(function PartPicker({part,slot,c,model,initial,close}:{part:Row|null;slot:string;c:Row;model:Row;initial:string;close:()=>void}){
 const [query,setQuery]=useState<string>(part?.name||'');
 const [open,setOpen]=useState(false);
 const [erp,setErp]=useState<{query:string;rows:Row[];error:string}|null>(null);
 const [saving,setSaving]=useState(false);
 const pending=useRef(false);
 const hasPart=Boolean(part&&(part.name||part.goodsId||part.sourceId));
 useLayoutEffect(()=>{if(!open)setQuery(part?.name||'');},[part?.name,open]);
 const existing=useMemo(()=>{if(!open)return [];const tokens=query.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean),found:Row[]=[];for(const p of model.catalog){if(!p.deletedAt&&tokens.every(t=>p.searchText.includes(t)))found.push(p);if(found.length===50)break;}return found;},[model.catalog,query,open]);
 const erpSearch=model.erpSearch;
 useEffect(()=>{
  if(!open||query.trim().length<2||existing.length===50||!erpSearch)return;
  let current=true;
  const timer=setTimeout(async()=>{
   try{const rows=await erpSearch(query);if(current)setErp({query,rows,error:''});}
   catch{if(current)setErp({query,rows:[],error:'ERP 补充搜索暂不可用，可在 ERP 同步中设置连接。'});}
  },250);
  return()=>{current=false;clearTimeout(timer);};
 },[erpSearch,open,query,existing.length]);
 const matches=useMemo(()=>{
  const goods=new Set(model.catalog.map((row:Row)=>row.goodsId));
  return [...existing,...(erp?.query===query?erp.rows.filter(row=>!goods.has(row.goodsId)).slice(0,50-existing.length):[])];
 },[existing,erp,query,model.catalog]);
 useLayoutEffect(()=>{setQuery(initial);setOpen(true);},[initial]);
 return <Autocomplete items={matches} filteredItems={matches} value={query} open={open} onOpenChange={(next,details)=>{
  // 清空后继续保留搜索框，方便直接输入新型号。
  if(!next&&(details.reason==='input-clear'||pending.current)){details.cancel();return;}
  setOpen(next);if(!next)close();
 }} onValueChange={(value,details)=>{
  setQuery(value);
  if(value===''&&hasPart&&details.reason==='input-change')model.clearActual(c.id,slot);
 }} itemToStringValue={(p:Row)=>p.name}>
 <AutocompleteInput render={<textarea rows={1} role="combobox"/>} className="ov-part-picker" size="sm" autoFocus
  aria-label={c.name+' '+slot+' 实际配件'} placeholder="搜索型号 / ERP ID" onFocus={e=>{model.activate(c.id);if(initial===part?.name)e.currentTarget.select();}} />
 <AutocompleteContent portalContainer={model.portalContainer} className="continuous-part-popup w-[min(650px,calc(100vw-2rem))]">
 {saving&&<small role="status">正在保存本店输出源…</small>}
 <AutocompleteEmpty>{erp?.query===query&&erp.error||'没有匹配配件，请调整关键词'}</AutocompleteEmpty><AutocompleteList>
 {(p:Row)=><AutocompleteItem key={p.sourceId} value={p} className={p.erpOnly?'ov-erp-candidate':undefined} onClick={async()=>{
  if(pending.current)return;
  if(!p.erpOnly){if(model.pick(c.id,slot,true,p.sourceId))close();return;}
  pending.current=true;setSaving(true);
  try{if(await model.adoptErp(c.id,slot,p))close();}
  finally{pending.current=false;setSaving(false);}
 }}>
 <div className="continuous-candidate"><strong><ErpPartName info={model.describePart(p,null,slot)}/></strong>
 <small>GoodID {p.goodsId||'未绑定'} · ERP ¥{amount(p.erp)}{p.erpOnly?' · 未建输出源，选中后创建':` · 含税 ¥${amount(p.tax)}`}</small>
 <span className="candidate-stock" data-stock-status={p.stock.status}>{p.stock.label}</span></div></AutocompleteItem>}
 </AutocompleteList></AutocompleteContent></Autocomplete>;
});

/** 展示明细和加购自然换行，初次单击全选，再次单击可以移动光标。 */
function EditableText({value,label,placeholder,onCommit}:{value:string;label:string;placeholder?:string;onCommit:(value:string)=>void}){
 const node=useRef<HTMLDivElement>(null),original=useRef(''),cancel=useRef(false),firstClick=useRef(false);
 const select=(element:HTMLElement)=>{const range=document.createRange();range.selectNodeContents(element);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);};
 useLayoutEffect(()=>{if(node.current&&node.current!==document.activeElement)node.current.textContent=value;},[value]);
 return <div ref={node} role="textbox" tabIndex={0} aria-label={label} data-placeholder={placeholder} className="ov-editable" contentEditable="plaintext-only"
  onPointerDown={event=>{firstClick.current=event.currentTarget!==document.activeElement;}}
  onMouseUp={event=>{if(firstClick.current){event.preventDefault();select(event.currentTarget);firstClick.current=false;}}}
  onFocus={event=>{original.current=value;cancel.current=false;select(event.currentTarget);}}
  onKeyDown={event=>{if(!event.nativeEvent.isComposing&&['Enter','Escape'].includes(event.key)){event.preventDefault();cancel.current=event.key==='Escape';event.currentTarget.blur();}}}
  onBlur={event=>{const text=(event.currentTarget.innerText||'').replace(/\s+/g,' ').trim();
   event.currentTarget.textContent=value;
   if(!cancel.current&&text!==original.current)onCommit(text);
  }} />;
}

function DisplayPart({row,c,model,addons}:{row:Row;c:Row;model:Row;addons:boolean}){
 const part=row.part,slot=row.slot,name=part?.displayName||part?.name||'',hidden=part?.posterVisible===false;
 const [showEmpty,setShowEmpty]=useState(false),editor=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{if(showEmpty)editor.current?.querySelector<HTMLElement>('[contenteditable]')?.focus();},[showEmpty]);
 const sourceAction=(row.actual?.sourceId||row.actual?.goodsId||row.actual?.name||part?.sourceId||part?.goodsId||part?.name)&&
  <button className="ov-edit-source" onClick={()=>model.editSource(c.id,slot)}>修改输出源</button>;
 if(hidden)return <div className="ov-display-line"><span className="ov-missing">展示明细已隐藏</span><button onClick={()=>model.partField(c.id,slot,false,'posterVisible',true)}>恢复展示</button>{sourceAction}</div>;
 // 空描述有独立的添加入口，原有描述仍可隐藏或显示。
 const hasAddon=Boolean(String(part?.upgrade??'').trim());
 const bracketed=/^【[\s\S]*】$/.test(String(part?.upgrade??'').trim());
 const addonVisible=addons&&(hasAddon?!part.overviewAddonHidden:showEmpty);
 return <><div className="ov-display-line">
  <div className="ov-display-name"><EditableText value={name} placeholder="填写展示明细" label={slot+'展示明细'} onCommit={value=>model.partField(c.id,slot,false,'displayName',value)}/>
  {part?.qty>1&&<small>×{part.qty}</small>}</div>
  {(name||part?.upgrade)&&<button onClick={()=>model.partField(c.id,slot,false,'posterVisible',false)}>隐藏展示配件</button>}
  {!addons&&sourceAction}
 </div>
 {addons&&<div className="ov-addon-line">
  {addonVisible&&<div className="ov-addon ov-addon-bracket" ref={editor}>{!bracketed&&<span className="ov-bracket">【</span>}<EditableText value={hasAddon?part.upgrade:''} label={slot+'加购'} placeholder="填写加购描述"
    onCommit={value=>{setShowEmpty(false);model.partField(c.id,slot,false,'upgrade',value);}}/>{!bracketed&&<span className="ov-bracket">】</span>}</div>}
  <span className="ov-addon-apply">
   {sourceAction}
   {addonVisible&&hasAddon&&<><button onClick={()=>model.upgradeScope(c.id,slot,'link')}>本链接</button><button className="ov-addon-apply-all" onClick={()=>model.upgradeScope(c.id,slot,'all')}>全局</button></>}
  </span>
  <button onClick={()=>{if(!hasAddon)setShowEmpty(v=>!v);else model.partField(c.id,slot,false,'overviewAddonHidden',addonVisible);}}>
    {hasAddon?(addonVisible?'隐藏加购':'显示加购'):(showEmpty?'收起输入框':'添加加购')}</button>
 </div>}</>;
}

function HeadLine({c,model,draft,onDraft,actual,mobile=false}:{c:Row;model:Row;draft:Draft;onDraft:(draft:Draft)=>void;actual:boolean;mobile?:boolean}){
 const raw=draft?.field==='tax'&&c.raw.tax!=null?{...c.raw,tax:c.raw.tax+(draft.value-(c.rows[draft.index!].actual?.tax??0))*(c.rows[draft.index!].actual?.qty??1)}:c.raw;
 const current=overviewTableTotals(c,raw,c.pricing,{price:draft?.field==='price'?draft.value:undefined,rate:draft?.field==='rate'&&draft.value<=30?draft.value:undefined});
 const rate=draft?.field==='rate'&&draft.value<=30?draft.value:c.totals.rate;
 const terms=c.pricing.term>0, allSame=model.configs.every((config:Row)=>config.loading||config.id===c.id||config.totals.rate===c.totals.rate);
 const summaries=[['ERP总价',current.erp,'cost'],['含税总价',current.tax,'cost'],[rate+'%+100',current.fee,'fee'],['核算利润',current.taxProfit,'profit'],['ERP利润',current.erpProfit,'profit']];
 const styles=(_:unknown,value:unknown,type:unknown)=>'ov-sum ov-'+type+(type==='profit'&&Number(value)<0?' ov-loss':'');
 const controls=<div className="ov-controls"><div><label>运营费率 <CommitInput value={c.totals.rate} label={c.name+'运营费率'} className="ov-rate" onCommit={value=>model.fee(c.id,value)} onDraft={value=>onDraft(value==null?null:{field:'rate',value})}/>%</label>
  <button disabled={allSame||model.loading} onClick={()=>model.fee(c.id,c.totals.rate,true)}>应用全部</button></div>
  {terms&&<small>分期手续费 −{amount(current.interest)}</small>}</div>;
 const versions=Array.from(new Set([String(c.version||''),'标准版','进阶版','豪华版'].filter(Boolean)));
 const titleBar=<div className="ov-title-bar">{!actual&&!mobile&&controls}
    <div className="ov-config-badge"><label><input type="checkbox" aria-label={'选择'+c.name} checked={c.selected} onChange={e=>model.select(c.id,e.currentTarget.checked)}/>{c.name}</label>
    <select aria-label={c.name+'版本'} value={c.version||''} onChange={e=>model.field(c.id,'version',e.currentTarget.value)}>
     {!c.version&&<option value="">未设置</option>}{versions.map(version=><option key={version}>{version}</option>)}
    </select></div><h2>{c.shortName||c.name}</h2>
   </div>;
 const priceLabel=<>到手价<span className="ov-price-tags">{terms?' · 分期':''}{c.overviewPrice99?' · 99':''}</span></>;
 const profit=(label:unknown,value:unknown)=>label==='核算利润'||label==='ERP利润'?<CommitInput numeric className="ov-profit-input" value={value} label={c.name+label} onCommit={text=>model.targetProfit(c.id,label==='核算利润'?'tax':'erp',text)}/>:amount(value);
 const price=<span className="ov-price-box"><CommitInput numeric value={c.price} label={c.name+'到手价'} onCommit={value=>model.field(c.id,'price',value)}
  onDraft={value=>onDraft(value==null?null:{field:'price',value})}/><span className="ov-price-step"><button aria-label={c.name+'到手价增加100'} onClick={()=>model.priceStep(c.id,100)}>▲</button><button aria-label={c.name+'到手价减少100'} onClick={()=>model.priceStep(c.id,-100)}>▼</button></span></span>;
 if(mobile)return <div className="ov-mobile-head">{titleBar}{controls}<dl className="ov-mobile-sums">
  {summaries.map(([label,value,type])=><div key={String(label)} className={styles(label,value,type)}><dt>{label}</dt><dd>{profit(label,value)}</dd></div>)}
  <div className="ov-sum ov-price"><dt>{priceLabel}</dt><dd>{price}</dd></div>
 </dl></div>;
 return <thead>
  <tr className="ov-sum-labels">{summaries.map(([label,value,type])=><th key={String(label)} className={styles(label,value,type)}>{label}</th>)}
  <th className="ov-sum ov-price">{priceLabel}</th>
  {actual&&<th rowSpan={2} className="ov-dark">{controls}</th>}
  <th rowSpan={2} className="ov-dark ov-title">{titleBar}</th></tr>
  <tr className="ov-sum-values">{summaries.map(([label,value,type])=><td key={String(label)} className={styles(label,value,type)}>{profit(label,value)}</td>)}
   <td className="ov-sum ov-price">{price}</td></tr>
  <tr className="ov-columns"><th>ERP 单价</th><th>含税单价</th><th>GoodID</th><th>库存</th><th>数量</th><th>配件</th>
   {actual&&<th className="ov-name-column">实际配件</th>}<th className="ov-name-column ov-display-head">展示明细</th></tr>
 </thead>;
}

const ConfigTable=memo(function ConfigTable({c,model,actual,addons,selections}:{c:Row;model:Row;actual:boolean;addons:boolean;selections:Map<string,RowSelection>}){
 // 仅保留槽位身份，不保留配置文档或DOM；离屏卸载后仍可恢复行选区。
 const cached=selections.get(c.id);
 const [selectedSlots,setSelectedSlots]=useState<string[]>(()=>cached?.slots||[]);
 const selected=c.rows.filter((row:Row)=>selectedSlots.includes(row.slot)).map((row:Row)=>row.index) as number[];
 const rowAnchor=useRef<string|null>(cached?.anchor??c.rows[0]?.slot??null);
 const setSelected=(update:number[]|((old:number[])=>number[]))=>{
  const indexes=typeof update==='function'?update(selected):update;
  const slots=c.rows.filter((row:Row)=>indexes.includes(row.index)).map((row:Row)=>row.slot) as string[];
  selections.set(c.id,{slots,anchor:selections.get(c.id)?.anchor||null});setSelectedSlots(slots);
 };
 const [draft,setDraft]=useState<Draft>(null);
 const [range,setRange]=useState<{anchor:Position;end:Position}|null>(null);
 const [copied,setCopied]=useState<{top:number;bottom:number;left:number;right:number}|null>(null);
 const [picker,setPicker]=useState<{row:number;input:string}|null>(null);
 const dragging=useRef(false),table=useRef<HTMLTableElement>(null);
 const advance=(index:number,column:string,direction:number)=>{
  const rows=table.current?.tBodies[0]?.rows;if(!rows)return;
  for(let next=index+direction;next>=0&&next<rows.length;next+=direction){
   const part=c.rows[next].actual;
   if(!part||part.specialComponent||!part.name&&!part.goodsId&&!part.sourceId)continue;
   const input=rows[next].querySelector<HTMLInputElement>(column);
   if(input){input.focus({preventScroll:true});input.select();input.scrollIntoView({block:'nearest'});return;}
  }
 };
 const position=(target:HTMLElement)=>{const td=target.closest<HTMLElement>('[data-ov-cell]');return td?{row:Number(td.dataset.ovRow),col:Number(td.dataset.ovCell) as 0|1}:null;};
 const bounds=range&&{top:Math.min(range.anchor.row,range.end.row),bottom:Math.max(range.anchor.row,range.end.row),left:Math.min(range.anchor.col,range.end.col),right:Math.max(range.anchor.col,range.end.col)};

 // 复制框随来源选区保留；别处复制或 Escape 时清除，支持连续粘贴。
 useEffect(()=>{
  const clear=(event:Event)=>{if(event.type==='keydown'&&(event as globalThis.KeyboardEvent).key!=='Escape')return;if(event.type!=='copy'||!table.current?.contains(event.target as Node)||!event.defaultPrevented)setCopied(null);};
  document.addEventListener('copy',clear);document.addEventListener('keydown',clear);
  return()=>{document.removeEventListener('copy',clear);document.removeEventListener('keydown',clear);};
 },[]);
 function focusCell(pos:Position){
  table.current?.querySelector<HTMLElement>('[data-ov-row="'+pos.row+'"][data-ov-cell="'+pos.col+'"]')?.focus({preventScroll:true});
 }
 function startEditing(pos:Position,value?:string){
  if(pos.col===0)setPicker({row:pos.row,input:value??c.rows[pos.row].actual?.name??''});
  else{
   const input=table.current?.querySelector<HTMLInputElement>('[data-ov-row="'+pos.row+'"][data-ov-cell="1"] input');
   if(input){input.focus();if(value!==undefined)input.value=value;}
  }
 }
 function onGridKey(e:KeyboardEvent<HTMLTableElement>){
  const target=e.target as HTMLElement;
  if(!target.matches('[data-ov-cell]')||e.ctrlKey||e.metaKey||e.altKey||e.nativeEvent.isComposing)return;
  const pos=position(target)!;
  // 清空复用网格粘贴的事务和撤销记录，编辑框内按键照常输入。
  if(e.key==='Backspace'||e.key==='Delete'){
   e.preventDefault();
   const box=bounds&&pos.row>=bounds.top&&pos.row<=bounds.bottom&&pos.col>=bounds.left&&pos.col<=bounds.right?
    bounds:{top:pos.row,bottom:pos.row,left:pos.col,right:pos.col};
   const row=Array<string>(box.right-box.left+1).fill(' ').join('\t');
   model.pasteActual(c.id,box.top,box.left,Array<string>(box.bottom-box.top+1).fill(row).join('\n'));
   return;
  }
  const delta:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,1],ArrowRight:[0,-1]};
  const move=delta[e.key];
  if(move){e.preventDefault();const next={row:Math.max(0,Math.min(c.rows.length-1,pos.row+move[0])),col:Math.max(actual?0:1,Math.min(1,pos.col+move[1])) as 0|1};
   setRange(old=>({anchor:e.shiftKey&&old?old.anchor:next,end:next}));focusCell(next);
  }else if(e.key==='Process'&&pos.col===0){
   // 中文输入法起笔：先打开搜索框，让拼音直接落进框里。
   startEditing(pos,'');
  }else if(e.key==='Enter'||e.key==='F2'||e.key.length===1&&(pos.col===0||/^\d$/.test(e.key))){
   e.preventDefault();startEditing(pos,e.key.length===1?e.key:undefined);
  }
 }
 function copy(e:ClipboardEvent){
  const target=e.target as HTMLElement;
  if(target.matches('input,textarea,select'))return;
  const row=target.closest<HTMLElement>('[data-row-slot]');
  if(row){
   setCopied(null);
   const payload=model.copy(c.id,selected.length?selected:[Number(row.dataset.rowSlot)]);
   if(!payload)return;
   e.preventDefault();e.clipboardData.setData('application/x-diy-workbench-rows',JSON.stringify(payload));
   e.clipboardData.setData('text/plain',payload.rows.map((item:Row)=>[item.actual?.name||'',item.actual?.qty??1].join('\t')).join('\r\n'));
  }else if(position(target)&&bounds){
   e.preventDefault();
   const data=c.rows.slice(bounds.top,bounds.bottom+1).map((item:Row)=>[item.actual?.name||'',item.actual?.qty??1].slice(bounds.left,bounds.right+1).join('\t'));
   e.clipboardData.setData('text/plain',data.join('\r\n'));
   const sourceData=c.rows.slice(bounds.top,bounds.bottom+1).map((item:Row)=>[item.actual?.sourceId||item.actual?.name||'',item.actual?.qty??1].slice(bounds.left,bounds.right+1).join('\t'));
   e.clipboardData.setData('application/x-diy-workbench-cells',JSON.stringify({text:data.join('\r\n'),sourceText:sourceData.join('\r\n')}));
   setCopied({...bounds});
  }
 }
 // 粘贴文本：工作台内部复制带输出源 ID 时按 ID 精确对应，外部（Excel / WPS）按文本匹配。
 function pasteText(e:ClipboardEvent,row:number,col:number){
  e.preventDefault();let text=e.clipboardData.getData('text/plain');
  try{const cells=JSON.parse(e.clipboardData.getData('application/x-diy-workbench-cells'));if(cells.text===text&&typeof cells.sourceText==='string')text=cells.sourceText;}catch{}
  model.pasteActual(c.id,row,col,text);
 }
 function paste(e:ClipboardEvent){
  const target=e.target as HTMLElement;
  if(target.matches('input,textarea,select'))return;
  const pos=position(target),row=target.closest<HTMLElement>('[data-row-slot]');
  if(pos)pasteText(e,pos.row,pos.col);
  else if(row){
   const raw=e.clipboardData.getData('application/x-diy-workbench-rows');
   if(raw){e.preventDefault();try{model.paste(c.id,Number(row.dataset.rowSlot),JSON.parse(raw));}catch{model.notice('剪贴板配件数据无效');}}
   // 配件标题格按型号格处理：单列粘型号，两列粘型号和数量。
   else if(e.clipboardData.getData('text/plain'))pasteText(e,Number(row.dataset.rowSlot),0);
  }
 }
 // 逻辑列顺序为型号、数量，画面顺序相反；配件标题属于两者之间的连续选区。
 const selectionProps=(row:number,col:number)=>{
  const inside=(box:typeof copied)=>box&&row>=box.top&&row<=box.bottom&&(col===2?box.left===0&&box.right===1:col>=box.left&&col<=box.right);
  const selectedCell=inside(bounds),copiedCell=inside(copied);
  const edge=(box:NonNullable<typeof copied>,side:string)=>side==='t'?row===box.top:side==='b'?row===box.bottom:side==='l'?col===box.right:col===box.left;
  return {'data-ov-selected':selectedCell||undefined,...Object.fromEntries(['t','b','l','r'].map(side=>['data-sel-'+side,selectedCell&&edge(bounds!,side)||undefined])),
   'data-cp':copiedCell||undefined,...Object.fromEntries(['t','b','l','r'].map(side=>['data-cp-'+side,copiedCell&&edge(copied!,side)||undefined]))};
 };
 const gridProps=(row:number,col:0|1)=>({'data-ov-cell':col,'data-ov-row':row,tabIndex:0,...selectionProps(row,col)});
 const benefits=model.configurationBenefits?.(c)??[];
 return <section className="ov-config" data-continuous-config={c.id} data-active={model.active===c.id||undefined}
  onFocusCapture={()=>model.activate(c.id)} onCopy={copy} onPaste={paste}>
  {/* 单套提醒和价格页使用相同明细，恢复也回到原业务检查点。 */}
  {c.taxOverrides?.length>0&&<div className="ov-tax-reminder"><strong>本套单独核算价：{c.taxOverrides.length} 项</strong>
   <span>{c.taxOverrides.map((line:any)=>`${line.slot} ${line.value} / 共用 ${line.base??'待补基准'}`).join('；')}</span>
   <button type="button" onClick={()=>model.restoreTaxes(c.id)}>恢复本套共用价</button></div>}
  <HeadLine c={c} model={model} draft={draft} onDraft={setDraft} actual={actual} mobile/>
  {benefits.length>0&&<section className="addon-pack-overview"><strong>福利点</strong>
   {benefits.map((text:string,i:number)=><p key={i}>{text}</p>)}
  </section>}
  <table ref={table} className="ov-table" aria-label={c.name+'配置总表'}
   onPointerDown={e=>{
    const target=e.target as HTMLElement,pos=position(target);
    model.activate(c.id);
    if(!pos||target.closest('input,textarea,button'))return;
    e.preventDefault();dragging.current=true;
    setRange(old=>({anchor:e.shiftKey&&old?old.anchor:pos,end:pos}));focusCell(pos);
   }}
   onPointerMove={e=>{
    if(!dragging.current||!(e.buttons&1))return;
    const pos=position(e.target as HTMLElement);if(pos){setRange(old=>old?{anchor:old.anchor,end:pos}:{anchor:pos,end:pos});focusCell(pos);}
   }} onPointerUp={()=>{dragging.current=false;}} onPointerCancel={()=>{dragging.current=false;}}
   onDoubleClick={e=>{const pos=position(e.target as HTMLElement);if(pos)startEditing(pos);}}
   onKeyDown={onGridKey}>
   <colgroup><col className="ov-unit" span={2}/><col className="ov-good"/><col className="ov-stock"/><col className="ov-qty"/><col className="ov-slot"/>
    {actual&&<col className="ov-actual-col"/>}<col/></colgroup>
   <HeadLine c={c} model={model} draft={draft} onDraft={setDraft} actual={actual}/>
   <tbody>{c.rows.map((row:Row,index:number)=>{
    const part=row.actual,stock=part?.name||part?.goodsId||part?.specialComponent?model.stock(part):null;
    const manualTax=part&&model.manualTax?.(part);
    const changed=part&&model.different(part),global=part&&model.globalTax(part),base=changed?model.baseTax(part):null,baseline=base??part?.tax;
    const taxDraft=draft?.field==='tax'&&draft.index===index?draft.value:undefined;
    const taxDifferent=taxDraft===undefined?changed:taxDraft!==(base??part?.tax);
    const label=c.name+' '+row.slot;
    const qty=part?.qty??1,subtotal=qty>1,shownTax=taxDraft??part?.tax;
    // 单价和乘数分开排，含税单价复用原输入框和提交逻辑。
    const multiplier=<span>× {qty}</span>;
    const taxUnit=part?.goodsId&&stock?.status!=='special'?<CommitInput className="ov-tax-input" value={part.tax} label={label+'含税单价'} numeric
       onCommit={value=>model.tax(c.id,row.slot,value)} onAdvance={direction=>advance(index,'.ov-tax-input',direction)} onDraft={value=>setDraft(value==null?null:{field:'tax',index,value})}/>:amount(part?.specialComponent?0:part?.tax);
    return <tr key={row.slot} className={[row.slot==='风扇'?'ov-divider':'',subtotal?'ov-multiple-qty':''].filter(Boolean).join(' ')}>
     <td className="ov-number" data-metric="ERP 单价">{subtotal?<><span className="ov-line-total">{amount(typeof part?.erp==='number'?part.erp*qty:null)}</span><span className="ov-line-calc"><span>{amount(part?.erp)}</span>{multiplier}</span></>:amount(part?.erp)}</td>
     <td className={'ov-number ov-tax'+(taxDifferent||global||manualTax?' ov-tax-changed':'')+(global?' ov-tax-global-changed':'')} data-metric="含税单价" title={manualTax?'店铺手动核算价，同步成本表时保留':global?'全局改价：原价 '+amount(global.base)+' → '+amount(global.value)+' · '+new Date(global.at).toLocaleString('zh-CN'):taxDifferent?'原含税单价 '+(baseline==null?'—':precise.format(baseline)):undefined}>
      {subtotal&&<span className="ov-line-total">{amount(typeof shownTax==='number'?shownTax*qty:null)}</span>}
      {subtotal?<span className="ov-line-calc"><span>{taxUnit}</span>{multiplier}</span>:<span>{taxUnit}</span>}
      {manualTax&&<span className="ov-manual-tax-tag">手动价 · 同步保留</span>}
      {(taxDifferent||global)&&<div className="ov-tax-actions">{taxDifferent&&<><button className="ov-tax-global" onClick={()=>model.taxGlobal(c.id,row.slot)}>全局</button><button className="ov-tax-global ov-tax-reset" onClick={()=>model.taxReset(c.id,row.slot)}>恢复</button></>}{global&&<><span className="ov-tax-global-tag">全局</span><button className="ov-tax-global ov-tax-reset" onClick={()=>model.taxGlobalRestore(c.id,row.slot)}>全局恢复</button></>}</div>}
     </td>
     <td className="ov-number" data-metric="GoodID">{part?.goodsId||'—'}</td>
     <td className={'ov-number'+(stock?.status==='out'&&!stock.incomingLabel?' ov-stock-out':'')} data-metric="库存" title={stock?.detail}>{stock?.status==='special'?'—':stock?.value==null?(stock?'未知':'—'):amount(stock.value)}{stock?.incomingLabel&&<small className="ov-stock-incoming">{stock.incomingLabel}</small>}</td>
     <td className="ov-number ov-quantity" data-metric="数量" {...gridProps(index,1)}>
      <CommitInput value={part?.qty??1} label={label+'实际数量'} numeric onCommit={value=>model.partField(c.id,row.slot,true,'qty',value)} onAdvance={direction=>advance(index,'.ov-quantity input',direction)}/>
     </td>
     <th scope="row" {...selectionProps(index,2)}><button type="button" data-row-slot={row.index} aria-pressed={selected.includes(row.index)} onClick={e=>{
      const anchor=c.rows.find((item:Row)=>item.slot===rowAnchor.current)?.index??row.index;
      setSelected(old=>e.shiftKey?c.rows.filter((item:Row)=>item.index>=Math.min(anchor,row.index)&&item.index<=Math.max(anchor,row.index)).map((item:Row)=>item.index):e.ctrlKey||e.metaKey?old.includes(row.index)?old.filter(i=>i!==row.index):[...old,row.index]:[row.index]);
      if(!e.shiftKey){rowAnchor.current=row.slot;const saved=selections.get(c.id);if(saved)saved.anchor=row.slot;}
     }}>{row.slot}</button></th>
     {actual&&<td className="ov-actual" aria-label={label+' 实际配件'} {...gridProps(index,0)}>
      {picker?.row===index?<PartPicker part={part} slot={row.slot} c={c} model={model} initial={picker.input} close={()=>{setPicker(null);requestAnimationFrame(()=>{const active=document.activeElement;if(!active||active===document.body)focusCell({row:index,col:0});});}}/>:<span className={part?.name?'ov-actual-name':'ov-missing'}><ErpPartName info={model.describePart(part,row.part,row.slot)}/></span>}
     </td>}
     <td className="ov-display"><DisplayPart row={row} c={c} model={model} addons={addons}/></td>
    </tr>;
   })}</tbody>
  </table>
  <div className="ov-row-tools">
   <button className="ov-add-row" aria-label={c.name+' 新增配件'} onClick={()=>model.addRow(c.id)}>＋ 增加配件</button>
   <button onClick={()=>model.removeLastRow(c.id)}>－ 减少配件</button>
   <span className="ov-row-tools-gap"/>
   <button onClick={()=>model.duplicate(c.id)}>复制当前配置</button>
   <button onClick={()=>model.insertBlank(c.id)}>＋ 插入空白配置</button>
   <button className="ov-delete-config" onClick={()=>model.remove(c.id)}>删除当前配置</button>
  </div>
  {!!(c.extras.parts.length+c.extras.actualParts.length)&&<p className="ov-notice">含额外或重复槽位，原配置数据保留。</p>}
  {c.hardwareIssues?.map((issue:Row,index:number)=><p key={index} className="ov-notice">{issue.label}：{issue.message}</p>)}
 </section>;
});

/** 价格展开区挂载的就是总表卡片，选择记录随该 React root 一起释放。 */
export function ConfigurationCard({model}:{model:Row}){
 const selections=useRef(new Map<string,RowSelection>());
 const c=model.configs.find((c:Row)=>c.id===model.cardId);
 return <div className="reui-continuous">{c&&!c.loading&&<ConfigTable c={c} model={model} actual addons selections={selections.current}/>}</div>;
}

export function ContinuousWorkbench({model}:{model:Row}){
 const sheet=useRef<HTMLDivElement>(null);
 const selections=useRef(new Map<string,RowSelection>());
 // 切换链接或删除配置时清理轻量选择记录，避免长期保留已离开的配置身份。
 useEffect(()=>{const ids=new Set(model.configs.map((c:Row)=>c.id));for(const id of selections.current.keys())if(!ids.has(id))selections.current.delete(id);},[model.configs]);
 const [focusedId,setFocusedId]=useState<string|null>(null);
 const [actual,setActual]=useState(true),[addons,setAddons]=useState(true),[query,setQuery]=useState(''),[locateId,setLocateId]=useState<string|null>(null);
 const list=useMemo(()=>{const text=query.trim().toLowerCase();return text?model.configs.filter((c:Row)=>(c.name+' '+(c.shortName||'')+' '+(c.version||'')+' '+JSON.stringify(c.rows||[])).toLowerCase().includes(text)):model.configs;},[model.configs,query]);
 const virtual=list.length>6,focusedIndex=list.findIndex((c:Row)=>c.id===focusedId);
 // 大链接按整套配置测高，保留焦点所在表格。
 const rangeExtractor=useCallback((range:Parameters<typeof defaultRangeExtractor>[0])=>{const indexes=defaultRangeExtractor(range);if(focusedIndex>=0&&!indexes.includes(focusedIndex))indexes.push(focusedIndex);return indexes.sort((a,b)=>a-b);},[focusedIndex]);
 const getItemKey=useCallback((index:number)=>list[index].id,[list]);
 const virtualizer=useVirtualizer({count:list.length,getScrollElement:()=>sheet.current,estimateSize:()=>780,getItemKey,overscan:1,rangeExtractor,enabled:virtual});
 // 换链接时定位到新链接的编辑项，清掉上一链接的搜索和滚动位置。
 useLayoutEffect(()=>{setQuery('');setLocateId(model.active??null);},[model.productId]);
 useLayoutEffect(()=>{
  const host=sheet.current?.closest('#continuous-workbench');if(!host)return;
  const locate=(event:Event)=>{setQuery('');setLocateId((event as CustomEvent<string>).detail);};
  host.addEventListener('workbench-locate-config',locate);return()=>host.removeEventListener('workbench-locate-config',locate);
 },[]);
 useLayoutEffect(()=>{
  const node=sheet.current;if(!node||!locateId)return;
  if(virtual){const index=list.findIndex((c:Row)=>c.id===locateId);if(index>=0)virtualizer.scrollToIndex(index,{align:'start',behavior:'auto'});setLocateId(null);return;}
  const target=[...node.querySelectorAll<HTMLElement>('[data-continuous-config]')].find(item=>item.dataset.continuousConfig===locateId);
  if(target){node.scrollTo({top:node.scrollTop+target.getBoundingClientRect().top-node.getBoundingClientRect().top-2,left:0});setLocateId(null);}
 },[locateId,list,virtual,virtualizer]);
 const renderConfig=(c:Row):ReactNode=>c.loading?<p role="status">正在加载 {c.name}</p>:<ConfigTable c={c} model={model} actual={actual} addons={addons} selections={selections.current}/>;
 return <div className="reui-continuous" onKeyDown={event=>{
  // 表内快捷键复用配置撤销，输入框和可编辑文字保留浏览器自己的撤销。
  const target=event.target;
  if(event.defaultPrevented||event.nativeEvent.isComposing||!event.ctrlKey||event.altKey||event.shiftKey||event.metaKey||event.key.toLowerCase()!=='z')return;
  if(!(target instanceof HTMLElement)||target.isContentEditable||target.closest('input, textarea, select'))return;
  event.preventDefault();
  if(!event.repeat&&model.canUndo)model.undo();
 }}>
  <div className="ov-toolbar">
   <div className="ov-search"><input type="search" aria-label="筛选当前链接配置" placeholder="搜索当前链接配置 / 配件名称" value={query} onChange={e=>setQuery(e.currentTarget.value)}/></div>
   <div className="ov-history" role="group" aria-label="配置总表编辑记录">
    <button type="button" title="撤销（Ctrl+Z）" aria-keyshortcuts="Control+Z" disabled={!model.canUndo} onClick={model.undo}>撤销</button>
    <button type="button" disabled={!model.canRedo} onClick={model.redo}>重做</button>
   </div>
   <label><input type="checkbox" checked={actual} onChange={e=>setActual(e.currentTarget.checked)}/>实际配件</label>
   <label><input type="checkbox" checked={addons} onChange={e=>setAddons(e.currentTarget.checked)}/>显示加购</label>
   <label title={model.term===null?'当前链接分期设置不一致':'整链开启按 24 期、到手价 10% 计算'}><input type="checkbox" disabled={model.loading} checked={model.term>0} onChange={e=>model.installment(e.currentTarget.checked)}/>整链分期（10%）</label>
   <label className="ov-price99"><input type="checkbox" disabled={model.loading} checked={model.price99On} onChange={e=>model.price99(e.currentTarget.checked)}/>整链取 99</label>
  </div>
  <p className="ov-hint">实际配件和数量可双击或键入编辑，删空型号即清除。用 <kbd>Shift</kbd> 选区，两列粘贴点数量格、配件格或实际配件格均可。</p>
  {model.error&&<p role="alert">{model.error} <button onClick={()=>model.retry()}>重试加载</button></p>}
  {!list.length&&<p>没有匹配的配置 <button onClick={()=>setQuery('')}>清空搜索</button></p>}
  <div ref={sheet} className="ov-sheet-scroll" data-product-id={model.productId} data-last-configuration={list.at(-1)?.id} aria-label="连续配置表" tabIndex={0}
   onFocusCapture={event=>setFocusedId((event.target as HTMLElement).closest<HTMLElement>('[data-continuous-config]')?.dataset.continuousConfig||null)}
   onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocusedId(null);}}>
   <div className="ov-content" style={virtual?{height:virtualizer.getTotalSize(),position:'relative'}:undefined}>
    {virtual?virtualizer.getVirtualItems().map(item=><div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{position:'absolute',top:0,left:0,width:'100%',transform:'translateY('+item.start+'px)'}}>{renderConfig(list[item.index])}</div>):list.map((c:Row)=><div key={c.id}>{renderConfig(c)}</div>)}
   </div>
  </div>
 </div>;
}
