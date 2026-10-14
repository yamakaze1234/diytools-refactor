// 发布前独立验签：程序、清单和源码公钥必须一致，且清单必须含固定 Gitea 地址。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const manifestName = 'diytools-refactor-windows-x86_64.json';
// 纯验证函数便于覆盖篡改、跨仓库与说明不一致等拒绝路径，不需要创建本机临时文件。
export function verifyGiteaPackage({ envelope, rawKey, binary, notes, version }) {
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('需要正式版本号');
const bytes = Buffer.from(envelope.payload, 'base64');
if (rawKey.length !== 32) throw Error('更新公钥长度无效');
const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') }, format: 'jwk' });
if (!verify(null, bytes, key, Buffer.from(envelope.signature, 'base64'))) throw Error('清单签名验证失败');
const payload = JSON.parse(bytes);
const artifactName = `diytools-refactor-${version}-windows-x86_64.exe`;
const giteaUrl = `https://gitea.cq360.top/CoreStudio/diy-tools-refactor/releases/download/refactor-v${version}/${artifactName}`;
const githubUrl = `https://github.com/yamakaze1234/diytools-refactor/releases/download/refactor-v${version}/${artifactName}`;
if (payload.schema !== 1 || payload.appId !== 'io.diytools.refactor' || payload.channel !== 'refactor' || payload.platform !== 'windows-x86_64' || payload.version !== version || payload.artifact?.name !== artifactName) throw Error('清单标识或版本不匹配');
const urls = payload.artifact.urls;
if (!Array.isArray(urls) || !urls.includes(giteaUrl) || new Set(urls).size !== urls.length || urls.some(url => ![giteaUrl, githubUrl].includes(url))) throw Error('清单下载地址不符合发行仓库约定');
if (binary.length !== payload.artifact.size || createHash('sha256').update(binary).digest('hex') !== payload.artifact.sha256) throw Error('EXE 大小或摘要与清单不符');
if (notes !== payload.notes) throw Error('发行说明与签名清单不一致');
return { version, artifact: artifactName, manifest: manifestName, sha256: payload.artifact.sha256, size: binary.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [source, directory, version] = process.argv.slice(2);
    if (!source || !directory || !version) throw Error('需要源码目录、附件目录和版本号');
    const result = verifyGiteaPackage({
        version,
        envelope: JSON.parse(readFileSync(resolve(directory, manifestName), 'utf8')),
        rawKey: Buffer.from(readFileSync(resolve(source, 'apps/desktop/src-tauri/updater-public-key.txt'), 'utf8').trim(), 'base64'),
        binary: readFileSync(resolve(directory, `diytools-refactor-${version}-windows-x86_64.exe`)),
        notes: readFileSync(resolve(directory, 'release-notes.md'), 'utf8'),
    });
    console.log(JSON.stringify(result));
}
