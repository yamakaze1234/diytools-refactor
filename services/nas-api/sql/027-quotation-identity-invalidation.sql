-- 换码时释放旧报价和销售发布，由新版 API 在配置保存的同一事务调用。
BEGIN;
CREATE OR REPLACE FUNCTION workbench_sources.invalidate_quotation_identity(
 request_shop text, workspace text, actor text, config_id text, expected_version bigint,
 next_spu text, next_sku text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $invalidate$
DECLARE schema_name text; previous record;
BEGIN
 IF request_shop NOT IN ('intel','gigabyte','jonsbo') OR
    NOT coalesce(workbench_sources.allowed(request_shop,workspace,actor),false)
 THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
 IF next_spu IS NULL OR next_sku IS NULL THEN RAISE EXCEPTION USING MESSAGE='INVALID_IDENTITY'; END IF;
 schema_name:=request_shop||'_live';
 EXECUTE format('SELECT spu,sku FROM %I.configurations
  WHERE shop_id=$1 AND configuration_id=$2 AND version=$3 AND archived_at IS NULL FOR UPDATE',schema_name)
  INTO previous USING request_shop,config_id,expected_version;
 IF previous.spu IS NULL OR (previous.spu,previous.sku) IS NOT DISTINCT FROM (next_spu,next_sku)
 THEN RAISE EXCEPTION USING MESSAGE='INVALID_IDENTITY'; END IF;
 EXECUTE format('UPDATE %I.publications SET published=false WHERE configuration_id=$1 AND published',schema_name) USING config_id;
 EXECUTE format($quote$UPDATE %I.quotations SET status='unmatched',amount_cents=NULL,
  difference_cents=NULL,workbook_rows='[]'::jsonb WHERE configuration_id=$1 AND status='matched'$quote$,schema_name)
  USING config_id;
 EXECUTE format('DELETE FROM %I.intel_quotation_overrides WHERE configuration_id=$1',schema_name) USING config_id;
END $invalidate$;

REVOKE ALL ON FUNCTION workbench_sources.invalidate_quotation_identity(text,text,text,text,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workbench_sources.invalidate_quotation_identity(text,text,text,text,bigint,text,text)
 TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;
COMMIT;
