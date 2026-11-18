-- 额外保护直接写配置、配件、回执与审计的权限；绑定身份后也不能跨店。
CREATE FUNCTION __LIVE__.operation_actor(ws text,who text) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $actor$
 SELECT __LIVE__.catalog_is_operator() AND
  ws=current_setting('__LIVE__.catalog_workspace',true) AND who=current_setting('__LIVE__.catalog_uid',true)
 $actor$;
REVOKE ALL ON FUNCTION __LIVE__.operation_actor(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __LIVE__.operation_actor(text,text) TO __ROLE__;

ALTER TABLE __LIVE__.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_product_insert ON __LIVE__.products FOR INSERT TO __ROLE__
 WITH CHECK(shop_id='__SHOP__' AND __LIVE__.catalog_is_operator());

ALTER TABLE __LIVE__.configurations ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_configuration_select ON __LIVE__.configurations FOR SELECT TO __ROLE__ USING(shop_id='__SHOP__');
CREATE POLICY store_configuration_insert ON __LIVE__.configurations FOR INSERT TO __ROLE__
 WITH CHECK(shop_id='__SHOP__' AND __LIVE__.catalog_is_operator());
CREATE POLICY store_configuration_update ON __LIVE__.configurations FOR UPDATE TO __ROLE__
 USING(shop_id='__SHOP__' AND __LIVE__.catalog_is_operator())
 WITH CHECK(shop_id='__SHOP__' AND __LIVE__.catalog_is_operator());

ALTER TABLE __LIVE__.parts ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_parts_select ON __LIVE__.parts FOR SELECT TO __ROLE__ USING(true);
CREATE POLICY store_parts_insert ON __LIVE__.parts FOR INSERT TO __ROLE__ WITH CHECK(__LIVE__.catalog_is_operator());
CREATE POLICY store_parts_delete ON __LIVE__.parts FOR DELETE TO __ROLE__ USING(__LIVE__.catalog_is_operator());

ALTER TABLE __LIVE__.addons ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_addons_select ON __LIVE__.addons FOR SELECT TO __ROLE__ USING(true);
CREATE POLICY store_addons_insert ON __LIVE__.addons FOR INSERT TO __ROLE__ WITH CHECK(__LIVE__.catalog_is_operator());
CREATE POLICY store_addons_delete ON __LIVE__.addons FOR DELETE TO __ROLE__ USING(__LIVE__.catalog_is_operator());

ALTER TABLE __LIVE__.save_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_save_select ON __LIVE__.save_receipts FOR SELECT TO __ROLE__
 USING(shop_id='__SHOP__' AND __LIVE__.operation_actor(workspace_id,actor_uid));
CREATE POLICY store_save_insert ON __LIVE__.save_receipts FOR INSERT TO __ROLE__
 WITH CHECK(shop_id='__SHOP__' AND __LIVE__.operation_actor(workspace_id,actor_uid));
ALTER TABLE __LIVE__.audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_audit_insert ON __LIVE__.audit_events FOR INSERT TO __ROLE__
 WITH CHECK(shop_id='__SHOP__' AND __LIVE__.operation_actor(workspace_id,actor_uid));

ALTER TABLE __LIVE__.catalog_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_catalog_select ON __LIVE__.catalog_receipts FOR SELECT TO __ROLE__
 USING(shop_id='__SHOP__' AND __LIVE__.operation_actor(workspace_id,actor_uid));
CREATE POLICY store_catalog_insert ON __LIVE__.catalog_receipts FOR INSERT TO __ROLE__
 WITH CHECK(shop_id='__SHOP__' AND __LIVE__.operation_actor(workspace_id,actor_uid));
ALTER TABLE __LIVE__.catalog_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_catalog_audit_insert ON __LIVE__.catalog_audit FOR INSERT TO __ROLE__
 WITH CHECK(__LIVE__.operation_actor(workspace_id,actor_uid));


-- 新店可撤下报价；本轮不开放上架。原英特尔工作台仍用自己的函数与授权。
CREATE OR REPLACE FUNCTION __LIVE__.withdraw_publication(config_id text) RETURNS void
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $withdraw$
 UPDATE __LIVE__.publications p SET published=false WHERE configuration_id=config_id
  AND __LIVE__.catalog_is_operator()
 $withdraw$;

CREATE OR REPLACE FUNCTION __LIVE__.set_quotation_publication(config_id text,visible boolean) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $publication$
 BEGIN
  IF NOT __LIVE__.catalog_is_operator() OR visible IS DISTINCT FROM false THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT FROM __LIVE__.configurations c
    WHERE c.configuration_id=config_id AND c.shop_id='__SHOP__' AND c.archived_at IS NULL)
  THEN RETURN false; END IF;
  UPDATE __LIVE__.publications p SET published=false WHERE configuration_id=config_id;
  RETURN true;
 END $publication$;
