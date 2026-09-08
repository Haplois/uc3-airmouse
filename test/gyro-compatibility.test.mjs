import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../runtime/controller.mjs';
import { fakeSensor, fakeOutput } from './helpers.mjs';
import { readJSON, saveJSON } from '../runtime/storage.mjs';

function fixture(t) {
  const f = fakeSensor(t);
  const write = f.io.write;
  f.io.write = (key, value) => {
    if (key === 'in_anglvel_scale') throw Object.assign(new Error('Unsupported scale write'), { code: 'EINVAL' });
    write(key, value);
  };
  return f;
}

test('explicit 2000 degree profile starts without a scale write on this firmware', t => {
  const { sensor, writes } = fixture(t), baseline = sensor.snapshot();
  sensor.begin(400, 2000);
  assert.equal(sensor.gyroScale, 0.001065);
  assert.equal(sensor.io.read('buffer/enable'), '1');
  assert.equal(writes.includes('in_anglvel_scale'), false);
  sensor.restore(); assert.deepEqual(sensor.snapshot(), baseline);
});

test('500 degree default still fails explicitly; no implicit range fallback', t => {
  const { sensor } = fixture(t), baseline = sensor.snapshot();
  assert.throws(() => sensor.begin(400), /in_anglvel_scale: EINVAL/);
  assert.deepEqual(sensor.snapshot(), baseline);
});

test('explicit compatibility config permits activation, output policy changes and exact restoration', async t => {
  const { sensor, configFile } = fixture(t), baseline = sensor.snapshot();
  const config = readJSON(configFile);
  config.motion.active_profile.gyroscope.range_degrees_per_second = 2000;
  saveJSON(configFile, config);
  const output = fakeOutput();
  const controller = new Controller({ sensor, configFile, output });
  controller.nativeControl = true; controller.target = 'host.a';
  t.after(() => controller.stop());
  await controller.apply({ type: 'on' }); assert.equal(controller.pointer, true);
  await controller.apply({ type: 'off' });
  await controller.apply({ type: 'output_policy', rate: 100 });
  await controller.apply({ type: 'on' }); assert.equal(controller.pointer, true);
  await controller.apply({ type: 'off' }); assert.deepEqual(sensor.snapshot(), baseline);
});
