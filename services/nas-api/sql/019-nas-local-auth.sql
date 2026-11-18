-- 为既有成员新增本地密码与会话。原 UID、成员启用状态及三店授权继续由 nas_business 管理。
BEGIN;
DO $check$ BEGIN
 IF current_database()<>'diy_workbench' OR to_regclass('nas_business.members') IS NULL
    OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='diy_api_intel_production')
 THEN RAISE EXCEPTION '仅在已有三店成员及运行角色的正式库安装 NAS 认证'; END IF;
END $check$;

CREATE SCHEMA nas_auth;
REVOKE ALL ON SCHEMA nas_auth FROM PUBLIC;
CREATE TABLE nas_auth.accounts(
 workspace_id text NOT NULL,
 uid text NOT NULL,
 username_key text NOT NULL CHECK(octet_length(username_key) BETWEEN 1 AND 576),
 member_id text NOT NULL,
 display_name text NOT NULL,
 password_salt bytea NOT NULL CHECK(octet_length(password_salt)=16),
 password_hash bytea NOT NULL CHECK(octet_length(password_hash)=32),
 enrolled_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,uid),
 UNIQUE(workspace_id,username_key),
 FOREIGN KEY(workspace_id,uid) REFERENCES nas_business.members ON DELETE CASCADE
);
CREATE TABLE nas_auth.sessions(
 workspace_id text NOT NULL,
 uid text NOT NULL,
 access_hash bytea NOT NULL CHECK(octet_length(access_hash)=32),
 refresh_hash bytea NOT NULL CHECK(octet_length(refresh_hash)=32),
 credential_salt bytea NOT NULL CHECK(octet_length(credential_salt)=16),
 previous_refresh_hash bytea CHECK(octet_length(previous_refresh_hash)=32),
 access_until timestamptz NOT NULL,
 refresh_until timestamptz NOT NULL,
 PRIMARY KEY(access_hash),
 UNIQUE(refresh_hash),
 FOREIGN KEY(workspace_id,uid) REFERENCES nas_auth.accounts ON DELETE CASCADE
);
CREATE INDEX sessions_member_expiry ON nas_auth.sessions(workspace_id,uid,refresh_until);
-- 只给认证连接看原成员身份和启用状态，其他两店运行账号不获得认证访问。
CREATE VIEW nas_auth.members WITH (security_barrier=true) AS
 SELECT workspace_id,uid,enabled FROM nas_business.members;
GRANT USAGE ON SCHEMA nas_auth TO diy_api_intel_production;
GRANT SELECT ON nas_auth.members TO diy_api_intel_production;
GRANT SELECT,INSERT ON nas_auth.accounts TO diy_api_intel_production;
GRANT SELECT,INSERT,UPDATE,DELETE ON nas_auth.sessions TO diy_api_intel_production;
COMMIT;
