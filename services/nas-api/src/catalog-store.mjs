/** 目录写入只接受原账号授权的店铺，行版本、修改审计和回执同事务。 */
import {createHash} from 'node:crypto';
import {Fault,requireValue} from './config.mjs';
import {shopLock} from './shop-scope.mjs';
import {foreignGalleryPrefix,lockGalleryAsset,sharedGalleryRows} from './shared-gallery.mjs';
import {adoptErpSource,listSharedSources,validateErpAdoption,validateSharedSourceEdit,writeSharedSource,sharedSourceVersions} from './shared-sources.mjs';
import {sourceGoodsId} from '../../../apps/desktop/public/workbench/shared-source-fields.js';
import {sourceAddon,validateAddon} from '../../../apps/desktop/public/workbench/addon-data.js';

export const sharedAddonFields=['addonText','addonNote','addonGoodsId','addonPriceCents','addonQty','addonItems',
 'addonOriginalQty','addonVariants','addonShowTogether','addonChoices','addonMode'];
const kinds=new Set(['sources','addons','gallery','templates','assets','shared-sources']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validVersion=v=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const own=(o,k)=>Object.hasOwn(o,k);
const text=(value,max=256)=>typeof value==='string'&&value.length<=max&&!value.includes('\u0000');
const idOk=value=>text(value)&&value.length>0&&!/[\x00-\x1f\x7f]/.test(value)&&value!=='.'&&value!=='..';
const validation=(ok,field)=>{if(!ok)throw new Fault('VALIDATION_FAILED',400,{field});};
const assetRef=value=>typeof value==='string'&&/^\/uploads\/[0-9a-f]{64}\.(?:png|jpg|jpeg)$/.test(value);
const partRef=value=>typeof value==='string'&&value.length>0;
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':plain(value)?
 '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
const safe=(value,n=0)=>n<32&&(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||
 text(value,262144)||Array.isArray(value)&&value.length<=4000&&value.every(v=>safe(v,n+1))||
 plain(value)&&Object.keys(value).length<=500&&Object.entries(value).every(([k,v])=>text(k)&&!['__proto__','prototype','constructor'].includes(k)&&safe(v,n+1)));
const without=(document,keys)=>Object.fromEntries(Object.entries(document).filter(([k])=>!keys.includes(k)));
const subset=(document,keys)=>Object.fromEntries(keys.filter(k=>own(document,k)).map(k=>[k,document[k]]));
const existsValue=(path,bind)=>"jsonb_path_exists("+path+",'$.** ? (@ == $ref)',jsonb_build_object('ref',"+bind+"::text))";
const descriptor=kind=>kind==='sources'||kind==='addons'?{
 table:'sources',id:'source_id',owner:'owner_shop',share:'shared',kind:'sources',
 doc:"attrs||jsonb_build_object('sourceId',source_id,'goodsId',goodsid,'name',name)"
}:kind==='gallery'?{
 table:'gallery',id:'gallery_id',owner:'owner_shop',share:'shared',kind:'gallery',
 doc:"attrs||jsonb_build_object('id',gallery_id,'url',legacy_uri,'brand',brand,'model',model,'color',color,'edition',edition)"
}:kind==='templates'?{
 table:'templates',id:'template_id',owner:'shop_id',share:'false',kind:'templates',
 doc:"attrs||jsonb_build_object('id',template_id,'shopId',shop_id,'name',name,'configs',configurations)"
}:null;
function mayWrite(row,grants,group,shop){
 // 新店只有本店目录写权限；共享快照仍可读、可按旧合同复制到本店。
 return row.owner_shop===shop&&!row.shared ||
  shop==='intel'&&(row.owner_shop===shop||row.owner_shop==='shared')&&grants.has(group);
}
const archives=document=>!!document?.deletedAt;
const operationalAttrs=['id','sourceId','name','goodsId','owner_shop','ownerShop','shared','version','resource_version'];
function validateSource(doc,id,shop){
 validation(doc.sourceId===id&&doc.shopId===shop,'document.sourceId/shopId');
 validation(text(doc.goodsId)&&text(doc.name,512)&&doc.name.trim().length,'document.goodsId/name');
 for(const key of ['erp','tax'])if(own(doc,key))validation(doc[key]===null||typeof doc[key]==='number'&&doc[key]>=0,'document.'+key);
 if(sharedAddonFields.some(k=>own(doc,k))){
  try{validateAddon(sourceAddon(doc));}catch{throw new Fault('VALIDATION_FAILED',400,{field:'document.addons'});}
 }
}
function validateGallery(doc,id){
 validation(doc.id===id&&assetRef(doc.url),'document.id/url');
 validation(text(doc.name,160)&&doc.name.trim().length,'document.name');
 for(const key of ['brand','model','color','edition'])validation(text(doc[key],80),'document.'+key);
}
function validateTemplate(doc,id,shop){
 validation(doc.id===id&&doc.shopId===shop&&text(doc.name,160)&&doc.name.trim().length,'document.id/shopId/name');
 validation(Array.isArray(doc.configs)&&doc.configs.length>0&&doc.configs.length<=100&&doc.configs.every(c=>plain(c)&&c.shopId===shop&&idOk(c.id)&&
  Array.isArray(c.parts)&&Array.isArray(c.actualParts)&&Array.isArray(c.addons)&&Array.isArray(c.modules))&&
  new Set(doc.configs.map(c=>c.id)).size===doc.configs.length,'document.configs');
}
function assetPaths(document,result=new Set()){
 if(assetRef(document))result.add(document);
 else if(Array.isArray(document))for(const value of document)assetPaths(value,result);
 else if(plain(document)){
  if(own(document,'caseImage'))validation(document.caseImage===''||document.caseImage===null||assetRef(document.caseImage),'document.caseImage');
  if(own(document,'posterImages'))validation(Array.isArray(document.posterImages)&&document.posterImages.every(item=>assetRef(item?.url)),'document.posterImages');
  for(const value of Object.values(document))assetPaths(value,result);
 }
 return result;
}

export class CatalogStore {
 constructor(pool,{shopId='intel',tx,writable,workspaceWritable=false,writeImage=null,applyTemplate=null,sharedGallery=false,sharedSources=false}){
  this.pool=pool;this.tx=tx;this.writable=writable;this.workspaceWritable=workspaceWritable;this.writeImage=writeImage;this.applyTemplate=applyTemplate;
  this.shopId=shopId;
  this.sharedGallery=sharedGallery;this.sharedSources=sharedSources;
 }
 async grants(db,member){
  if(!this.writable||this.shopId!=='intel')return new Set();
  return new Set((await db.query('SELECT resource_kind FROM intel_live.catalog_shared_editors WHERE workspace_id=$1 AND uid=$2',[member.workspaceId,member.uid])).rows.map(r=>r.resource_kind));
 }
 async bind(db,member){
  // 权限必须在写事务中重新核验；RLS 以同一身份再次检查写入范围。
  await db.query("SELECT set_config('intel_live.catalog_workspace',$1,true),set_config('intel_live.catalog_uid',$2,true)",[member.workspaceId,member.uid]);
  const {rows:[row]}=await db.query('SELECT intel_live.catalog_is_operator() AS allowed');
  requireValue(row.allowed,'FORBIDDEN',403);
 }
 async read(db,kind,id=null){
  const info=descriptor(kind);
  requireValue(info,'NOT_FOUND',404);
  return (await db.query("SELECT "+info.id+" AS id,"+info.owner+" AS owner_shop,"+info.share+" AS shared,version::text, "+info.doc+
   " AS document FROM intel_live."+info.table+" WHERE ("+info.owner+"=$2 OR "+info.owner+"='shared' OR ("+info.share+")) AND ($1::text IS NULL OR "+info.id+"=$1) ORDER BY "+info.id,[id,this.shopId])).rows;
 }
 async list(member,kind,id){
  if(kind==='shared-sources'){
   requireValue(this.sharedSources,'NOT_FOUND',404);
   return this.tx(false,db=>listSharedSources(db,member,this.shopId,id));
  }
  return this.tx(false,async db=>{
   const grants=await this.grants(db,member);
   const rows=kind==='gallery'&&this.sharedGallery?await sharedGalleryRows(db,this.shopId,id,{includeArchived:true}):await this.read(db,kind,id);
   const output=rows.map(({source_shop,sha256,extension,...row})=>({...row,
    editable:(!source_shop||source_shop===this.shopId)&&this.writable&&(kind!=='addons'||!archives(row.document))&&mayWrite(row,grants,descriptor(kind).kind,this.shopId),
    document:kind==='addons'?{sourceId:row.id,shopId:row.document.shopId,...subset(row.document,[...sharedAddonFields,'deletedAt'])}:row.document}));
   if(!id)return output;
   if(!output.length)throw new Fault('NOT_FOUND',404);
   if(kind==='gallery')output[0].references=await this.references(db,kind,output[0]);
   return output[0];
  });
 }
 async references(db,kind,row){
  const key=kind==='gallery'?row.document.url:row.id;
  if(kind==='gallery'){
   if(this.sharedGallery)return (await db.query('SELECT * FROM workbench_gallery.image_references($1)',[key])).rows[0];
   const {rows:[count]}=await db.query(`SELECT
    (SELECT count(*)::int FROM intel_live.configurations WHERE ${existsValue('design','$1')} OR ${existsValue('fields','$1')}) AS configurations,
    (SELECT count(*)::int FROM intel_live.templates WHERE ${existsValue('configurations','$1')} OR ${existsValue('attrs','$1')}) AS templates,
    (SELECT count(*)::int FROM intel_live.sources WHERE ${existsValue('attrs','$1')}) AS sources`,[key]);
   return count;
  }
  const {rows:[count]}=await db.query(`SELECT
   (SELECT count(DISTINCT p.configuration_id)::int FROM
    (SELECT configuration_id FROM intel_live.parts WHERE source_id=$1 UNION
     SELECT configuration_id FROM intel_live.addons WHERE ${existsValue('fields','$1')} OR ${existsValue('items','$1')}) p) AS configurations,
   (SELECT count(*)::int FROM intel_live.templates WHERE ${existsValue('configurations','$1')}) AS templates`,[key]);
  return count;
 }
 async checkAssetPaths(db,document){
  const paths=[...assetPaths(document)].sort();
  // 与图库归档和配置保存使用同一摘要事务锁，保留所有历史素材。
  for(const path of paths)await (this.sharedGallery?lockGalleryAsset(db,path):shopLock(db,this.shopId,814519,'asset:'+path));
  if(paths.length){
   const {rows:[row]}=await db.query('SELECT count(*)::int AS count FROM intel_live.assets WHERE legacy_uri=ANY($1::text[])',[paths]);
   validation(row.count===paths.length,'document.images');
  }
 }
 async write(db,kind,id,document,old){
  let sql,params;
  const info=descriptor(kind);
  if(info.kind==='sources'){
   const attrs=without(document,['sourceId','goodsId','name']);
   params=[id,document.goodsId,document.name,JSON.stringify(attrs)];
   sql=old?"UPDATE intel_live.sources SET goodsid=$2,name=$3,attrs=$4,version=version+1 WHERE source_id=$1":
    "INSERT INTO intel_live.sources(source_id,owner_shop,shared,goodsid,name,attrs) VALUES($1,$5,false,$2,$3,$4)";
  }else if(kind==='gallery'){
   const attrs=without(document,['id','url','brand','model','color','edition']);
   params=[id,document.url,document.brand,document.model,document.color,document.edition,JSON.stringify(attrs)];
   sql=old?"UPDATE intel_live.gallery SET legacy_uri=$2,brand=$3,model=$4,color=$5,edition=$6,attrs=$7,version=version+1 WHERE gallery_id=$1":
    "INSERT INTO intel_live.gallery(gallery_id,owner_shop,shared,legacy_uri,brand,model,color,edition,attrs) VALUES($1,$8,false,$2,$3,$4,$5,$6,$7)";
  }else{
   const attrs=without(document,['id','shopId','name','configs']);
   params=[id,document.name,JSON.stringify(document.configs),JSON.stringify(attrs)];
   sql=old?"UPDATE intel_live.templates SET name=$2,configurations=$3,attrs=$4,version=version+1 WHERE template_id=$1":
    "INSERT INTO intel_live.templates(template_id,shop_id,name,configurations,attrs) VALUES($1,$5,$2,$3,$4)";
  }
  const {rows:[next]}=await db.query(sql+' RETURNING version::text',old?params:[...params,this.shopId]);
  if(!next)throw new Fault('FORBIDDEN',403);
  return next.version;
 }
 async save(member,shop,kind,id,action,body,requestId,image=null){
  requireValue(this.writable,'WRITES_DISABLED',405);
  validation(shop===this.shopId&&kinds.has(kind),'operation');
  validation(plain(body)&&uuid.test(body.operation_id||'')&&idOk(id),'operation_id/resource_id');
  if(kind==='gallery'&&this.sharedGallery){
   requireValue(!id.startsWith(foreignGalleryPrefix),'CATALOG_SHARED_READ_ONLY',403);
   validation(typeof body.target_id!=='string'||!body.target_id.startsWith(foreignGalleryPrefix),'target_id');
  }
  const sharedEdit=kind==='shared-sources';
  if(sharedEdit)requireValue(this.sharedSources&&(action==='create'||action==='replace'),'METHOD_NOT_ALLOWED',405);
  const op=body.operation_id.toLowerCase();
  const writeImage=image&&kind==='assets'&&action==='upload';
  const create=action==='create',copy=action==='copy',apply=action==='apply';
  const adoption=sharedEdit&&create&&plain(body.document)&&own(body.document,'erpAdoption');
  if(adoption)requireValue(this.workspaceWritable,'WRITES_DISABLED',405);
  const keys=['operation_id',...(create||writeImage?[]:['expected_version']),...(create||action==='replace'?['document']:[]),
   ...(copy?['target_id']:[]),...(apply?['target_product_id','target_configuration_id','expected_target_version','selection','name_format','replace_manual_names','archive_empty_target']:[])];
  validation(Object.keys(body).every(k=>keys.includes(k)),'operation');
  if(!create&&!writeImage)validation(validVersion(body.expected_version),'expected_version');
  if(copy)validation(kind==='gallery'&&idOk(body.target_id)&&body.target_id!==id,'target_id');
  if(apply)validation(kind==='templates'&&idOk(body.target_product_id)&&idOk(body.target_configuration_id)&&validVersion(body.expected_target_version)&&
   (!own(body,'name_format')||['compact','default'].includes(body.name_format))&&
   (!own(body,'replace_manual_names')||typeof body.replace_manual_names==='boolean'&&own(body,'name_format'))&&
   (!own(body,'archive_empty_target')||body.archive_empty_target===true)&&
   Array.isArray(body.selection)&&body.selection.length>0&&body.selection.length<=64&&
   body.selection.every(entry=>plain(entry)&&Object.keys(entry).length===2&&idOk(entry.source_id)&&typeof entry.id==='string'&&uuid.test(entry.id))&&
   new Set(body.selection.map(entry=>entry.id.toLowerCase())).size===body.selection.length&&new Set(body.selection.map(entry=>entry.source_id)).size===body.selection.length,'selection');
  if(create||action==='replace'){
   validation(plain(body.document)&&safe(body.document),'document');
   for(const field of ['owner_shop','ownerShop','shared','resource_version'])
    validation(!own(body.document,field),'document.'+field);
   validation(body.document.deletedAt==null,'document.deletedAt');
   if(adoption)validateErpAdoption(id,body.document);
   else if(sharedEdit)validateSharedSourceEdit(id,body.document,create);
  }
  const hash=sha(canonical({shop,kind,id,action,body:{...body,operation_id:op},asset:writeImage?{digest:image.digest,mime:image.mime}:null}));
  return this.tx(sharedEdit?'shared':true,async db=>{
   await this.bind(db,member);
   await shopLock(db,shop,814517,JSON.stringify([member.workspaceId,member.uid,op]));
   const actor=[member.workspaceId,member.uid,op];
   const oldReceipt=(await db.query('SELECT request_sha256,result FROM intel_live.catalog_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3',actor)).rows[0];
   if(oldReceipt){
    if(oldReceipt.request_sha256!==hash)throw new Fault('OPERATION_REUSED',409);
    return oldReceipt.result;
   }
   if((await db.query('SELECT 1 FROM intel_live.save_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3',actor)).rows.length)
    throw new Fault('OPERATION_REUSED',409);
   if(this.workspaceWritable&&(await db.query('SELECT 1 FROM intel_live.workspace_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3',actor)).rows.length)
    throw new Fault('OPERATION_REUSED',409);
   let resultId=id,version='1',previous=null,document=null;
   if(adoption){
    document=await adoptErpSource(db,member,shop,id,body.document);version=document.version;
   }else if(sharedEdit){
    previous=body.expected_version??null;
    version=await writeSharedSource(db,member,shop,id,previous,body.document);
    document={id,...(body.document.alias_edits||body.document.addon_sync?{source_versions:await sharedSourceVersions(db,member,shop,id)}:{})};
   }else if(writeImage){
    requireValue(this.writeImage,'IMAGE_UPLOAD_DISABLED',405);
    await (this.sharedGallery?lockGalleryAsset(db,id):shopLock(db,shop,814519,'asset:'+id));
    await this.writeImage(image);
    await db.query('INSERT INTO intel_live.assets(legacy_uri,sha256,extension,byte_count) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,image.digest,image.extension,image.bytes.length]);
    const {rows:[asset]}=await db.query('SELECT sha256,extension,byte_count::text FROM intel_live.assets WHERE legacy_uri=$1',[id]);
    requireValue(asset?.sha256===image.digest&&asset.extension===image.extension&&asset.byte_count===String(image.bytes.length),'IMAGE_CONFLICT',409);
    document={url:id,sha256:image.digest,mime:image.mime,width:image.width,height:image.height};
   }else{
    requireValue(descriptor(kind)&&['create','replace','archive','restore','copy','apply'].includes(action),'INVALID_REQUEST');
    requireValue(kind!=='addons'||action==='replace','METHOD_NOT_ALLOWED',405);
    const info=descriptor(kind);
    const lock=[id,...(copy?[body.target_id]:[])].sort();
    for(const resource of lock)await shopLock(db,shop,814519,(info.kind==='sources'?'source':info.kind)+':'+resource);
    const [existing]=await this.read(db,kind,id);
    if(this.sharedSources&&info.kind==='sources'&&(create||action==='replace')){
     // 保留旧目录的删除与恢复。普通配件资料必须走共用事务，避免只更新投影。
     const source=existing?.document||body.document;
     requireValue(!sourceGoodsId(source?.goodsId)&&source?.specialComponent!==true,
      'SHARED_SOURCE_EDITOR_REQUIRED',409);
    }
    if(create){
     requireValue(!existing,'CATALOG_EXISTS',409);
     document=body.document;
    }else{
     requireValue(existing,'NOT_FOUND',404);
     requireValue(copy||mayWrite(existing,await this.grants(db,member),info.kind,shop),'CATALOG_SHARED_READ_ONLY',403);
     if(existing.version!==body.expected_version)throw new Fault('VERSION_CONFLICT',409,{current_version:existing.version});
     const deleted=archives(existing.document);
     requireValue(deleted===(action==='restore'),'INVALID_CONFIGURATION_STATE',409);
     previous=copy?null:existing.version;
     if(apply){
      requireValue(this.applyTemplate,'METHOD_NOT_ALLOWED',405);
      document=await this.applyTemplate(db,existing.document,body);
      version=existing.version;
     }else if(copy){
      resultId=body.target_id;
      if((await this.read(db,kind,resultId)).length)throw new Fault('CATALOG_EXISTS',409);
      document={...existing.document,id:resultId};
     }else if(action==='replace'&&kind==='addons'){
      validation(body.document.sourceId===id&&Object.keys(body.document).every(k=>['sourceId','shopId',...sharedAddonFields].includes(k))&&body.document.shopId===shop,'document');
      document={...without(existing.document,sharedAddonFields),...subset(body.document,sharedAddonFields)};
     }else if(action==='replace'){
      document=body.document;
     }else{
      document={...existing.document};
      if(action==='archive'){
       if(kind==='gallery')await this.checkAssetPaths(db,document);
       if(kind==='gallery'||kind==='sources'){
        const refs=await this.references(db,kind,existing);
        if(refs.configurations||refs.templates||refs.sources)throw new Fault('CATALOG_IN_USE',409,refs);
       }
       document.deletedAt=new Date().toISOString();
      }else delete document.deletedAt;
     }
    }
    if(!apply){
     if(info.kind==='sources')validateSource(document,resultId,copy||create?shop:(existing?.document.shopId||shop));
     if(kind==='gallery')validateGallery(document,resultId);
     if(kind==='templates')validateTemplate(document,resultId,shop);
     if(action!=='archive')await this.checkAssetPaths(db,document);
     version=await this.write(db,kind,resultId,document,!(create||copy));
    }
   }
   const result={kind,resource_id:resultId,operation_id:op,shop_id:shop,version,archived:action==='archive',document};
   await db.query('INSERT INTO intel_live.catalog_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,resource_id,request_sha256,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [...actor,shop,kind,resultId,hash,JSON.stringify(result)]);
   await db.query('INSERT INTO intel_live.catalog_audit(workspace_id,actor_uid,operation_id,action,previous_version,next_version,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [...actor,apply?'copy':action,previous,version,requestId]);
   return result;
  });
 }
 async receipt(member,shop,id){
  requireValue(this.writable,'WRITES_DISABLED',405);
  const query=db=>db.query('SELECT result FROM intel_live.catalog_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3 AND shop_id=$4',[member.workspaceId,member.uid,id,shop]);
  const {rows:[row]}=await (this.shopId==='intel'?query(this.pool):this.tx(false,async db=>{
   await this.bind(db,member);
   return query(db);
  }));
  if(!row)throw new Fault('RECEIPT_NOT_FOUND',404);
  return row.result;
 }
}

export const catalogOperationId=value=>typeof value==='string'&&uuid.test(value);
