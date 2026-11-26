-- 清理只经固定店铺函数执行；配置历史和素材没有级联删除路径。
BEGIN;
DO $migration$
DECLARE
 shop text; ns text; runtime text; fk record; ck record; tbl text;
BEGIN
 IF current_database() NOT IN ('diy_workbench','diy_workbench_trial') THEN
  RAISE EXCEPTION '回收站迁移只允许工作台正式库或试验库';
 END IF;
 IF to_regclass('intel_live.configurations') IS NULL THEN RAISE EXCEPTION '缺少工作台配置库'; END IF;
 FOREACH shop IN ARRAY ARRAY['intel','gigabyte','jonsbo'] LOOP
  ns:=shop||'_live';
  IF to_regnamespace(ns) IS NULL THEN CONTINUE; END IF;
  runtime:=CASE WHEN current_database()='diy_workbench_trial' AND shop='intel' THEN 'diy_api_operations'
                ELSE 'diy_api_'||shop||'_production' END;
  IF to_regrole(runtime) IS NULL OR to_regprocedure(ns||'.catalog_is_operator()') IS NULL THEN
   RAISE EXCEPTION '缺少 % 的运营权限基线',shop;
  END IF;
  -- 仅拆除指向配置的两条历史 FK；历史行之间的回执外键和其他约束原样保留。
  FOR fk IN SELECT c.conrelid::regclass AS relation,c.conname FROM pg_constraint c
   JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='configuration_id'
   WHERE c.contype='f' AND c.conrelid IN ((ns||'.audit_events')::regclass,(ns||'.save_receipts')::regclass)
   AND c.confrelid=(ns||'.configurations')::regclass AND c.conkey=ARRAY[a.attnum]
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',fk.relation,fk.conname); END LOOP;
  -- workspace_audit 的部分版本允许任意动作；有白名单的版本仅追加 purge。
  FOREACH tbl IN ARRAY ARRAY['audit_events','workspace_audit','catalog_audit'] LOOP
   FOR ck IN SELECT c.conname,pg_get_expr(c.conbin,c.conrelid) AS expr FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='action'
    WHERE c.conrelid=(ns||'.'||tbl)::regclass AND c.contype='c' AND c.conkey=ARRAY[a.attnum]
   LOOP
    IF strpos(ck.expr,'''purge''')=0 THEN
     EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK ((%s) OR action=''purge'')',
      ns,tbl,ck.conname,ck.conname,ck.expr);
    END IF;
   END LOOP;
  END LOOP;

  EXECUTE format($functions$
   -- 只保留曾彻底删除的来源键，不保留源行内容。旧库有未绑定来源的快照加购，
   -- 整套重存时会先删后插；不能因为历史键从未存在就拦截无关修改。
   CREATE TABLE IF NOT EXISTS %1$I.retention_purged_source_keys(source_id text PRIMARY KEY);
   -- 按字段抽取真实绑定，避免备注或同值 goodsId 被误计；兼容历史 snake_case。
   CREATE OR REPLACE FUNCTION %1$I.retention_json_source_ids(doc jsonb) RETURNS SETOF text
    LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $refs$
    SELECT DISTINCT val #>> '{}' FROM (
     SELECT jsonb_path_query(doc,'$.**.sourceId ? (@.type() == "string")') AS val
     UNION ALL SELECT jsonb_path_query(doc,'$.**.source_id ? (@.type() == "string")')
    ) ids WHERE val<>'""'::jsonb
   $refs$;
   CREATE OR REPLACE FUNCTION %1$I.deleted_source_references(p_shop text,p_ids text[])
    RETURNS TABLE(source_id text,configurations integer,templates integer)
    LANGUAGE sql STABLE SET search_path=pg_catalog AS $counts$
    WITH targets AS MATERIALIZED (
     SELECT s.source_id FROM %1$I.sources s WHERE p_shop=%2$L AND s.source_id=ANY(p_ids)
      AND (s.owner_shop=p_shop OR s.owner_shop='shared' OR s.shared) AND s.attrs->>'deletedAt' IS NOT NULL
    ), config_hits AS (
     SELECT p.source_id,p.configuration_id FROM %1$I.parts p JOIN targets t USING(source_id)
     UNION
     SELECT ref.id,a.configuration_id FROM %1$I.addons a
     CROSS JOIN LATERAL %1$I.retention_json_source_ids(jsonb_build_array(a.fields,a.items)) ref(id)
     JOIN targets t ON t.source_id=ref.id
    ), template_hits AS (
     SELECT ref.id,t.template_id FROM %1$I.templates t
     CROSS JOIN LATERAL %1$I.retention_json_source_ids(t.configurations) ref(id)
     JOIN targets s ON s.source_id=ref.id
    )
    SELECT s.source_id,coalesce(c.n,0),coalesce(t.n,0) FROM targets s
     LEFT JOIN (SELECT h.source_id,count(*)::int n FROM config_hits h GROUP BY h.source_id) c USING(source_id)
     LEFT JOIN (SELECT h.id,count(*)::int n FROM template_hits h GROUP BY h.id) t ON t.id=s.source_id
   $counts$;

   -- 关系表 parts 已有 FK；JSON 绑定加入同样的键锁，避免并发新增引用绕过删除检查。
   CREATE OR REPLACE FUNCTION %1$I.guard_retention_json_references() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $guard$
   DECLARE incoming jsonb; previous jsonb:='[]'; ref text;
   BEGIN
    IF TG_TABLE_NAME='templates' THEN
     incoming:=NEW.configurations;
     IF TG_OP='UPDATE' THEN previous:=OLD.configurations; END IF;
    ELSE
     incoming:=jsonb_build_array(NEW.fields,NEW.items);
     IF TG_OP='UPDATE' THEN previous:=jsonb_build_array(OLD.fields,OLD.items); END IF;
    END IF;
    FOR ref IN SELECT * FROM %1$I.retention_json_source_ids(incoming)
      EXCEPT SELECT * FROM %1$I.retention_json_source_ids(previous) ORDER BY 1 LOOP
     PERFORM 1 FROM %1$I.sources WHERE source_id=ref FOR KEY SHARE;
     IF NOT FOUND AND EXISTS(SELECT FROM %1$I.retention_purged_source_keys WHERE source_id=ref) THEN
      RAISE EXCEPTION USING MESSAGE='INVALID_DEPENDENCY';
     END IF;
    END LOOP;
    RETURN NEW;
   END $guard$;
   CREATE OR REPLACE TRIGGER retention_json_refs BEFORE INSERT OR UPDATE OF fields,items ON %1$I.addons
    FOR EACH ROW EXECUTE FUNCTION %1$I.guard_retention_json_references();
   CREATE OR REPLACE TRIGGER retention_json_refs BEFORE INSERT OR UPDATE OF configurations ON %1$I.templates
    FOR EACH ROW EXECUTE FUNCTION %1$I.guard_retention_json_references();

   -- 私有助手共用同一条删除路径，调用方不能绕开运营身份或定时保留期。
   CREATE OR REPLACE FUNCTION %1$I.retention_delete_config(p_id text,p_version bigint) RETURNS jsonb
    LANGUAGE plpgsql SET search_path=pg_catalog AS $delete$
   DECLARE target record;
   BEGIN
    SELECT version,archived_at INTO target FROM %1$I.configurations
     WHERE configuration_id=p_id AND shop_id=%2$L FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='NOT_FOUND'; END IF;
    IF target.archived_at IS NULL THEN RAISE EXCEPTION USING MESSAGE='INVALID_CONFIGURATION_STATE'; END IF;
    IF target.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION USING MESSAGE='VERSION_CONFLICT'; END IF;
    DELETE FROM %1$I.parts WHERE configuration_id=p_id;
    DELETE FROM %1$I.addons WHERE configuration_id=p_id;
    DELETE FROM %1$I.quotations WHERE configuration_id=p_id;
    DELETE FROM %1$I.intel_quotation_overrides WHERE configuration_id=p_id;
    DELETE FROM %1$I.publications WHERE configuration_id=p_id;
    DELETE FROM %1$I.configurations WHERE configuration_id=p_id;
    RETURN jsonb_build_object('configuration_id',p_id,'version',(p_version+1)::text,'purged',true);
   END $delete$;
   CREATE OR REPLACE FUNCTION %1$I.purge_archived_configuration(p_shop text,p_config_id text,p_expected_version bigint)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $manual$
   BEGIN
    IF p_shop IS DISTINCT FROM %2$L OR NOT %1$I.catalog_is_operator() THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
    RETURN %1$I.retention_delete_config(p_config_id,p_expected_version);
   END $manual$;
   CREATE OR REPLACE FUNCTION %1$I.retention_delete_source(p_id text,p_version bigint,allow_shared boolean,check_references boolean)
    RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $delete$
   DECLARE target record; refs record; parent text;
   BEGIN
    -- 与跨店投影保持父条目在前的锁序；巡检已预锁来源，碰到正在编辑的父条目立即跳过。
    IF to_regclass('workbench_sources.aliases') IS NOT NULL THEN
     EXECUTE 'SELECT e.id FROM workbench_sources.aliases a JOIN workbench_sources.entries e ON e.id=a.entry_id
       WHERE a.shop_id=$1 AND a.source_id=$2 FOR UPDATE OF e'||CASE WHEN check_references THEN '' ELSE ' NOWAIT' END
      INTO parent USING %2$L,p_id;
    END IF;
    SELECT owner_shop,shared,version,attrs->>'deletedAt' AS deleted INTO target FROM %1$I.sources
     WHERE source_id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='NOT_FOUND'; END IF;
    IF NOT (target.owner_shop=%2$L AND NOT target.shared) AND NOT
     (allow_shared AND %2$L='intel' AND target.owner_shop IN (%2$L,'shared')
      AND %1$I.catalog_can_write(target.owner_shop,target.shared,'sources')) THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
    IF target.deleted IS NULL THEN RAISE EXCEPTION USING MESSAGE='INVALID_CATALOG_STATE'; END IF;
    IF target.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION USING MESSAGE='VERSION_CONFLICT'; END IF;
    IF check_references THEN
     SELECT * INTO STRICT refs FROM %1$I.deleted_source_references(%2$L,ARRAY[p_id]);
     IF refs.configurations>0 OR refs.templates>0 THEN
      RAISE EXCEPTION USING MESSAGE='CATALOG_IN_USE',DETAIL=jsonb_build_object('configurations',refs.configurations,'templates',refs.templates)::text;
     END IF;
    END IF;
    IF parent IS NOT NULL THEN
     DELETE FROM workbench_sources.aliases WHERE shop_id=%2$L AND source_id=p_id AND entry_id=parent;
     IF FOUND THEN
      DELETE FROM workbench_sources.entries e WHERE e.id=parent
       AND NOT EXISTS(SELECT FROM workbench_sources.aliases a WHERE a.entry_id=e.id);
      -- 其余店铺仍在使用父条目，旧草稿应在下一次保存时重新核对别名版本。
      IF NOT FOUND THEN UPDATE workbench_sources.entries SET version=version+1 WHERE id=parent; END IF;
     END IF;
    END IF;
    INSERT INTO %1$I.retention_purged_source_keys(source_id) VALUES(p_id) ON CONFLICT DO NOTHING;
    DELETE FROM %1$I.sources WHERE source_id=p_id;
    RETURN jsonb_build_object('resource_id',p_id,'version',(p_version+1)::text,'purged',true);
   END $delete$;
   CREATE OR REPLACE FUNCTION %1$I.purge_deleted_source(p_shop text,p_source_id text,p_expected_version bigint)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $manual$
   BEGIN
    IF p_shop IS DISTINCT FROM %2$L OR NOT %1$I.catalog_is_operator() THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
    -- JSON 引用检查必须看得到取得源行锁之前刚提交的引用；旧事务快照应重新开启写事务。
    IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
     RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='回收站写入需要最新引用快照';
    END IF;
    RETURN %1$I.retention_delete_source(p_source_id,p_expected_version,true,true);
   END $manual$;
   CREATE OR REPLACE FUNCTION %1$I.retention_deleted_at(stamp text) RETURNS timestamptz
    LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog AS $date$
   BEGIN
    -- 排除相对日期、无限日期及不能确定年份的历史脏值。
    IF stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ].+)?$' THEN RETURN NULL; END IF;
    RETURN stamp::timestamptz;
   EXCEPTION WHEN data_exception THEN RETURN NULL;
   END $date$;
   CREATE OR REPLACE FUNCTION %1$I.purge_expired_retention(p_shop text,p_config_days integer DEFAULT 7,p_source_days integer DEFAULT 30)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='75ms' AS $sweep$
   DECLARE item record; nc integer:=0; ns integer:=0; protected integer:=0; result jsonb; op uuid; hash text;
    ws text:=coalesce(nullif(current_setting('%1$s.catalog_workspace',true),''),'retention-system');
    due_ids text[]; candidates text[]; locked_ids text[];
   BEGIN
    IF p_shop IS DISTINCT FROM %2$L THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
    IF p_config_days IS NULL OR p_config_days NOT BETWEEN 7 AND 36500 OR
       p_source_days IS NULL OR p_source_days NOT BETWEEN 30 AND 36500 THEN RAISE EXCEPTION USING MESSAGE='INVALID_RETENTION'; END IF;
    IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
     RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='回收站写入需要最新引用快照';
    END IF;
    IF pg_try_advisory_xact_lock(814520,%3$s) THEN
     FOR item IN SELECT configuration_id AS id,version FROM %1$I.configurations WHERE shop_id=p_shop AND
      archived_at<=now()-make_interval(days=>p_config_days) ORDER BY configuration_id FOR UPDATE SKIP LOCKED LOOP
      BEGIN
       result:=%1$I.retention_delete_config(item.id,item.version);
      EXCEPTION WHEN lock_not_available OR deadlock_detected THEN CONTINUE;
      END;
      op:=gen_random_uuid(); hash:=encode(sha256(convert_to(op::text,'UTF8')),'hex');
      INSERT INTO %1$I.workspace_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,request_sha256,result)
       VALUES(ws,'system:retention',op,p_shop,'configurations',hash,result);
      INSERT INTO %1$I.workspace_audit(workspace_id,actor_uid,operation_id,position,resource_id,action,previous_version,next_version,request_id)
       VALUES(ws,'system:retention',op,1,item.id,'purge',item.version,item.version+1,op);
      nc:=nc+1;
     END LOOP;
     -- 先排除被引用的到期源，不占用它们的行锁；只对初筛可删项加锁后批量复核。
     SELECT array_agg(s.source_id) INTO due_ids FROM %1$I.sources s WHERE s.owner_shop=p_shop AND NOT s.shared
      AND %1$I.retention_deleted_at(s.attrs->>'deletedAt')<=now()-make_interval(days=>p_source_days);
     SELECT array_agg(r.source_id) FILTER (WHERE r.configurations=0 AND r.templates=0),
      count(*) FILTER (WHERE r.configurations>0 OR r.templates>0) INTO candidates,protected
      FROM %1$I.deleted_source_references(p_shop,due_ids) r;
     SELECT array_agg(s.source_id) INTO locked_ids FROM
      (SELECT source_id FROM %1$I.sources WHERE source_id=ANY(candidates) AND owner_shop=p_shop AND NOT shared AND
       %1$I.retention_deleted_at(attrs->>'deletedAt')<=now()-make_interval(days=>p_source_days)
       ORDER BY source_id FOR UPDATE SKIP LOCKED) s;
     FOR item IN SELECT s.source_id AS id,s.version,r.configurations,r.templates
      FROM %1$I.deleted_source_references(p_shop,locked_ids) r JOIN %1$I.sources s USING(source_id) ORDER BY s.source_id LOOP
      IF item.configurations>0 OR item.templates>0 THEN protected:=protected+1; CONTINUE; END IF;
      BEGIN
       result:=%1$I.retention_delete_source(item.id,item.version,false,false);
      EXCEPTION WHEN lock_not_available OR deadlock_detected THEN CONTINUE;
      END;
      op:=gen_random_uuid(); hash:=encode(sha256(convert_to(op::text,'UTF8')),'hex');
      INSERT INTO %1$I.catalog_receipts(workspace_id,actor_uid,operation_id,shop_id,kind,resource_id,request_sha256,result)
       VALUES(ws,'system:retention',op,p_shop,'sources',item.id,hash,result);
      INSERT INTO %1$I.catalog_audit(workspace_id,actor_uid,operation_id,action,previous_version,next_version,request_id)
       VALUES(ws,'system:retention',op,'purge',item.version,item.version+1,op);
      ns:=ns+1;
     END LOOP;
    END IF;
    RETURN jsonb_build_object('purged_configs',nc,'purged_sources',ns,'skipped_referenced_sources',protected);
   END $sweep$;
  $functions$,ns,shop,CASE shop WHEN 'intel' THEN 76 WHEN 'gigabyte' THEN 77 ELSE 78 END);
  -- 私有助手仅供定义者函数调用；运行角色没有 DELETE ON 配置、来源或历史表。
  EXECUTE format('REVOKE ALL ON TABLE %1$I.retention_purged_source_keys FROM PUBLIC,%2$I',ns,runtime);
  EXECUTE format('REVOKE ALL ON FUNCTION %1$I.retention_json_source_ids(jsonb),%1$I.deleted_source_references(text,text[]),
   %1$I.guard_retention_json_references(),%1$I.retention_delete_config(text,bigint),%1$I.retention_delete_source(text,bigint,boolean,boolean),
   %1$I.retention_deleted_at(text),%1$I.purge_archived_configuration(text,text,bigint),
   %1$I.purge_deleted_source(text,text,bigint),%1$I.purge_expired_retention(text,integer,integer) FROM PUBLIC',ns);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %1$I.retention_json_source_ids(jsonb),%1$I.deleted_source_references(text,text[]),
   %1$I.purge_archived_configuration(text,text,bigint),%1$I.purge_deleted_source(text,text,bigint),
   %1$I.purge_expired_retention(text,integer,integer) TO %2$I',ns,runtime);
 END LOOP;
END $migration$;
COMMIT;
