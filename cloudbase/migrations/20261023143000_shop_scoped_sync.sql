-- Selected-shop downloads retain global sequence cursors and shared records. Unscoped clients keep the original protocol.
CREATE OR REPLACE FUNCTION public.wa_api(request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 m public.wa_members%ROWTYPE; p jsonb; action text; cp bigint; head bigint;
 shops jsonb; cur bigint; stop_seq bigint; next_cur bigint; page_size int; rows jsonb; next_key jsonb; has_more boolean; old_key public.wa_mutation_keys%ROWTYPE;
BEGIN
 IF coalesce(auth.role(),'')<>'authenticated' OR coalesce(auth.uid(),'')='' OR coalesce(auth.jwt()->>'is_anonymous','false')='true' THEN
  RETURN jsonb_build_object('ok',false,'code','UNAUTHENTICATED','message','请使用成员账号登录');
 END IF;
 SELECT * INTO m FROM public.wa_members WHERE uid=auth.uid() AND active=true;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','NOT_MEMBER'); END IF;
 IF request->>'protocolVersion' IS DISTINCT FROM '2' THEN RETURN jsonb_build_object('ok',false,'code','UPGRADE_REQUIRED'); END IF;
 p:=coalesce(request->'payload','{}'::jsonb);action:=request->>'action';
 shops:=p->'shopIds';
 IF action IN ('sync.pull','sync.snapshot') AND shops IS NOT NULL THEN
  IF jsonb_typeof(shops)<>'array' THEN RETURN jsonb_build_object('ok',false,'code','INVALID_SHOPS'); END IF;
  IF jsonb_array_length(shops) NOT BETWEEN 1 AND 3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(shops) x WHERE jsonb_typeof(x)<>'string' OR x#>>'{}' NOT IN ('intel','gigabyte','jonsbo')) THEN RETURN jsonb_build_object('ok',false,'code','INVALID_SHOPS'); END IF;
 END IF;
 IF action='sync.push' THEN
  -- Serialize with receipt archival before checking the permanent tombstone.
  SELECT head_seq INTO head FROM public.wa_workspaces WHERE id=m.workspace_id FOR UPDATE;
  SELECT * INTO old_key FROM public.wa_mutation_keys WHERE workspace_id=m.workspace_id AND mutation_id=p->>'mutationId';
  IF FOUND THEN
   IF old_key.member_id<>m.member_id OR old_key.request_hash<>encode(sha256(convert_to(p::text,'UTF8')),'hex') THEN
    RETURN jsonb_build_object('ok',false,'code','MUTATION_REUSED','message','同一提交 ID 不能携带不同内容');
   END IF;
   RETURN jsonb_build_object('ok',false,'code','RECEIPT_EXPIRED','message','旧提交回执已归档；原请求未重复执行，请核对本地待同步内容');
  END IF;
 ELSIF action='sync.receipt' THEN
  SELECT head_seq INTO head FROM public.wa_workspaces WHERE id=m.workspace_id FOR SHARE;
  IF EXISTS(SELECT 1 FROM public.wa_mutation_keys WHERE workspace_id=m.workspace_id AND mutation_id=p->>'mutationId' AND member_id=m.member_id) THEN
   RETURN jsonb_build_object('ok',false,'code','RECEIPT_EXPIRED','message','旧提交回执已归档');
  END IF;
 ELSIF action='sync.bootstrap' THEN
  SELECT head_seq INTO head FROM public.wa_workspaces WHERE id=m.workspace_id;
  SELECT seq INTO cp FROM public.wa_sync_checkpoints WHERE workspace_id=m.workspace_id;
  RETURN jsonb_build_object('ok',true,'headSeq',head,'fromCursor',coalesce(cp,0),'protocolVersion',2,
   'strategy',CASE WHEN cp IS NULL THEN 'replay-retained-log' ELSE 'checkpoint-replay' END);
 ELSIF action='sync.pull' THEN
  SELECT head_seq INTO head FROM public.wa_workspaces WHERE id=m.workspace_id FOR SHARE;
  SELECT seq INTO cp FROM public.wa_sync_checkpoints WHERE workspace_id=m.workspace_id;
  IF cp IS NOT NULL AND coalesce((p->>'cursor')::bigint,0)<cp THEN
   RETURN jsonb_build_object('ok',false,'code','SNAPSHOT_REQUIRED','checkpointSeq',cp,'message','同步日志已归档，需要接收云端检查点');
  END IF;

  IF shops IS NOT NULL THEN
   cur:=coalesce((p->>'cursor')::bigint,0); stop_seq:=coalesce((p->>'headSeq')::bigint,head);
   page_size:=least(100,greatest(1,coalesce((p->>'limit')::int,100)));
   IF cur<0 OR stop_seq<cur OR stop_seq>head THEN RETURN jsonb_build_object('ok',false,'code','INVALID_CURSOR'); END IF;
   WITH candidates AS (
    SELECT r.*,sum(octet_length(data::text)) OVER(ORDER BY seq) bytes,row_number() OVER(ORDER BY seq) rn
    FROM (SELECT * FROM public.wa_changes WHERE workspace_id=m.workspace_id AND seq>cur AND seq<=stop_seq AND (shops IS NULL OR shops ? (CASE WHEN entity_type='settings' THEN entity_id ELSE data->>'shopId' END) OR (entity_type<>'settings' AND data->>'shopId' IS NULL)) ORDER BY seq LIMIT page_size) r
   ), bounded AS (SELECT * FROM candidates WHERE bytes<=450000 OR rn=1)
   SELECT coalesce(jsonb_agg(jsonb_build_object('seq',seq,'type',entity_type,'id',entity_id,'version',version,'data',data,'updatedBy',updated_by,'updatedAt',updated_at,'mutationId',mutation_id) ORDER BY seq),'[]'::jsonb),coalesce(max(seq),cur) INTO rows,next_cur FROM bounded;
   SELECT EXISTS(SELECT 1 FROM public.wa_changes WHERE workspace_id=m.workspace_id AND seq>next_cur AND seq<=stop_seq AND (shops IS NULL OR shops ? (CASE WHEN entity_type='settings' THEN entity_id ELSE data->>'shopId' END) OR (entity_type<>'settings' AND data->>'shopId' IS NULL))) INTO has_more;
   IF NOT has_more THEN next_cur:=stop_seq; END IF;
   RETURN jsonb_build_object('ok',true,'shopIds',shops,'headSeq',stop_seq,'nextCursor',next_cur,'changes',rows,'hasMore',has_more);
  END IF;
 ELSIF action='sync.snapshot' THEN
  SELECT head_seq INTO head FROM public.wa_workspaces WHERE id=m.workspace_id FOR SHARE;
  SELECT seq INTO cp FROM public.wa_sync_checkpoints WHERE workspace_id=m.workspace_id;
  IF cp IS NULL THEN RETURN jsonb_build_object('ok',false,'code','SNAPSHOT_UNAVAILABLE'); END IF;
  IF p?'checkpointSeq' AND (p->>'checkpointSeq')::bigint<>cp THEN
   RETURN jsonb_build_object('ok',false,'code','SNAPSHOT_CHANGED','message','检查点已更新，请从第一页重试');
  END IF;
  IF p?'cursor' AND p->'cursor'<>'null'::jsonb AND (jsonb_typeof(p->'cursor')<>'array' OR jsonb_array_length(p->'cursor')<>2) THEN
   RETURN jsonb_build_object('ok',false,'code','INVALID_CURSOR');
  END IF;
  page_size:=least(100,greatest(1,coalesce((p->>'limit')::int,100)));
  WITH candidates AS (
   SELECT r.*,sum(octet_length(r.data::text)) OVER(ORDER BY r.entity_type,r.entity_id) AS bytes,
    row_number() OVER(ORDER BY r.entity_type,r.entity_id) AS rn
   FROM (SELECT * FROM public.wa_sync_checkpoint_records
    WHERE workspace_id=m.workspace_id AND (shops IS NULL OR shops ? (CASE WHEN entity_type='settings' THEN entity_id ELSE data->>'shopId' END) OR (entity_type<>'settings' AND data->>'shopId' IS NULL)) AND (NOT (p?'cursor') OR p->'cursor'='null'::jsonb OR (entity_type,entity_id)>(p->'cursor'->>0,p->'cursor'->>1))
    ORDER BY entity_type,entity_id LIMIT page_size) r
  ), bounded AS (
   SELECT * FROM candidates WHERE bytes<=450000 OR rn=1
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('type',entity_type,'id',entity_id,'version',version,
   'data',data,'updatedBy',updated_by,'updatedAt',updated_at) ORDER BY entity_type,entity_id),'[]'::jsonb),
   (SELECT jsonb_build_array(entity_type,entity_id) FROM bounded ORDER BY entity_type DESC,entity_id DESC LIMIT 1)
  INTO rows,next_key FROM bounded;
  IF jsonb_array_length(rows)=0 THEN next_key:=p->'cursor'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.wa_sync_checkpoint_records
   WHERE workspace_id=m.workspace_id AND (shops IS NULL OR shops ? (CASE WHEN entity_type='settings' THEN entity_id ELSE data->>'shopId' END) OR (entity_type<>'settings' AND data->>'shopId' IS NULL)) AND (next_key IS NULL OR (entity_type,entity_id)>(next_key->>0,next_key->>1))) INTO has_more;
  RETURN jsonb_build_object('ok',true,'shopIds',shops,'checkpointSeq',cp,'records',rows,'nextCursor',next_key,'hasMore',has_more);
 END IF;
 RETURN public.wa_api_core(request);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('ok',false,'code','INVALID_CURSOR');
END $$;
