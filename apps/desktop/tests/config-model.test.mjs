import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCents, fromDraft, toDraft, preview } from '../src/config-model.ts';

test('decimal amounts are converted to exact integer cents', () => {
  assert.equal(parseCents('0.29'), 29);
  assert.equal(parseCents('8799.01'), 879901);
  assert.equal(parseCents('0'), 0);
  for (const value of ['', '-1', '1.005', '1e3', 'Infinity', '10000000.01']) {
    assert.throws(() => parseCents(value));
  }
});

test('incomplete input cannot silently turn into zero or alter the loaded baseline', () => {
  const config = structuredClone(preview.config);
  const draft = toDraft(config);
  draft.actualParts[0].quantity = '';
  assert.throws(() => fromDraft(draft, config));
  draft.actualParts[0].quantity = '2';
  draft.actualParts[0].unitCost = '100.29';
  const result = fromDraft(draft, config);
  assert.equal(result.actualParts[0].quantity, 2);
  assert.equal(result.actualParts[0].unitCostCents, 10029);
  assert.equal(result.id, config.id);
  assert.equal(result.revision, config.revision);
  assert.equal(config.actualParts[0].quantity, 1);
});
