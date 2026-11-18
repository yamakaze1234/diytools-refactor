"""在当前操作系统用户自己的目录中，生成独立试验账号和容器文件凭据。"""
import argparse
import os
from pathlib import Path
import secrets

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
destination = args.output.resolve()
profile = Path(os.environ['LOCALAPPDATA'] if os.name == 'nt' else str(Path.home())).resolve()
if destination == profile or not destination.is_relative_to(profile):
    raise SystemExit('凭据产物必须保存在当前操作系统用户的私有目录')
template = (Path(__file__).resolve().parent.parent / 'sql/004-runtime-operations.template.sql').read_text(encoding='utf-8')
placeholder = "runtime_password text := '__SET_RANDOM_PASSWORD__';"
if template.count(placeholder) != 1:
    raise SystemExit('写账号模板占位符异常')
destination.mkdir(parents=True, exist_ok=False, mode=0o700)
password = secrets.token_hex(32)


def write_private(name, content):
    path = destination / name
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8', newline='\n') as file:
        file.write(content)


write_private('05-创建试验运行写账号.sql', template.replace(placeholder, f"runtime_password text := '{password}';", 1))
write_private('database-password', password)
print(destination)
