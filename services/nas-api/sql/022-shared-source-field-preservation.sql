-- 单店仅改名称等部分字段时，保留原有加购、数量、金额及硬件资料。
-- JSON 提取显式加括号，避免拼接后的对象再次取 values 而丢掉未修改字段。
BEGIN;
CREATE OR REPLACE FUNCTION workbench_sources.save(request_shop text, workspace text, actor text, entry_key text,
 expected bigint, edits jsonb, erp_name text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $save$
DECLARE entry workbench_sources.entries%ROWTYPE; change record; restored text[]; changed text[]; allowed_shops text[];
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
 PERFORM workbench_sources.project(entry_key,CASE WHEN edits ? 'shared' THEN ARRAY['intel','gigabyte','jonsbo']
  ELSE ARRAY(SELECT jsonb_object_keys(edits)) END,now(),erp_name);
 RETURN entry.version::text;
END $save$;
COMMIT;
