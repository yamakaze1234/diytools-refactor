-- 在现有函数上只扩展库存观察，保留已安装的核算价保护、权限、锁及回执逻辑。
-- 先核对每段锚点，任一函数不匹配即回滚整个迁移。可重复执行。
BEGIN;
DO $migration$
DECLARE
 patch record;
 definition text;
 updated text;
BEGIN
 IF current_database() <> 'diy_workbench' THEN RAISE EXCEPTION '需要三店工作台数据库'; END IF;
 FOR patch IN SELECT * FROM (VALUES
  ('workbench_sources.cost_sync_snapshot(text,text,text)',
   $q$'stockAvailable',r.document->'stockAvailable',$q$,
   $q$'stockAvailable',r.document->'stockAvailable','stockIncomingAvailable',r.document->'stockIncomingAvailable',$q$),
  ('workbench_sources.apply_cost_sync(text,text,text,text,jsonb,uuid)',
   $q$ELSE incoming ?& ARRAY['erp','stockAvailable','name','sku'] AND$q$,
   $q$ELSE incoming ?& ARRAY['erp','stockAvailable','name','sku'] AND
       (NOT incoming ? 'stockIncomingAvailable' OR incoming->'stockIncomingAvailable'='null'::jsonb OR
        jsonb_typeof(incoming->'stockIncomingAvailable')='number' AND abs((incoming->>'stockIncomingAvailable')::numeric)<=9007199254740991) AND$q$),
  ('workbench_sources.apply_cost_sync(text,text,text,text,jsonb,uuid)',
   $q$IF NOT next_doc @> cost_data THEN$q$,
   $q$IF incoming ? 'stockIncomingAvailable' THEN
     cost_data:=cost_data||jsonb_build_object('stockIncomingAvailable',incoming->'stockIncomingAvailable');
    END IF;
    IF NOT next_doc @> cost_data THEN$q$),
  ('workbench_sources.adopt_erp(text,text,text,text,text,jsonb)',
   $q$OR coalesce(jsonb_typeof(observation->'stockAvailable'),'') NOT IN ('null','number')$q$,
   $q$OR coalesce(jsonb_typeof(observation->'stockAvailable'),'') NOT IN ('null','number')
  OR observation ? 'stockIncomingAvailable' AND (jsonb_typeof(observation->'stockIncomingAvailable') NOT IN ('null','number')
    OR abs((observation->>'stockIncomingAvailable')::numeric)>9007199254740991)$q$),
  ('workbench_sources.adopt_erp(text,text,text,text,text,jsonb)',
   $q$'stockAvailable',observation->'stockAvailable',$q$,
   $q$'stockAvailable',observation->'stockAvailable','stockIncomingAvailable',observation->'stockIncomingAvailable',$q$)
 ) AS patches(signature, original, replacement) LOOP
  definition:=pg_get_functiondef(patch.signature::regprocedure);
  IF strpos(definition,patch.replacement)>0 THEN CONTINUE; END IF;
  IF cardinality(string_to_array(definition,patch.original))<>2 THEN
   RAISE EXCEPTION '库存字段迁移与已安装的 % 不匹配，请先核对函数版本',patch.signature;
  END IF;
  updated:=replace(definition,patch.original,patch.replacement);
  EXECUTE updated;
 END LOOP;
END $migration$;
COMMIT;
