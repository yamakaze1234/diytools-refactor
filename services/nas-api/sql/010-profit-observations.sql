-- 单独保存英特尔 NAS 的检测历史与比较基准。不读旧历史，不改配置、成本或销售报价。
DO $nas_profit_install$
DECLARE runtime_role text;
BEGIN
 runtime_role:=CASE current_database()
  WHEN 'diy_workbench' THEN 'diy_api_intel_production'
  WHEN 'diy_workbench_trial' THEN 'diy_api_operations' END;
 IF runtime_role IS NULL THEN RAISE EXCEPTION '只允许英特尔正式库或试验库'; END IF;
 IF to_regrole(runtime_role) IS NULL OR to_regprocedure('intel_live.catalog_is_operator()') IS NULL OR
    NOT has_schema_privilege(runtime_role,'intel_live','USAGE') OR
    NOT has_function_privilege(runtime_role,'intel_live.catalog_is_operator()','EXECUTE') OR
    NOT EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel')
 THEN RAISE EXCEPTION '请先核对英特尔运行库与已有运营权限'; END IF;
 PERFORM pg_advisory_xact_lock(814517,6);

 CREATE TABLE IF NOT EXISTS intel_live.profit_runs(
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id text NOT NULL, actor_uid text NOT NULL,
  request_id uuid NOT NULL, scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),
  run_id uuid NOT NULL DEFAULT gen_random_uuid(), started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  covered integer NOT NULL CHECK(covered BETWEEN 1 AND 5000), UNIQUE(workspace_id,actor_uid,request_id), UNIQUE(workspace_id,run_id)
 );
 CREATE TABLE IF NOT EXISTS intel_live.profit_observations(
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id text NOT NULL, run_id uuid NOT NULL,
  result_id uuid NOT NULL DEFAULT gen_random_uuid(), configuration_id text NOT NULL, configuration_version bigint NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'), profit_cents bigint, payload jsonb NOT NULL,
  UNIQUE(workspace_id,run_id,configuration_id), UNIQUE(workspace_id,result_id),
  FOREIGN KEY(workspace_id,run_id) REFERENCES intel_live.profit_runs(workspace_id,run_id)
 );
 CREATE INDEX IF NOT EXISTS profit_observations_by_config
  ON intel_live.profit_observations(workspace_id,configuration_id,sequence DESC);
 CREATE TABLE IF NOT EXISTS intel_live.profit_baselines(
  workspace_id text NOT NULL, configuration_id text NOT NULL, latest_id uuid NOT NULL, latest_cents bigint NOT NULL,
  anchor_id uuid NOT NULL, anchor_cents bigint NOT NULL, was_loss boolean NOT NULL, PRIMARY KEY(workspace_id,configuration_id),
  FOREIGN KEY(workspace_id,latest_id) REFERENCES intel_live.profit_observations(workspace_id,result_id),
  FOREIGN KEY(workspace_id,anchor_id) REFERENCES intel_live.profit_observations(workspace_id,result_id)
 );
 CREATE TABLE IF NOT EXISTS intel_live.profit_reset_receipts(
  workspace_id text NOT NULL, actor_uid text NOT NULL, request_id uuid NOT NULL, result_id uuid NOT NULL,
  configuration_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,actor_uid,request_id),
  FOREIGN KEY(workspace_id,result_id) REFERENCES intel_live.profit_observations(workspace_id,result_id)
 );
 REVOKE ALL ON intel_live.profit_runs,intel_live.profit_observations,intel_live.profit_baselines,intel_live.profit_reset_receipts FROM PUBLIC;

 CREATE OR REPLACE FUNCTION intel_live.profit_observe(operation text, args jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $profit$
 DECLARE
  ws text:=current_setting('intel_live.catalog_workspace',true); actor text:=current_setting('intel_live.catalog_uid',true);
  req uuid; run_ref uuid; result_ref uuid; cfg text; off integer; row_count integer; item jsonb; view jsonb;
  p bigint; config_rev bigint; prev_delta bigint; anchor_delta bigint; loss boolean; changed boolean;
  r intel_live.profit_runs%ROWTYPE; b intel_live.profit_baselines%ROWTYPE;
  observation intel_live.profit_observations%ROWTYPE; receipt intel_live.profit_reset_receipts%ROWTYPE;
 BEGIN
  IF intel_live.catalog_is_operator() IS NOT TRUE THEN RETURN jsonb_build_object('error','FORBIDDEN'); END IF;
  IF operation NOT IN ('lookup','start','history','status','reset_lookup','reset') OR jsonb_typeof(args) IS DISTINCT FROM 'object'
   THEN RETURN jsonb_build_object('error','INVALID_REQUEST'); END IF;
  IF operation IN ('start','reset') THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(ws,814569));
  END IF;
  IF operation IN ('lookup','start','reset_lookup','reset') THEN req:=(args->>'requestId')::uuid; END IF;
  IF operation IN ('lookup','start') THEN
   IF req IS NULL OR coalesce(args->>'scopeHash','')!~'^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('error','INVALID_REQUEST'); END IF;
   SELECT * INTO r FROM intel_live.profit_runs WHERE workspace_id=ws AND actor_uid=actor AND request_id=req;
   IF FOUND THEN
    IF r.scope_hash<>args->>'scopeHash' THEN RETURN jsonb_build_object('error','OPERATION_REUSED'); END IF;
    RETURN jsonb_build_object('runId',r.run_id);
   END IF;
   IF operation='lookup' THEN RETURN '{}'::jsonb; END IF;
   IF jsonb_typeof(args->'results') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('error','INVALID_REQUEST'); END IF;
   row_count:=jsonb_array_length(args->'results');
   IF row_count NOT BETWEEN 1 AND 5000 OR (SELECT count(DISTINCT v->>'config_id') FROM jsonb_array_elements(args->'results') v)<>row_count
    THEN RETURN jsonb_build_object('error','INVALID_REQUEST'); END IF;
   -- 核算输入只能指向此刻仍存在的英特尔普通配置；批内任何一套漂移时整次回滚。
   FOR item IN SELECT value FROM jsonb_array_elements(args->'results') LOOP
    IF item->>'shop_id' IS DISTINCT FROM 'intel' OR item->>'metric' IS DISTINCT FROM 'accounting' OR
       coalesce(item->>'fingerprint','')!~'^[a-f0-9]{64}$' OR jsonb_typeof(item->'valid') IS DISTINCT FROM 'boolean' OR
       ((item->>'profit_cents' IS NOT NULL) IS DISTINCT FROM (item->>'valid')::boolean) OR
       jsonb_typeof(item->'snapshot') IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('error','INVALID_REQUEST'); END IF;
    SELECT c.version INTO config_rev FROM intel_live.configurations c WHERE c.shop_id='intel' AND c.archived_at IS NULL
     AND c.configuration_id=item->>'config_id' AND coalesce(c.fields->>'productCategory','')<>'主机模板'
     AND coalesce(c.fields->>'emptyLinkDraft','false')<>'true' FOR SHARE;
    IF config_rev IS NULL OR config_rev IS DISTINCT FROM (item->>'config_version')::bigint THEN RETURN jsonb_build_object('error','VERSION_CONFLICT'); END IF;
   END LOOP;
   INSERT INTO intel_live.profit_runs(workspace_id,actor_uid,request_id,scope_hash,covered)
    VALUES(ws,actor,req,args->>'scopeHash',row_count) RETURNING run_id INTO run_ref;
   FOR item IN SELECT value FROM jsonb_array_elements(args->'results') LOOP
    cfg:=item->>'config_id'; p:=(item->>'profit_cents')::bigint; loss:=coalesce(p< -30000,false);
    SELECT * INTO b FROM intel_live.profit_baselines WHERE workspace_id=ws AND configuration_id=cfg;
    prev_delta:=p-b.latest_cents; anchor_delta:=p-b.anchor_cents; changed:=coalesce(abs(anchor_delta)>10000,false);
    result_ref:=gen_random_uuid();
    INSERT INTO intel_live.profit_observations(workspace_id,run_id,result_id,configuration_id,configuration_version,fingerprint,profit_cents,payload)
     VALUES(ws,run_ref,result_ref,cfg,(item->>'config_version')::bigint,item->>'fingerprint',p,
      (item-'fingerprint'-'config_version')||jsonb_build_object('id',result_ref,'loss',loss,'changed',changed,
       'previous_delta_cents',prev_delta,'anchor_delta_cents',anchor_delta,'recovered',coalesce(p IS NOT NULL AND b.was_loss AND NOT loss,false)));
    -- 未知利润仍是历史观察，不推进比较基准。超过门槛后以该次有效观察为新累计基准。
    IF p IS NOT NULL THEN
     INSERT INTO intel_live.profit_baselines VALUES(ws,cfg,result_ref,p,
      CASE WHEN changed THEN result_ref ELSE coalesce(b.anchor_id,result_ref) END,
      CASE WHEN changed THEN p ELSE coalesce(b.anchor_cents,p) END,loss)
     ON CONFLICT(workspace_id,configuration_id) DO UPDATE SET latest_id=excluded.latest_id,latest_cents=excluded.latest_cents,
      anchor_id=excluded.anchor_id,anchor_cents=excluded.anchor_cents,was_loss=excluded.was_loss;
    END IF;
   END LOOP;
   RETURN jsonb_build_object('runId',run_ref);
  END IF;
  IF operation='history' THEN
   RETURN jsonb_build_object('runs',coalesce((SELECT jsonb_agg(jsonb_build_object('id',h.run_id,'shop_id','intel',
    'started_at',h.started_at,'covered',h.covered,'status','completed') ORDER BY h.sequence DESC)
    FROM (SELECT * FROM intel_live.profit_runs WHERE workspace_id=ws ORDER BY sequence DESC LIMIT 50) h),'[]'::jsonb));
  END IF;
  IF operation='status' THEN
   run_ref:=(args->>'runId')::uuid;off:=greatest(0,coalesce((args->>'offset')::integer,0));
   SELECT * INTO r FROM intel_live.profit_runs WHERE workspace_id=ws AND run_id=run_ref;
   IF NOT FOUND THEN RETURN jsonb_build_object('error','NOT_FOUND'); END IF;
   SELECT coalesce(jsonb_agg(o.payload||jsonb_build_object('configUpdated',
    c.version IS DISTINCT FROM o.configuration_version OR c.archived_at IS NOT NULL) ORDER BY o.sequence),'[]'::jsonb)
   INTO view FROM (SELECT * FROM intel_live.profit_observations WHERE workspace_id=ws AND run_id=run_ref
    ORDER BY sequence LIMIT 60 OFFSET off) o
   LEFT JOIN intel_live.configurations c ON c.shop_id='intel' AND c.configuration_id=o.configuration_id;
   RETURN jsonb_build_object('run',jsonb_build_object('id',r.run_id,'shop_id','intel','status','completed','started_at',r.started_at,
    'covered',r.covered,'erpCollected',false,'accountingSource','saved-tax'),'results',view,
    'nextOffset',CASE WHEN off+60<r.covered THEN off+60 ELSE NULL END);
  END IF;
  IF operation IN ('reset_lookup','reset') THEN
   cfg:=args->>'configId';result_ref:=(args->>'resultId')::uuid;
   IF req IS NULL OR cfg IS NULL OR result_ref IS NULL THEN RETURN jsonb_build_object('error','INVALID_REQUEST'); END IF;
   SELECT * INTO receipt FROM intel_live.profit_reset_receipts WHERE workspace_id=ws AND actor_uid=actor AND request_id=req;
   IF FOUND THEN
    IF receipt.configuration_id<>cfg OR receipt.result_id<>result_ref THEN RETURN jsonb_build_object('error','OPERATION_REUSED'); END IF;
    RETURN jsonb_build_object('ok',true);
   END IF;
   IF operation='reset_lookup' THEN RETURN '{}'::jsonb; END IF;
   SELECT * INTO observation FROM intel_live.profit_observations WHERE workspace_id=ws AND configuration_id=cfg ORDER BY sequence DESC LIMIT 1;
   SELECT c.version INTO config_rev FROM intel_live.configurations c WHERE c.shop_id='intel' AND c.configuration_id=cfg AND c.archived_at IS NULL FOR SHARE;
   IF observation.result_id IS DISTINCT FROM result_ref OR observation.profit_cents IS NULL OR
      observation.fingerprint IS DISTINCT FROM args->>'fingerprint' OR config_rev IS DISTINCT FROM observation.configuration_version
    THEN RETURN jsonb_build_object('error','PROFIT_RESULT_STALE'); END IF;
   UPDATE intel_live.profit_baselines SET anchor_id=result_ref,anchor_cents=observation.profit_cents WHERE workspace_id=ws AND configuration_id=cfg;
   IF NOT FOUND THEN RETURN jsonb_build_object('error','PROFIT_RESULT_STALE'); END IF;
   INSERT INTO intel_live.profit_reset_receipts(workspace_id,actor_uid,request_id,result_id,configuration_id) VALUES(ws,actor,req,result_ref,cfg);
   RETURN jsonb_build_object('ok',true);
  END IF;
  RETURN jsonb_build_object('error','INVALID_REQUEST');
 END $profit$;
 REVOKE ALL ON FUNCTION intel_live.profit_observe(text,jsonb) FROM PUBLIC;
 EXECUTE format('GRANT EXECUTE ON FUNCTION intel_live.profit_observe(text,jsonb) TO %I',runtime_role);
END $nas_profit_install$;
