"""发行前检查文件边界及常见凭据格式；只报告文件名和类别，不打印命中内容。"""
import argparse
import json
import re
import subprocess
from pathlib import Path


def audit(root: Path, private_values=()):
    """只扫描候选源码，拒绝运行数据；额外私有值由发布者在本机提供。"""
    findings = []
    count = 0
    forbidden_dirs = {"data", "sandbox", "release", "exports", ".runtime", ".venv", "node_modules", "target", "dist", "__pycache__", ".test-output"}
    token_patterns = [r"AKID[A-Za-z0-9]{24,}", r"gh[pousr]_[A-Za-z0-9]{24,}", r"github_pat_[A-Za-z0-9_]{30,}", r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"]
    # 在已提交的仓库只检查索引文件，忽略开发者本机未跟踪的依赖与构建目录。
    if (root / ".git").exists():
        result = subprocess.run(["git", "ls-files", "-z"], cwd=root, check=True, stdout=subprocess.PIPE)
        candidates = [root / name.decode("utf-8") for name in result.stdout.split(b"\0") if name]
    else:
        candidates = root.rglob("*")
    for path in sorted(candidates):
        relative = path.relative_to(root)
        if ".git" in relative.parts:
            continue
        if path.is_symlink() or path.is_junction():
            findings.append({"path": str(relative), "kind": "link"})
            continue
        if not path.is_file():
            continue
        count += 1
        if forbidden_dirs.intersection(relative.parts) or path.suffix.lower() in {".pem", ".key", ".sqlite", ".sqlite3", ".db", ".exe", ".zip", ".log", ".pyc"} or path.name.startswith(".env") or path.name in {"integrations.json", "catalog.private.json", "sql-credentials.dpapi.json"}:
            findings.append({"path": str(relative), "kind": "private-file"})
        raw = path.read_bytes()
        text = raw.decode("utf-8", errors="replace")
        if any(re.search(pattern, text) for pattern in token_patterns):
            findings.append({"path": str(relative), "kind": "credential-pattern"})
        if any(value.encode("utf-8") in raw or value.encode("utf-16le") in raw for value in private_values if len(value) >= 8):
            findings.append({"path": str(relative), "kind": "private-configuration-value"})
        if relative.as_posix() == "apps/desktop/public/workbench/catalog.json" and json.loads(text) != []:
            findings.append({"path": str(relative), "kind": "embedded-business-catalog"})
    return {"status": "passed" if not findings and count else "failed", "files": count, "findings": findings}


def strings(value):
    """展开私有配置的字符串值，仅在进程内用于匹配，不写入扫描报告。"""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    return []


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--private-values", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    private = strings(json.loads(args.private_values.read_text(encoding="utf-8-sig"))) if args.private_values else []
    report = audit(args.root.resolve(), private)
    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(output + "\n", encoding="utf-8")
    print(output)
    raise SystemExit(0 if report["status"] == "passed" else 1)
