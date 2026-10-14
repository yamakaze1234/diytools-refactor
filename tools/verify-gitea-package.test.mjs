// 发行验签和仓库边界的拒绝测试；所有样本只在内存中生成，不读取发布者私钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { verifyGiteaPackage } from './verify-gitea-package.mjs';

function fixture(change = () => {}) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const version = '0.2.2', binary = Buffer.from('test fixture'), notes = '测试发布说明';
    const name = `diytools-refactor-${version}-windows-x86_64.exe`;
    const payload = { schema: 1, appId: 'io.diytools.refactor', channel: 'refactor', platform: 'windows-x86_64', version, notes,
        artifact: { name, size: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), urls: [`https://gitea.cq360.top/CoreStudio/diy-tools-refactor/releases/download/refactor-v${version}/${name}`] } };
    change(payload);
    const bytes = Buffer.from(JSON.stringify(payload));
    return { version, binary, notes, rawKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'), envelope: { payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') } };
}

test('有效 Gitea 清单通过完整签名和程序摘要验证', () => assert.equal(verifyGiteaPackage(fixture()).version, '0.2.2'));
test('篡改签名载荷、程序或发布说明均拒绝', () => {
    const signed = fixture();
    signed.envelope.payload = Buffer.from('{}').toString('base64');
    assert.throws(() => verifyGiteaPackage(signed), /签名/);
    assert.throws(() => verifyGiteaPackage({ ...fixture(), binary: Buffer.from('other') }), /摘要/);
    assert.throws(() => verifyGiteaPackage({ ...fixture(), notes: '不同说明' }), /说明/);
});
test('旧仓库、重复地址和缺少 Gitea 地址均拒绝', () => {
    assert.throws(() => verifyGiteaPackage(fixture(p => p.artifact.urls[0] = p.artifact.urls[0].replace('diy-tools-refactor/', 'diy-tools/'))), /下载地址/);
    assert.throws(() => verifyGiteaPackage(fixture(p => p.artifact.urls.push(p.artifact.urls[0]))), /下载地址/);
    assert.throws(() => verifyGiteaPackage(fixture(p => p.artifact.urls = [])), /下载地址/);
});
test('已签名的其他版本也不得作为当前源码版本发布', () => assert.throws(() => verifyGiteaPackage(fixture(p => p.version = '0.2.3')), /版本/));
