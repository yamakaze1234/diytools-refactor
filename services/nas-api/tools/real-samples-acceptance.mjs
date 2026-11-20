/** 仅给本机 PGlite 测试包导入已抽取的少量真实样本，不接受正式 PostgreSQL 连接。 */
import {PGlite} from '@electric-sql/pglite';
import {createHash} from 'node:crypto';
const shops=['intel','gigabyte','jonsbo'];
const clone=value=>structuredClone(value);
const designKeys=['caseImage','fontFamily','footer','layout','modules','palette','posterDesignVersion','showUpgrades','showWarranty','textStyles','theme','themePalettes','upgradeColor','upgradeSize','upgradeWeight','productCardColor','fixedInitialFormat','freeCanvasLayouts','caseTransforms','skuExportMode','textTransforms','productTheme','posterImages','previousSquareLayout','skuTextStyles','posterFields'];
const configKeys=['id','shopId','productId','name','skuId','spu','workspaceOrder','price','parts','actualParts','addons'];
const omit=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
const subset=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>keys.includes(key)));
export async function seedRealSamples(db,payload){
 if(!(db instanceof PGlite)||payload?.format!==1||!shops.every(shop=>payload.shops?.[shop]?.configurations?.length))throw Error('真实样本只允许导入本机测试内核');
 for(const shop of shops){
  const s=payload.shops[shop],schema=shop+'_live';
  if(s.configurations.length>24||s.configurations.some(c=>c.shopId!==shop||c.deletedAt))throw Error('样本范围或店铺不正确');
  // 这些表仅属于新建的本机样本库；清除脚手架合成记录后放入少量已核对真实配置。
  await db.exec(`TRUNCATE ${schema}.configurations CASCADE; TRUNCATE ${schema}.products CASCADE;
   TRUNCATE ${schema}.templates,${schema}.gallery,${schema}.assets CASCADE; TRUNCATE ${schema}.sources CASCADE;
   TRUNCATE ${schema}.costs; DELETE FROM ${schema}.intel_cost_overrides;`);
  await db.query(`UPDATE ${schema}.shops SET profile=$1::jsonb,settings=$2::jsonb WHERE shop_id=$3`,[JSON.stringify(s.profile),JSON.stringify(s.settings),shop]);
  await db.query(`INSERT INTO ${schema}.sources(source_id,owner_shop,shared,goodsid,name,attrs)
   SELECT p->>'sourceId',$2,false,coalesce(p->>'goodsId',''),coalesce(p->>'name',''),p-ARRAY['sourceId','goodsId','name'] FROM jsonb_array_elements($1::jsonb) p`,[JSON.stringify(s.sources),shop]);
  await db.query(`INSERT INTO ${schema}.costs(goodsid,owner_shop,shared,erp,tax,attrs)
   SELECT p->>'goodsId',$2,false,(p->>'erp')::numeric,(p->>'tax')::numeric,p-ARRAY['goodsId','erp','tax'] FROM jsonb_array_elements($1::jsonb) p`,[JSON.stringify(s.costs),shop]);
  for(const asset of s.assets)await db.query(`INSERT INTO ${schema}.assets(legacy_uri,sha256,extension,byte_count) VALUES($1,$2,$3,$4)`,[asset.uri,asset.sha256,asset.uri.split('.').at(-1),asset.size]);
  for(const image of s.gallery)await db.query(`INSERT INTO ${schema}.gallery(gallery_id,owner_shop,shared,legacy_uri,brand,model,color,edition,attrs) VALUES($1,$2,false,$3,$4,$5,$6,$7,$8::jsonb)`,[image.id,shop,image.url,image.brand||'',image.model||'',image.color||'',image.edition||'',JSON.stringify(omit(image,['id','url','brand','model','color','edition']))]);
  for(const [index,raw] of s.configurations.entries()){
   const c=clone(raw);
   // 快照不带行号的兼容记录只补稳定行标识，配件、成本、文案和售价不改动。
   for(const key of ['parts','actualParts'])c[key]=(c[key]??[]).map((p,i)=>({...p,lineId:p.lineId||'sample-'+key+'-'+i}));
   await db.query(`INSERT INTO ${schema}.products(shop_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[shop,c.productId]);
   await db.query(`INSERT INTO ${schema}.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,[c.id,shop,c.productId,c.name,c.skuId||'',c.spu||'',c.workspaceOrder??index*100,c.price==null?null:Math.round(c.price*100),JSON.stringify(omit(c,[...configKeys,...designKeys])),JSON.stringify(subset(c,designKeys))]);
   for(const [kind,key] of [['display','parts'],['actual','actualParts']])for(const [i,p] of c[key].entries())await db.query(`INSERT INTO ${schema}.parts(configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[c.id,kind,i+1,p.lineId,p.slot,p.goodsId||'',p.name||'',p.qty??1,p.sourceId||null,JSON.stringify(omit(p,['lineId','slot','goodsId','name','qty','sourceId']))]);
   for(const [i,a] of (c.addons??[]).entries())await db.query(`INSERT INTO ${schema}.addons(configuration_id,position,fields,items) VALUES($1,$2,$3::jsonb,$4::jsonb)`,[c.id,i+1,JSON.stringify(omit(a,['items'])),JSON.stringify(a.items??[])]);
  }
  const digest=createHash('sha256').update(JSON.stringify(s.configurations)).digest('hex');
  await db.query(`UPDATE ${schema}.bootstrap SET loaded_at=now() WHERE shop_id=$1`,[shop]);
  // 本机独立溯源记录，启动后不再覆盖已编辑样本。
  await db.exec('CREATE TABLE IF NOT EXISTS public.real_sample_provenance(shop text PRIMARY KEY, digest text NOT NULL)');
  await db.query('INSERT INTO public.real_sample_provenance VALUES($1,$2)',[shop,digest]);
 }
}
