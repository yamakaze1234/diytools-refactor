// 生成 Windows 重构版的签名升级清单及程序文件；私钥只在本机使用，不写进清单或升级包。
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const manifestName = 'diytools-refactor-windows-x86_64.json';
// 提取 Ed25519 原始公钥并转为宿主使用的 Base64 编码。
export function publicKeyBase64(key) {
  return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64');
}
// 先限定正式版本号、x64 PE 和大小，再将程序哈希及独立仓库地址签名并本地回验。
export function makeEnvelope({ binary, version, notes = '', publishedAt = new Date().toISOString(), privateKey }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('版本必须为正式语义版本，例如 0.1.1');
  const pe = binary.length >= 64 ? binary.readUInt32LE(0x3c) : 0;
  if (binary.toString('ascii', 0, 2) !== 'MZ' || pe < 64 || pe + 6 > binary.length || binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x8664) throw Error('只接受 Windows x86_64 PE 程序');
  if (binary.length > 512 * 1024 * 1024) throw Error('更新程序超过 512 MiB');
  if (Buffer.byteLength(notes) > 16000) throw Error('更新说明超过 16000 字节');
  const name = `diytools-refactor-${version}-windows-x86_64.exe`;
  const payload = {
    schema: 1, appId: 'io.diytools.refactor', channel: 'refactor', platform: 'windows-x86_64',
    version, publishedAt, notes,
    artifact: { name, size: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), urls: [
      `https://github.com/yamakaze1234/diytools-refactor/releases/download/refactor-v${version}/${name}`,
    ] },
  };
  // 签名覆盖确切的序列化字节；接收方应验证 payload 原文，而不是重排 JSON 后再验证。
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, bytes, privateKey);
  if (!verify(null, bytes, createPublicKey(privateKey), signature)) throw Error('签名回验失败');
  return { envelope: { payload: bytes.toString('base64'), signature: signature.toString('base64') }, payload };
}

// 初始化密钥与制作更新包分开执行；已有密钥禁止覆盖，打包版本必须匹配 Tauri 配置。
function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw Error(`未知参数 ${args[i]}`);
    const key = args[i].slice(2);
    options[key] = key === 'init-key' ? true : args[++i];
  }
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const keyPath = options.key || process.env.DIYTOOLS_UPDATE_PRIVATE_KEY;
  if (!keyPath) throw Error('请用 --key 指定私钥路径，或设置 DIYTOOLS_UPDATE_PRIVATE_KEY');
  const publicPath = resolve(project, 'apps/desktop/src-tauri/updater-public-key.txt');
  if (options['init-key']) {
    if (existsSync(keyPath) || existsSync(publicPath)) throw Error('密钥已存在；禁止覆盖，以免已安装程序无法验证后续更新');
    const { privateKey } = generateKeyPairSync('ed25519');
    mkdirSync(dirname(resolve(keyPath)), { recursive: true });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    writeFileSync(publicPath, publicKeyBase64(privateKey) + '\n', { flag: 'wx' });
    console.log('已生成本机私钥和程序内置公钥。私钥未打印，不会写入更新包。');
    return;
  }
  if (!options.exe || !options.version || !options.out) throw Error('用法: node tools/package-portable-update.mjs --key 私钥 --exe 程序 --version 0.1.1 --out 新目录 [--notes-file 说明]');
  const privateKey = createPrivateKey(readFileSync(keyPath));
  if (readFileSync(publicPath, 'utf8').trim() !== publicKeyBase64(privateKey)) throw Error('私钥与程序内置公钥不匹配');
  const config = JSON.parse(readFileSync(resolve(project, 'apps/desktop/src-tauri/tauri.conf.json')));
  if (config.version !== options.version) throw Error('版本与 tauri.conf.json 不一致；先统一版本并重新构建');
  const binary = readFileSync(options.exe);
  const { envelope, payload } = makeEnvelope({ binary, version: options.version, privateKey, notes: options['notes-file'] ? readFileSync(options['notes-file'], 'utf8') : '' });
  const output = resolve(options.out);
  mkdirSync(output); // A fresh directory prevents mixing old and new release artifacts.
  copyFileSync(options.exe, resolve(output, payload.artifact.name));
  writeFileSync(resolve(output, manifestName), JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ directory: output, manifest: manifestName, artifact: payload.artifact.name, version: payload.version, sha256: payload.artifact.sha256 }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
