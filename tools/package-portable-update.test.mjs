// 用临时生成的签名密钥和最小 PE 字节测试升级清单的完整性；不启动程序、不接触真实发布密钥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { makeEnvelope, publicKeyBase64 } from './package-portable-update.mjs';

// 只构造能被格式校验识别的 PE 头，绝不执行这段合成二进制。
function binary() { const value = Buffer.alloc(160); value.write('MZ'); value.writeUInt32LE(80, 60); value.writeUInt32LE(0x4550, 80); value.writeUInt16LE(0x8664, 84); return value; }
// 验证签名涵盖版本、新仓库地址、长度和哈希，改动一个字节就必须失败。
test('signed manifest covers version, independent repository URL, size and binary hash', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const result = makeEnvelope({ binary: binary(), version: '0.1.1', notes: '修复更新', privateKey });
  const payload = Buffer.from(result.envelope.payload, 'base64');
  assert.equal(verify(null, payload, publicKey, Buffer.from(result.envelope.signature, 'base64')), true);
  assert.equal(Buffer.from(publicKeyBase64(privateKey), 'base64').length, 32);
  assert.deepEqual(JSON.parse(payload).artifact.urls, ['https://github.com/yamakaze1234/diytools-refactor/releases/download/refactor-v0.1.1/diytools-refactor-0.1.1-windows-x86_64.exe']);
  payload[0] ^= 1;
  assert.equal(verify(null, payload, publicKey, Buffer.from(result.envelope.signature, 'base64')), false);
});
// 旧 Python ZIP、错误 CPU 架构或非法版本号都不能伪装成重构版升级包。
test('refuse an old Python ZIP, wrong architecture and invalid release version', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  assert.throws(() => makeEnvelope({ binary: Buffer.from('PK old Python archive'), version: '0.1.1', privateKey }), /PE/);
  const arm = binary(); arm.writeUInt16LE(0xaa64, 84);
  assert.throws(() => makeEnvelope({ binary: arm, version: '0.1.1', privateKey }), /PE/);
  assert.throws(() => makeEnvelope({ binary: binary(), version: '../bad', privateKey }), /版本/);
});
