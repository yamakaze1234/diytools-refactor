-- 独立成本只读接口；成员身份决定工作区，客户端不能指定工作区。
CREATE OR REPLACE FUNCTION public.wa_cost_prices(request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m public.wa_members%ROWTYPE; p jsonb; n int; cur text; stamp text; expected text; rows jsonb; last_id text; more boolean;
BEGIN
 IF coalesce(auth.role(),'') <> 'authenticated' OR coalesce(auth.uid(),'')='' OR coalesce(auth.jwt()->>'is_anonymous','false')='true' THEN
  RETURN jsonb_build_object('ok',false,'code','UNAUTHENTICATED'); END IF;
 SELECT * INTO m FROM public.wa_members WHERE uid=auth.uid() AND active=true;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','FORBIDDEN'); END IF;
 p:=coalesce(request->'payload','{}'::jsonb);
 IF jsonb_typeof(p)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('cursor','checkpoint','limit')) THEN RAISE EXCEPTION 'Invalid cost request'; END IF;
 n:=least(1000,greatest(1,coalesce((p->>'limit')::int,1000)));cur:=coalesce(p->>'cursor','');expected:=p->>'checkpoint';
 IF length(cur)>512 OR length(coalesce(expected,''))>64 THEN RAISE EXCEPTION 'Invalid cursor'; END IF;
 -- 同一 SQL 调用使用同一语句快照；跨页校验实体版本摘要，修改或删除后拒收旧批次。
 SELECT md5(coalesce(string_agg(entity_id||':'||version::text,',' ORDER BY entity_id),'')) INTO stamp
 FROM public.wa_records WHERE workspace_id=m.workspace_id AND entity_type='component';
 IF expected IS NOT NULL AND expected<>stamp THEN RETURN jsonb_build_object('ok',false,'code','COSTS_CHANGED','message','云端成本已变化，请重新读取'); END IF;
 WITH batch AS (SELECT entity_id,data FROM public.wa_records WHERE workspace_id=m.workspace_id AND entity_type='component' AND entity_id>cur ORDER BY entity_id LIMIT n)
 SELECT coalesce(jsonb_agg(jsonb_build_object('goods_id',data->>'goodsId','tax',CASE WHEN data->>'deletedAt' IS NOT NULL THEN NULL ELSE (data->>'taxCents')::numeric/100 END) ORDER BY entity_id),'[]'::jsonb),max(entity_id) INTO rows,last_id FROM batch;
 SELECT EXISTS(SELECT 1 FROM public.wa_records WHERE workspace_id=m.workspace_id AND entity_type='component' AND entity_id>coalesce(last_id,cur)) INTO more;
 RETURN jsonb_build_object('ok',true,'workspaceId',m.workspace_id,'checkpoint',stamp,'rows',rows,'nextCursor',coalesce(last_id,cur),'hasMore',more);
END $$;
REVOKE ALL ON FUNCTION public.wa_cost_prices(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wa_cost_prices(jsonb) TO authenticated;
