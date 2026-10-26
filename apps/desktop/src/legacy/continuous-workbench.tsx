/** ReUI 连续编辑表；所有写入通过现有工作台领域回调，不维护第二份业务状态。 */
import {createContext,useContext,memo,useMemo,useState,useRef,useLayoutEffect,useCallback,type ClipboardEvent} from 'react';
import {useVirtualizer,defaultRangeExtractor} from '@tanstack/react-virtual';
import {useTable,type ColumnDef} from '@tanstack/react-table';
import {DataGrid,DataGridContainer,dataGridFeatures,type DataGridFeatures} from '@/components/reui/data-grid/data-grid';
import {DataGridTable} from '@/components/reui/data-grid/data-grid-table';
import {Frame,FramePanel} from '@/components/reui/frame';
import {Badge} from '@/components/reui/badge';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Checkbox} from '@/components/ui/checkbox';
import {Skeleton} from '@/components/ui/skeleton';
import {Autocomplete,AutocompleteContent,AutocompleteEmpty,AutocompleteInput,AutocompleteItem,AutocompleteList} from '@/components/reui/autocomplete';
import type {Row} from './editor-controls';
import {profitTone} from '../../public/workbench/profit-tone.js';
const amount=(n:unknown)=>n==null?'待补充':Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
function Edit({value,label,type='text',integerDisplay=false,change}: {value:unknown;label:string;type?:string;integerDisplay?:boolean;change:(value:string)=>unknown}){
 const ref=useRef<HTMLInputElement>(null);
 useLayoutEffect(()=>{if(ref.current&&ref.current.ownerDocument.activeElement!==ref.current)ref.current.value=String(value??'');},[value]);
 return <Input ref={ref} aria-label={label} type={type} min={type==='number'?0:undefined} step={type==='number'?'any':undefined} defaultValue={String(value??'')} onChange={e=>{if(type==='number'&&(!e.currentTarget.value||!e.currentTarget.validity.valid))return;change(e.currentTarget.value);}} onBlur={e=>{if(type==='number'&&(!e.currentTarget.value||!e.currentTarget.validity.valid))e.currentTarget.value=String(value??'');else if(integerDisplay)e.currentTarget.value=String(Math.round(Number(e.currentTarget.value)));}}/>;
}
function WrappedEdit({value,label,change}:{value:unknown;label:string;change:(value:string)=>unknown}){
 const ref=useRef<HTMLTextAreaElement>(null);
 const fit=()=>{const node=ref.current;if(node){node.style.height='auto';node.style.height=`${node.scrollHeight}px`;}};
 useLayoutEffect(()=>{const node=ref.current;if(!node)return;if(node.ownerDocument.activeElement!==node)node.value=String(value??'');fit();},[value]);
 useLayoutEffect(()=>{const node=ref.current;if(!node)return;let width=-1;const observer=new ResizeObserver(entries=>{const next=entries[0].contentRect.width;if(next!==width){width=next;fit();}});observer.observe(node);return()=>observer.disconnect();},[]);
 return <textarea ref={ref} className="continuous-wrapped-edit" rows={1} aria-label={label} defaultValue={String(value??'')} onChange={e=>{fit();change(e.currentTarget.value);}}/>;
}
const PartPicker=memo(function PartPicker({part,slot,actual,c,model}:{part:Row|null;slot:string;actual:boolean;c:Row;model:Row}){
 const [query,setQuery]=useState<string>(part?.name||'');
 const [open,setOpen]=useState(false);
 useLayoutEffect(()=>{if(!open)setQuery(part?.name||'');},[part?.name,open]);
 const matches=useMemo(()=>{if(!open)return [];const tokens=query.trim().toLowerCase().split(/\s+/).filter(Boolean),found:Row[]=[];for(const p of model.catalog){if(!p.deletedAt&&tokens.every(t=>p.searchText.includes(t)))found.push(p);if(found.length===50)break;}return found;},[model.catalog,query,open]);
 return <Autocomplete items={matches} filteredItems={matches} value={query} open={open} onOpenChange={setOpen} onValueChange={setQuery} itemToStringValue={(p:Row)=>p.name}>
 <AutocompleteInput render={<textarea rows={1} role="combobox"/>} className="continuous-part-input" size="sm" showTrigger aria-label={`${c.name} ${slot} ${actual?'实际':'展示'}配件`} placeholder="搜索型号 / ERP ID" onFocus={()=>{model.activate(c.id);setOpen(true);}} />
 <AutocompleteContent portalContainer={model.portalContainer} className="continuous-part-popup w-[min(650px,calc(100vw-2rem))]">
 <AutocompleteEmpty>没有匹配配件，请调整关键词</AutocompleteEmpty><AutocompleteList>{(p:Row)=><AutocompleteItem key={p.sourceId} value={p} onClick={()=>model.pick(c.id,slot,actual,p.sourceId)}><div className="continuous-candidate"><strong>{p.name}</strong><small>ERP ID {p.goodsId||'未绑定'} · ERP ¥{amount(p.erp)} · 含税 ¥{p.tax==null?'未知':Math.round(Number(p.tax))}{p.erpName?' · ERP 原名：'+p.erpName:''}</small><span className="candidate-stock" data-stock-status={p.stock.status}>ERP 可销库存：{p.stock.label}</span></div></AutocompleteItem>}</AutocompleteList>
 </AutocompleteContent></Autocomplete>;
},(a,b)=>a.part?.name===b.part?.name&&a.part?.sourceId===b.part?.sourceId&&a.slot===b.slot&&a.actual===b.actual&&a.c.id===b.c.id&&a.c.name===b.c.name&&a.model.catalog===b.model.catalog&&a.model.portalContainer===b.model.portalContainer);
const ConfigCellContext=createContext<Row|null>(null);
// 列渲染函数保持身份稳定，输入时更新上下文，不卸载正在编辑的输入框。
function ConfigCell({row,column}:{row:Row;column:Row}) {
 const {c,model,selection,choose,remove}=useContext(ConfigCellContext)!;
 switch(column.id){
 case 'slot': return <div className="continuous-row-actions"><Button size="sm" variant={selection.includes(row.original.index)?'secondary':'ghost'} data-row-slot={row.original.index} aria-pressed={selection.includes(row.original.index)} onClick={e=>choose(row.original.index,e.shiftKey,e.ctrlKey||e.metaKey)}>{row.original.slot}</Button><Button size="sm" variant="ghost" className="continuous-remove-row" aria-label={`${c.name} ${Number(row.original.slot.slice(2))>5?'删除':'清空'}${row.original.slot}`} title="移除本行展示和实际配件，可撤销" disabled={!row.original.part&&!row.original.actual} onClick={()=>remove(row.original.slot)}>{Number(row.original.slot.slice(2))>5?'删除':'清空'}</Button></div>;
 case 'display': return <PartPicker part={row.original.part} slot={row.original.slot} actual={false} c={c} model={model}/>;
 case 'actual': return <div className="flex items-center gap-2"><div className="min-w-0 flex-1"><PartPicker part={row.original.actual} slot={row.original.slot} actual c={c} model={model}/></div><div className="w-12"><Edit value={row.original.actual?.qty??1} label={`${c.name} ${row.original.slot} 实际数量`} type="number" change={v=>model.partField(c.id,row.original.slot,true,'qty',v)}/></div></div>;
 case 'quantity': return <Edit value={row.original.part?.qty??1} label={`${c.name} ${row.original.slot} 展示数量`} type="number" change={v=>model.partField(c.id,row.original.slot,false,'qty',v)}/>;
 case 'stock': {const part=row.original.actual;if(!part?.name&&!part?.goodsId&&!part?.specialComponent)return <span className="continuous-stock" data-stock-status="empty">—</span>;const stock=model.stock(part);return <span className="continuous-stock" data-stock-status={stock.status} title={['实际配件：'+part.name,stock.label,stock.detail].filter(Boolean).join('\n')}><span>{stock.status==='special'?'不核算':stock.value==null?'未知':stock.value.toLocaleString('zh-CN',{maximumFractionDigits:6})}</span>{['out','low'].includes(stock.status)&&<small>{stock.status==='out'?'缺货':'偏低'}</small>}</span>;}
 case 'cost': return <div className="continuous-unit-cost"><div><small>ERP</small><span>{row.original.actual?.erp==null?'未知':Number(row.original.actual.erp).toLocaleString('zh-CN',{maximumFractionDigits:2})}</span></div><div><small>含税</small><div className="unit-tax"><Edit integerDisplay value={row.original.actual?.tax==null?undefined:Math.round(Number(row.original.actual.tax))} label={`${c.name} ${row.original.slot} 核算单价`} type="number" change={v=>model.tax(c.id,row.original.slot,v)}/>{row.original.actual?.tax==null&&<span className="unit-unknown">未知</span>}</div></div></div>;
 case 'subtotal': return <span className="text-xs tabular-nums">{row.original.actual?.erp==null?'待补充':amount(row.original.actual.erp*row.original.actual.qty)}</span>;
 case 'displayName': return <WrappedEdit value={row.original.part?.displayName} label={`${c.name} ${row.original.slot} 展示名称`} change={v=>model.partField(c.id,row.original.slot,false,'displayName',v)}/>;
 case 'upgrade': return <WrappedEdit value={row.original.part?.upgrade} label={`${c.name} ${row.original.slot} 加购描述`} change={v=>model.partField(c.id,row.original.slot,false,'upgrade',v)}/>;
 default:return null;
 }
}
const ConfigTable=memo(function ConfigTable({c,model,actual,copy,selections,onAddRow}:{c:Row;model:Row;actual:boolean;copy:boolean;selections:Map<string,{rows:number[];anchor:number}>;onAddRow:(id:string)=>void}){
 const [selection,setSelection]=useState<number[]>(()=>selections.get(c.id)?.rows||[]),anchor=useRef<number>(selections.get(c.id)?.anchor||0);
 useLayoutEffect(()=>{selections.set(c.id,{rows:selection,anchor:anchor.current});},[c.id,selection,selections]);
 const data=c.rows;
 const choose=(i:number,shift:boolean,ctrl:boolean)=>{setSelection(old=>shift?c.rows.filter((r:Row)=>r.index>=Math.min(anchor.current,i)&&r.index<=Math.max(anchor.current,i)).map((r:Row)=>r.index):ctrl?old.includes(i)?old.filter(n=>n!==i):[...old,i]:[i]);if(!shift)anchor.current=i;model.activate(c.id);};
 const remove=(slot:string)=>{if(model.removeRow(c.id,slot)){setSelection([]);anchor.current=0;selections.delete(c.id);}};
 const columns=useMemo<ColumnDef<DataGridFeatures,Row>[]>(()=>[{id:'slot',header:'配件',size:64,cell:ConfigCell},{id:'display',header:'展示配件 / 商品型号',size:230,cell:ConfigCell},...(actual?[{id:'actual',header:'实际配件 / 数量',size:260,cell:ConfigCell}]:[]),{id:'quantity',header:'数量',size:64,cell:ConfigCell},{id:'stock',header:'库存',size:72,cell:ConfigCell},{id:'cost',header:'ERP / 含税单价',size:112,cell:ConfigCell},{id:'subtotal',header:'ERP 小计',size:92,cell:ConfigCell},...(copy?[{id:'displayName',header:'对客展示名称',size:180,cell:ConfigCell},{id:'upgrade',header:'加购描述',size:180,cell:ConfigCell}]:[])],[actual,copy]);
 const table=useTable({features:dataGridFeatures,data,columns,getRowId:(r:Row)=>r.slot,manualPagination:true,initialState:{columnPinning:{start:['slot'],end:[]}}});
 const copyRows=(e:ClipboardEvent)=>{if(!(e.target as HTMLElement).closest('[data-row-slot]'))return;e.preventDefault();const payload=model.copy(c.id,selection.length?selection:[Number((e.target as HTMLElement).closest<HTMLElement>('[data-row-slot]')?.dataset.rowSlot)]);if(!payload)return;e.clipboardData.setData('application/x-diy-workbench-rows',JSON.stringify(payload));e.clipboardData.setData('text/plain',payload.rows.map((r:Row)=>[r.part?.name||'',r.part?.qty||1,r.actual?.name||'',r.actual?.erp??'',r.actual?.tax??''].join('\t')).join('\n'));model.notice(`已复制 ${payload.rows.length} 行`);};
 const pasteRows=(e:ClipboardEvent)=>{if(!(e.target as HTMLElement).closest('[data-row-slot]'))return;e.preventDefault();try{const raw=e.clipboardData.getData('application/x-diy-workbench-rows');if(!raw)return model.notice('请先复制本工作台的配件行');if(model.paste(c.id,Number((e.target as HTMLElement).closest<HTMLElement>('[data-row-slot]')?.dataset.rowSlot),JSON.parse(raw)))model.notice('已按目标位置粘贴，可撤销');}catch{model.notice('剪贴板配件数据无效');}};
 return <ConfigCellContext.Provider value={{c,model,selection,choose,remove}}><section data-continuous-config={c.id} data-active={model.active===c.id||undefined} className="min-w-0" onFocusCapture={event=>{if((event.target as HTMLElement).matches('input,textarea,select'))model.activate(c.id);}} onCopy={copyRows} onPaste={pasteRows}>
 <Frame spacing="xs" dense stacked className={model.active===c.id?'border-l-2 border-l-primary':undefined}><FramePanel className="overflow-visible bg-muted/50"><div className="continuous-config-heading"><div className="config-identity"><Checkbox aria-label={`选择${c.name}`} checked={c.selected} onCheckedChange={v=>model.select(c.id,v)}/><div className="config-title"><Edit value={c.name} label={`${c.name} 配置名称`} change={v=>model.field(c.id,'name',v)}/></div><div className="config-version"><Edit value={c.version} label={`${c.name} 版本`} change={v=>model.field(c.id,'version',v)}/></div><Button variant="ghost" size="sm" onClick={()=>model.detail(c.id,'display')}>完整编辑</Button></div>
 <div className="config-finance"><label className="config-arrival"><span className="finance-label">到手价</span><div className="arrival-money"><span aria-hidden="true">¥</span><Edit value={c.price} label={`${c.name} 到手价`} type="number" change={v=>model.field(c.id,'price',v)}/></div></label>{[['erp','ERP 成本'],['tax','核算成本'],['erpProfit','ERP 利润'],['taxProfit','核算利润']].map(([key,label])=><div className="finance-metric" data-metric={key} key={key}><span className="finance-label">{label}</span><div className="finance-amounts"><span className="finance-value tabular-nums" data-profit-tone={key.endsWith('Profit')?profitTone(c.totals[key+'Before']):undefined}>{amount(key.endsWith('Profit')?c.totals[key+'Before']:c.totals[key])}</span>{key.endsWith('Profit')&&c.pricing.term>0&&c.totals[key]!=null&&<span className="finance-installment" data-profit-tone={profitTone(c.totals[key])}>（分期后实际 ¥{amount(c.totals[key])}）</span>}</div></div>)}</div>
 <div className="config-installment"><span>{c.pricing.term?c.pricing.term+' 期分期':'不分期'}</span>{c.pricing.term>0&&<><span>手续费 {Math.round(c.pricing.rate*100)}% · ¥{amount(c.pricing.fee)}</span><span>括号内为扣除分期费后的实际利润</span></>}</div>
 {!!(c.extras.parts.length+c.extras.actualParts.length)&&<Badge variant="warning-light">含额外或重复槽位，请使用展示明细和实际配件页签；所有原内容保留</Badge>}</div></FramePanel>
 <FramePanel className="overflow-visible p-0"><DataGrid table={table} recordCount={data.length} emptyMessage="暂无配件" tableLayout={{dense:true,cellBorder:true,width:'fixed',columnsPinnable:true,headerSticky:false,headerBackground:true}}><DataGridContainer className="overflow-visible"><DataGridTable/></DataGridContainer></DataGrid></FramePanel><FramePanel className="continuous-add-row"><Button variant="ghost" size="sm" aria-label={`${c.name} 新增配件`} onClick={()=>onAddRow(c.id)}><span aria-hidden="true">＋</span> 新增配件</Button></FramePanel></Frame></section></ConfigCellContext.Provider>;
},(a,b)=>a.c===b.c&&a.actual===b.actual&&a.copy===b.copy&&(a.model.active===a.c.id)===(b.model.active===b.c.id)&&a.model.catalog===b.model.catalog&&a.model.portalContainer===b.model.portalContainer);
export function ContinuousWorkbench({model}:{model:Row}){
 const sheet=useRef<HTMLDivElement>(null);
 const selections=useRef(new Map<string,{rows:number[];anchor:number}>());
 const [focusedId,setFocusedId]=useState<string|null>(null);
 const [actual,setActual]=useState(true),[copy,setCopy]=useState(true),[query,setQuery]=useState(''),[locateId,setLocateId]=useState<string|null>(null);
 const list=useMemo(()=>{const text=query.trim().toLowerCase();return text?model.configs.filter((c:Row)=>(c.name+' '+c.version+' '+JSON.stringify(c.rows||[])).toLowerCase().includes(text)):model.configs;},[model.configs,query]);
 const virtual=list.length>6,focusedIndex=list.findIndex((c:Row)=>c.id===focusedId);
 // 每套配置整体测高，滚动时只挂载可见配置及相邻一套；焦点所在配置不卸载。
 const rangeExtractor=useCallback((range:Parameters<typeof defaultRangeExtractor>[0])=>{const indexes=defaultRangeExtractor(range);if(focusedIndex>=0&&!indexes.includes(focusedIndex))indexes.push(focusedIndex);return indexes.sort((a,b)=>a-b);},[focusedIndex]);
 const getItemKey=useCallback((index:number)=>list[index].id,[list]);
 const virtualizer=useVirtualizer({count:list.length,getScrollElement:()=>sheet.current,estimateSize:()=>1050,getItemKey,overscan:1,rangeExtractor,enabled:virtual});
 useLayoutEffect(()=>{const ids=new Set(model.configs.map((c:Row)=>c.id));for(const id of selections.current.keys())if(!ids.has(id))selections.current.delete(id);},[model.configs]);
 useLayoutEffect(()=>{
  const node=sheet.current,host=node?.closest('#continuous-workbench');if(!node||!host)return;
  const measure=()=>node.style.setProperty('--sheet-visible-width',`${Math.max(0,node.clientWidth-18)}px`);
  const locate=(event:Event)=>{setQuery('');setLocateId((event as CustomEvent<string>).detail);};
  measure();const observer=new ResizeObserver(measure);observer.observe(node);host.addEventListener('workbench-locate-config',locate);
  return()=>{observer.disconnect();host.removeEventListener('workbench-locate-config',locate);};
 },[]);
 useLayoutEffect(()=>{
  const node=sheet.current;if(!node||!locateId)return;
  if(virtual){const index=list.findIndex((c:Row)=>c.id===locateId);if(index>=0)virtualizer.scrollToIndex(index,{align:'start',behavior:'auto'});setLocateId(null);return;}
  const target=[...node.querySelectorAll<HTMLElement>('[data-continuous-config]')].find(item=>item.dataset.continuousConfig===locateId);
  if(target){node.scrollTo({top:node.scrollTop+target.getBoundingClientRect().top-node.getBoundingClientRect().top-1,left:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});setLocateId(null);}
 },[locateId,list,virtual,virtualizer]);
 const addRow=(id:string)=>{model.addRow(id);};
 const renderConfig=(c:Row)=>c.loading?<Frame><FramePanel><Skeleton className="h-32 w-full"/><span role="status">正在加载 {c.name}</span></FramePanel></Frame>:<ConfigTable c={c} model={model} actual={actual} copy={copy} selections={selections.current} onAddRow={addRow}/>;
 return <div className="reui-continuous flex min-w-0 flex-col text-sm"><div className="continuous-view-toolbar"><div className="continuous-view-options" role="group" aria-label="配置表显示选项"><span className="continuous-view-caption">显示列</span><button type="button" className="continuous-view-toggle" aria-pressed={actual} onClick={()=>setActual(v=>!v)}><span aria-hidden="true" className="continuous-view-mark">{actual?'✓':'+'}</span>实际配件</button><button type="button" className="continuous-view-toggle" aria-pressed={copy} onClick={()=>setCopy(v=>!v)}><span aria-hidden="true" className="continuous-view-mark">{copy?'✓':'+'}</span>展示与加购</button></div><div className="min-w-40 flex-1"><Input aria-label="筛选当前链接配置" placeholder="搜索当前链接配置 / 配件型号" value={query} onChange={e=>setQuery(e.target.value)}/></div></div><p className="shrink-0 pb-2 text-xs text-muted-foreground">点击配件类型选行 · Shift 连选 / Ctrl 多选 · Ctrl+C 复制 · Ctrl+V 从目标位置粘贴 · 底部 ＋ 可继续新增配件</p>
 {model.error&&<Frame><FramePanel><p role="alert">{model.error}</p><Button size="sm" variant="outline" onClick={model.retry}>重试加载</Button></FramePanel></Frame>}
 {!list.length&&<Frame><FramePanel><p>没有匹配的配置</p><Button size="sm" variant="outline" onClick={()=>setQuery('')}>清空搜索</Button></FramePanel></Frame>}
 <div ref={sheet} className="continuous-sheet" aria-label="连续配置表" tabIndex={0} onFocusCapture={event=>setFocusedId((event.target as HTMLElement).closest<HTMLElement>('[data-continuous-config]')?.dataset.continuousConfig||null)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocusedId(null);}}><div className="continuous-sheet-content" style={{minWidth:634+(actual?260:0)+(copy?360:0),...(virtual?{height:virtualizer.getTotalSize(),position:'relative' as const}:{} )}}>{virtual?virtualizer.getVirtualItems().map(item=><div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{position:'absolute',top:0,left:0,width:'100%',transform:`translateY(${item.start}px)`}}>{renderConfig(list[item.index])}</div>):list.map((c:Row)=><div key={c.id}>{renderConfig(c)}</div>)}</div></div>
 </div>;
}
