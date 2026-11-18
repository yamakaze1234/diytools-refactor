export const foreignGalleryPrefix='shared-gallery:';

// 各店保留已有图库标识；其他店的同名记录使用固定、独立的只读标识。
export async function sharedGalleryRows(db,shop,id=null,{includeArchived=false}={}){
 const {rows}=await db.query(`SELECT source_shop,id,owner_shop,shared,version,sha256,extension,
  attrs||jsonb_build_object('id',id,'url',legacy_uri,'brand',brand,'model',model,'color',color,'edition',edition) AS document
  FROM (
   SELECT source_shop,CASE WHEN source_shop=$1 THEN gallery_id
    ELSE 'shared-gallery:'||source_shop||':'||encode(sha256(convert_to(gallery_id,'UTF8')),'hex') END AS id,
    CASE WHEN source_shop=$1 THEN owner_shop ELSE source_shop END AS owner_shop,
    (source_shop<>$1 OR shared) AS shared,version::text,sha256,extension,legacy_uri,brand,model,color,edition,
    CASE WHEN source_shop=$1 THEN attrs ELSE jsonb_build_object('name',attrs->>'name',
     'createdAt',attrs->>'createdAt','updatedAt',attrs->>'updatedAt') END AS attrs
   FROM workbench_gallery.catalog WHERE attrs->>'deletedAt' IS NULL OR ($3::boolean AND source_shop=$1)
  ) AS entries WHERE $2::text IS NULL OR id=$2
  ORDER BY (source_shop=$1) DESC,source_shop,id`,[shop,id,includeArchived]);
 if(id)return rows;
 const seen=new Set();
 // 迁移时已有多店相同分类和原图的记录，选图只展示一份外店副本，优先展示本店资料。
 return rows.filter(row=>{
  const {url,brand,model,color,edition,deletedAt}=row.document;
  if(deletedAt)return true;
  const key=JSON.stringify([url,brand,model,color,edition]);
  if(row.source_shop!==shop&&seen.has(key))return false;
  seen.add(key);
  return true;
 });
}

export function lockGalleryAsset(db,ref){
 return db.query('SELECT pg_advisory_xact_lock(814521,hashtext($1))',[ref]);
}
