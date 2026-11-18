-- 只建英特尔价格变动记录和处理标记；历史从安装后实际成本写入起累计。
DO $install_price_history$
DECLARE runtime_role text;
BEGIN
 runtime_role:=CASE current_database() WHEN 'diy_workbench' THEN 'diy_api_intel_production' WHEN 'diy_workbench_trial' THEN 'diy_api_operations' END;
 IF runtime_role IS NULL OR to_regrole(runtime_role) IS NULL OR to_regprocedure('intel_live.catalog_is_operator()') IS NULL
   OR NOT EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel')
 THEN RAISE EXCEPTION '请先核对英特尔运行库与已有运营权限'; END IF;
 PERFORM pg_advisory_xact_lock(814517,7);
 CREATE TABLE IF NOT EXISTS intel_live.price_history(
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id text NOT NULL,
  operation_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  message text NOT NULL, items jsonb NOT NULL, configs jsonb NOT NULL,
  UNIQUE(workspace_id,operation_id)
 );
 CREATE INDEX IF NOT EXISTS price_history_scope ON intel_live.price_history(workspace_id,created_at DESC,revision DESC);
 CREATE TABLE IF NOT EXISTS intel_live.price_history_handled(
  revision bigint NOT NULL REFERENCES intel_live.price_history(revision), configuration_id text NOT NULL,
  PRIMARY KEY(revision,configuration_id)
 );
 REVOKE ALL ON intel_live.price_history,intel_live.price_history_handled FROM PUBLIC;
 CREATE OR REPLACE FUNCTION intel_live.operations_price_history(action text,args jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $price_history$
 DECLARE ws text:=current_setting('intel_live.catalog_workspace',true); r bigint;
  off integer; cfg text; batch intel_live.price_history%ROWTYPE; day_start timestamptz;
 BEGIN
  IF NOT intel_live.catalog_is_operator() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  IF action='append' THEN
   IF jsonb_typeof(args->'items') IS DISTINCT FROM 'array' OR jsonb_typeof(args->'configs') IS DISTINCT FROM 'array'
     OR jsonb_array_length(args->'items') NOT BETWEEN 1 AND 100 OR jsonb_array_length(args->'configs')>5000
     OR length(args->>'message')>100 THEN RAISE EXCEPTION 'invalid price history payload'; END IF;
   INSERT INTO intel_live.price_history(workspace_id,operation_id,message,items,configs)
    VALUES(ws,(args->>'operationId')::uuid,args->>'message',args->'items',args->'configs');
   RETURN '{}'::jsonb;
  ELSIF action='list' THEN
   off:=coalesce((args->>'offset')::integer,0);
   IF off NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'invalid offset'; END IF;
   RETURN jsonb_build_object('batches',coalesce((SELECT jsonb_agg(jsonb_build_object('revision',revision,'at',created_at,'message',message) ORDER BY revision DESC)
    FROM (SELECT revision,created_at,message FROM intel_live.price_history WHERE workspace_id=ws ORDER BY revision DESC LIMIT 30 OFFSET off) q),'[]'::jsonb));
  ELSIF action='day' THEN
   day_start:=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
   RETURN jsonb_build_object('day',to_char(day_start AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD'),
    'baselineKnown',EXISTS(SELECT FROM intel_live.price_history WHERE workspace_id=ws AND created_at<day_start AND created_at>=day_start-interval '1 day'),
    'yesterday',coalesce((SELECT jsonb_agg(revision ORDER BY revision) FROM intel_live.price_history WHERE workspace_id=ws AND created_at<day_start AND created_at>=day_start-interval '1 day'),'[]'::jsonb),
    'revisions',coalesce((SELECT jsonb_agg(revision ORDER BY revision) FROM intel_live.price_history WHERE workspace_id=ws AND created_at>=day_start),'[]'::jsonb));
  ELSIF action IN ('detail','handle') THEN
   r:=(args->>'revision')::bigint;
   SELECT * INTO batch FROM intel_live.price_history WHERE workspace_id=ws AND revision=r;
   IF NOT FOUND THEN RETURN jsonb_build_object('missing',true); END IF;
   IF action='handle' THEN
    cfg:=args->>'configId';
    IF NOT EXISTS(SELECT FROM jsonb_array_elements(batch.configs) x WHERE x->'after'->>'id'=cfg) THEN RETURN jsonb_build_object('missing',true); END IF;
    IF (args->>'handled')::boolean THEN INSERT INTO intel_live.price_history_handled VALUES(r,cfg) ON CONFLICT DO NOTHING;
    ELSE DELETE FROM intel_live.price_history_handled WHERE revision=r AND configuration_id=cfg; END IF;
    RETURN jsonb_build_object('ok',true);
   END IF;
   off:=coalesce((args->>'offset')::integer,0);
   IF off NOT BETWEEN 0 AND 5000 THEN RAISE EXCEPTION 'invalid offset'; END IF;
   RETURN jsonb_build_object('revision',r,'at',batch.created_at,'message',batch.message,'items',CASE WHEN off=0 THEN batch.items ELSE '[]'::jsonb END,
    'handled',CASE WHEN off=0 THEN coalesce((SELECT jsonb_agg(configuration_id ORDER BY configuration_id) FROM intel_live.price_history_handled WHERE revision=r),'[]'::jsonb) ELSE '[]'::jsonb END,
    'configs',coalesce((SELECT jsonb_agg(x ORDER BY i) FROM jsonb_array_elements(batch.configs) WITH ORDINALITY AS e(x,i) WHERE i>off AND i<=off+30),'[]'::jsonb),
    'nextOffset',CASE WHEN off+30<jsonb_array_length(batch.configs) THEN off+30 ELSE NULL END);
  END IF;
  RAISE EXCEPTION 'invalid price history action';
 END;
 $price_history$;
 REVOKE ALL ON FUNCTION intel_live.operations_price_history(text,jsonb) FROM PUBLIC;
 EXECUTE format('GRANT EXECUTE ON FUNCTION intel_live.operations_price_history(text,jsonb) TO %I',runtime_role);
END;
$install_price_history$;
