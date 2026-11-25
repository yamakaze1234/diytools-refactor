-- 输出源维护与总表全局改价默认受手动核算价保护，同步成本表时不覆盖。
-- 依赖已安装的 020/022/025 三店共用结构；可重复执行，不改已有业务数据或恢复基线。
BEGIN;
DO $guard$
BEGIN
 IF current_database()<>'diy_workbench'
  OR to_regprocedure('workbench_sources.global_tax(text,text,text,text,jsonb,jsonb,uuid,uuid)') IS NULL
  OR to_regprocedure('workbench_sources.save(text,text,text,text,bigint,jsonb,text)') IS NULL
  OR to_regprocedure('workbench_sources.project(text,text[],timestamp with time zone,text)') IS NULL
 THEN RAISE EXCEPTION '需要已安装共用输出源与全局核算价的三店正式结构'; END IF;
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
END $guard$;

-- 仅内部调用。按本次维护意图同步各店来源与成本，避免非改价投影误改手动标记。
CREATE OR REPLACE FUNCTION workbench_sources.project_with_tax_mode(
 entry_key text, target_shops text[], edited_at timestamptz, erp_name text DEFAULT NULL,
 manual_shops text[] DEFAULT ARRAY[]::text[], follow_shops text[] DEFAULT ARRAY[]::text[]
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $project$
DECLARE
 shop text; schema_name text; item record; special boolean := entry_key LIKE 'special:%';
 effective_fields jsonb; current_name text; attrs jsonb; next_attrs jsonb; addon jsonb;
 caps jsonb; hardware jsonb; override_tax jsonb; tax_count integer; cost_doc jsonb; cost_version bigint;
 want_manual boolean; current_manual boolean;
 addon_keys text[] := ARRAY['addonText','addonNote','addonGoodsId','addonPriceCents','addonQty','addonItems',
  'addonOriginalQty','addonVariants','addonShowTogether','addonChoices','addonMode'];
BEGIN
 FOREACH shop IN ARRAY target_shops LOOP
  schema_name := shop||'_live';
  FOR item IN SELECT a.source_id,e.fields||(CASE WHEN a.fields->'addonTextFollowShared'='true'::jsonb THEN
    a.fields||jsonb_build_object('addon',coalesce(a.fields->'addon',e.fields->'addon','{}'::jsonb)||
      jsonb_build_object('addonText',coalesce(e.fields->'addon'->'addonText','""'::jsonb))) ELSE a.fields END) AS fields FROM workbench_sources.aliases a
   JOIN workbench_sources.entries e ON e.id=a.entry_id WHERE a.entry_id=entry_key AND a.shop_id=shop
  LOOP
   effective_fields := item.fields;
   EXECUTE format('SELECT name,attrs FROM %I.sources WHERE source_id=$1',schema_name)
    INTO current_name,attrs USING item.source_id;
   current_name := coalesce(effective_fields->>'name',current_name,'展示名称待确认');
   next_attrs := coalesce(attrs,'{}')-addon_keys-ARRAY['capacityOverrides','hardwareOverrides'];
   SELECT jsonb_object_agg(key,value) INTO addon FROM jsonb_each(coalesce(effective_fields->'addon','{}')) WHERE key=ANY(addon_keys);
   next_attrs := next_attrs||coalesce(addon,'{}')||jsonb_build_object('shopId',shop,'sharedSourceId',entry_key);
   IF special THEN
    next_attrs := next_attrs||jsonb_build_object('specialComponent',true,'erp',0,'tax',0);
   ELSE
    IF effective_fields ? 'tax' THEN
     next_attrs := next_attrs||jsonb_build_object('tax',effective_fields->'tax');
    END IF;
    SELECT jsonb_object_agg(split_part(key,'.',2),value) INTO caps
     FROM jsonb_each(effective_fields) WHERE key LIKE 'capacityOverrides.%' AND value<>'null'::jsonb;
    SELECT jsonb_object_agg(split_part(key,'.',2),value) INTO hardware
     FROM jsonb_each(effective_fields) WHERE key LIKE 'hardwareOverrides.%' AND value<>'null'::jsonb;
    caps:=(coalesce(nullif(attrs->'capacityOverrides','null'::jsonb),'{}')-ARRAY['memoryGb','vramGb','storageGb'])||coalesce(caps,'{}');
    hardware:=(coalesce(nullif(attrs->'hardwareOverrides','null'::jsonb),'{}')-ARRAY['cpuName','gpuName','boardType','caseBoards','color'])||coalesce(hardware,'{}');
    IF caps<>'{}' THEN next_attrs:=next_attrs||jsonb_build_object('capacityOverrides',caps); END IF;
    IF hardware<>'{}' THEN next_attrs:=next_attrs||jsonb_build_object('hardwareOverrides',hardware); END IF;
    IF attrs IS NULL AND erp_name IS NOT NULL THEN next_attrs:=next_attrs||jsonb_build_object('erpName',erp_name); END IF;
   END IF;
   IF attrs IS NULL THEN
    EXECUTE format('INSERT INTO %I.sources(source_id,owner_shop,shared,goodsid,name,attrs) VALUES($1,$2,false,$3,$4,$5)',schema_name)
     USING item.source_id,shop,CASE WHEN special THEN '' ELSE entry_key END,current_name,next_attrs;
   ELSE
    EXECUTE format($update$UPDATE %I.sources SET name=$2,
     attrs=$3||CASE WHEN $4::timestamptz IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updatedAt',$4) END,
     version=version+1 WHERE source_id=$1 AND (name IS DISTINCT FROM $2 OR attrs IS DISTINCT FROM $3)$update$,schema_name)
     USING item.source_id,current_name,next_attrs,edited_at;
   END IF;
  END LOOP;
  IF special THEN CONTINUE; END IF;
  -- 同店若有多个不同历史值，保留在旧来源行。等维护人员选择店铺核算价后再设置唯一成本。
  SELECT count(DISTINCT (e.fields||a.fields)->'tax'), (jsonb_agg(DISTINCT (e.fields||a.fields)->'tax')->0)
   INTO tax_count,override_tax FROM workbench_sources.aliases a JOIN workbench_sources.entries e ON e.id=a.entry_id
   WHERE a.entry_id=entry_key AND a.shop_id=shop AND (e.fields||a.fields) ? 'tax';
  IF tax_count<>1 THEN CONTINUE; END IF;
  EXECUTE format($cost$SELECT coalesce(o.document,c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax)),
    coalesce(o.version,c.version) FROM %1$I.costs c FULL JOIN %1$I.intel_cost_overrides o USING(goodsid)
    WHERE goodsid=$1$cost$,schema_name) INTO cost_doc,cost_version USING entry_key;
  want_manual := CASE
   WHEN shop = ANY(coalesce(manual_shops,ARRAY[]::text[])) AND jsonb_typeof(override_tax)='number' THEN true
   WHEN shop = ANY(coalesce(follow_shops,ARRAY[]::text[])) THEN false
   ELSE NULL
  END;
  IF want_manual IS NULL THEN
   IF cost_doc->'tax' IS NOT DISTINCT FROM override_tax OR cost_doc IS NULL AND override_tax='null'::jsonb THEN CONTINUE; END IF;
   cost_doc:=coalesce(cost_doc,jsonb_build_object('goodsId',entry_key,'name',current_name,'erp',null))||
    jsonb_build_object('tax',override_tax,'nasTaxOverride',true,'taxUpdatedAt',coalesce(edited_at,now()));
  ELSE
   IF cost_doc IS NULL AND override_tax='null'::jsonb THEN CONTINUE; END IF;
   current_manual := coalesce(cost_doc->'nasManualTax'='true'::jsonb,false);
   IF cost_doc->'tax' IS NOT DISTINCT FROM override_tax
    AND current_manual IS NOT DISTINCT FROM want_manual
    AND cost_doc->'nasTaxOverride' = 'true'::jsonb
    AND NOT (cost_doc ? 'nasProvisionalTax')
   THEN CONTINUE; END IF;
   cost_doc:=(coalesce(cost_doc,jsonb_build_object('goodsId',entry_key,'name',current_name,'erp',null))-ARRAY['nasProvisionalTax','globalTax'])||
    jsonb_build_object('tax',override_tax,'nasTaxOverride',true,'nasManualTax',want_manual,'taxUpdatedAt',coalesce(edited_at,now()));
  END IF;
  EXECUTE format($upsert$INSERT INTO %I.intel_cost_overrides(goodsid,document,version) VALUES($1,$2,$3)
   ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version$upsert$,schema_name)
   USING entry_key,cost_doc,coalesce(cost_version,0)+1;
 END LOOP;
END $project$;

CREATE OR REPLACE FUNCTION workbench_sources.project(entry_key text, target_shops text[], edited_at timestamptz, erp_name text DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $project_compat$
BEGIN
 PERFORM workbench_sources.project_with_tax_mode(entry_key,target_shops,edited_at,erp_name,ARRAY[]::text[],ARRAY[]::text[]);
END $project_compat$;

CREATE OR REPLACE FUNCTION workbench_sources.save(request_shop text, workspace text, actor text, entry_key text,
 expected bigint, edits jsonb, erp_name text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $save$
DECLARE
 entry workbench_sources.entries%ROWTYPE; change record; restored text[]; changed text[]; allowed_shops text[];
 target_shops text[]; manual_shops text[]:=ARRAY[]::text[]; follow_shops text[]:=ARRAY[]::text[];
 target_shop text; peer text; shared_tax_edited boolean; shop_tax_edited boolean; shop_tax_restored boolean;
 shop_has_alias_tax boolean; shop_has_any_alias boolean; peer_has_alias boolean; peer_has_alias_tax boolean;
 peer_doc jsonb; shared_manual_count integer; shared_follow_count integer; common_tax jsonb;
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 SELECT array_agg(o.shop_id ORDER BY o.shop_id) INTO allowed_shops FROM workbench_sources.operators o
  WHERE o.workspace_id=workspace AND o.uid=actor;
 FOR change IN SELECT key,value FROM jsonb_each(edits) LOOP
  IF change.key='shared' AND cardinality(allowed_shops)<>3
   OR change.key<>'shared' AND NOT (change.key=ANY(allowed_shops))
  THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 END LOOP;
 SELECT * INTO entry FROM workbench_sources.entries e WHERE e.id=entry_key FOR UPDATE;
 IF expected IS NULL THEN
  IF FOUND OR entry_key LIKE 'special:%' AND EXISTS (
    SELECT 1 FROM workbench_sources.entries e WHERE e.id LIKE 'special:%' AND e.fields->'name'=edits->'shared'->'values'->'name')
  THEN RAISE EXCEPTION USING MESSAGE='CATALOG_EXISTS'; END IF;
  IF cardinality(allowed_shops)<>3 OR NOT (edits ? 'shared') THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
  INSERT INTO workbench_sources.entries(id,fields) VALUES(entry_key,'{}') RETURNING * INTO entry;
  INSERT INTO workbench_sources.aliases(entry_id,shop_id,source_id)
   SELECT entry_key,shop,'shared-src:'||entry_key FROM unnest(allowed_shops) shop;
 ELSIF entry.version IS DISTINCT FROM expected THEN
  RAISE EXCEPTION USING MESSAGE='VERSION_CONFLICT';
 END IF;
 entry.fields:=entry.fields||coalesce(edits->'shared'->'values','{}');
 UPDATE workbench_sources.entries SET fields=entry.fields, version=entry.version+CASE WHEN expected IS NULL THEN 0 ELSE 1 END
  WHERE id=entry_key RETURNING version INTO entry.version;
 FOR change IN SELECT key,value FROM jsonb_each(edits) WHERE key<>'shared' LOOP
  restored:=ARRAY(SELECT jsonb_array_elements_text(coalesce(change.value->'restore','[]')));
  IF NOT (entry.fields ?& restored) THEN RAISE EXCEPTION USING MESSAGE='SHARED_SOURCE_VALUE_REQUIRED'; END IF;
  changed:=restored||ARRAY(SELECT jsonb_object_keys(change.value->'values'));
  UPDATE workbench_sources.aliases a SET fields=(a.fields-restored)||(change.value->'values'), legacy=a.legacy-changed
   WHERE a.entry_id=entry_key AND a.shop_id=change.key;
 END LOOP;
 target_shops:=CASE WHEN edits ? 'shared' THEN ARRAY['intel','gigabyte','jonsbo']
  ELSE ARRAY(SELECT jsonb_object_keys(edits)) END;
 IF entry_key NOT LIKE 'special:%' THEN
  shared_tax_edited:=coalesce(edits->'shared'->'values' ? 'tax',false);
  common_tax:=entry.fields->'tax';
  FOREACH target_shop IN ARRAY target_shops LOOP
   shop_tax_edited:=coalesce(edits->target_shop->'values' ? 'tax',false);
   shop_tax_restored:=coalesce((edits->target_shop->'restore') ? 'tax',false);
   SELECT EXISTS(SELECT 1 FROM workbench_sources.aliases a WHERE a.entry_id=entry_key AND a.shop_id=target_shop),
          EXISTS(SELECT 1 FROM workbench_sources.aliases a WHERE a.entry_id=entry_key AND a.shop_id=target_shop AND a.fields ? 'tax')
    INTO shop_has_any_alias,shop_has_alias_tax;
   IF shop_tax_edited THEN
    IF jsonb_typeof(edits->target_shop->'values'->'tax')='number' THEN manual_shops:=array_append(manual_shops,target_shop);
    ELSE follow_shops:=array_append(follow_shops,target_shop); END IF;
   ELSIF shared_tax_edited THEN
    IF shop_has_any_alias AND NOT shop_has_alias_tax THEN
     IF jsonb_typeof(edits->'shared'->'values'->'tax')='number' THEN manual_shops:=array_append(manual_shops,target_shop);
     ELSE follow_shops:=array_append(follow_shops,target_shop); END IF;
    END IF;
   ELSIF shop_tax_restored THEN
    IF jsonb_typeof(common_tax)<>'number' THEN
     follow_shops:=array_append(follow_shops,target_shop);
    ELSE
     -- 单店恢复共用时，若其他继承共用价的店均为手动保护价则沿用保护，否则恢复跟随成本表。
     shared_manual_count:=0; shared_follow_count:=0;
     FOREACH peer IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
      IF peer=target_shop OR coalesce((edits->peer->'restore') ? 'tax',false) OR coalesce(edits->peer->'values' ? 'tax',false) THEN CONTINUE; END IF;
      SELECT EXISTS(SELECT 1 FROM workbench_sources.aliases a WHERE a.entry_id=entry_key AND a.shop_id=peer),
             EXISTS(SELECT 1 FROM workbench_sources.aliases a WHERE a.entry_id=entry_key AND a.shop_id=peer AND a.fields ? 'tax')
       INTO peer_has_alias,peer_has_alias_tax;
      IF NOT peer_has_alias OR peer_has_alias_tax THEN CONTINUE; END IF;
      EXECUTE format($peer$SELECT coalesce(o.document,c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax))
       FROM %1$I.costs c FULL JOIN %1$I.intel_cost_overrides o USING(goodsid)
       WHERE goodsid=$1 AND (c.goodsid IS NULL OR c.owner_shop=$2 OR c.owner_shop='shared' OR c.shared)$peer$,peer||'_live')
       INTO peer_doc USING entry_key,peer;
      IF peer_doc IS NOT NULL AND peer_doc->'tax' IS NOT DISTINCT FROM common_tax AND coalesce(peer_doc->'nasManualTax'='true'::jsonb,false)
      THEN shared_manual_count:=shared_manual_count+1;
      ELSE shared_follow_count:=shared_follow_count+1; END IF;
     END LOOP;
     IF shared_manual_count>0 AND shared_follow_count=0 THEN manual_shops:=array_append(manual_shops,target_shop);
     ELSE follow_shops:=array_append(follow_shops,target_shop); END IF;
    END IF;
   END IF;
  END LOOP;
 END IF;
 PERFORM workbench_sources.project_with_tax_mode(entry_key,target_shops,now(),erp_name,manual_shops,follow_shops);
 RETURN entry.version::text;
END $save$;

CREATE OR REPLACE FUNCTION workbench_sources.global_tax(request_shop text, workspace text, actor text, goods text,
 expected jsonb, fields jsonb, operation uuid, request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $global$
DECLARE
 shop text; schema_name text; previous jsonb; current_version text; next_doc jsonb; next_version bigint;
 tax jsonb; base jsonb; base_manual boolean; valid_marker boolean; marker jsonb;
 at_time timestamptz:=clock_timestamp(); context jsonb; result jsonb:='{}';
 restoring boolean:=fields->'restore'='true'::jsonb; exists_op boolean; common_tax jsonb;
BEGIN
 IF NOT workbench_sources.allowed(request_shop,workspace,actor) OR
  (SELECT count(DISTINCT shop_id) FROM workbench_sources.operators WHERE workspace_id=workspace AND uid=actor)<>3
 THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 IF goods!~'^[0-9]{1,20}$' OR jsonb_typeof(expected) IS DISTINCT FROM 'object' OR
  NOT expected ?& ARRAY['intel','gigabyte','jonsbo'] OR (SELECT count(*) FROM jsonb_object_keys(expected))<>3 OR
  jsonb_typeof(fields) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(fields))<>1 OR
  NOT coalesce((restoring OR jsonb_typeof(fields->'tax')='number' AND
   (fields->>'tax')::numeric BETWEEN 0 AND 100000000 AND trunc((fields->>'tax')::numeric*100)=(fields->>'tax')::numeric*100),false)
 THEN RAISE EXCEPTION USING MESSAGE='GLOBAL_TAX_INVALID'; END IF;
 -- 与原配置、目录和成本入口按相同顺序争用三店事务锁。
 PERFORM pg_advisory_xact_lock(814518,76);
 PERFORM pg_advisory_xact_lock(814518,77);
 PERFORM pg_advisory_xact_lock(814518,78);
 -- 原输出源条目也核锁，防止与人工共用维护交错投影。
 PERFORM 1 FROM workbench_sources.entries WHERE id=goods FOR UPDATE;
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  schema_name:=shop||'_live';
  EXECUTE format('SELECT EXISTS(SELECT FROM %1$I.workspace_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3
   UNION ALL SELECT FROM %1$I.catalog_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3
   UNION ALL SELECT FROM %1$I.save_receipts WHERE workspace_id=$1 AND actor_uid=$2 AND operation_id=$3)',schema_name)
   INTO exists_op USING workspace,actor,operation;
  IF exists_op THEN RAISE EXCEPTION USING MESSAGE='OPERATION_REUSED'; END IF;
  previous:=NULL; current_version:=NULL;
  EXECUTE format($old$SELECT coalesce(o.document,c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax)),
   coalesce(o.version,c.version)::text FROM %1$I.costs c FULL JOIN %1$I.intel_cost_overrides o USING(goodsid)
   WHERE goodsid=$1 AND (c.goodsid IS NULL OR c.owner_shop=$2 OR c.owner_shop='shared' OR c.shared)$old$,schema_name)
   INTO previous,current_version USING goods,shop;
  IF (expected->>shop) IS DISTINCT FROM current_version THEN RAISE EXCEPTION USING MESSAGE='VERSION_CONFLICT'; END IF;
  marker:=previous->'globalTax';
  IF restoring THEN
   IF marker IS NULL OR NOT marker ? 'base' OR marker->'value' IS DISTINCT FROM previous->'tax'
   THEN RAISE EXCEPTION USING MESSAGE='GLOBAL_TAX_RESTORE_CONFLICT'; END IF;
   tax:=marker->'base';
  ELSE tax:=fields->'tax'; END IF;
  -- 历史在清除相同独立价之前取配置，确保修改前快照仍反映原配置。
  EXECUTE format($context$SELECT jsonb_build_object(
   'configs',coalesce((SELECT jsonb_agg(d.document ORDER BY c.configuration_id) FROM %1$I.configuration_documents d
    JOIN %1$I.configurations c USING(configuration_id) WHERE c.shop_id=$1 AND c.archived_at IS NULL
    AND c.fields->'emptyLinkDraft' IS DISTINCT FROM 'true'::jsonb AND c.fields->>'productCategory' IS DISTINCT FROM '主机模板'
    AND EXISTS(SELECT FROM %1$I.parts p WHERE p.configuration_id=c.configuration_id AND p.part_kind='actual' AND p.goodsid=$2)),'[]'),
   'linkConfigs',coalesce((SELECT jsonb_agg(jsonb_build_object('productId',product_id)||
    CASE WHEN fields?'installment' THEN jsonb_build_object('installment',fields->'installment') ELSE '{}'::jsonb END)
    FROM %1$I.configurations WHERE shop_id=$1 AND archived_at IS NULL),'[]'),
   'settings',(SELECT coalesce(o.settings,s.settings) FROM %1$I.shops s LEFT JOIN %1$I.intel_settings_overrides o USING(shop_id) WHERE s.shop_id=$1),
   'costs',coalesce((SELECT jsonb_agg(coalesce(o.document,c.attrs||jsonb_build_object('goodsId',c.goodsid,'erp',c.erp,'tax',c.tax)))
    FROM %1$I.costs c FULL JOIN %1$I.intel_cost_overrides o USING(goodsid)
    WHERE c.goodsid IS NULL OR c.owner_shop=$1 OR c.owner_shop='shared' OR c.shared),'[]'))$context$,schema_name)
   INTO context USING shop,goods;
  valid_marker:=marker IS NOT NULL AND marker->'value' IS NOT DISTINCT FROM previous->'tax' AND marker ? 'base';
  base:=CASE WHEN valid_marker THEN marker->'base' ELSE coalesce(previous->'tax','null'::jsonb) END;
  base_manual:=CASE WHEN valid_marker AND marker ? 'baseManual'
   THEN coalesce(marker->'baseManual'='true'::jsonb,false)
   ELSE coalesce(previous->'nasManualTax'='true'::jsonb,false) END;
  next_doc:=(coalesce(previous,jsonb_build_object('goodsId',goods,'erp',null))-ARRAY['globalTax','nasProvisionalTax'])||
   jsonb_build_object('tax',tax,'nasTaxOverride',true,'nasManualTax',CASE WHEN coalesce(restoring,false) THEN base_manual ELSE true END,'taxUpdatedAt',at_time);
  IF NOT coalesce(restoring,false) THEN next_doc:=next_doc||jsonb_build_object('globalTax',
   jsonb_build_object('base',base,'baseManual',base_manual,'value',tax,'at',at_time,'by',actor)); END IF;
  next_version:=coalesce(current_version::bigint,0)+1;
  EXECUTE format($upsert$INSERT INTO %I.intel_cost_overrides(goodsid,document,version) VALUES($1,$2,$3)
   ON CONFLICT(goodsid) DO UPDATE SET document=excluded.document,version=excluded.version$upsert$,schema_name)
   USING goods,next_doc,next_version;
  -- 等于新共用价的独立覆盖可取消，其他人工价保留；受影响配置递增版本使旧草稿冲突。
  EXECUTE format($parts$WITH changed AS (
   UPDATE %1$I.parts p SET attrs=(p.attrs-'taxOverride')||jsonb_build_object('tax',$2)
   FROM %1$I.configurations c WHERE c.configuration_id=p.configuration_id AND c.archived_at IS NULL
    AND c.fields->>'productCategory' IS DISTINCT FROM '主机模板' AND p.part_kind='actual' AND p.goodsid=$1
    AND p.attrs->'taxOverride'->>'goodsId'=$1 AND p.attrs->'taxOverride'->'value'=$2
   RETURNING p.configuration_id)
   UPDATE %1$I.configurations SET version=version+1 WHERE configuration_id IN (SELECT configuration_id FROM changed)$parts$,schema_name)
   USING goods,tax;
  UPDATE workbench_sources.aliases a SET fields=a.fields||jsonb_build_object('tax',tax),legacy=a.legacy-'tax'
   WHERE a.entry_id=goods AND a.shop_id=shop;
  IF shop=request_shop THEN common_tax:=tax; END IF;
  result:=result||jsonb_build_object(shop,context||jsonb_build_object('before',previous,'after',next_doc,
   'previous_version',current_version,'version',next_version::text));
 END LOOP;
 -- 保持受管输出源与成本一致；恢复时各店保留各自第一次改价前的原值。
 UPDATE workbench_sources.entries e SET fields=e.fields||jsonb_build_object('tax',common_tax),version=e.version+1 WHERE e.id=goods;
 PERFORM workbench_sources.project(goods,ARRAY['intel','gigabyte','jonsbo'],at_time);
 RETURN result;
END $global$;

REVOKE ALL ON FUNCTION workbench_sources.project_with_tax_mode(text,text[],timestamptz,text,text[],text[]),
 workbench_sources.project(text,text[],timestamptz,text),
 workbench_sources.save(text,text,text,text,bigint,jsonb,text),
 workbench_sources.global_tax(text,text,text,text,jsonb,jsonb,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workbench_sources.save(text,text,text,text,bigint,jsonb,text),
 workbench_sources.global_tax(text,text,text,text,jsonb,jsonb,uuid,uuid)
 TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;
COMMIT;
