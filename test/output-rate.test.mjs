import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutputRate } from '../runtime/output-rate.mjs';

test('output limits accept the full range and reject non-finite or out-of-range rates', () => {
  for (const rate of [10, 80, 125.5, 400, 1000]) assert.equal(validateOutputRate(rate), rate);
  for (const rate of [NaN, Infinity, -Infinity, 9, 1001, '400']) assert.throws(() => validateOutputRate(rate));
});
