import test from 'node:test';
import assert from 'node:assert/strict';
import { sensorSandbox, validateWakeDevice } from '../runtime/device-permissions.mjs';

test('the sensor sandbox uses the stable BMI323 wake-device symlink', () => {
  const sandbox = sensorSandbox('/sys/devices/sensor/iio:device1', '/dev/iio:device1', '/dev/input/airmouse-wake');
  assert.match(sandbox, /DeviceAllow=\/dev\/input\/airmouse-wake r/);
  assert.doesNotMatch(sandbox, /event\d+/);

  for (const event of ['/dev/input/event2', '/dev/input/event4']) {
    assert.doesNotThrow(() => validateWakeDevice('/dev/input/airmouse-wake', event, () => event));
  }
});

test('the permission helper rejects a stable symlink to another input device', () => {
  assert.throws(
    () => validateWakeDevice('/dev/input/airmouse-wake', '/dev/input/event2', () => '/dev/input/event4'),
    /does not identify the BMI323/,
  );
});

test('the permission helper rejects a missing stable wake-device symlink', () => {
  assert.throws(
    () => validateWakeDevice('/dev/input/airmouse-wake', '/dev/input/event2', () => { throw new Error('missing'); }),
    /Stable BMI323 wake device is missing/,
  );
});
