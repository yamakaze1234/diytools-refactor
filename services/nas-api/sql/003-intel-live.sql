-- 仅在试验库执行这条完整 DO。建表、初始化和核对同事务；样本与导入原文不改动。
DO $intel_runtime$
DECLARE batch text; digest text; total bigint; batches bigint;
BEGIN
 IF current_database()<>'diy_workbench_trial' THEN RAISE EXCEPTION '运行结构只允许试验库'; END IF;
 PERFORM pg_advisory_xact_lock(814517,2);

CREATE SCHEMA IF NOT EXISTS intel_live;
REVOKE ALL ON SCHEMA intel_live FROM PUBLIC;
CREATE TABLE IF NOT EXISTS intel_live.bootstrap(
 shop_id text PRIMARY KEY CHECK (shop_id='intel'), batch_id text UNIQUE NOT NULL REFERENCES nas_import.batches,
 payload_sha256 text NOT NULL CHECK(length(payload_sha256)=64), loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS intel_live.shops(
 shop_id text PRIMARY KEY CHECK (shop_id='intel'), profile jsonb NOT NULL, settings jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS intel_live.sources(
 source_id text PRIMARY KEY, owner_shop text NOT NULL, shared boolean NOT NULL,
 goodsid text NOT NULL, name text NOT NULL, attrs jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS intel_live.costs(
 goodsid text PRIMARY KEY, owner_shop text NOT NULL, shared boolean NOT NULL,
 erp numeric, tax numeric, attrs jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS intel_live.assets(
 legacy_uri text PRIMARY KEY, sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 extension text NOT NULL CHECK(extension IN ('png','jpg','jpeg')),
 byte_count bigint NOT NULL CHECK(byte_count>0), UNIQUE(sha256,extension)
);
CREATE TABLE IF NOT EXISTS intel_live.gallery(
 gallery_id text PRIMARY KEY, owner_shop text NOT NULL, shared boolean NOT NULL,
 legacy_uri text NOT NULL REFERENCES intel_live.assets(legacy_uri),
 brand text NOT NULL, model text NOT NULL, color text NOT NULL, edition text NOT NULL,
 attrs jsonb NOT NULL, version bigint NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS intel_live.templates(
 template_id text PRIMARY KEY, shop_id text NOT NULL REFERENCES intel_live.shops,
 name text NOT NULL, configurations jsonb NOT NULL CHECK(jsonb_typeof(configurations)='array'), attrs jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS intel_live.products(
 shop_id text NOT NULL REFERENCES intel_live.shops,
 product_id text NOT NULL CHECK(product_id<>''),
 PRIMARY KEY(shop_id,product_id)
);
CREATE TABLE IF NOT EXISTS intel_live.configurations(
 configuration_id text PRIMARY KEY, shop_id text NOT NULL REFERENCES intel_live.shops, product_id text NOT NULL,
 name text NOT NULL, sku text NOT NULL, spu text NOT NULL, workspace_order numeric NOT NULL,
 workbench_price_cents bigint NOT NULL CHECK(workbench_price_cents>=0),
 fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='object'),
 design jsonb NOT NULL CHECK(jsonb_typeof(design)='object'),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), archived_at timestamptz,
 FOREIGN KEY(shop_id,product_id) REFERENCES intel_live.products
);
CREATE INDEX IF NOT EXISTS intel_live_config_shop ON intel_live.configurations(shop_id,configuration_id);
CREATE TABLE IF NOT EXISTS intel_live.parts(
 configuration_id text NOT NULL REFERENCES intel_live.configurations,
 part_kind text NOT NULL CHECK(part_kind IN ('display','actual')),
 position integer NOT NULL CHECK(position>0), line_id text NOT NULL CHECK(line_id<>''), slot text NOT NULL,
 goodsid text NOT NULL, name text NOT NULL, qty integer NOT NULL CHECK(qty>0),
 source_id text REFERENCES intel_live.sources, attrs jsonb NOT NULL CHECK(jsonb_typeof(attrs)='object'),
 PRIMARY KEY(configuration_id,part_kind,position),
 UNIQUE(configuration_id,part_kind,line_id)
);
CREATE INDEX IF NOT EXISTS intel_live_part_source ON intel_live.parts(source_id);
CREATE TABLE IF NOT EXISTS intel_live.addons(
 configuration_id text NOT NULL REFERENCES intel_live.configurations, position integer NOT NULL CHECK(position>0),
 fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='object'),
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),
 PRIMARY KEY(configuration_id,position)
);
CREATE TABLE IF NOT EXISTS intel_live.quotations(
 configuration_id text PRIMARY KEY REFERENCES intel_live.configurations,
 workbook_sha256 text NOT NULL CHECK(workbook_sha256 ~ '^[0-9a-f]{64}$'), source text NOT NULL, sheet text NOT NULL,
 status text NOT NULL CHECK(status IN ('matched','unmatched')),
 amount_cents bigint CHECK(amount_cents>=0), imported_workbench_cents bigint CHECK(imported_workbench_cents>=0),
 difference_cents bigint, workbook_rows jsonb NOT NULL CHECK(jsonb_typeof(workbook_rows)='array'),
 CHECK ((status='matched')=(amount_cents IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS intel_live.publications(
 configuration_id text PRIMARY KEY REFERENCES intel_live.configurations,
 published boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS intel_live.save_receipts(
 workspace_id text NOT NULL, actor_uid text NOT NULL, operation_id uuid NOT NULL,
 shop_id text NOT NULL REFERENCES intel_live.shops, configuration_id text NOT NULL REFERENCES intel_live.configurations,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,actor_uid,operation_id)
);
CREATE TABLE IF NOT EXISTS intel_live.audit_events(
 workspace_id text NOT NULL, actor_uid text NOT NULL, operation_id uuid NOT NULL,
 shop_id text NOT NULL REFERENCES intel_live.shops, configuration_id text NOT NULL REFERENCES intel_live.configurations,
 action text NOT NULL CHECK(action IN ('create','replace','archive','restore','design')),
 previous_version bigint, next_version bigint NOT NULL,
 request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,actor_uid,operation_id),
 FOREIGN KEY(workspace_id,actor_uid,operation_id) REFERENCES intel_live.save_receipts
);

-- 图格式与普通字段分别保存；缺席属性保持缺席，未知兼容字段只留在 fields 或行 attrs。
CREATE OR REPLACE FUNCTION intel_live.design_keys() RETURNS text[]
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
 SELECT ARRAY['caseImage','fontFamily','footer','layout','modules','palette','posterDesignVersion',
 'showUpgrades','showWarranty','textStyles','theme','themePalettes','upgradeColor','upgradeSize','upgradeWeight',
 'productCardColor','fixedInitialFormat','freeCanvasLayouts','caseTransforms','skuExportMode','textTransforms',
 'productTheme','posterImages','previousSquareLayout','skuTextStyles','posterFields']
$fn$;
CREATE OR REPLACE FUNCTION intel_live.configuration_keys() RETURNS text[]
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $fn$
 SELECT ARRAY['id','shopId','productId','name','skuId','spu','workspaceOrder','price','parts','actualParts','addons']
$fn$;
REVOKE ALL ON FUNCTION intel_live.design_keys(),intel_live.configuration_keys() FROM PUBLIC;

-- 重新拼装工作台编辑文档，任何字段只有一个运行归属。数据库版本与原文的展示版本分开。
CREATE OR REPLACE VIEW intel_live.configuration_documents AS
 SELECT c.configuration_id,c.shop_id,c.version,c.archived_at,
  c.fields || c.design || jsonb_build_object(
   'id',c.configuration_id,'shopId',c.shop_id,'productId',c.product_id,'name',c.name,'skuId',c.sku,
   'spu',c.spu,'workspaceOrder',c.workspace_order,'price',c.workbench_price_cents/100.0,
   'parts',coalesce((SELECT jsonb_agg(p.attrs || jsonb_build_object('lineId',p.line_id,'slot',p.slot,'goodsId',p.goodsid,'name',p.name,'qty',p.qty)
                       || CASE WHEN p.source_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceId',p.source_id) END ORDER BY p.position)
                    FROM intel_live.parts p WHERE p.configuration_id=c.configuration_id AND p.part_kind='display'),'[]'::jsonb),
   'actualParts',coalesce((SELECT jsonb_agg(p.attrs || jsonb_build_object('lineId',p.line_id,'slot',p.slot,'goodsId',p.goodsid,'name',p.name,'qty',p.qty)
                       || CASE WHEN p.source_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceId',p.source_id) END ORDER BY p.position)
                    FROM intel_live.parts p WHERE p.configuration_id=c.configuration_id AND p.part_kind='actual'),'[]'::jsonb),
   'addons',coalesce((SELECT jsonb_agg(a.fields || jsonb_build_object('items',a.items) ORDER BY a.position)
                    FROM intel_live.addons a WHERE a.configuration_id=c.configuration_id),'[]'::jsonb)
  ) AS document
 FROM intel_live.configurations c;

 SELECT count(*),min(batch_id),min(payload_sha256) INTO batches,batch,digest
  FROM nas_import.batches WHERE manifest->>'shop_id'='intel';
 IF batches<>1 THEN RAISE EXCEPTION '需要唯一的英特尔接收批次'; END IF;
 IF EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel') THEN
  IF NOT EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel' AND batch_id=batch AND payload_sha256=digest)
   THEN RAISE EXCEPTION '英特尔运行区已由其他批次初始化'; END IF;
  -- 运行区有后续运营修改时也不覆盖。
  RETURN;
 END IF;
 SELECT count(*) INTO total FROM nas_import.records WHERE batch_id=batch;
 IF total<>(SELECT record_count FROM nas_import.batches WHERE batch_id=batch)
  OR EXISTS(SELECT 1 FROM nas_import.records WHERE batch_id=batch AND stored_md5<>md5(document::text))
  THEN RAISE EXCEPTION '接收区数据未通过摘要核对'; END IF;
 IF EXISTS(SELECT 1 FROM nas_import.records WHERE batch_id=batch AND kind NOT IN
   ('shop','settings','source','cost','asset','gallery','template','configuration','quotation'))
  THEN RAISE EXCEPTION '接收区存在未知记录类型'; END IF;
 IF (SELECT count(*) FROM nas_import.records WHERE batch_id=batch AND kind='shop')<>1 OR
    (SELECT count(*) FROM nas_import.records WHERE batch_id=batch AND kind='settings')<>1
  THEN RAISE EXCEPTION '无唯一店铺设置'; END IF;

 INSERT INTO intel_live.shops
 SELECT 'intel',s.document,t.document FROM nas_import.records s JOIN nas_import.records t USING (batch_id)
  WHERE s.batch_id=batch AND s.kind='shop' AND t.kind='settings';
 INSERT INTO intel_live.sources(source_id,owner_shop,shared,goodsid,name,attrs)
 SELECT record_id,owner_shop,shared,document->>'goodsId',document->>'name',document - ARRAY['sourceId','goodsId','name']
 FROM nas_import.records WHERE batch_id=batch AND kind='source';
 INSERT INTO intel_live.costs(goodsid,owner_shop,shared,erp,tax,attrs)
 SELECT record_id,owner_shop,shared,(document->>'erp')::numeric,(document->>'tax')::numeric,document - ARRAY['goodsId','erp','tax']
 FROM nas_import.records WHERE batch_id=batch AND kind='cost';
 INSERT INTO intel_live.assets(legacy_uri,sha256,extension,byte_count)
 SELECT record_id,document->>'sha256',substring(record_id from '\.([a-z]+)$'),(document->>'size')::bigint
 FROM nas_import.records WHERE batch_id=batch AND kind='asset'
  AND record_id=document->>'uri' AND document->>'file'='assets/'||(document->>'sha256')
  AND record_id ~ '^/uploads/[0-9a-f]{64}\.(png|jpg|jpeg)$';
 IF (SELECT count(*) FROM intel_live.assets)<>(SELECT count(*) FROM nas_import.records WHERE batch_id=batch AND kind='asset')
  THEN RAISE EXCEPTION '存在不符合摘要路径合同的素材'; END IF;
 INSERT INTO intel_live.gallery(gallery_id,owner_shop,shared,legacy_uri,brand,model,color,edition,attrs)
 SELECT record_id,owner_shop,shared,document->>'url',document->>'brand',document->>'model',document->>'color',document->>'edition',
        document - ARRAY['id','url','brand','model','color','edition']
 FROM nas_import.records WHERE batch_id=batch AND kind='gallery';
 INSERT INTO intel_live.templates(template_id,shop_id,name,configurations,attrs)
 SELECT record_id,owner_shop,document->>'name',document->'configs',document - ARRAY['id','shopId','name','configs']
 FROM nas_import.records WHERE batch_id=batch AND kind='template';
 INSERT INTO intel_live.products SELECT DISTINCT document->>'shopId',document->>'productId'
 FROM nas_import.records WHERE batch_id=batch AND kind='configuration';
 INSERT INTO intel_live.configurations(configuration_id,shop_id,product_id,name,sku,spu,workspace_order,workbench_price_cents,fields,design)
 SELECT record_id,document->>'shopId',document->>'productId',document->>'name',document->>'skuId',document->>'spu',
  (document->>'workspaceOrder')::numeric,((document->>'price')::numeric*100)::bigint,
  document - (intel_live.configuration_keys() || intel_live.design_keys()),
  coalesce((SELECT jsonb_object_agg(k,v) FROM jsonb_each(document) e(k,v) WHERE k=ANY(intel_live.design_keys())),'{}'::jsonb)
 FROM nas_import.records WHERE batch_id=batch AND kind='configuration';
 INSERT INTO intel_live.parts(configuration_id,part_kind,position,line_id,slot,goodsid,name,qty,source_id,attrs)
 SELECT r.record_id,f.kind,p.n,p.v->>'lineId',p.v->>'slot',p.v->>'goodsId',p.v->>'name',(p.v->>'qty')::integer,
  nullif(p.v->>'sourceId',''),(p.v - ARRAY['lineId','slot','goodsId','name','qty']) -
   CASE WHEN nullif(p.v->>'sourceId','') IS NULL THEN ARRAY[]::text[] ELSE ARRAY['sourceId'] END
 FROM nas_import.records r CROSS JOIN (VALUES ('display','parts'),('actual','actualParts')) f(kind,key)
 CROSS JOIN LATERAL jsonb_array_elements(r.document->f.key) WITH ORDINALITY p(v,n)
 WHERE r.batch_id=batch AND r.kind='configuration';
 INSERT INTO intel_live.addons(configuration_id,position,fields,items)
 SELECT r.record_id,a.n,a.v-'items',a.v->'items' FROM nas_import.records r
 CROSS JOIN LATERAL jsonb_array_elements(r.document->'addons') WITH ORDINALITY a(v,n)
 WHERE r.batch_id=batch AND r.kind='configuration';
 INSERT INTO intel_live.quotations
 SELECT record_id,document->>'workbook_sha256',document->>'source',document->>'sheet',document->>'status',
  (document->>'amount_cents')::bigint,(document->>'workbench_price_cents')::bigint,
  (document->>'difference_cents')::bigint,document->'workbook_rows'
 FROM nas_import.records WHERE batch_id=batch AND kind='quotation';
 IF EXISTS(SELECT 1 FROM intel_live.configurations c LEFT JOIN intel_live.quotations q USING(configuration_id) WHERE q.configuration_id IS NULL)
  THEN RAISE EXCEPTION '存在未核对的报价配置'; END IF;

 IF EXISTS(SELECT 1 FROM nas_import.records r LEFT JOIN intel_live.configuration_documents c ON c.configuration_id=r.record_id
   WHERE r.batch_id=batch AND r.kind='configuration' AND c.document IS DISTINCT FROM r.document)
  THEN RAISE EXCEPTION '运行配置和接收文档逐项回组核对不一致'; END IF;
 IF EXISTS(
  SELECT 1 FROM nas_import.records r
  LEFT JOIN intel_live.sources s ON r.kind='source' AND s.source_id=r.record_id
  LEFT JOIN intel_live.costs c ON r.kind='cost' AND c.goodsid=r.record_id
  LEFT JOIN intel_live.gallery g ON r.kind='gallery' AND g.gallery_id=r.record_id
  LEFT JOIN intel_live.templates t ON r.kind='template' AND t.template_id=r.record_id
  LEFT JOIN intel_live.quotations q ON r.kind='quotation' AND q.configuration_id=r.record_id
  LEFT JOIN intel_live.assets a ON r.kind='asset' AND a.legacy_uri=r.record_id
  WHERE r.batch_id=batch AND r.document IS DISTINCT FROM CASE r.kind
   WHEN 'source' THEN s.attrs||jsonb_build_object('sourceId',s.source_id,'goodsId',s.goodsid,'name',s.name)
   WHEN 'cost' THEN c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax)
   WHEN 'gallery' THEN g.attrs||jsonb_build_object('id',g.gallery_id,'url',g.legacy_uri,'brand',g.brand,'model',g.model,'color',g.color,'edition',g.edition)
   WHEN 'template' THEN t.attrs||jsonb_build_object('id',t.template_id,'shopId',t.shop_id,'name',t.name,'configs',t.configurations)
   WHEN 'quotation' THEN jsonb_build_object('configuration_id',q.configuration_id,'workbook_sha256',q.workbook_sha256,'source',q.source,
     'sheet',q.sheet,'status',q.status,'amount_cents',q.amount_cents::text,'workbench_price_cents',q.imported_workbench_cents::text,
     'difference_cents',q.difference_cents::text,'workbook_rows',q.workbook_rows)
   WHEN 'asset' THEN jsonb_build_object('uri',a.legacy_uri,'sha256',a.sha256,'size',a.byte_count,'file','assets/'||a.sha256)
   ELSE r.document END)
  THEN RAISE EXCEPTION '运行依赖逐项回组核对不一致'; END IF;
 INSERT INTO intel_live.bootstrap(shop_id,batch_id,payload_sha256) VALUES('intel',batch,digest);
END $intel_runtime$;
