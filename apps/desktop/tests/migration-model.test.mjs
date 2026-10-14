import test from 'node:test';
import assert from 'node:assert/strict';
import { groupConfigs, isDeleted, filterConfigs, pageItems, PAGE_SIZE, textValue, isAbsoluteBundlePath, validName } from '../src/migration-model.ts';

test('grouping preserves first-seen shop/link order and config order without normalizing state', () => {
  const records = [
    { id: '001', shopId: 'B', spu: '01', name: '配置乙', parts: [{ goodsId: '0008', qty: 2 }], actualParts: [], unknown: { value: null } },
    { id: '002', shopId: 'A', spu: 'x', name: '配置甲' },
    { id: '003', shopId: 'B', spu: '02', deletedAt: '2026-10-11', name: '删除配置' },
    { id: '004', shopId: 'B', spu: '01', actualParts: null },
  ];
  const original = structuredClone(records);
  const groups = groupConfigs(records);
  assert.deepEqual(groups.map(shop => shop.label), ['店铺 B', '店铺 A']);
  assert.deepEqual(groups[0].links.map(link => link.key), [JSON.stringify('legacy:01'), JSON.stringify('legacy:02')]);
  assert.deepEqual(groups[0].links[0].configs.map(item => item.id), ['001', '004']);
  assert.equal(groups[0].links[0].configs[0], records[0]);
  assert.deepEqual(groups[0].links[0].configs[0].actualParts, []);
  assert.equal(groups[0].links[0].configs[1].actualParts, null);
  assert.equal('actualParts' in groups[1].links[0].configs[0], false);
  assert.equal(isDeleted(groups[0].links[1].configs[0]), true);
  assert.deepEqual(records, original);
});

test('SPU strings remain exact and completely missing link identities fall back to each config ID', () => {
  const records = [
    { id: '1', shopId: 'A', spu: '未绑定 SPU' },
    { id: '2', shopId: 'A' },
    { id: '3', shopId: 'A', spu: '' },
    { id: '4', shopId: 'A', spu: null },
    { id: '5', shopId: 'A', spu: '001' },
    { id: '6', shopId: 'A', spu: '1' },
    { id: '7' },
    { id: '8', shopId: null },
  ];
  const groups = groupConfigs(records);
  assert.equal(groups[0].links.length, 6);
  assert.deepEqual(groups[0].links.slice(1, 4).map(link => link.configs.map(item => item.id)), [['2'], ['3'], ['4']]);
  assert.notEqual(groups[0].links[0].key, groups[0].links[1].key);
  assert.equal(groups.length, 3);
  assert.deepEqual(groupConfigs([]), []);
});

test('deleted status matches JavaScript truthiness, including unusual legacy metadata', () => {
  for (const deletedAt of [undefined, null, false, 0, '']) assert.equal(isDeleted({ id: 'a', deletedAt }), false);
  for (const deletedAt of [true, 1, 'false', [], {}]) assert.equal(isDeleted({ id: 'a', deletedAt }), true);
});

test('large configuration searches preserve order and paging does not render all rows', () => {
  const records = Array.from({ length: 10003 }, (_, index) => ({ id: `00${index}`, name: `配置 ${index}`, product: '测试商品', skuId: `SKU-${index}` }));
  assert.equal(filterConfigs(records, ' 测试商品 ').length, records.length);
  assert.deepEqual(filterConfigs(records, 'sku-10002').map(item => item.id), ['0010002']);
  assert.equal(pageItems(records, 0).length, PAGE_SIZE);
  assert.equal(pageItems(records, 200).length, 3);
  assert.equal(pageItems(records, 200)[0], records[10000]);
  assert.equal(records.length, 10003);
});

test('raw text distinguishes missing, null and empty; names and absolute paths validate before IPC', () => {
  assert.equal(textValue(undefined), '未提供');
  assert.equal(textValue(null), 'null');
  assert.equal(textValue(''), '（空字符串）');
  assert.equal(textValue([]), '[]');
  assert.equal(textValue('<script>x</script>'), '<script>x</script>');
  for (const path of ['D:\\sandbox\\bundle.json', 'D:/sandbox/bundle.json', '\\\\server\\share\\bundle.json', '/tmp/bundle.json']) assert.equal(isAbsoluteBundlePath(path), true);
  for (const path of ['', 'bundle.json', 'D:bundle.json', '~\\bundle.json']) assert.equal(isAbsoluteBundlePath(path), false);
  assert.equal(validName('  '), false);
  assert.equal(validName(' 配置名称 '), true);
});

test('product identity keeps distinct products separate even with the same or missing SPU', () => {
  const records = [
    { id: 'a', shopId: 'A', productId: 'p1', product: '商品一', spu: '0001' },
    { id: 'b', shopId: 'A', productId: 'p2', product: '商品二', spu: '0001' },
    { id: 'c', shopId: 'A', productId: 'p1', spu: 'later-edited' },
    { id: 'd', shopId: 'A', productId: 'p3', spu: '' },
    { id: 'e', shopId: 'A', productId: 'p4' },
    { id: 'f', shopId: 'B', productId: 'p1', spu: '0001' },
  ];
  const original = structuredClone(records);
  const groups = groupConfigs(records);
  assert.deepEqual(groups[0].links.map(link => link.configs.map(item => item.id)), [['a', 'c'], ['b'], ['d'], ['e']]);
  assert.deepEqual(groups[1].links[0].configs.map(item => item.id), ['f']);
  assert.match(groups[0].links[0].label, /^商品一 · SPU 0001/);
  assert.deepEqual(records, original);
});

test('legacy link fallback uses SPU then product then config ID without inserting a productId', () => {
  const records = [
    { id: '1', shopId: 'A', productId: '', spu: '009' },
    { id: '2', shopId: 'A', spu: '009', product: 'different name' },
    { id: '3', shopId: 'A', spu: '', product: '商品' },
    { id: '4', shopId: 'A', product: '商品' },
    { id: '5', shopId: 'A' },
    { id: '6', shopId: 'A' },
  ];
  assert.deepEqual(groupConfigs(records)[0].links.map(link => link.configs.map(item => item.id)), [['1', '2'], ['3', '4'], ['5'], ['6']]);
  assert.equal('productId' in records[1], false);
});

test('name limit counts Unicode scalar characters like the Rust API and never truncates input', () => {
  assert.equal(validName('😀'.repeat(120)), true);
  assert.equal(validName('😀'.repeat(121)), false);
  assert.equal(validName('a'.repeat(120)), true);
  assert.equal(validName('a'.repeat(121)), false);
  assert.equal(validName(' ' + 'a'.repeat(120)), false);
});
