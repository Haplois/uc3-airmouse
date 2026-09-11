import test from 'node:test';
import assert from 'node:assert/strict';
import { targetProfile } from '../runtime/target-profile.mjs';

test('LG TV detection uses the Bluetooth identity even after a rename', () => {
  assert.equal(targetProfile({ name: 'TV', bluetooth_name: '[LG] webOS TV OLED77G3PSA' }), 'lg-tv');
  assert.equal(targetProfile({ name: 'Living room', bluetooth_name: 'LG OLED55C3' }), 'lg-tv');
  assert.equal(targetProfile({ name: '[LG] webOS TV OLED77G3PSA' }), 'lg-tv');
  for (const name of ['LG headphones', 'TV', 'webOS TV', 'ALG TV', 'iPad']) {
    assert.equal(targetProfile({ name }), 'computer');
  }
  assert.equal(targetProfile({ name: 'LG TV', bluetooth_name: 'DESKTOP-ABC' }), 'computer');
  assert.equal(targetProfile(), 'computer');
});

test('MR23 sensor conversion preserves physical units while rotating and calibrating axes', async () => {
  const { lgMotion } = await import('../runtime/target-profile.mjs');
  const sample = { generation: 7, time: 1, gyro: [0.07 * Math.PI / 180, -0.14 * Math.PI / 180, 0], accel: [0, 0, -9.80665] };
  assert.deepEqual(lgMotion(sample).axes, [-2, -1, 0, 0, 0, -4096]);
  assert.deepEqual(lgMotion(sample, [sample.gyro[0], 0, 0], 1800).axes, [-2, 0, 0, 0, 0, -4096]);
  assert.deepEqual(lgMotion({ ...sample, gyro: [1000, -1000, 0] }).axes.slice(0, 2), [-32768, -32768]);
  assert.equal(lgMotion({ ...sample, accel: [NaN, 0, 0] }), null);
  assert.equal(lgMotion(sample, []), null);
});

test('LG pitch, roll and gravity use the same measured mount rotation', async () => {
  const { lgMotion } = await import('../runtime/target-profile.mjs');
  const unit = 0.07 * Math.PI / 180;
  const sample = { generation: 1, time: 1, gyro: [0, 10 * unit, 0], accel: [9.80665, 0, 0] };
  assert.deepEqual(lgMotion(sample).axes, [10, 0, 0, 0, -4096, 0]);
  assert.deepEqual(lgMotion({ ...sample, gyro: [10 * unit, 0, 0], accel: [0, 9.80665, 0] }).axes, [0, -10, 0, 4096, 0, 0]);
  assert.deepEqual(lgMotion({ ...sample, gyro: [0, 0, 10 * unit], accel: [0, 0, -9.80665] }).axes, [0, 0, 10, 0, 0, -4096]);
});
