import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Sensor } from '../runtime/sensor.mjs';
import { fakeSensor } from './helpers.mjs';

test('FIFO acquisition clears the trigger and restores it after active rate changes', t => {
  const { sensor, settings } = fakeSensor(t);
  settings['trigger/current_trigger'] = 'bmi323-imu-trig-1';
  sensor.begin(400, 2000);
  assert.equal(settings['trigger/current_trigger'], '');
  sensor.begin(200, 2000);
  sensor.restore();
  assert.equal(settings['trigger/current_trigger'], 'bmi323-imu-trig-1');
});

test('rate intersection and baseline survive repeated activation and active changes', t => {
  const { sensor } = fakeSensor(t), baseline = sensor.snapshot();
  assert.deepEqual(sensor.rates([50, 100, 200, 400, 800]), [50, 100, 200, 400]);
  sensor.begin(400); sensor.begin(400); sensor.begin(100);
  sensor.restore(); assert.deepEqual(sensor.snapshot(), baseline);
});

test('every partial activation write rolls back', t => {
  const success = fakeSensor(t);
  success.sensor.begin(400);
  const writeCount = success.writes.length;
  success.sensor.restore();
  for (let n = 1; n <= writeCount; n++) {
    const { sensor, fail, dir } = fakeSensor(t), baseline = sensor.snapshot();
    fail(n);
    assert.throws(() => sensor.begin(400), /Injected/);
    assert.deepEqual(sensor.snapshot(), baseline);
    assert.equal(fs.existsSync(`${dir}/sensor-journal.json`), false);
  }
});

test('new process recovers original baseline after simulated kill', t => {
  const { sensor, dir, io } = fakeSensor(t), baseline = sensor.snapshot();
  sensor.begin(400); sensor.begin(200);
  const next = new Sensor({ stateDir: dir, sysfs: dir, io, bootID: 'test-boot' });
  next.restore(); assert.deepEqual(next.snapshot(), baseline);
});

test('recovery accepts a pre-FIFO journal without changing its unowned trigger', t => {
  const { sensor, settings, dir, io } = fakeSensor(t), baseline = sensor.snapshot();
  sensor.begin(400);
  const journal = JSON.parse(fs.readFileSync(sensor.journalFile, 'utf8'));
  delete journal.values['trigger/current_trigger'];
  settings['trigger/current_trigger'] = baseline['trigger/current_trigger'];
  fs.writeFileSync(sensor.journalFile, JSON.stringify(journal));
  const next = new Sensor({ stateDir: dir, sysfs: dir, io, bootID: 'test-boot' });
  next.restore();
  assert.deepEqual(next.snapshot(), baseline);
  assert.equal(fs.existsSync(sensor.journalFile), false);
});

test('foreign writes and changed boot identity block restoration', t => {
  const { sensor, settings, dir, io } = fakeSensor(t);
  sensor.begin(400); settings.in_accel_sampling_frequency = '800';
  assert.throws(() => sensor.restore(), /external sensor/);
  assert.equal(settings.in_accel_sampling_frequency, '800');
  settings.in_accel_sampling_frequency = '400';
  const next = new Sensor({ stateDir: dir, sysfs: dir, io, bootID: 'new-boot' });
  assert.throws(() => next.restore(), /earlier boot/);
  sensor.restore();
});

test('occupied buffer is never adopted', t => {
  const { sensor, settings, writes } = fakeSensor(t);
  settings['buffer/enable'] = '1';
  assert.throws(() => sensor.begin(400), /already owned/);
  assert.equal(writes.length, 0);
});

test('decode uses aligned signed channel layout and monotonic timestamps', t => {
  const { sensor } = fakeSensor(t);
  sensor.begin(400);
  const scan = Buffer.alloc(24); scan.writeInt16LE(-100, 6); scan.writeBigInt64LE(1234567890n, 16);
  const [sample] = sensor.decode(scan, 7);
  assert.equal(sample.generation, 7); assert.equal(sample.time, 1.23456789);
  assert.ok(Math.abs(sample.gyro[0] + 0.0266) < 1e-12);
  assert.throws(() => sensor.decode(scan.subarray(1), 7), /Incomplete/);
  sensor.restore();
});
