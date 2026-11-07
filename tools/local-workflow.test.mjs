// 使用隔离 Git 仓库验证入口与发布边界；所有临时目录留给本机按回收站规则收尾。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { inspectSource, checkSource, planRelease } from './local-workflow.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = resolve(source, 'sandbox/local-workflow-tests');
mkdirSync(scratch, { recursive: true });
function run(root, exe, args) {
  const result = spawnSync(exe, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function put(root, path, text) {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
}
function fixture() {
  const root = mkdtempSync(resolve(scratch, 'case-'));
  put(root, '.gitignore', 'release/\n');
  for (const path of ['package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) put(root, path, '{"version":"0.9.0"}\n');
  put(root, 'apps/desktop/src-tauri/Cargo.toml', '[package]\nname = "desktop"\nversion = "0.9.0"\n');
  put(root, 'apps/desktop/src-tauri/Cargo.lock', '[[package]]\nname = "desktop"\nversion = "0.9.0"\n');
  put(root, 'docs/PUBLIC-USAGE.md', '合成测试使用说明\n');
  mkdirSync(resolve(root, 'tools'));
  copyFileSync(resolve(source, 'tools/audit-public-tree.py'), resolve(root, 'tools/audit-public-tree.py'));
  run(root, 'git', ['init', '-b', 'codex/test']);
  run(root, 'git', ['config', 'user.name', 'Workflow Test']);
  run(root, 'git', ['config', 'user.email', 'workflow@example.invalid']);
  commit(root);
  return root;
}
function commit(root) {
  run(root, 'git', ['add', '.']);
  run(root, 'git', ['-c', 'core.hooksPath=NUL', 'commit', '-m', 'fixture']);
}

test('识别真实提交和版本，不访问远端', () => {
  const state = inspectSource(fixture());
  assert.equal(state.version, '0.9.0');
  assert.equal(state.changes, '');
  assert.equal(state.remoteVerified, false);
  assert.match(state.commit, /^[a-f0-9]{40}$/);
});
test('拒绝子目录和 Cargo.lock 版本漂移', () => {
  const root = fixture();
  assert.throws(() => inspectSource(resolve(root, 'apps')), /根目录/);
  put(root, 'apps/desktop/src-tauri/Cargo.lock', '[[package]]\nname = "desktop"\nversion = "0.8.0"\n');
  assert.throws(() => inspectSource(root), /版本必须一致/);
});
test('检查不会把基础检查写成业务测试通过', () => {
  const result = checkSource(fixture());
  assert.equal(result.checks.trackedFileAudit.status, 'passed');
  assert.equal(result.checks.businessTests, 'not_run');
});
test('已暂存业务数据阻止检查', () => {
  const root = fixture();
  put(root, 'data/example.json', '{}\n');
  run(root, 'git', ['add', 'data/example.json']);
  assert.throws(() => checkSource(root), /private-file/);
});
test('脏工作区阻止计划，计划不覆盖既有记录', () => {
  const root = fixture();
  put(root, 'release/notes.md', '测试更新\n');
  put(root, 'unrelated.txt', '待保留的其他任务\n');
  const output = resolve(root, 'release/plan.json');
  const notes = resolve(root, 'release/notes.md');
  assert.throws(() => planRelease(root, output, notes), /干净/);
  commit(root);
  const plan = planRelease(root, output, notes);
  assert.equal(plan.status, 'planned_local_only');
  assert.equal(plan.stages.giteaChannel.status, 'pending');
  assert.throws(() => planRelease(root, output, notes), /EEXIST/);
  run(root, 'git', ['tag', 'refactor-v0.9.0']);
  assert.throws(() => planRelease(root, resolve(root, 'release/other.json'), notes), /已有此版本标签/);
});
test('未知 publish 动作不能触发发行', () => {
  const root = fixture();
  const result = spawnSync('node', [resolve(source, 'tools/local-workflow.mjs'), 'publish', '--source', root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不支持远端推送或发布/);
});
test('PrepareOnly 实际验签和 ZIP 校验后返回，不读取发布凭据；篡改产物被拒绝', () => {
  const root = fixture();
  for (const name of ['publish-gitea-release.ps1', 'package-public-release.mjs', 'package-portable-update.mjs', 'verify-gitea-package.mjs']) {
    copyFileSync(resolve(source, 'tools', name), resolve(root, 'tools', name));
  }
  // 若准备模式越过边界，立即失败；不调用真实凭据管理器或服务器。
  put(root, 'tools/gitea-credentials.ps1', 'function Get-DIYGiteaCredential { throw "CREDENTIAL_BOUNDARY_REACHED" }\n');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  put(root, 'apps/desktop/src-tauri/updater-public-key.txt', Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') + '\n');
  commit(root);
  put(root, 'release/test-key.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
  put(root, 'release/notes.md', '隔离测试，不用于发行\n');
  // 最小合成 PE 仅用于打包边界检查，绝不执行。
  const binary = Buffer.alloc(128);
  binary.write('MZ'); binary.writeUInt32LE(64, 0x3c); binary.writeUInt32LE(0x4550, 64); binary.writeUInt16LE(0x8664, 68);
  put(root, 'release/test.exe', binary);
  const out = resolve(root, 'release/artifacts');
  const key = resolve(root, 'release/test-key.pem'), notes = resolve(root, 'release/notes.md');
  run(root, 'node', ['tools/package-public-release.mjs', '--key', key, '--exe', resolve(root, 'release/test.exe'), '--out', out, '--notes', notes]);
  put(root, 'release/artifacts/build-provenance.json', JSON.stringify({ sourceCommit: inspectSource(root).commit, version: '0.9.0', artifactSha256: createHash('sha256').update(binary).digest('hex') }));
  // 显式设置管道输出 UTF-8，避免中文 Windows 控制台代码页影响断言。
  put(root, 'release/run-prepare.ps1', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n& (Join-Path $PSScriptRoot "../tools/publish-gitea-release.ps1") @args\n');
  const args = ['-NoProfile', '-File', 'release/run-prepare.ps1', '-PrepareOnly', '-PrivateKeyPath', key, '-NotesPath', notes, '-ArtifactsDirectory', out];
  const result = run(root, 'pwsh.exe', args);
  assert.match(result, /未推送、未上传、未更新通道/);
  assert.equal(inspectSource(root).changes, '');
  const artifact = resolve(out, 'diytools-refactor-0.9.0-windows-x86_64.exe');
  const changed = readFileSync(artifact); changed[100] = 1; writeFileSync(artifact, changed);
  const rejected = spawnSync('pwsh.exe', args, { cwd: root, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /不一致/);
  assert.doesNotMatch(rejected.stderr, /CREDENTIAL_BOUNDARY_REACHED/);
});
