/** 在原 NAS 接口上读取三店现用资料。试验范围与草稿按服务和成员保存在本机。 */
import {sameNasDocument as equal} from './nas-main-workspace.js';
import {sharedScopeRow} from './shared-source-editor.js';
import {sourceFields,sourceGoodsId,sharedSourceKeys} from './shared-source-fields.js';
import {excludedComponent} from './component-policy.js';

const keyOf = row => {
 if (row.specialComponent===true) return 'special:legacy:'+row.name;
 if (sourceGoodsId(row.goodsId)&&!excludedComponent(row)) return row.goodsId;
};
const pendingId = (scope,key) => 'preview-source:'+scope+':'+key;
const blankAlias = sourceId => ({sourceId,fields:{},legacy:[]});

export function createSharedSourcePreview({snapshots,shop,storage,scope}) {
 const shops=Object.keys(snapshots);
 const cacheKey='diy-shared-source-acceptance:'+scope;
 let revision=storage.getItem(cacheKey);
 let trials=JSON.parse(revision||'{}');
 let entries,bySource,catalog;
 const rebuild=()=>{
  const original=Object.entries(snapshots).flatMap(([store,data])=>{
   const costs=new Map(data.costSource.map(row=>[row.goodsId,row]));
   return data.sourceCatalog.filter(row=>!row.deletedAt&&keyOf(row)).map(row=>{
    const cost=costs.get(row.goodsId);
    const doc={...row,shopId:store};
    if(cost&&Object.hasOwn(cost,'tax'))doc.tax=cost.tax;
    return doc;
   });
  });
  entries=new Map();
  catalog=[];
  for(const [id,rows] of Map.groupBy(original,keyOf)){
   const common={},observed=rows.map(row=>sourceFields(row)),entry={id,common,stores:{},version:'1'};
   const keys=id.startsWith('special:')?['name']:sharedSourceKeys;
   for(const key of keys)if(observed.every(row=>equal(row[key],observed[0][key])))common[key]=observed[0][key];
   rows.forEach((row,index)=>{
    const alias=blankAlias(row.sourceId);
    alias.legacy=keys.filter(key=>!Object.hasOwn(common,key));
    for(const key of alias.legacy)alias.fields[key]=observed[index][key];
    (entry.stores[row.shopId]??=[]).push(alias);
   });
   for(const store of shops)entry.stores[store]??=[blankAlias(pendingId(store,id))];
   const local=rows.filter(row=>row.shopId===shop);
   const base=local.length?local:[{...rows[0],sourceId:pendingId(shop,id),shopId:shop}];
   catalog.push(...base);
   entries.set(id,entry);
  }
  for(const [id,trial] of Object.entries(trials)){
   const prior=entries.get(id);
   if(!prior&&trial.row){
    entries.set(id,{id,common:{},version:'1',stores:Object.fromEntries(shops.map(store=>[store,[blankAlias(pendingId(store,id))]]))});
    catalog.push({...trial.row,sourceId:pendingId(shop,id),shopId:shop});
   }
   const record=entries.get(id);
   if(!record)continue;
   record.common={...record.common,...trial.edits.shared?.values};
   for(const [store,change] of Object.entries(trial.edits)){
    for(const alias of record.stores[store]??[]){
     for(const field of change.restore)delete alias.fields[field];
     Object.assign(alias.fields,change.values);
     alias.legacy=alias.legacy.filter(field=>!change.restore.includes(field)&&!Object.hasOwn(change.values,field));
    }
   }
  }
  bySource=new Map([...entries.values()].flatMap(entry=>entry.stores[shop].map(alias=>[alias.sourceId,entry])));
  catalog=catalog.map(row=>{
   const entry=bySource.get(row.sourceId);
   const local=sharedScopeRow(row,entry,shop,{});
   return {...local,name:local.name||row.name};
  });
 };
 rebuild();
 const record=row=>bySource.get(row.sourceId);
 return {record,preview:true,rows:()=>catalog,canCreate:shops.length===3,defaultScope:shops.length===3?'shared':shop,
  scopes:shops.length===3?['shared',...shops]:shops,
  searchNames:row=>{
   const entry=record(row);
   return entry?[entry.common.name,...Object.values(entry.stores).flatMap(aliases=>aliases.map(alias=>alias.fields.name))]:[];
  },
  dedupe:rows=>[...Map.groupBy(rows,row=>record(row)?.id??row.sourceId).values()].map(group=>group[0]),
  async save(changes){
   if(storage.getItem(cacheKey)!==revision)throw Error('本机另一窗口已更新验收资料，请重新打开。');
   const next=structuredClone(trials),sourceIds={};
   for(const {managed,row} of changes){
    const {id,edits,version}=managed;
    if(!version&&entries.has(id))throw Error('该 ERP ID 已在三店输出源中，请重新搜索。');
    const item=next[id]??={edits:{},...(!version?{row}:{})};
    for(const [store,change] of Object.entries(edits)){
     const draft=item.edits[store]??={values:{},restore:[]};
     for(const field of change.restore)delete draft.values[field];
     draft.values={...draft.values,...change.values};
     draft.restore=[...new Set([...draft.restore,...change.restore])].filter(field=>!Object.hasOwn(change.values,field));
    }
    if(!version)sourceIds[row.sourceId]=pendingId(shop,id);
   }
   const updated=JSON.stringify(next);
   storage.setItem(cacheKey,updated);
   revision=updated;trials=next;rebuild();
   return {count:changes.length,sourceIds,configIds:[],autoChanges:[]};
  },
 };
}
