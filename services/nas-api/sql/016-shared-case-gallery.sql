-- 在三店正式库整条执行。仅增加图库读取与摘要登记，原图文件继续存放在原上传目录。
DO $install$
DECLARE
 schemas text[] := ARRAY['intel_live','gigabyte_live','jonsbo_live'];
 schema_name text;
 row_asset record;
BEGIN
 IF current_database()<>'diy_workbench' THEN RAISE EXCEPTION '只允许三店正式库'; END IF;
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM pg_advisory_xact_lock(814521,0);
 FOREACH schema_name IN ARRAY schemas LOOP
  IF to_regclass(format('%I.gallery',schema_name)) IS NULL OR to_regclass(format('%I.assets',schema_name)) IS NULL
  THEN RAISE EXCEPTION '缺少三店图库或摘要登记: %',schema_name; END IF;
 END LOOP;
 -- 初始登记与安装触发器同事务完成，安装期间不会漏掉并发新增的图片。
 LOCK TABLE intel_live.gallery,gigabyte_live.gallery,jonsbo_live.gallery IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM intel_live.gallery WHERE gallery_id LIKE 'shared-gallery:%'
    UNION ALL SELECT 1 FROM gigabyte_live.gallery WHERE gallery_id LIKE 'shared-gallery:%'
    UNION ALL SELECT 1 FROM jonsbo_live.gallery WHERE gallery_id LIKE 'shared-gallery:%')
 THEN RAISE EXCEPTION '图库标识使用了共享读取保留前缀'; END IF;

 CREATE SCHEMA IF NOT EXISTS workbench_gallery;
 REVOKE ALL ON SCHEMA workbench_gallery FROM PUBLIC;
 CREATE OR REPLACE VIEW workbench_gallery.catalog AS
  SELECT 'intel'::text AS source_shop,g.*,a.sha256,a.extension,a.byte_count
   FROM intel_live.gallery g JOIN intel_live.assets a USING(legacy_uri)
   WHERE g.owner_shop IN ('intel','shared') OR g.shared
  UNION ALL
  SELECT 'gigabyte',g.*,a.sha256,a.extension,a.byte_count
   FROM gigabyte_live.gallery g JOIN gigabyte_live.assets a USING(legacy_uri)
   WHERE g.owner_shop IN ('gigabyte','shared') OR g.shared
  UNION ALL
  SELECT 'jonsbo',g.*,a.sha256,a.extension,a.byte_count
   FROM jonsbo_live.gallery g JOIN jonsbo_live.assets a USING(legacy_uri)
   WHERE g.owner_shop IN ('jonsbo','shared') OR g.shared;

 -- 公共图库只广播可选原图的摘要登记。保留历史登记，已保存的配置与模板继续可读。
 CREATE OR REPLACE FUNCTION workbench_gallery.register_asset(ref text,digest text,ext text,size_bytes bigint) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $register$
 DECLARE target text; same_bytes boolean;
 BEGIN
  IF ref<>('/uploads/'||digest||'.'||ext) THEN RAISE EXCEPTION '图库摘要地址不一致'; END IF;
  PERFORM pg_advisory_xact_lock(814521,hashtext(ref));
  FOREACH target IN ARRAY ARRAY['intel_live','gigabyte_live','jonsbo_live'] LOOP
   EXECUTE format('INSERT INTO %I.assets(legacy_uri,sha256,extension,byte_count)
    VALUES($1,$2,$3,$4) ON CONFLICT(legacy_uri) DO NOTHING',target) USING ref,digest,ext,size_bytes;
   EXECUTE format('SELECT sha256=$2 AND extension=$3 AND byte_count=$4 FROM %I.assets WHERE legacy_uri=$1',target)
    INTO same_bytes USING ref,digest,ext,size_bytes;
   IF same_bytes IS DISTINCT FROM true THEN RAISE EXCEPTION '三店图库摘要登记不一致'; END IF;
  END LOOP;
 END $register$;
 REVOKE ALL ON FUNCTION workbench_gallery.register_asset(text,text,text,bigint) FROM PUBLIC;

 CREATE OR REPLACE FUNCTION workbench_gallery.publish_gallery_asset() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $publish$
 DECLARE item record;
 BEGIN
  IF TG_TABLE_SCHEMA NOT IN ('intel_live','gigabyte_live','jonsbo_live') OR TG_TABLE_NAME<>'gallery'
  THEN RAISE EXCEPTION '图库触发器绑定错误'; END IF;
  IF NEW.attrs->>'deletedAt' IS NOT NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT sha256,extension,byte_count FROM %I.assets WHERE legacy_uri=$1',TG_TABLE_SCHEMA)
   INTO STRICT item USING NEW.legacy_uri;
  PERFORM workbench_gallery.register_asset(NEW.legacy_uri,item.sha256,item.extension,item.byte_count);
  RETURN NEW;
 END $publish$;
 REVOKE ALL ON FUNCTION workbench_gallery.publish_gallery_asset() FROM PUBLIC;

 -- 只给运行账号返回总引用数，编辑权限和各店配置的读取范围沿用原来的规则。
 CREATE OR REPLACE FUNCTION workbench_gallery.image_references(ref text)
 RETURNS TABLE(configurations integer,templates integer,sources integer)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $refs$
 DECLARE target text; counts record; needle jsonb := jsonb_build_object('ref',ref);
 BEGIN
  configurations:=0; templates:=0; sources:=0;
  FOREACH target IN ARRAY ARRAY['intel_live','gigabyte_live','jonsbo_live'] LOOP
   EXECUTE format($count$SELECT
    (SELECT count(*)::int FROM %1$I.configurations WHERE jsonb_path_exists(design,'$.** ? (@ == $ref)',$1)
      OR jsonb_path_exists(fields,'$.** ? (@ == $ref)',$1)) AS configs,
    (SELECT count(*)::int FROM %1$I.templates WHERE jsonb_path_exists(configurations,'$.** ? (@ == $ref)',$1)
      OR jsonb_path_exists(attrs,'$.** ? (@ == $ref)',$1)) AS templates,
    (SELECT count(*)::int FROM %1$I.sources WHERE jsonb_path_exists(attrs,'$.** ? (@ == $ref)',$1)) AS sources$count$,target)
    INTO counts USING needle;
   configurations:=configurations+counts.configs; templates:=templates+counts.templates; sources:=sources+counts.sources;
  END LOOP;
  RETURN NEXT;
 END $refs$;
 REVOKE ALL ON FUNCTION workbench_gallery.image_references(text) FROM PUBLIC;
 GRANT USAGE ON SCHEMA workbench_gallery TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;
 GRANT SELECT ON workbench_gallery.catalog TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;
 GRANT EXECUTE ON FUNCTION workbench_gallery.image_references(text)
  TO diy_api_intel_production,diy_api_gigabyte_production,diy_api_jonsbo_production;

 FOR row_asset IN SELECT DISTINCT legacy_uri,sha256,extension,byte_count FROM workbench_gallery.catalog
   WHERE attrs->>'deletedAt' IS NULL ORDER BY legacy_uri
 LOOP
  PERFORM workbench_gallery.register_asset(row_asset.legacy_uri,row_asset.sha256,row_asset.extension,row_asset.byte_count);
 END LOOP;
 FOREACH schema_name IN ARRAY schemas LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS share_gallery_original ON %I.gallery',schema_name);
  EXECUTE format('CREATE TRIGGER share_gallery_original AFTER INSERT OR UPDATE OF legacy_uri,attrs ON %I.gallery
   FOR EACH ROW EXECUTE FUNCTION workbench_gallery.publish_gallery_asset()',schema_name);
 END LOOP;
END $install$;
