"""从已冻结的英特尔本机导出生成正式库单事务；不安装成员、登录角色或服务。"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path


def load_import_builder():
    spec=importlib.util.spec_from_file_location('build_intel_import',Path(__file__).with_name('build-import.py'))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build


def scoped_sql(text,trial_guard,replacement):
    if text.count(trial_guard)!=1:
        raise ValueError('原 SQL 目标边界发生变化，重新审查')
    return text.replace(trial_guard,replacement,1)


def execute_block(sql,tag):
    delimiter='$'+tag+'$'
    if delimiter in sql:
        raise ValueError('不能使用与原文冲突的 SQL 分隔符')
    return ' EXECUTE '+delimiter+'\n'+sql+'\n'+delimiter+';\n'


def build(snapshot,out):
    out.mkdir(parents=True,exist_ok=False)
    summary=load_import_builder()(snapshot,out/'receiving-only','diy_workbench')
    manifest=json.loads((out/'receiving-only'/'manifest.json').read_text(encoding='utf-8'))
    if manifest['shop_id']!='intel' or not str(manifest['source_revision']).isdigit():
        raise ValueError('仅允许独立英特尔源快照')
    receiving=(out/'receiving-only'/'01-导入全店接收区.sql').read_text(encoding='utf-8')
    runtime=(Path(__file__).resolve().parents[1]/'sql'/'003-intel-live.sql').read_text(encoding='utf-8')
    runtime=scoped_sql(runtime,"current_database()<>'diy_workbench_trial' THEN RAISE EXCEPTION '运行结构只允许试验库'",
                       "current_database()<>'diy_workbench' THEN RAISE EXCEPTION '运行结构只允许正式库'")
    runtime=runtime.replace('-- 仅在试验库执行这条完整 DO。','-- 仅在正式库执行这条完整 DO。',1)
    code='''-- 正式英特尔：在 DBX 选 diy_workbench，将本文件整体作为一条 SQL 执行。
-- 接收原文与运行表同事务；重复执行只核对已有批次，不覆盖运行数据。无角色、成员、服务或发布变更。
DO $production_intel_data$
DECLARE
 existing_batch text;
BEGIN
 IF current_database()<>'diy_workbench' THEN RAISE EXCEPTION '只允许在正式库 diy_workbench 执行'; END IF;
 PERFORM pg_advisory_xact_lock(814517,11);
 -- 除本次精确重读之外，已有接收区或运行区一律停下，不复用或覆盖来源不同的表。
 IF to_regnamespace('nas_import') IS NOT NULL OR to_regnamespace('intel_live') IS NOT NULL THEN
  IF to_regclass('intel_live.bootstrap') IS NULL OR to_regclass('nas_import.batches') IS NULL THEN
   RAISE EXCEPTION '正式接收区或运行区已有其他结构；未替换';
  END IF;
  SELECT batch_id INTO existing_batch FROM intel_live.bootstrap WHERE shop_id='intel';
  IF existing_batch IS DISTINCT FROM '__FORMAL_BATCH__' THEN RAISE EXCEPTION '正式库存在不同的英特尔批次；未替换'; END IF;
 END IF;
'''.replace('__FORMAL_BATCH__',summary['batch_id'])
    code += execute_block(receiving,'prod_receive_'+summary['payload_sha256'][:12])
    code += execute_block(runtime,'prod_runtime_'+summary['payload_sha256'][:12])
    code += '''
 IF NOT EXISTS(SELECT 1 FROM intel_live.bootstrap WHERE shop_id='intel' AND batch_id='__FORMAL_BATCH__' AND payload_sha256='__FORMAL_DIGEST__') THEN
  RAISE EXCEPTION '正式英特尔运行批次核对失败';
 END IF;
END $production_intel_data$;
'''.replace('__FORMAL_BATCH__',summary['batch_id']).replace('__FORMAL_DIGEST__',summary['payload_sha256'])
    sql=out/'02-正式英特尔接收与初始化.sql'
    sql.write_bytes(code.encode('utf-8'))
    manifest['production_sql_sha256']=hashlib.sha256(sql.read_bytes()).hexdigest()
    manifest['target_database']='diy_workbench'
    manifest['includes_access_roles']=False
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({**summary,'production_sql_sha256':manifest['production_sql_sha256']},ensure_ascii=False))


if __name__=='__main__':
    cli=argparse.ArgumentParser()
    cli.add_argument('--snapshot',type=Path,required=True)
    cli.add_argument('--output',type=Path,required=True)
    args=cli.parse_args()
    build(args.snapshot,args.output)
