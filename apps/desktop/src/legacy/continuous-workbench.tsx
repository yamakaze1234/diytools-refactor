import {memo,useCallback,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent,type KeyboardEvent,type ReactNode} from 'react';
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

/** 编辑以回车或失焦提交，取消或无效输入恢复最后一次已确认的值。 */
function CommitInput({value,label,className='',fallback='',numeric=false,onCommit,onDraft}:
 {value:unknown;label:string;className?:string;fallback?:string;numeric?:boolean;onCommit:(value:string)=>unknown;onDraft?:(value:number|null)=>void}){
 const node=useRef<HTMLInputElement>(null),before=useRef(''),cancelled=useRef(false),mouseSelect=useRef(false);
 const text=String(value??'');
 const displayed=numeric?(value==null?'':amount(Number(value))):text;
 useLayoutEffect(()=>{if(node.current&&node.current!==document.activeElement)node.current.value=displayed;},[displayed]);
 return <input ref={node} className={className} aria-label={label} placeholder={fallback} inputMode={numeric?'decimal':undefined} defaultValue={displayed}
  onPointerDown={e=>{mouseSelect.current=e.currentTarget!==document.activeElement;}}
  onMouseUp={e=>{if(mouseSelect.current){e.preventDefault();e.currentTarget.select();mouseSelect.current=false;}}}
  onFocus={e=>{cancelled.current=false;before.current=text;e.currentTarget.value=text;e.currentTarget.select();}}
  onChange={e=>{const changed=normalize(e.currentTarget.value);onDraft?.(/^\d+(?:\.\d*)?$|^\.\d+$/.test(changed)&&Number.isFinite(Number(changed))?Number(changed):null);}}
  onKeyDown={e=>{if(e.nativeEvent.isComposing||!['Enter','Escape'].includes(e.key))return;e.preventDefault();cancelled.current=e.key==='Escape';e.currentTarget.blur();}}
  onBlur={e=>{const next=e.currentTarget.value.trim();onDraft?.(null);
   if(!cancelled.current&&next!==before.current)onCommit(numeric?normalize(next):next);
   e.currentTarget.value=displayed;
  }} />;
}

const PartPicker=memo(function PartPicker({part,slot,c,model,initial,close}:{part:Row|null;slot:string;c:Row;model:Row;initial:string;close:()=>void}){
 const [query,setQuery]=useState<string>(part?.name||'');
 const [open,setOpen]=useState(false);
 const hasPart=Boolean(part&&(part.name||part.goodsId||part.sourceId));
 useLayoutEffect(()=>{if(!open)setQuery(part?.name||'');},[part?.name,open]);
 const matches=useMemo(()=>{if(!open)return [];const tokens=query.trim().toLowerCase().split(/\s+/).filter(Boolean),found:Row[]=[];for(const p of model.catalog){if(!p.deletedAt&&tokens.every(t=>p.searchText.includes(t)))found.push(p);if(found.length===50)break;}return found;},[model.catalog,query,open]);
 useLayoutEffect(()=>{setQuery(initial);setOpen(true);},[initial]);
 return <Autocomplete items={matches} filteredItems={matches} value={query} open={open} onOpenChange={(next,details)=>{
  // 清空后继续保留搜索框，方便直接输入新型号。
  if(!next&&hasPart&&details.reason==='input-clear'){details.cancel();return;}
  setOpen(next);if(!next)close();
 }} onValueChange={(value,details)=>{
  setQuery(value);
  if(value===''&&hasPart&&details.reason==='input-change')model.clearActual(c.id,slot);
 }} itemToStringValue={(p:Row)=>p.name}>
 <AutocompleteInput render={<textarea rows={1} role="combobox"/>} className="ov-part-picker" size="sm" autoFocus
  aria-label={c.name+' '+slot+' 实际配件'} placeholder="搜索型号 / ERP ID" onFocus={e=>{model.activate(c.id);if(initial===part?.name)e.currentTarget.select();}} />
 <AutocompleteContent portalContainer={model.portalContainer} className="continuous-part-popup w-[min(650px,calc(100vw-2rem))]">
 <AutocompleteEmpty>没有匹配配件，请调整关键词</AutocompleteEmpty><AutocompleteList>
 {(p:Row)=><AutocompleteItem key={p.sourceId} value={p} onClick={()=>{model.pick(c.id,slot,true,p.sourceId);close();}}>
 <div className="continuous-candidate"><strong>{p.name}</strong><small>GoodID {p.goodsId||'未绑定'} · ERP ¥{amount(p.erp)} · 含税 ¥{amount(p.tax)}</small>
 <span className="candidate-stock" data-stock-status={p.stock.status}>ERP 可销库存：{p.stock.label}</span></div></AutocompleteItem>}
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
 if(hidden)return <div className="ov-display-line"><span className="ov-missing">展示明细已隐藏</span><button onClick={()=>model.partField(c.id,slot,false,'posterVisible',true)}>恢复展示</button></div>;
 // 空描述有独立的添加入口，原有描述仍可隐藏或显示。
 const hasAddon=Boolean(String(part?.upgrade??'').trim());
 const addonVisible=addons&&(hasAddon?!part.overviewAddonHidden:showEmpty);
 return <><div className="ov-display-line">
  <div className="ov-display-name"><EditableText value={name} placeholder="填写展示明细" label={slot+'展示明细'} onCommit={value=>model.partField(c.id,slot,false,'displayName',value)}/>
  {part?.qty>1&&<small>×{part.qty}</small>}</div>
  {(name||part?.upgrade)&&<button onClick={()=>model.partField(c.id,slot,false,'posterVisible',false)}>隐藏展示配件</button>}
 </div>
 {addons&&<div className="ov-addon-line">
  {addonVisible&&<div className="ov-addon" ref={editor}><EditableText value={hasAddon?part.upgrade:''} label={slot+'加购'} placeholder="填写加购描述"
    onCommit={value=>{setShowEmpty(false);model.partField(c.id,slot,false,'upgrade',value);}}/></div>}
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
 const priceLabel='到手价'+(terms?' · 分期':'');
 const price=<CommitInput numeric value={c.price} label={c.name+'到手价'} onCommit={value=>model.field(c.id,'price',value)}
  onDraft={value=>onDraft(value==null?null:{field:'price',value})}/>;
 if(mobile)return <div className="ov-mobile-head">{titleBar}{controls}<dl className="ov-mobile-sums">
  {summaries.map(([label,value,type])=><div key={String(label)} className={styles(label,value,type)}><dt>{label}</dt><dd>{amount(value)}</dd></div>)}
  <div className="ov-sum ov-price"><dt>{priceLabel}</dt><dd>{price}</dd></div>
 </dl></div>;
 return <thead>
  <tr className="ov-sum-labels">{summaries.map(([label,value,type])=><th key={String(label)} className={styles(label,value,type)}>{label}</th>)}
  <th className="ov-sum ov-price">{priceLabel}</th>
  {actual&&<th rowSpan={2} className="ov-dark">{controls}</th>}
  <th rowSpan={2} className="ov-dark ov-title">{titleBar}</th></tr>
  <tr className="ov-sum-values">{summaries.map(([label,value,type])=><td key={String(label)} className={styles(label,value,type)}>{amount(value)}</td>)}
   <td className="ov-sum ov-price">{price}</td></tr>
  <tr className="ov-columns"><th>ERP 单价</th><th>含税单价</th><th>GoodID</th><th>库存</th><th>数量</th><th>配件</th>
   {actual&&<th className="ov-name-column">实际配件</th>}<th className="ov-name-column ov-display-head">展示明细</th></tr>
 </thead>;
}

const ConfigTable=memo(function ConfigTable({c,model,actual,addons}:{c:Row;model:Row;actual:boolean;addons:boolean}){
 const [selected,setSelected]=useState<number[]>([]),rowAnchor=useRef(0);
 const [draft,setDraft]=useState<Draft>(null);
 const [range,setRange]=useState<{anchor:Position;end:Position}|null>(null);
 const [picker,setPicker]=useState<{row:number;input:string}|null>(null);
 const dragging=useRef(false),table=useRef<HTMLTableElement>(null);
 const position=(target:HTMLElement)=>{const td=target.closest<HTMLElement>('[data-ov-cell]');return td?{row:Number(td.dataset.ovRow),col:Number(td.dataset.ovCell) as 0|1}:null;};
 const bounds=range&&{top:Math.min(range.anchor.row,range.end.row),bottom:Math.max(range.anchor.row,range.end.row),left:Math.min(range.anchor.col,range.end.col),right:Math.max(range.anchor.col,range.end.col)};
 const chosen=(row:number,col:number)=>bounds&&row>=bounds.top&&row<=bounds.bottom&&col>=bounds.left&&col<=bounds.right;
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
  const delta:Record<string,[number,number]>={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,1],ArrowRight:[0,-1]};
  const move=delta[e.key];
  if(move){e.preventDefault();const next={row:Math.max(0,Math.min(c.rows.length-1,pos.row+move[0])),col:Math.max(actual?0:1,Math.min(1,pos.col+move[1])) as 0|1};
   setRange(old=>({anchor:e.shiftKey&&old?old.anchor:next,end:next}));focusCell(next);
  }else if(e.key==='Enter'||e.key==='F2'||e.key.length===1&&(pos.col===0||/^\d$/.test(e.key))){
   e.preventDefault();startEditing(pos,e.key.length===1?e.key:undefined);
  }
 }
 function copy(e:ClipboardEvent){
  const target=e.target as HTMLElement;
  if(target.matches('input,textarea,select'))return;
  const row=target.closest<HTMLElement>('[data-row-slot]');
  if(row){
   const payload=model.copy(c.id,selected.length?selected:[Number(row.dataset.rowSlot)]);
   if(!payload)return;
   e.preventDefault();e.clipboardData.setData('application/x-diy-workbench-rows',JSON.stringify(payload));
   e.clipboardData.setData('text/plain',payload.rows.map((item:Row)=>[item.actual?.name||'',item.actual?.qty??1].join('\t')).join('\r\n'));
  }else if(position(target)&&bounds){
   e.preventDefault();
   const data=c.rows.slice(bounds.top,bounds.bottom+1).map((item:Row)=>[item.actual?.name||'',item.actual?.qty??1].slice(bounds.left,bounds.right+1).join('\t'));
   e.clipboardData.setData('text/plain',data.join('\r\n'));
  }
 }
 function paste(e:ClipboardEvent){
  const target=e.target as HTMLElement;
  if(target.matches('input,textarea,select'))return;
  const pos=position(target),row=target.closest<HTMLElement>('[data-row-slot]');
  if(pos){e.preventDefault();model.pasteActual(c.id,pos.row,pos.col,e.clipboardData.getData('text/plain'));}
  else if(row){
   const raw=e.clipboardData.getData('application/x-diy-workbench-rows');
   if(raw){e.preventDefault();try{model.paste(c.id,Number(row.dataset.rowSlot),JSON.parse(raw));}catch{model.notice('剪贴板配件数据无效');}}
  }
 }
 const gridProps=(row:number,col:0|1)=>({'data-ov-cell':col,'data-ov-row':row,tabIndex:0,'data-ov-selected':chosen(row,col)||undefined});
 return <section className="ov-config" data-continuous-config={c.id} data-active={model.active===c.id||undefined}
  onFocusCapture={()=>model.activate(c.id)} onCopy={copy} onPaste={paste}>
  <HeadLine c={c} model={model} draft={draft} onDraft={setDraft} actual={actual} mobile/>
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
    const changed=part&&model.different(part),base=changed?model.baseTax(part):null,baseline=base??part?.tax;
    const taxDraft=draft?.field==='tax'&&draft.index===index?draft.value:undefined;
    const taxDifferent=taxDraft===undefined?changed:taxDraft!==(base??part?.tax);
    const label=c.name+' '+row.slot;
    return <tr key={row.slot} className={row.slot==='风扇'?'ov-divider':''}>
     <td className="ov-number" data-metric="ERP 单价">{amount(part?.erp)}</td>
     <td className={'ov-number ov-tax'+(taxDifferent?' ov-tax-changed':'')} data-metric="含税单价" title={taxDifferent?'原含税单价 '+(baseline==null?'—':precise.format(baseline)):undefined}>
      {part?.goodsId&&stock?.status!=='special'?<CommitInput className="ov-tax-input" value={part.tax} label={label+'含税单价'} numeric
       onCommit={value=>model.tax(c.id,row.slot,value)} onDraft={value=>setDraft(value==null?null:{field:'tax',index,value})}/>:amount(part?.tax)}
     </td>
     <td className="ov-number" data-metric="GoodID">{part?.goodsId||'—'}</td>
     <td className={'ov-number'+(stock?.status==='out'?' ov-stock-out':'')} data-metric="库存" title={stock?.detail}>{stock?.status==='special'?'—':stock?.value==null?(stock?'未知':'—'):amount(stock.value)}</td>
     <td className="ov-number ov-quantity" data-metric="数量" {...gridProps(index,1)}>
      <CommitInput value={part?.qty??1} label={label+'实际数量'} numeric onCommit={value=>model.partField(c.id,row.slot,true,'qty',value)}/>
     </td>
     <th scope="row"><button type="button" data-row-slot={row.index} aria-pressed={selected.includes(row.index)} onClick={e=>{
      setSelected(old=>e.shiftKey?c.rows.filter((item:Row)=>item.index>=Math.min(rowAnchor.current,row.index)&&item.index<=Math.max(rowAnchor.current,row.index)).map((item:Row)=>item.index):e.ctrlKey||e.metaKey?old.includes(row.index)?old.filter(i=>i!==row.index):[...old,row.index]:[row.index]);
      if(!e.shiftKey)rowAnchor.current=row.index;
     }}>{row.slot}</button></th>
     {actual&&<td className="ov-actual" aria-label={label+' 实际配件'} {...gridProps(index,0)}>
      {picker?.row===index?<PartPicker part={part} slot={row.slot} c={c} model={model} initial={picker.input} close={()=>setPicker(null)}/>:<span className={part?.name?'ov-actual-name':'ov-missing'}>{part?.name||'—'}</span>}
     </td>}
     <td className="ov-display"><DisplayPart row={row} c={c} model={model} addons={addons}/></td>
    </tr>;
   })}</tbody>
  </table>
  <button className="ov-add-row" aria-label={c.name+' 新增配件'} onClick={()=>model.addRow(c.id)}>＋ 新增配件</button>
  {!!(c.extras.parts.length+c.extras.actualParts.length)&&<p className="ov-notice">含额外或重复槽位，原配置数据保留。</p>}
  {c.hardwareIssues?.map((issue:Row,index:number)=><p key={index} className="ov-notice">{issue.label}：{issue.message}</p>)}
 </section>;
});

export function ContinuousWorkbench({model}:{model:Row}){
 const sheet=useRef<HTMLDivElement>(null);
 const [focusedId,setFocusedId]=useState<string|null>(null);
 const [actual,setActual]=useState(true),[addons,setAddons]=useState(true),[query,setQuery]=useState(''),[locateId,setLocateId]=useState<string|null>(null);
 const list=useMemo(()=>{const text=query.trim().toLowerCase();return text?model.configs.filter((c:Row)=>(c.name+' '+(c.shortName||'')+' '+(c.version||'')+' '+JSON.stringify(c.rows||[])).toLowerCase().includes(text)):model.configs;},[model.configs,query]);
 const virtual=list.length>6,focusedIndex=list.findIndex((c:Row)=>c.id===focusedId);
 // 大链接按整套配置测高，保留焦点所在表格。
 const rangeExtractor=useCallback((range:Parameters<typeof defaultRangeExtractor>[0])=>{const indexes=defaultRangeExtractor(range);if(focusedIndex>=0&&!indexes.includes(focusedIndex))indexes.push(focusedIndex);return indexes.sort((a,b)=>a-b);},[focusedIndex]);
 const getItemKey=useCallback((index:number)=>list[index].id,[list]);
 const virtualizer=useVirtualizer({count:list.length,getScrollElement:()=>sheet.current,estimateSize:()=>780,getItemKey,overscan:1,rangeExtractor,enabled:virtual});
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
 const renderConfig=(c:Row):ReactNode=>c.loading?<p role="status">正在加载 {c.name}</p>:<ConfigTable c={c} model={model} actual={actual} addons={addons}/>;
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
  </div>
  <p className="ov-hint">实际配件和数量可双击或键入编辑，删空型号即清除。用 <kbd>Shift</kbd> 选区，两列粘贴从实际配件格开始，顺序为型号、数量。</p>
  {model.error&&<p role="alert">{model.error} <button onClick={()=>model.retry()}>重试加载</button></p>}
  {!list.length&&<p>没有匹配的配置 <button onClick={()=>setQuery('')}>清空搜索</button></p>}
  <div ref={sheet} className="ov-sheet-scroll" aria-label="连续配置表" tabIndex={0}
   onFocusCapture={event=>setFocusedId((event.target as HTMLElement).closest<HTMLElement>('[data-continuous-config]')?.dataset.continuousConfig||null)}
   onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocusedId(null);}}>
   <div className="ov-content" style={virtual?{height:virtualizer.getTotalSize(),position:'relative'}:undefined}>
    {virtual?virtualizer.getVirtualItems().map(item=><div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{position:'absolute',top:0,left:0,width:'100%',transform:'translateY('+item.start+'px)'}}>{renderConfig(list[item.index])}</div>):list.map((c:Row)=><div key={c.id}>{renderConfig(c)}</div>)}
   </div>
  </div>
 </div>;
}
