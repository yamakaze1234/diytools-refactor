// 独立运行区持久层。版本、配置明细、审计和回执由同一个事务提交。
import {createHash} from 'node:crypto';
import {Fault,requireValue} from './config.mjs';
import {Store,authorize} from './store.mjs';
import {CatalogStore} from './catalog-store.mjs';
import {liveScopes,shopLock} from './shop-scope.mjs';
import {runNasProfit} from './profit-store.mjs';
import {priceHistoryAction,priceHistorySnapshot,priceHistoryCurrent} from './price-history.mjs';
import {addonItems,choiceAddon,effectiveNasAddon} from '../../../apps/desktop/public/workbench/addon-data.js';
import {DEFAULT_PRICING_RULE,normalizePricingRule,normalizeProfitAlert,normalizeProfitAlerts} from '../../../apps/desktop/public/workbench/pricing.js';
import {applyNameFormatPlan,nameFormatPlan} from '../../../apps/desktop/public/workbench/name-format-batch.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const own=(o,k)=>Object.hasOwn(o,k);
const goodText=(v,max=256)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const identity=v=>goodText(v)&&v.length>0&&v!=='.'&&v!=='..';
export const operationId=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const version=v=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const failure=(condition,field)=>{if(!condition)throw new Fault('VALIDATION_FAILED',400,{field});};
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':plain(value)?
 '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
const safeValue=(v,depth=0)=>depth<=24&&(
 v===null||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v))||
 (typeof v==='string'&&v.length<=262144&&!v.includes('\u0000'))||
 (Array.isArray(v)&&v.length<=5000&&v.every(x=>safeValue(x,depth+1)))||
 (plain(v)&&Object.keys(v).length<=300&&Object.entries(v).every(([k,x])=>!['__proto__','prototype','constructor'].includes(k)&&goodText(k)&&safeValue(x,depth+1)))
);
const designKeys=['caseImage','fontFamily','footer','layout','modules','palette','posterDesignVersion',
 'showUpgrades','showWarranty','textStyles','theme','themePalettes','upgradeColor','upgradeSize','upgradeWeight','productCardColor',
 'fixedInitialFormat','freeCanvasLayouts','caseTransforms','skuExportMode','textTransforms','productTheme','posterImages',
 'previousSquareLayout','skuTextStyles','posterFields'];
const priceAmount=overlay=>overlay?'coalesce(o.amount_cents,q.amount_cents)':'q.amount_cents';
const summarySelect=overlay=>"c.configuration_id,c.shop_id,c.name,NULLIF(c.sku,'') AS sku_id,NULLIF(c.spu,'') AS spu,c.version::text,c.archived_at,c.fields->>'product' AS product_name,c.fields->>'version' AS config_label,coalesce(p.published,false) AS published,("+priceAmount(overlay)+")::text AS final_price_cents,CASE WHEN "+priceAmount(overlay)+" IS NOT NULL THEN 'available' WHEN q.configuration_id IS NULL THEN 'not_selected' ELSE 'unavailable' END AS quotation_status,CASE WHEN a.sha256 IS NOT NULL THEN '/images/'||a.sha256||'.'||a.extension END AS image_url";
const summaryJoins=overlay=>"FROM intel_live.configurations c LEFT JOIN intel_live.quotations q USING(configuration_id) LEFT JOIN intel_live.publications p USING(configuration_id) LEFT JOIN intel_live.assets a ON a.legacy_uri=c.design->>'caseImage'"+
 (overlay?" LEFT JOIN intel_live.intel_quotation_overrides o ON o.configuration_id=c.configuration_id AND o.sku=c.sku AND o.spu=c.spu":"");
// 回收站需要真实归档时间和商品链接名；这些字段不增加到销售目录。
const summary=(row,sales)=>{const {published,archived_at,product_name,config_label,...rest}=row;return sales?rest:{...rest,published,archived:!!archived_at,...(archived_at?{archived_at,product_name,config_label}:{})};};
const quantity=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const price=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER/100&&Math.abs(v*100-Math.round(v*100))<0.00001;
const partKeys=['lineId','slot','goodsId','name','qty','sourceId'];
const pricingRuleOk=value=>value===null||plain(value)&&Object.keys(value).every(k=>own(DEFAULT_PRICING_RULE,k))&&normalizePricingRule(value)!==null;
const profitAlertOk=value=>value===null||plain(value)&&normalizeProfitAlerts(value)!==null&&
 Object.keys(value).every(k=>['bases','mode','loss','target','erpProfit','taxProfit'].includes(k))&&
 (!own(value,'bases')||Array.isArray(value.bases)&&value.bases.length>0&&value.bases.every(k=>['erp','tax'].includes(k)))&&
 ['erpProfit','taxProfit'].every(k=>!own(value,k)||normalizeProfitAlert(value[k])!==null);

function validatePart(p,field){
 failure(plain(p)&&identity(p.lineId)&&goodText(p.slot)&&goodText(p.goodsId)&&goodText(p.name,2048)&&quantity(p.qty),field);
 if(own(p,'sourceId')&&p.sourceId!==null)failure(p.sourceId===''||identity(p.sourceId),field+'.sourceId');
}
function validateDocument(document,{id,shop}){
 failure(plain(document)&&safeValue(document),'document');
 failure(document.id===id&&document.shopId===shop,'document.id/shopId');
 failure(identity(document.productId)&&goodText(document.name,2048)&&document.name.trim().length,'document.productId/name');
 failure(goodText(document.skuId)&&goodText(document.spu),'document.skuId/spu');
 failure(typeof document.workspaceOrder==='number'&&Number.isFinite(document.workspaceOrder)&&Math.abs(document.workspaceOrder)<=Number.MAX_SAFE_INTEGER,'document.workspaceOrder');
 failure(document.price===null||price(document.price),'document.price');
 if(own(document,'pricingRule'))failure(pricingRuleOk(document.pricingRule),'document.pricingRule');
 for(const key of ['parts','actualParts']){
  failure(Array.isArray(document[key])&&document[key].length<=500,'document.'+key);
  const ids=new Set();
  document[key].forEach((p,i)=>{
   validatePart(p,'document.'+key+'.'+i);
   failure(!ids.has(p.lineId),'document.'+key+'.'+i+'.lineId');
   ids.add(p.lineId);
  });
 }
 failure(Array.isArray(document.addons)&&document.addons.length<=500,'document.addons');
 const validateAddon=(a,f,top=false)=>{
  failure(plain(a)&&(!top&&!own(a,'items')||Array.isArray(a.items)&&a.items.length<=500),f);
  if(own(a,'followPolicy'))failure(['snapshot','follow'].includes(a.followPolicy)&&(a.followPolicy!=='follow'||identity(a.sourceId)),f+'.followPolicy');
  if(own(a,'priceCents'))failure(a.priceCents===null||(Number.isSafeInteger(a.priceCents)&&a.priceCents>=0),f+'.priceCents');
  if(own(a,'goodsId'))failure(goodText(a.goodsId),f+'.goodsId');
  for(const k of ['qty','originalQty'])if(own(a,k))failure(quantity(a[k]),f+'.'+k);
  for(const [j,item] of (a.items||[]).entries())failure(plain(item)&&goodText(item.goodsId)&&quantity(item.qty),f+'.items.'+j);
  if(own(a,'choices'))failure(Array.isArray(a.choices)&&a.choices.length<=100&&a.choices.every(plain),f+'.choices');
  if(own(a,'variants')){
   failure(Array.isArray(a.variants)&&a.variants.length<=100,f+'.variants');
   a.variants.forEach((v,j)=>validateAddon(v,f+'.variants.'+j));
  }
 };
 document.addons.forEach((a,i)=>validateAddon(a,'document.addons.'+i,true));
 for(const key of ['priceBasis','final_price_cents','published','archived_at','deletedAt','quotation','shop_id','configuration_id'])
  failure(!own(document,key),'document.'+key);
}
function validateChange(shop,id,action,body){
  failure(plain(body)&&identity(id)&&['create','replace','design','archive','restore'].includes(action),'configuration_id/action');
  const keys=[...(action==='create'?[]:['expected_version']),...(action==='create'||action==='replace'?['document','dependencies']:action==='design'?['design']:[])];
  failure(Object.keys(body).every(k=>keys.includes(k)),'request');
  if(action!=='create')failure(version(body.expected_version),'expected_version');
  if(action==='replace'||action==='create'){
   validateDocument(body.document,{id,shop});
   failure(plain(body.dependencies)&&Object.keys(body.dependencies).every(k=>['sources','costs'].includes(k))&&['sources','costs'].every(k=>plain(body.dependencies[k])&&Object.entries(body.dependencies[k]).every(([id,value])=>identity(id)&&version(value))),'dependencies');
  }
  if(action==='design')failure(plain(body.design)&&safeValue(body.design)&&Object.keys(body.design).every(k=>designKeys.includes(k)),'design');
}
const pick=(obj,keys)=>Object.fromEntries(keys.filter(k=>own(obj,k)).map(k=>[k,obj[k]]));
const omit=(obj,keys)=>Object.fromEntries(Object.entries(obj).filter(([k])=>!keys.includes(k)));
const sourceIds=parts=>[...new Set(parts.map(p=>p.sourceId).filter(Boolean))].sort();
const costIds=parts=>[...new Set(parts.map(p=>p.goodsId).filter(Boolean))].sort();
/** 每家店维护各自的覆盖；已明确为未知的成本为 null，不从母档回填。 */
const effectiveCosts=async(db,shop,ids,override)=>{
 const base=`SELECT goodsid,version,attrs||jsonb_build_object('goodsId',goodsid,'erp',erp,'tax',tax) AS document
  FROM intel_live.costs WHERE (owner_shop=$1 OR owner_shop='shared' OR shared) AND ($2::text[] IS NULL OR goodsid=ANY($2::text[]))`;
 const query=override?`SELECT coalesce(a.goodsid,b.goodsid) AS goodsid,coalesce(b.version,a.version)::text AS version,
  coalesce(b.document,a.document) AS document
  FROM (${base}) a FULL JOIN (SELECT * FROM intel_live.intel_cost_overrides WHERE ($2::text[] IS NULL OR goodsid=ANY($2::text[]))) b USING(goodsid)
  ORDER BY goodsid`:`SELECT goodsid,version::text,document FROM (${base}) a ORDER BY goodsid`;
 return (await db.query(query,[shop,ids])).rows;
};
// 配置加购是已保存的快照；其组合/选项可能引用额外商品，核算也需检查这些成本版本。
const withAddonCosts=document=>{
 const result=[...document.parts,...document.actualParts];
 const add=addon=>{
  for(const item of [addon,...(addon.items||[]),...(addon.choices||[])])if(typeof item?.goodsId==='string'&&item.goodsId)
   result.push({goodsId:item.goodsId});
  for(const variant of (addon.variants||[]))if(plain(variant))add(variant);
 };
 for(const addon of document.addons)add(addon);
 for(const addon of document.addons)if(addon.followPolicy==='follow')result.push({sourceId:addon.sourceId});
 return result;
};
const dependencies=async(db,shop,parts,{lock=false,addons=[],overrides=false}={})=>{
 const sources=sourceIds(parts);
 // 与以后修改依赖的事务共用有序事务锁；读取与核验后，直到提交前不得修改依赖。
 if(lock)for(const key of sources)await shopLock(db,shop,814519,'source:'+key);
 const sourceRows=(await db.query("SELECT source_id, version::text, attrs->>'deletedAt' AS deleted_at,owner_shop,shared,attrs||jsonb_build_object('sourceId',source_id,'goodsId',goodsid,'name',name) AS document FROM intel_live.sources WHERE source_id=ANY($1::text[]) AND (owner_shop=$2 OR owner_shop='shared' OR shared) ORDER BY source_id",[sources,shop])).rows;
 const byId=new Map(sourceRows.map(row=>[row.source_id,row.document]));
 const effective=addons.map(a=>effectiveNasAddon(a,byId.get(a.sourceId)));
 const costs=costIds([...parts,...withAddonCosts({parts:[],actualParts:[],addons:effective.filter(x=>x.available).map(x=>x.addon)})]);
 if(lock)for(const key of costs)await shopLock(db,shop,814519,'cost:'+key);
 const costRows=await effectiveCosts(db,shop,costs,overrides);
 return {sources:Object.fromEntries(sourceRows.map(r=>[r.source_id,r.version])),costs:Object.fromEntries(costRows.map(r=>[r.goodsid,r.version])),sourceRows,effective};
};
const validateAssets=async(db,shop,design)=>{
 const paths=[];
 if(own(design,'caseImage')){
  failure(typeof design.caseImage==='string','design.caseImage');
  if(design.caseImage)paths.push(design.caseImage);
 }
 if(own(design,'posterImages')){
  failure(Array.isArray(design.posterImages)&&design.posterImages.length<=200,'design.posterImages');
  for(const image of design.posterImages){
   failure(plain(image)&&typeof image.url==='string'&&image.url,'design.posterImages.url');
   paths.push(image.url);
  }
 }
 const distinct=[...new Set(paths)];
 if(!distinct.length)return;
 for(const path of distinct.sort())await shopLock(db,shop,814519,'asset:'+path);
 const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM intel_live.assets WHERE legacy_uri=ANY($1::text[])',[distinct]);
 failure(count===distinct.length,'design.images');
};
const checkDependencies=(given,current,oldPartSet,newParts)=>{
 for(const kind of ['sources','costs'])for(const [key,value] of Object.entries(current[kind])){
  if(given[kind]?.[key]!==value)throw new Fault('DEPENDENCY_CONFLICT',409,{field:kind});
 }
 const used=new Map(current.sourceRows.map(r=>[r.source_id,r]));
 for(const [kind,part] of newParts)if(part.sourceId){
  const info=used.get(part.sourceId);
  if(!info||(info.deleted_at&&!oldPartSet.has(JSON.stringify([kind,part.lineId,part.sourceId]))))
   throw new Fault('INVALID_DEPENDENCY',400,{field:kind+'.sourceId'});
 }
};
const setParts=async(db,id,document)=>{
 await db.query('DELETE FROM intel_live.parts WHERE configuration_id=$1',[id]);
 const groups=[['display',document.parts],['actual',document.actualParts]];
 const data=groups.flatMap(([kind,list])=>list.map((p,i)=>({
  part_kind:kind,position:i+1,line_id:p.lineId,slot:p.slot,goodsid:p.goodsId,name:p.name,qty:p.qty,
  source_id:p.sourceId||null,attrs:omit(p,p.sourceId?partKeys:partKeys.slice(0,-1))
 })));
 await db.query("INSERT INTO intel_live.parts(configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs) SELECT $1,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs FROM jsonb_to_recordset($2::jsonb) AS p(part_kind text,position int,line_id text,slot text,goodsid text,name text,qty int,source_id text,attrs jsonb)",[id,JSON.stringify(data)]);
 await db.query('DELETE FROM intel_live.addons WHERE configuration_id=$1',[id]);
 await db.query("INSERT INTO intel_live.addons(configuration_id,position,fields,items) SELECT $1,ord,addon-'items',addon->'items' FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY a(addon,ord)",[id,JSON.stringify(document.addons)]);
};

export class LiveStore extends Store{
 constructor(pool,{shopId='intel',writable=false,catalogWritable=false,workspaceWritable=false,writeImage=null}={}){
  if(!Object.hasOwn(liveScopes,shopId))throw Error('unsupported live store');
  super(pool);this.writable=writable;
  this.workspaceWritable=workspaceWritable;this.shopId=shopId;this.dataSource=liveScopes[shopId].dataSchema;
  this.catalog=new CatalogStore(pool,{shopId,tx:(mode,task)=>this.tx(mode,task),writable:catalogWritable,workspaceWritable,writeImage,
   applyTemplate:(db,document,body)=>this.applyTemplate(db,document,body)});
 }
 async applyTemplate(db,template,body){
  requireValue(this.writable,'WRITES_DISABLED',405);
  const product=body.target_product_id,shop=this.shopId;
  await shopLock(db,shop,814519,'product:'+product);
  const ids=body.selection.map(entry=>entry.id.toLowerCase());
  for(const id of [...ids].sort())await shopLock(db,shop,814518,id);
  // 锁住要引用的现有链接行：其他配置保存或归档不能在核验后悄悄改变目标。
  const {rows:targets}=await db.query(`SELECT configuration_id,spu,fields,design,workspace_order::text,version::text FROM intel_live.configurations
   WHERE product_id=$1 AND shop_id=$2 AND archived_at IS NULL ORDER BY configuration_id FOR SHARE`,[product,shop]);
  const target=targets.find(row=>row.configuration_id===body.target_configuration_id);
  requireValue(target,'NOT_FOUND',404);
  if(target.version!==body.expected_target_version)throw new Fault('VERSION_CONFLICT',409,{current_version:target.version});
  const countOffset=target.fields.emptyLinkDraft===true?1:0;
  if(body.archive_empty_target){
   const {rows:[row]}=await db.query('SELECT document FROM intel_live.configuration_documents WHERE configuration_id=$1 AND shop_id=$2',[target.configuration_id,shop]);
   const c=row?.document;
   // 只在最终模板批次入库时移入回收站；有配件、售价或 SKU 的原配置不符合清理条件。
   if(!c?.emptyLinkDraft||c.skuId||(c.price!=null&&c.price!==0)||c.parts.some(p=>p.name||p.goodsId)||
    c.actualParts.some(p=>p.name||p.goodsId)||c.addons.length||c.benefits?.length)throw new Fault('VERSION_CONFLICT',409,{configuration_id:target.configuration_id});
  }
  const currentSpus=new Set(targets.map(row=>row.spu).filter(Boolean)),terms=new Set(targets.map(row=>row.fields.installment??0));
  if(currentSpus.size>1||terms.size>1)throw new Fault('VALIDATION_FAILED',400,{field:'target_product.identity'});
  if((await db.query('SELECT 1 FROM intel_live.configurations WHERE configuration_id=ANY($1::text[])',[ids])).rows.length)
   throw new Fault('CONFIGURATION_EXISTS',409);
  const available=new Map(template.configs.map(c=>[c.id,c]));
  const max=Math.max(0,...targets.map(row=>Number(row.workspace_order)));
  const documents=body.selection.map(({source_id},i)=>{
   const previous=available.get(source_id);
   failure(previous&&previous.shopId===shop,'selection.source_id');
   // 只重建目标链接身份；不借模板复制历史 SKU、报价、删除状态或后台标记。
   const document={...previous,id:ids[i],shopId:shop,productId:product,
    product:target.fields.product??'',productCategory:target.fields.productCategory??'',productUrl:target.fields.productUrl??'',
    productCardColor:target.design.productCardColor??'',spu:[...currentSpus][0]||'',skuId:'',
    installment:[...terms][0],pricingRule:target.fields.pricingRule??null,name:'配置'+(targets.length-countOffset+i+1),
    workspaceOrder:max+i+1,updatedAt:null};
   for(const k of ['sampleNote','emptyLinkDraft','deletedAt','deletionSessionId','isTemplate','templateId','productTheme'])delete document[k];
   if(['light','dark'].includes(target.design.productTheme))document.productTheme=target.design.productTheme;
   validateDocument(document,{id:ids[i],shop});
   return document;
  });
  if(body.name_format)applyNameFormatPlan(nameFormatPlan(documents,{format:body.name_format,replaceManual:body.replace_manual_names??false,shopId:shop}),documents);
  const allParts=documents.flatMap(withAddonCosts),addons=documents.flatMap(c=>c.addons);
  const deps=await dependencies(db,shop,allParts,{lock:true,addons,overrides:this.workspaceWritable});
  checkDependencies({sources:deps.sources,costs:deps.costs},deps,new Set(),documents.flatMap(c=>[
   ...c.parts.map(p=>['display',p]),...c.actualParts.map(p=>['actual',p])]));
  if(deps.effective.some(a=>!a.available))throw new Fault('INVALID_DEPENDENCY',400,{field:'addons.sourceId'});
  const urls=[...new Set(documents.flatMap(c=>[c.caseImage,...(c.posterImages||[]).map(image=>image.url)]).filter(Boolean))];
  await validateAssets(db,shop,{posterImages:urls.map(url=>({url}))});
  for(const document of documents){
   const columns=[document.id,shop,product,document.name,document.skuId,document.spu,document.workspaceOrder,document.price===null?null:Math.round(document.price*100),
    JSON.stringify(omit(document,['id','shopId','productId','name','skuId','spu','workspaceOrder','price','parts','actualParts','addons',...designKeys])),
    JSON.stringify(pick(document,designKeys))];
   await db.query('INSERT INTO intel_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',columns);
   await setParts(db,document.id,document);
  }
  if(body.archive_empty_target)await this.configurationChange(db,shop,target.configuration_id,'archive',{expected_version:target.version},body.operation_id);
  return {configuration_ids:ids,target_product_id:product,...(body.archive_empty_target?{archived_placeholder_id:target.configuration_id}:{})};
 }
 async tx(write,use){
  const connection=await this.pool.connect();
  try{
   await connection.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   // 同一店的配置和目录写入共用一个短事务门，各店锁号独立。
   if(write&&this.workspaceWritable)await connection.query('SELECT pg_advisory_xact_lock(814518,$1::integer)',[liveScopes[this.shopId].writeLock]);
   const result=await use(connection);
   await connection.query('COMMIT');return result;
  }catch(error){try{await connection.query('ROLLBACK');}catch{}throw error;}
  finally{connection.release();}
 }
 async configurations(shop,{id=null,sales=false,limit=50,offset=0,search='',archived=false,db=this.pool}={}){
  const {rows}=await db.query('SELECT '+summarySelect(this.workspaceWritable)+' '+summaryJoins(this.workspaceWritable)+
   " WHERE c.shop_id=$1 AND ($2::text IS NULL OR c.configuration_id=$2) AND (c.archived_at IS NOT NULL)=$3 AND (NOT $4::boolean OR p.published) AND ($5='' OR strpos(lower(c.name),lower($5))>0 OR strpos(c.spu,$5)>0 OR strpos(c.sku,$5)>0) ORDER BY c.workspace_order,c.configuration_id LIMIT $6 OFFSET $7",[shop,id,archived,sales,search,limit,offset]);
  return rows.map(row=>summary(row,sales));
 }
 async detail(shop,id,sales,{archived=false}={}){
  return this.tx(false,async db=>{
   const [row]=await this.configurations(shop,{id,sales,archived,db});
   if(!row)throw new Fault('NOT_FOUND',404);
   if(sales){
    const {rows:parts}=await db.query("SELECT slot,name,qty FROM intel_live.parts WHERE configuration_id=$1 AND part_kind='display' AND attrs->>'posterVisible' IS DISTINCT FROM 'false' AND name<>'' ORDER BY position",[id]);
    return {...row,parts};
   }
   const {rows:[{document}]}=await db.query('SELECT document FROM intel_live.configuration_documents WHERE shop_id=$1 AND configuration_id=$2',[shop,id]);
   const {sources,costs,effective}=await dependencies(db,shop,withAddonCosts(document),{addons:document.addons,overrides:this.workspaceWritable});
   return {...row,document,dependencies:{sources,costs},effective_addons:effective};
  });
 }
 async addons(shop,id,sales){
  return this.tx(false,async db=>{
   if(!(await this.configurations(shop,{id,sales,db})).length)throw new Fault('NOT_FOUND',404);
   const {rows}=await db.query("SELECT fields,items FROM intel_live.addons WHERE configuration_id=$1 ORDER BY position",[id]);
   const addons=rows.map(r=>({...r.fields,items:r.items}));
   const {effective}=await dependencies(db,shop,withAddonCosts({parts:[],actualParts:[],addons}),{addons,overrides:this.workspaceWritable});
   if(!sales)return effective.map(({addon,available})=>({...addon,follow_available:available}));
   // 销售只投影选中且可报价的选项，绝不发送来源原文、备注或成本。
   const offers=effective.filter(r=>r.available).flatMap(({addon})=>Array.isArray(addon.choices)?
    addon.choices.filter(c=>c.enabled===true).map(c=>({...choiceAddon(c),mode:addon.mode})):addon).map(a=>({...a,items:addonItems(a)}));
   return offers.filter(r=>Number.isSafeInteger(r.priceCents)&&r.priceCents>=0&&r.items.length&&r.items.every(i=>identity(i.goodsId)&&quantity(i.qty)))
    .map(r=>({additional_price_cents:String(r.priceCents),quotation_status:'available',
     description:typeof r.text==='string'?r.text:'',
     original_qty:quantity(r.originalQty)?r.originalQty:null,
     ...(['add','replace'].includes(r.mode)?{mode:r.mode}:{}),
     items:r.items.map(i=>({goodsid:i.goodsId,qty:i.qty,...(['add','replace'].includes(i.mode)?{mode:i.mode}:{}),
      ...(quantity(i.originalQty)?{original_qty:i.originalQty}:{})}))}));
  });
 }
 async resource(shop,kind,id){
  if(kind==='costs'){
   const [row]=await effectiveCosts(this.pool,shop,[id],this.workspaceWritable);
   if(!row)throw new Fault('NOT_FOUND',404);
   return {id:row.goodsid,version:row.version,document:row.document};
  }
  const resources={
   sources:"SELECT source_id AS id,version::text,attrs||jsonb_build_object('sourceId',source_id,'goodsId',goodsid,'name',name) AS document FROM intel_live.sources WHERE (owner_shop=$1 OR owner_shop='shared' OR shared) AND attrs->>'deletedAt' IS NULL",
   templates:"SELECT template_id AS id,version::text,attrs||jsonb_build_object('id',template_id,'shopId',shop_id,'name',name,'configs',configurations) AS document FROM intel_live.templates WHERE shop_id=$1 AND attrs->>'deletedAt' IS NULL",
   gallery:"SELECT g.gallery_id AS id,g.version::text,g.attrs||jsonb_build_object('id',g.gallery_id,'brand',g.brand,'model',g.model,'color',g.color,'edition',g.edition,'url','/images/'||a.sha256||'.'||a.extension) AS document FROM intel_live.gallery g JOIN intel_live.assets a USING(legacy_uri) WHERE (g.owner_shop=$1 OR g.owner_shop='shared' OR g.shared) AND g.attrs->>'deletedAt' IS NULL"
  };
  requireValue(own(resources,kind),'NOT_FOUND',404);
  const {rows:[row]}=await this.pool.query('SELECT * FROM ('+resources[kind]+') v WHERE v.id=$2',[shop,id]);
  if(!row)throw new Fault('NOT_FOUND',404);
  return row;
 }
 async lookupReceipt(member,shop,op){
  const query=db=>db.query('SELECT result FROM intel_live.save_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3 AND shop_id=$4',[member.workspaceId,member.uid,op,shop]);
  const {rows:[row]}=await (this.shopId==='intel'?query(this.pool):this.tx(false,async db=>{
   await this.catalog.bind(db,member);
   return query(db);
  }));
  if(!row)throw new Fault('RECEIPT_NOT_FOUND',404);
  return row.result;
 }
 async workspaceIndex(shop){
  return this.tx(false,async db=>{
   const {rows:[info]}=await db.query('SELECT loaded_at, shop_id FROM intel_live.bootstrap WHERE shop_id=$1',[shop]);
   if(!info)throw new Fault('NOT_FOUND',404);
   // 左侧目录只带定位和搜索字段；完整编辑文档始终另取，不能拿摘要保存。
   const {rows}=await db.query(`SELECT c.version::text AS server_version, jsonb_build_object(
    'id',c.configuration_id,'shopId',c.shop_id,'productId',c.product_id,'name',c.name,'skuId',c.sku,'spu',c.spu,
    'workspaceOrder',c.workspace_order,'price',c.workbench_price_cents/100.0,
    'product',c.fields->'product','productCategory',c.fields->'productCategory','productUrl',c.fields->'productUrl',
    'productCardColor',c.design->'productCardColor','version',c.fields->'version','shortName',c.fields->'shortName',
    'installment',c.fields->'installment','pricingRule',c.fields->'pricingRule','emptyLinkDraft',c.fields->'emptyLinkDraft',
    'parts',coalesce((SELECT jsonb_agg(jsonb_build_object('slot',p.slot,'name',p.name,'qty',p.qty,'goodsId',p.goodsid) ORDER BY p.position)
      FROM intel_live.parts p WHERE p.configuration_id=c.configuration_id AND p.part_kind='display'),'[]'::jsonb)
   ) AS summary FROM intel_live.configurations c WHERE shop_id=$1 AND archived_at IS NULL ORDER BY workspace_order,configuration_id`,[shop]);
   return {revision:sha(JSON.stringify(rows.map(r=>[r.summary.id,r.server_version]))),updatedAt:info.loaded_at,
    summaries:rows.map(r=>this.workspaceWritable?{...r.summary,nasVersion:r.server_version}:r.summary)};
  });
 }
 async workspaceCatalog(shop){
  return this.tx(false,async db=>{
   const {rows:[entry]}=await db.query('SELECT profile,settings FROM intel_live.shops WHERE shop_id=$1',[shop]);
   if(!entry)throw new Fault('NOT_FOUND',404);
   const sourceCatalog=(await db.query(`SELECT attrs||jsonb_build_object('sourceId',source_id,'goodsId',goodsid,'name',name) AS document
    FROM intel_live.sources WHERE (owner_shop=$1 OR owner_shop='shared' OR shared) AND attrs->>'deletedAt' IS NULL ORDER BY source_id`,[shop])).rows.map(r=>r.document);
   const costs=await effectiveCosts(db,shop,null,this.workspaceWritable),costSource=costs.map(row=>row.document);
   const [shopOverride]=this.workspaceWritable?(await db.query('SELECT settings,version::text FROM intel_live.intel_settings_overrides WHERE shop_id=$1',[shop])).rows:[];
   // 原主编辑器选图仍保存登记的 /uploads 引用，实际内容由摘要路由单独读取。
   const caseGallery=(await db.query(`SELECT g.attrs||jsonb_build_object('id',g.gallery_id,'brand',g.brand,'model',g.model,
    'color',g.color,'edition',g.edition,'url',g.legacy_uri) AS document FROM intel_live.gallery g
    JOIN intel_live.assets a USING(legacy_uri) WHERE (g.owner_shop=$1 OR g.owner_shop='shared' OR g.shared)
    AND g.attrs->>'deletedAt' IS NULL ORDER BY g.gallery_id`,[shop])).rows.map(r=>r.document);
   return {dataVersion:3,shops:[entry.profile],shopSettings:{[shop]:shopOverride?.settings??entry.settings},sourceCatalog,costSource,caseGallery,templates:[],logs:[],
    ...(this.workspaceWritable?{costVersions:Object.fromEntries(costs.map(row=>[row.goodsid,row.version])),settingsVersion:shopOverride?.version??null}:{})};
  });
 }
 async configurationChange(db,shop,id,action,body,op){
   // 先锁定单配置，即使新建记录尚不存在也能校验同一标识的并发请求。
   await shopLock(db,shop,814518,id);
   const {rows:[old]}=await db.query('SELECT version::text,archived_at,spu,sku FROM intel_live.configurations WHERE shop_id=$1 AND configuration_id=$2 FOR UPDATE',[shop,id]);
   if(action==='create'){
    if(old)throw new Fault('CONFIGURATION_EXISTS',409);
   }else{
    if(!old)throw new Fault('NOT_FOUND',404);
    if(old.version!==body.expected_version)throw new Fault('VERSION_CONFLICT',409,{current_version:old.version});
    if(!!old.archived_at!==(action==='restore'))throw new Fault('INVALID_CONFIGURATION_STATE',409);
   }
   let next;
   if(action==='create'||action==='replace'){
    const document=body.document;
    if(document.skuId&&(!old||old.sku!==document.skuId||old.spu!==document.spu)){
     const duplicate=await db.query('SELECT 1 FROM intel_live.configurations WHERE shop_id=$1 AND spu=$2 AND sku=$3 AND configuration_id<>$4 AND archived_at IS NULL LIMIT 1',[shop,document.spu,document.skuId,id]);
     if(duplicate.rows.length)throw new Fault('SKU_ALREADY_USED',409);
    }
    if(old&&(old.spu!==document.spu||old.sku!==document.skuId)){
     const {rows}=await db.query("SELECT 1 FROM intel_live.quotations WHERE configuration_id=$1 AND status='matched'",[id]);
     if(rows.length)throw new Fault('QUOTATION_REVIEW_REQUIRED',409,{field:'document.skuId/spu'});
     await db.query('SELECT intel_live.withdraw_publication($1)',[id]);
    }
    const oldParts=old?(await db.query('SELECT part_kind,line_id,source_id FROM intel_live.parts WHERE configuration_id=$1 AND source_id IS NOT NULL',[id])).rows:[];
    const oldSet=new Set(oldParts.map(p=>JSON.stringify([p.part_kind,p.line_id,p.source_id])));
    const parts=withAddonCosts(document);
    const deps=await dependencies(db,shop,parts,{lock:true,addons:document.addons,overrides:this.workspaceWritable});
    checkDependencies(body.dependencies,deps,oldSet,[...document.parts.map(p=>['display',p]),...document.actualParts.map(p=>['actual',p])]);
    if(deps.effective.some(item=>!item.available))throw new Fault('INVALID_DEPENDENCY',400,{field:'addons.sourceId'});
    await validateAssets(db,shop,document);
    const columns=[id,shop,document.productId,document.name,document.skuId,document.spu,document.workspaceOrder,document.price===null?null:Math.round(document.price*100),
     JSON.stringify(omit(document,['id','shopId','productId','name','skuId','spu','workspaceOrder','price','parts','actualParts','addons',...designKeys])),
     JSON.stringify(pick(document,designKeys))];
    await db.query('INSERT INTO intel_live.products(shop_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[shop,document.productId]);
    const query=action==='create'?
     'INSERT INTO intel_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING version::text':
     'UPDATE intel_live.configurations SET product_id=$3,name=$4,sku=$5,spu=$6,workspace_order=$7,workbench_price_cents=$8,fields=$9,design=$10,version=version+1 WHERE configuration_id=$1 AND shop_id=$2 RETURNING version::text';
    next=(await db.query(query,columns)).rows[0].version;
    await setParts(db,id,document);
   }else if(action==='design'){
    await validateAssets(db,shop,body.design);
    next=(await db.query('UPDATE intel_live.configurations SET design=$3,version=version+1 WHERE configuration_id=$1 AND shop_id=$2 RETURNING version::text',[id,shop,JSON.stringify(body.design)])).rows[0].version;
   }else{
    next=(await db.query('UPDATE intel_live.configurations SET archived_at=CASE WHEN $3::boolean THEN now() ELSE NULL END,version=version+1 WHERE configuration_id=$1 AND shop_id=$2 RETURNING version::text',[id,shop,action==='archive'])).rows[0].version;
    if(action==='archive')await db.query('SELECT intel_live.withdraw_publication($1)',[id]);
   }
   const result={configuration_id:id,shop_id:shop,operation_id:op,version:next,archived:action==='archive'};
   return {result,previousVersion:old?.version||null};
 }
 async save(member,shop,id,action,body,requestId){
  requireValue(shop===this.shopId,'FORBIDDEN',403);
  requireValue(this.writable,'WRITES_DISABLED',405);
  failure(plain(body)&&operationId(body.operation_id),'operation_id');
  const op=body.operation_id.toLowerCase();
  const item=omit(body,['operation_id']);
  validateChange(shop,id,action,item);
  const hash=sha(canonical({shop,id,action,...body,operation_id:op}));
  return this.tx(true,async db=>{
   // 同一员工的相同请求串行校验。唯一约束同时兜底，写回执之前不提前提交。
   await shopLock(db,shop,814517,JSON.stringify([member.workspaceId,member.uid,op]));
   const {rows:roles}=await db.query("SELECT r.shop_id,r.role FROM nas_business.members m JOIN nas_business.shop_roles r USING(workspace_id,uid) WHERE m.workspace_id=$1 AND m.uid=$2 AND m.enabled",[member.workspaceId,member.uid]);
   authorize(roles,shop,false);
   if(this.workspaceWritable||shop!=='intel')await this.catalog.bind(db,member);
   const {rows:[receipt]}=await db.query('SELECT request_sha256,result FROM intel_live.save_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3',[member.workspaceId,member.uid,op]);
   if(receipt){
    if(receipt.request_sha256!==hash)throw new Fault('OPERATION_REUSED',409);
    return receipt.result;
   }
   if(this.catalog.writable&&(await db.query('SELECT 1 FROM intel_live.catalog_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3',[member.workspaceId,member.uid,op])).rows.length)
    throw new Fault('OPERATION_REUSED',409);
   if(this.workspaceWritable){
    if(await this.workspaceReceiptRow(db,[member.workspaceId,member.uid,op]))throw new Fault('OPERATION_REUSED',409);
   }
   const {result,previousVersion}=await this.configurationChange(db,shop,id,action,item,op);
   await db.query('INSERT INTO intel_live.save_receipts(workspace_id,actor_uid,operation_id,shop_id,configuration_id,request_sha256,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[member.workspaceId,member.uid,op,shop,id,hash,JSON.stringify(result)]);
   await db.query('INSERT INTO intel_live.audit_events(workspace_id,actor_uid,operation_id,shop_id,configuration_id,action,previous_version,next_version,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[member.workspaceId,member.uid,op,shop,id,action,previousVersion,result.version,requestId]);
   return result;
  });
 }
 async workspaceReceiptRow(db,actor){
  return (await db.query('SELECT kind,request_sha256,result FROM intel_live.workspace_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3',actor)).rows[0];
 }
 async workspaceReceipt(member,shop,id){
  requireValue(this.workspaceWritable,'WRITES_DISABLED',405);
  return this.tx(false,async db=>{
   await this.catalog.bind(db,member);
   const receipt=await this.workspaceReceiptRow(db,[member.workspaceId,member.uid,id]);
   if(!receipt||receipt.result.shop_id!==shop)throw new Fault('NOT_FOUND',404);
   return receipt.result;
  });
 }
 async workspaceOperation(member,shop,kind,body,requestId,apply){
  requireValue(this.workspaceWritable,'WRITES_DISABLED',405);
  failure(shop===this.shopId&&plain(body)&&operationId(body.operation_id),'operation_id');
  const op=body.operation_id.toLowerCase(),actor=[member.workspaceId,member.uid,op];
  const hash=sha(canonical({shop,kind,...body,operation_id:op}));
  return this.tx(true,async db=>{
   await this.catalog.bind(db,member);
   await shopLock(db,shop,814517,JSON.stringify(actor));
   const prior=await this.workspaceReceiptRow(db,actor);
   if(prior){
    if(prior.request_sha256!==hash||prior.kind!==kind)throw new Fault('OPERATION_REUSED',409);
    return prior.result;
   }
   for(const table of ['save_receipts','catalog_receipts'])
    if((await db.query('SELECT 1 FROM intel_live.'+table+' WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3',actor)).rows.length)
     throw new Fault('OPERATION_REUSED',409);
   const changes=await apply(db,op),result={shop_id:shop,operation_id:op,kind,changes:changes.map(row=>row.result)};
   await db.query('INSERT INTO intel_live.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [...actor,shop,kind,hash,JSON.stringify(result)]);
   for(const [index,row] of changes.entries())
    await db.query('INSERT INTO intel_live.workspace_audit(workspace_id,actor_uid,operation_id,position,resource_id,action,previous_version,next_version,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
     [...actor,index+1,row.id,row.action,row.previousVersion,row.result.version,requestId]);
   return result;
  });
 }
 async workspaceBatch(member,shop,body,requestId){
  failure(plain(body)&&Object.keys(body).every(k=>['operation_id','changes','group'].includes(k))&&Array.isArray(body.changes)&&
   body.changes.length>0&&body.changes.length<=100,'changes');
  const group=body.group;
  const items=body.changes.map(item=>{
   failure(plain(item),'change');
   const {id,action,...doc}=item;
   validateChange(shop,id,action,doc);
   if(action==='create')failure(doc.document.skuId===''||group?.configuration_ids?.length>0&&doc.document.productId===group.product_id&&
    /^\d{1,24}$/.test(doc.document.skuId)&&/^\d{1,24}$/.test(doc.document.spu),'document.skuId');
   return {id,action,doc};
  });
  failure(new Set(items.map(item=>item.id)).size===items.length,'changes.id');
  if(group!==undefined)failure(plain(group)&&Object.keys(group).length===2&&identity(group.product_id)&&Array.isArray(group.configuration_ids)&&
   group.configuration_ids.length<=5000&&new Set(group.configuration_ids).size===group.configuration_ids.length&&group.configuration_ids.every(identity),'group');
  return this.workspaceOperation(member,shop,'configurations',body,requestId,async(db,op)=>{
   if(group){
    const {rows}=await db.query('SELECT configuration_id,spu FROM intel_live.configurations WHERE shop_id=$1 AND product_id=$2 AND archived_at IS NULL ORDER BY configuration_id',[shop,group.product_id]);
    if(JSON.stringify(rows.map(r=>r.configuration_id).sort())!==JSON.stringify([...group.configuration_ids].sort()))
     throw new Fault('PRODUCT_MEMBERS_CHANGED',409);
    if(items.some(row=>row.action==='create'&&row.doc.document.skuId&&rows.some(target=>target.spu&&target.spu!==row.doc.document.spu)))
     throw new Fault('PRODUCT_MEMBERS_CHANGED',409);
   }
   const ordered=[...items].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),byId=new Map();
   for(const {id,action,doc} of ordered){
    try{byId.set(id,{id,action,...await this.configurationChange(db,shop,id,action,doc,op)});}
    catch(error){if(error instanceof Fault)error.details={...error.details,configuration_id:id};throw error;}
   }
   return items.map(item=>byId.get(item.id));
  });
 }
 async workspaceImportPreview(body){
  requireValue(this.workspaceWritable,'WRITES_DISABLED',405);
  failure(plain(body)&&Object.keys(body).length===1&&Array.isArray(body.images)&&body.images.length<=5000&&
   body.images.every(path=>typeof path==='string'&&/^\/uploads\/[a-f0-9]{64}\.(png|jpe?g)$/.test(path)),'images');
  const {rows}=await this.pool.query('SELECT legacy_uri FROM intel_live.assets WHERE legacy_uri=ANY($1::text[])',[body.images]);
  return {found:rows.map(row=>row.legacy_uri)};
 }
 async workspaceActivity(member,limit){
  requireValue(this.workspaceWritable,'WRITES_DISABLED',405);
  return this.tx(false,async db=>{
   await this.catalog.bind(db,member);
   return (await db.query('SELECT kind,resource_id,action,next_version::text,created_at FROM intel_live.operations_activity($1)',[limit])).rows;
  });
 }
 async workspaceActivityPage(member,{from,to,page,size}){
  requireValue(this.workspaceWritable,'WRITES_DISABLED',405);
  return this.tx(false,async db=>{
   await this.catalog.bind(db,member);
   const {rows:[{data}]}=await db.query('SELECT intel_live.operations_activity_page($1::date,$2::date,$3::integer,$4::integer) AS data',[from,to,page,size]);
   return {...data,rows:data.rows.map(({own_operation,...row})=>({...row,operator:own_operation?member.name||'':''}))};
  });
 }
 async workspaceProfit(member,shop,action,input){
  const write=['start','reset'].includes(action);
  if(write)requireValue(this.workspaceWritable,'WRITES_DISABLED',405);
  return this.tx(write,async db=>{
   await this.catalog.bind(db,member);
   // 身份、已保存配置、实际 BOM、店铺规则和生效成本都从同一个工作区取。
   return runNasProfit(db,action,input,async(ids)=>{
    const {rows:documents}=await db.query(`SELECT d.document,c.version::text AS version FROM intel_live.configuration_documents d
     JOIN intel_live.configurations c USING(configuration_id) WHERE c.shop_id=$1 AND c.archived_at IS NULL AND c.configuration_id=ANY($2::text[])`,[shop,ids]);
    const goods=[...new Set(documents.flatMap(({document})=>(document.actualParts??document.parts??[]).map(p=>p.goodsId).filter(Boolean)))];
    const costs=new Map((await effectiveCosts(db,shop,goods,this.workspaceWritable)).map(row=>[row.goodsid,row.document]));
    const configs=documents.map(({document,version})=>({...document,nasVersion:version,actualParts:(document.actualParts??document.parts??[]).map(part=>{
     const cost=costs.get(part.goodsId);return cost?.nasTaxOverride&&own(cost,'tax')?{...part,tax:cost.tax}:part;
    })}));
    const grouped=[...new Set(configs.map(c=>c.productId))];
    const {rows:linkConfigs}=await db.query(`SELECT configuration_id AS id,shop_id AS "shopId",product_id AS "productId",fields->'installment' AS installment,fields?'installment' AS has_installment
     FROM intel_live.configurations WHERE shop_id=$1 AND archived_at IS NULL AND product_id=ANY($2::text[])`,[shop,grouped]);
    for(const entry of linkConfigs)if(!entry.has_installment)delete entry.installment;
    const {rows:[row]}=await db.query(`SELECT coalesce(o.settings,s.settings) AS settings FROM intel_live.shops s
     LEFT JOIN intel_live.intel_settings_overrides o USING(shop_id) WHERE s.shop_id=$1`,[shop]);
    return {configs,linkConfigs,settings:row?.settings};
   },shop);
  });
 }
 async workspaceSourceUsage(shop,input){
  failure(plain(input)&&Object.keys(input).every(key=>['sources','goods'].includes(key))&&
   ['sources','goods'].every(key=>Array.isArray(input[key])&&input[key].length<=5000&&input[key].every(identity)),'source_usage');
  // 原跟随预览按源引用和实际配件查找，不能仅从左侧列表的展示摘要推断。
  const {rows}=await this.pool.query(`SELECT c.configuration_id AS id FROM intel_live.configurations c
   WHERE c.shop_id=$1 AND c.archived_at IS NULL AND (
    EXISTS (SELECT FROM intel_live.parts p WHERE p.configuration_id=c.configuration_id AND (p.source_id=ANY($2) OR p.goodsid=ANY($3)))
    OR EXISTS (SELECT FROM intel_live.addons a WHERE a.configuration_id=c.configuration_id AND a.fields->>'sourceId'=ANY($2)))
   ORDER BY c.workspace_order,c.configuration_id`,[shop,input.sources,input.goods]);
  return rows.map(row=>row.id);
 }
 async workspacePriceHistory(member,action,input){
  const keys={list:['offset'],detail:['revision','offset'],day:[],handle:['revision','configId','handled']};
  failure(plain(input)&&own(keys,action)&&Object.keys(input).every(k=>keys[action].includes(k)),'price_history');
  if(action==='detail'||action==='handle')failure(Number.isSafeInteger(input.revision)&&input.revision>0,'revision');
  if(own(input,'offset'))failure(Number.isSafeInteger(input.offset)&&input.offset>=0&&input.offset<=(action==='detail'?5000:100000),'offset');
  if(action==='handle')failure(identity(input.configId)&&typeof input.handled==='boolean','handled');
  if(action==='handle')requireValue(this.workspaceWritable,'WRITES_DISABLED',405);
  return this.tx(action==='handle',async db=>{
   await this.catalog.bind(db,member);
   const result=await priceHistoryAction(db,action,input);
   if(action==='detail'){
    const {rows}=await db.query(`SELECT d.document FROM intel_live.configuration_documents d JOIN intel_live.configurations c USING(configuration_id)
     WHERE c.shop_id=$2 AND c.archived_at IS NULL AND c.configuration_id=ANY($1)`,[result.configs.map(row=>row.after.id),this.shopId]);
    result.current=priceHistoryCurrent(await this.priceHistoryInputs(db,this.shopId,rows.map(row=>row.document)));
   }
   return result;
  });
 }
 async priceHistoryInputs(db,shop,configs){
  const products=[...new Set(configs.map(row=>row.productId))];
  const allGoods=[...new Set(configs.flatMap(c=>(c.actualParts??c.parts).map(p=>p.goodsId).filter(Boolean)))];
  const costs=new Map((await effectiveCosts(db,shop,allGoods,true)).map(row=>[row.goodsid,row.document]));
  const {rows:linkConfigs}=await db.query(`SELECT product_id AS "productId",fields->'installment' AS installment,
   fields?'installment' AS has_installment FROM intel_live.configurations WHERE shop_id=$1 AND archived_at IS NULL AND product_id=ANY($2)`,[shop,products]);
  for(const row of linkConfigs)if(!row.has_installment)delete row.installment;
  const {rows:[{settings}]}=await db.query('SELECT coalesce(o.settings,s.settings) AS settings FROM intel_live.shops s LEFT JOIN intel_live.intel_settings_overrides o USING(shop_id) WHERE s.shop_id=$1',[shop]);
  return {configs,linkConfigs,settings,costs};
 }
 async recordPriceHistory(db,shop,op,changes,message){
  // 可先安装结构再切API；试验/旧数据库仍可运行原有成本维护，不补造此前历史。
  const {rows:[status]}=await db.query("SELECT to_regprocedure('intel_live.operations_price_history(text,jsonb)') IS NOT NULL AS installed");
  if(!status.installed)return;
  const goods=[...changes.keys()];
  const {rows:documents}=await db.query(`SELECT d.document FROM intel_live.configuration_documents d JOIN intel_live.configurations c USING(configuration_id)
   WHERE c.shop_id=$1 AND c.archived_at IS NULL AND c.fields->'emptyLinkDraft' IS DISTINCT FROM 'true'::jsonb AND c.fields->>'productCategory' IS DISTINCT FROM '主机模板'
   AND EXISTS (SELECT FROM intel_live.parts p WHERE p.configuration_id=c.configuration_id AND p.part_kind='actual' AND p.goodsid=ANY($2))
   ORDER BY c.configuration_id`,[shop,goods]);
  const snapshot=priceHistorySnapshot({...await this.priceHistoryInputs(db,shop,documents.map(row=>row.document)),changes});
  if(snapshot.items.length)await priceHistoryAction(db,'append',{operationId:op,message,...snapshot});
 }
 async workspaceQuotations(shop,id){
  requireValue(this.workspaceWritable,'WRITES_DISABLED',405);
  const {rows:[row]}=await this.pool.query(`SELECT c.configuration_id,c.shop_id,c.spu,c.sku AS sku_id,c.version::text,
   coalesce(o.amount_cents,q.amount_cents)::text AS amount_cents,
   coalesce(o.workbook_sha256,q.workbook_sha256) AS workbook_sha256,
   CASE WHEN o.workbook_row IS NOT NULL THEN jsonb_build_array(o.workbook_row) ELSE q.workbook_rows END AS workbook_rows,
   coalesce(p.published,false) AS published
   ${summaryJoins(true)} WHERE c.shop_id=$1 AND c.configuration_id=$2 AND c.archived_at IS NULL`,[shop,id]);
  if(!row)throw new Fault('NOT_FOUND',404);
  return row;
 }
 async workspaceMaintain(member,shop,kind,body,requestId){
  const expectedVersion=v=>v===null||version(v);
  failure(plain(body)&&Object.keys(body).every(k=>['operation_id','changes'].includes(k))&&Array.isArray(body.changes)&&
   body.changes.length>0&&body.changes.length<=100&&body.changes.every(row=>plain(row)&&identity(row.id)&&
    expectedVersion(row.expected_version))&&new Set(body.changes.map(row=>row.id)).size===body.changes.length,'changes');
  const entries=body.changes;
  const validated=(row,keys)=>failure(Object.keys(row).every(k=>['id','action','expected_version',...keys].includes(k)),'changes');
  const cents=c=>typeof c==='string'&&/^(?:0|[1-9]\d{0,14})$/.test(c);
  for(const row of entries){
   if(kind==='costs'){
    validated(row,['fields']);
    const f=row.fields;
    failure(/^\d{1,20}$/.test(row.id)&&plain(f)&&safeValue(f)&&Object.keys(f).length&&['erp_snapshot','tax_edit','tax_file'].includes(row.action),'changes.costs');
    const erp=row.action==='erp_snapshot';
    failure(Object.keys(f).every(k=>(erp?['erp','stockAvailable','name','sku','stockUpdatedAt']:['tax','taxUpdatedAt']).includes(k))&&
     (erp?own(f,'erp')&&own(f,'stockAvailable'):own(f,'tax')),'changes.cost_fields');
    for(const k of ['erp','tax'])if(own(f,k))failure(f[k]===null||(typeof f[k]==='number'&&Number.isFinite(f[k])&&f[k]>=0&&f[k]<=Number.MAX_SAFE_INTEGER/100),'changes.'+k);
    if(own(f,'stockAvailable'))failure(f.stockAvailable===null||(typeof f.stockAvailable==='number'&&Number.isFinite(f.stockAvailable)&&Math.abs(f.stockAvailable)<=Number.MAX_SAFE_INTEGER),'changes.stockAvailable');
    for(const k of ['name','sku','stockUpdatedAt','taxUpdatedAt'])if(own(f,k))failure(goodText(f[k],512),'changes.'+k);
   }else if(kind==='settings'){
    validated(row,['fields']);
    const f=row.fields;
    failure(row.id===shop&&row.action==='replace'&&plain(f)&&safeValue(f)&&Object.keys(f).length&&
     Object.keys(f).every(k=>['coupon','serviceText','erpShopId','erpShopName','pricingRule','profitAlert','posterView'].includes(k)),'changes.settings');
    if(own(f,'coupon'))failure(price(f.coupon),'changes.coupon');
    if(own(f,'serviceText'))failure(typeof f.serviceText==='string'&&f.serviceText.length<=1000,'changes.serviceText');
    if(own(f,'erpShopId'))failure(typeof f.erpShopId==='string'&&/^(?:|\d{1,20})$/.test(f.erpShopId),'changes.erpShopId');
    if(own(f,'erpShopName'))failure(goodText(f.erpShopName,200),'changes.erpShopName');
    if(own(f,'pricingRule'))failure(pricingRuleOk(f.pricingRule),'changes.pricingRule');
    if(own(f,'profitAlert'))failure(profitAlertOk(f.profitAlert),'changes.profitAlert');
    if(own(f,'posterView'))failure(plain(f.posterView)&&Object.keys(f.posterView).length===2&&['long','square'].includes(f.posterView.layout)&&['padded','dedicated'].includes(f.posterView.skuMode),'changes.posterView');
   }else if(kind==='quotations'){
    validated(row,row.action==='select_workbook'?['spu','sku','amount_cents','workbook_sha256','workbook_row']:[]);
    failure(version(row.expected_version)&&['select_workbook','publish','withdraw'].includes(row.action),'changes.quotation');
    // 新迁店允许维护报价；销售发布须另授权，不能随运营迁移一并打开。
    requireValue(row.action!=='publish'||shop==='intel','SALES_PUBLICATION_DISABLED',403);
    if(row.action==='select_workbook')failure(/^\d{1,24}$/.test(row.spu||'')&&/^\d{1,24}$/.test(row.sku||'')&&cents(row.amount_cents)&&
     /^[a-f0-9]{64}$/.test(row.workbook_sha256||'')&&Number.isInteger(row.workbook_row)&&row.workbook_row>0&&row.workbook_row<=1048576,'changes.workbook');
   }else throw new Fault('NOT_FOUND',404);
  }
  return this.workspaceOperation(member,shop,kind,body,requestId,async(db,op)=>{
   const rows=[],priceChanges=new Map();
   for(const row of entries){
    const {id,action,fields}=row;let previousVersion,updated;
    if(kind==='costs'){
     const [old]=await effectiveCosts(db,shop,[id],true);
     previousVersion=old?.version??null;
     if(previousVersion!==row.expected_version)throw new Fault('VERSION_CONFLICT',409,{goods_id:id,current_version:previousVersion});
     const document={...old?.document,...fields,goodsId:id};
     if(action==='erp_snapshot'){document.erpMissing=false;document.erpUnknown=fields.erp===null;document.stockMissing=false;document.nasErpOverride=true;}
     else document.nasTaxOverride=true;
     if(document.tax!==old?.document.tax||document.erp!==old?.document.erp||document.erpUnknown!==old?.document.erpUnknown||document.erpMissing!==old?.document.erpMissing)
      priceChanges.set(id,{before:old?.document,after:document});
     updated=(BigInt(previousVersion||'0')+1n).toString();
     await db.query(`INSERT INTO intel_live.intel_cost_overrides(goodsid,document,version) VALUES($1,$2,$3)
      ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version`,[id,JSON.stringify(document),updated]);
    }else if(kind==='settings'){
     const {rows:[old]}=await db.query(`SELECT coalesce(o.settings,s.settings) AS settings,o.version::text FROM intel_live.shops s
      LEFT JOIN intel_live.intel_settings_overrides o USING(shop_id) WHERE s.shop_id=$1`,[shop]);
     previousVersion=old.version;
     if(previousVersion!==row.expected_version)throw new Fault('VERSION_CONFLICT',409,{current_version:previousVersion});
     updated=(BigInt(previousVersion||'0')+1n).toString();
     await db.query(`INSERT INTO intel_live.intel_settings_overrides(shop_id,settings,version) VALUES($1,$2,$3)
      ON CONFLICT(shop_id) DO UPDATE SET settings=excluded.settings,version=excluded.version`,[shop,JSON.stringify({...old.settings,...fields}),updated]);
    }else{
     const {rows:[old]}=await db.query('SELECT sku,spu,version::text FROM intel_live.configurations WHERE configuration_id=$1 AND shop_id=$2 AND archived_at IS NULL FOR UPDATE',[id,shop]);
     if(!old)throw new Fault('NOT_FOUND',404);
     previousVersion=old.version;
     if(previousVersion!==row.expected_version)throw new Fault('VERSION_CONFLICT',409,{configuration_id:id,current_version:previousVersion});
     updated=(BigInt(previousVersion)+1n).toString();
     if(action==='select_workbook'){
      if(old.sku!==row.sku||old.spu!==row.spu)throw new Fault('QUOTATION_IDENTITY_MISMATCH',409);
      await db.query(`INSERT INTO intel_live.intel_quotation_overrides(configuration_id,sku,spu,amount_cents,workbook_sha256,workbook_row,version)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(configuration_id) DO UPDATE SET sku=excluded.sku,spu=excluded.spu,
       amount_cents=excluded.amount_cents,workbook_sha256=excluded.workbook_sha256,workbook_row=excluded.workbook_row,version=excluded.version`,
       [id,row.sku,row.spu,row.amount_cents,row.workbook_sha256,row.workbook_row,updated]);
     }
     const {rows:[changed]}=await db.query('SELECT intel_live.set_quotation_publication($1,$2) AS ok',[id,action==='publish']);
     if(!changed.ok)throw new Fault('QUOTATION_NOT_AVAILABLE',409);
     await db.query('UPDATE intel_live.configurations SET version=$2 WHERE configuration_id=$1',[id,updated]);
    }
    rows.push({id,action,previousVersion,result:{id,version:updated,...(kind==='quotations'?{published:action==='publish'}:{})}});
   }
   if(priceChanges.size)await this.recordPriceHistory(db,shop,op,priceChanges,entries.every(row=>row.action==='erp_snapshot')?'ERP 库存与成本同步':entries.every(row=>row.action==='tax_file')?'含税成本表更新':'成本价维护');
   return rows;
  });
 }
}
