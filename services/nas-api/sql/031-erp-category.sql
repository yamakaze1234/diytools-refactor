-- 基于 030 的锚点只追加分类观察，保留原有权限、锁、回执和核算价保护。
BEGIN;
DO $migration$
DECLARE patch record; definition text; updated text;
BEGIN
 IF current_database() <> 'diy_workbench' THEN RAISE EXCEPTION '需要三店工作台数据库'; END IF;
 FOR patch IN SELECT * FROM (VALUES
  -- 在其余字段清除 null 后单独追加：未观察的大类仍省略，ERP 已清空的大类保留 JSON null。
  ('workbench_sources.cost_sync_snapshot(text,text,text)',
   $q$'sku',r.document->'sku')))$q$,
   $q$'sku',r.document->'sku')) ||
      CASE WHEN r.document ? 'erpCategory' THEN jsonb_build_object('erpCategory',r.document->'erpCategory') ELSE '{}'::jsonb END)$q$),
  ('workbench_sources.apply_cost_sync(text,text,text,text,jsonb,uuid)',
   $q$(NOT incoming ? 'stockIncomingAvailable' OR$q$,
   $q$(NOT incoming ? 'erpCategory' OR incoming->'erpCategory'='null'::jsonb OR
        jsonb_typeof(incoming->'erpCategory')='string' AND length(incoming->>'erpCategory')<=100
        AND (incoming->>'erpCategory') !~ '[[:cntrl:]]') AND
       (NOT incoming ? 'stockIncomingAvailable' OR$q$),
  ('workbench_sources.apply_cost_sync(text,text,text,text,jsonb,uuid)',
   $q$IF incoming ? 'stockIncomingAvailable' THEN$q$,
   $q$IF incoming ? 'erpCategory' THEN
     cost_data:=cost_data||jsonb_build_object('erpCategory',incoming->'erpCategory');
    END IF;
    IF incoming ? 'stockIncomingAvailable' THEN$q$),
  ('workbench_sources.adopt_erp(text,text,text,text,text,jsonb)',
   $q$OR observation ? 'stockIncomingAvailable' AND$q$,
   $q$OR observation ? 'erpCategory' AND (jsonb_typeof(observation->'erpCategory') NOT IN ('null','string')
    OR length(observation->>'erpCategory')>100 OR (observation->>'erpCategory') ~ '[[:cntrl:]]')
  OR observation ? 'stockIncomingAvailable' AND$q$),
  ('workbench_sources.adopt_erp(text,text,text,text,text,jsonb)',
   $q$  EXECUTE format($upsert$INSERT INTO$q$,
   $q$  IF observation ? 'erpCategory' THEN
   cost_doc:=cost_doc||jsonb_build_object('erpCategory',observation->'erpCategory');
  END IF;
  EXECUTE format($upsert$INSERT INTO$q$),
  ('workbench_sources.adopt_erp(text,text,text,text,text,jsonb)',
   $q$||coalesce(addon,'{}')$q$,
   $q$||CASE WHEN observation ? 'erpCategory' THEN jsonb_build_object('erpCategory',observation->'erpCategory') ELSE '{}'::jsonb END
   ||coalesce(addon,'{}')$q$),
  -- 三店共用新建走 029 的投影函数，单店引入才走 adopt_erp。
  ('workbench_sources.project_with_tax_mode(text,text[],timestamp with time zone,text,text[],text[])',
   $q$IF attrs IS NULL AND erp_name IS NOT NULL THEN$q$,
   $q$IF attrs IS NULL AND effective_fields ? 'erpCategory' THEN
     next_attrs:=next_attrs||jsonb_build_object('erpCategory',effective_fields->'erpCategory');
    END IF;
    IF attrs IS NULL AND erp_name IS NOT NULL THEN$q$)
 ) AS patches(signature, original, replacement) LOOP
  definition:=pg_get_functiondef(patch.signature::regprocedure);
  IF strpos(definition,patch.replacement)>0 THEN CONTINUE; END IF;
  IF cardinality(string_to_array(definition,patch.original))<>2 THEN
   RAISE EXCEPTION 'ERP 类别迁移与已安装的 % 不匹配，请先核对函数版本',patch.signature;
  END IF;
  updated:=replace(definition,patch.original,patch.replacement);
  EXECUTE updated;
 END LOOP;
END $migration$;
COMMIT;
