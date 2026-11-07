// 本地流程不调用远端 API、不推送；发布计划只记录待办，不能当作发布成功证据。
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

function run(root, program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw Error(`${program} 检查失败：${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const git = (root, ...args) => run(root, 'git', args);
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

export function inspectSource(directory) {
  const root = realpathSync(directory);
  // 必须传仓库根目录，防止在外层资料目录或子目录误提交、误构建。
  if (realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== root) throw Error('请使用桌面源码仓库根目录');
  const commit = git(root, 'rev-parse', '--verify', 'HEAD');
  const version = json(resolve(root, 'package.json')).version;
  const cargo = readFileSync(resolve(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
  const lock = readFileSync(resolve(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
  const versions = [version, json(resolve(root, 'apps/desktop/package.json')).version,
    json(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json')).version,
    cargo.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1],
    lock.match(/\[\[package\]\]\s+name = "desktop"\s+version = "([^"]+)"/)?.[1]];
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || versions.some(v => v !== version)) {
    throw Error('根包、桌面包、Tauri、Cargo.toml 和 Cargo.lock 版本必须一致');
  }
  return { source: root, commit, tree: git(root, 'rev-parse', 'HEAD^{tree}'), version,
    branch: git(root, 'branch', '--show-current'),
    changes: git(root, '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'),
    remoteVerified: false };
}

export function checkSource(directory) {
  const state = inspectSource(directory);
  git(state.source, 'diff', '--check');
  git(state.source, 'diff', '--cached', '--check');
  // 现有公开审计检查索引文件；新文件须先明确暂存，再重跑，不能视为全目录扫描。
  const audit = run(state.source, 'py', ['-3', '-X', 'utf8', 'tools/audit-public-tree.py', '--root', '.']);
  return { ...state, checks: { versions: 'passed', whitespace: 'passed', trackedFileAudit: JSON.parse(audit),
    businessTests: 'not_run', windowsBuild: 'not_run' } };
}

export function planRelease(directory, output, notesPath) {
  const state = checkSource(directory);
  if (state.changes) throw Error('发布准备要求工作区和索引干净；请先审查并提交本次文件');
  if (!state.branch) throw Error('请先切换到具名分支');
  if (!notesPath || !readFileSync(notesPath, 'utf8').trim()) throw Error('需要非空更新说明文件');
  const tag = `refactor-v${state.version}`;
  if (git(state.source, 'tag', '--list', tag)) throw Error('本地已有此版本标签，请先递增版本；远端仍需在获准发布后核对');
  const plan = { schema: 1, createdAt: new Date().toISOString(), ...state, tag,
    notesPath: resolve(notesPath), notesSha256: createHash('sha256').update(readFileSync(notesPath)).digest('hex'),
    status: 'planned_local_only',
    stages: Object.fromEntries(['buildAndSign', 'giteaAssets', 'githubAssets', 'giteaChannel', 'githubChannel',
      'nativeUpdateProbe', 'dingtalkReadback', 'cleanup'].map(name => [name, { status: 'pending' }])) };
  mkdirSync(dirname(resolve(output)), { recursive: true });
  // 不覆盖已有记录；失败后先查证远端结果，不按本地标记盲目重发。
  writeFileSync(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  return plan;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      source: { type: 'string' }, output: { type: 'string' }, notes: { type: 'string' },
    } });
    const source = values.source || resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const action = positionals[0] || 'status';
    let result;
    if (positionals.length > 1) throw Error('每次只执行一个动作');
    if (action === 'status') result = inspectSource(source);
    else if (action === 'check') result = checkSource(source);
    else if (action === 'plan-release') {
      if (!values.output) throw Error('需要 --output 指定新的本地计划文件');
      result = planRelease(source, values.output, values.notes);
    } else throw Error('仅支持 status、check、plan-release；不支持远端推送或发布');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
