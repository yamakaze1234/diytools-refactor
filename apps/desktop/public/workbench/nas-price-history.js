/** 将 NAS 的真实成本记录接入原价格变化页面；分页读取不重写或重放任何成本操作。 */
export function nasPriceHistory(read){
 async function detail(revision){
  const opening=await read('detail',{revision});
  const configs=[...opening.configs],current=[...opening.current];
  for(let offset=opening.nextOffset;offset!==null;){
   const page=await read('detail',{revision,offset});
   if(page.nextOffset!==null&&page.nextOffset<=offset)throw Error('价格变化分页无效，请重新读取。');
   configs.push(...page.configs);current.push(...page.current);offset=page.nextOffset;
  }
  return {...opening,configs,current};
 }
 const request=async(path,options)=>{
  const action=path.match(/^\/api\/price-changes\/(list|detail|day|seen|handle)$/)?.[1],input=JSON.parse(options?.body||'{}');
  if(action==='seen')return {ok:true};
  if(action==='detail')return detail(input.revision);
  if(action==='day'){
   const bounds=await read('day',{}),daily={day:bounds.day,daily:true,baselineKnown:bounds.baselineKnown,at:bounds.day+'T00:00:00+08:00',
    message:'服务端价格变化',items:[],configs:[],handled:[],current:[]};
   if(!bounds.baselineKnown)return daily;
   const oldItems=new Map(),oldConfigs=new Map(),items=new Map(),configs=new Map(),live=new Map();
   for(const revision of bounds.yesterday){
    const result=await detail(revision);
    for(const item of result.items)oldItems.set(item.goodsId,item.after);
    for(const row of result.configs)oldConfigs.set(row.after.id,row.after);
   }
   for(const revision of bounds.revisions){
    const batch=await detail(revision);daily.at=batch.at;
    for(const item of batch.items){
     const previous=items.get(item.goodsId);
     items.set(item.goodsId,{...item,before:previous?.before??oldItems.get(item.goodsId)??item.before,
      slots:[...new Set([...(previous?.slots||[]),...item.slots])],
      configIds:[...new Set([...(previous?.configIds||[]),...item.configIds])]});
    }
    for(const row of batch.configs){
     const before=oldConfigs.get(row.after.id)||{...row.before,price:null,loggedProfit:{tax:null,erp:null}};
     configs.set(row.after.id,{before,after:row.after});
    }
    for(const row of batch.configs)live.delete(row.after.id);
    for(const row of batch.current)live.set(row.id,row);
   }
   return {...daily,items:[...items.values()].filter(x=>x.before.tax!==x.after.tax||x.before.erp!==x.after.erp),configs:[...configs.values()],current:[...live.values()]};
  }
  if(action==='list'||action==='handle')return read(action,input);
  throw Error('不支持的价格变化操作。');
 };
 return {request};
}
