"""生成待审批的正式英特尔权限安装单语句。不连接真实 DB 或输出凭据正文。"""
import argparse
import hashlib
import json
import re
from pathlib import Path


def quote(value):
    return "'"+value.replace("'","''")+"'"


def make(manifest_path,uid_path,password_path,output):
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    batch=manifest['batch_id']
    if manifest.get('target_database')!='diy_workbench' or manifest.get('shop_id')!='intel' or not re.fullmatch(r'intel-\d+-[a-f0-9]{16}-[a-f0-9]{8}',batch):
        raise ValueError('必须绑定已核对的正式英特尔批次')
    uid=uid_path.read_text(encoding='utf-8').strip()
    password=password_path.read_text(encoding='utf-8').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,128}',uid) or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}',password):
        raise ValueError('待安装的运营 UID 或随机密码不是安全格式')
    sql_dir=Path(__file__).resolve().parents[1]/'sql'
    code='''-- 正式独立运行权限候选：仅绑定本批数据及已核对的一个英特尔运营成员。
-- 本文件含独立服务密码，禁止共享、提交到 Git 或投放到试验 API。
DO $production_access$
BEGIN
 IF current_database()<>'diy_workbench' THEN RAISE EXCEPTION '只允许正式库 diy_workbench'; END IF;
 PERFORM pg_advisory_xact_lock(814517,12);
 IF NOT EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel' AND batch_id=__VERIFIED_BATCH__) THEN
  RAISE EXCEPTION '正式英特尔数据未通过本批次核对';
 END IF;
 IF to_regnamespace('nas_business') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='diy_api_intel_production') THEN
  RAISE EXCEPTION '目标访问结构或角色已经存在；停止，不更新原权限及密码';
 END IF;
 CREATE SCHEMA nas_business;
 REVOKE ALL ON SCHEMA nas_business FROM PUBLIC;
 CREATE TABLE nas_business.members(
  workspace_id text NOT NULL,uid text NOT NULL,enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY(workspace_id,uid)
 );
 CREATE TABLE nas_business.shop_roles(
  workspace_id text NOT NULL,uid text NOT NULL,shop_id text NOT NULL REFERENCES intel_live.shops,
  role text NOT NULL CHECK(role IN ('operations','sales')),
  PRIMARY KEY(workspace_id,uid,shop_id),
  FOREIGN KEY(workspace_id,uid) REFERENCES nas_business.members
 );
 INSERT INTO nas_business.members VALUES('workbench-main',__VERIFIED_UID__,true);
 INSERT INTO nas_business.shop_roles VALUES('workbench-main',__VERIFIED_UID__,'intel','operations');
'''.replace('__VERIFIED_BATCH__',quote(batch)).replace('__VERIFIED_UID__',quote(uid))
    for tag,name in [('role','004-runtime-operations.template.sql'),('index','005-main-editor-catalog-read.sql'),
                     ('catalog','006-catalog-management.sql'),('workspace','007-workspace-operations.sql')]:
        text=(sql_dir/name).read_text(encoding='utf-8')
        if 'diy_workbench_trial' not in text or 'diy_api_operations' not in text:
            raise ValueError('依赖 SQL 边界发生变化：'+name)
        text=text.replace('diy_workbench_trial','diy_workbench').replace('diy_api_operations','diy_api_intel_production').replace('试验库','正式库')
        if tag=='role':
            if text.count('__SET_RANDOM_PASSWORD__')!=2:
                raise ValueError('角色密码模板合同发生变化')
            text=text.replace("runtime_password text := '__SET_RANDOM_PASSWORD__'","runtime_password text := "+quote(password),1)
        delimiter='$formal_'+tag+'$'
        if delimiter in text:
            raise ValueError('SQL 分隔符冲突')
        code+=' EXECUTE '+delimiter+'\n'+text+'\n'+delimiter+';\n'
    code+='''
 IF (SELECT count(*) FROM nas_business.members)<>1 OR (SELECT count(*) FROM nas_business.shop_roles)<>1
    OR (SELECT count(*) FROM intel_live.catalog_shared_editors)<>0 OR EXISTS(SELECT 1 FROM intel_live.publications WHERE published)
 THEN RAISE EXCEPTION '正式初始角色或发布范围不一致'; END IF;
END $production_access$;
'''
    with output.open('xb') as file:
        file.write(code.encode('utf-8'))
    print(json.dumps({'status':'prepared_not_executed','target_database':'diy_workbench','batch_id':batch,
                      'runtime_role':'diy_api_intel_production','initial_intel_operator_count':1,'shared_editor_count':0,
                      'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))


if __name__=='__main__':
    cli=argparse.ArgumentParser()
    for arg in ['manifest','uid-file','password-file','output']:
        cli.add_argument('--'+arg,type=Path,required=True)
    args=cli.parse_args()
    make(args.manifest,args.uid_file,args.password_file,args.output)
