import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Sensor } from '../runtime/sensor.mjs';
import { fakeSensor } from './helpers.mjs';

test('samples are delivered while driver health reads are waiting', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { sensor, dir, io } = fakeSensor(t);
  sensor.begin(400, 2000);
  sensor.device = `${dir}/scans`;
  fs.writeFileSync(sensor.device, Buffer.alloc(24));
  const originalRead = io.read;
  let finish, samples = 0, failure;
  io.readAsync = key => new Promise(resolve => { finish = () => resolve(originalRead(key)); });
  io.read = () => { throw new Error('Synchronous driver read on movement thread'); };
  sensor.start = Sensor.prototype.start;
  t.after(() => sensor.closeReader());
  sensor.start(1, batch => { samples += batch.length; }, error => { failure = error; });
  sensor.lastCheck = -Infinity;
  t.mock.timers.tick(2);
  assert.equal(failure, undefined);
  assert.equal(samples, 1, 'A slow attribute read must not delay available scans');
  sensor.closeReader();
  finish(); await Promise.resolve();
  assert.equal(failure, undefined, 'A completed health read must not affect a stopped reader');
  io.read = originalRead; sensor.restore();
});
