// 公开发行包只允许程序、便携标记和说明；绝不从现有安装目录收集文件。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPrivateKey } from 'node:crypto';
import { makeEnvelope, publicKeyBase64, manifestName } from './package-portable-update.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, i, values) => {
  if (i % 2 === 0) rows.push([value.replace(/^--/, ''), values[i + 1]]);
  return rows;
}, []));
if (!args.exe || !args.out || !args.key) throw Error('需要 --exe、--out、--key；输出目录必须尚不存在');
const config = JSON.parse(readFileSync(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json')));
// Rust 用 Cargo 版本判断是否需要升级；四处版本不同会造成重复提示同一版本。
const versions = ['package.json', 'apps/desktop/package.json'].map(path => JSON.parse(readFileSync(resolve(root, path))).version);
const cargo = readFileSync(resolve(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
versions.push(cargo.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1]);
if (versions.some(version => version !== config.version)) throw Error('根包、桌面包、Cargo 和 Tauri 版本必须一致');
const binary = readFileSync(args.exe), privateKey = createPrivateKey(readFileSync(args.key));
if (readFileSync(resolve(root, 'apps/desktop/src-tauri/updater-public-key.txt'), 'utf8').trim() !== publicKeyBase64(privateKey)) throw Error('更新公私钥不匹配');
const notes = args.notes ? readFileSync(args.notes, 'utf8') : '独立仓库发行版；软件内支持签名校验和一键更新。';
const { envelope, payload } = makeEnvelope({ binary, version: config.version, notes, privateKey });
const output = resolve(args.out);
mkdirSync(output);
const portable = resolve(output, `DIYTools-${config.version}-Windows-x64`);
mkdirSync(portable);
writeFileSync(resolve(output, manifestName), JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
writeFileSync(resolve(output, payload.artifact.name), binary, { flag: 'wx' });
writeFileSync(resolve(portable, 'DIYTools.exe'), binary, { flag: 'wx' });
writeFileSync(resolve(portable, 'diytools-portable.json'), '{"mode":"portable"}\n', { flag: 'wx' });
copyFileSync(resolve(root, 'docs/PUBLIC-USAGE.md'), resolve(portable, '使用说明.md'));
const result = { version: config.version, portable, artifact: payload.artifact.name, manifest: manifestName,
  sha256: createHash('sha256').update(binary).digest('hex'), size: binary.length,
  policy: 'EXE + marker + usage only; no data, private runtime, service config, or credentials' };
writeFileSync(resolve(output, 'release-build.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
