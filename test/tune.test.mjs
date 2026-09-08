import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSensor } from './helpers.mjs';
import { readJSON, saveJSON } from '../runtime/storage.mjs';

const tune = (dir, sensitivity, rate) => spawnSync(process.execPath, [new URL('../runtime/tune.mjs', import.meta.url).pathname, dir, String(sensitivity), String(rate)], { encoding: 'utf8' });

test('tuning preserves sampling, axis mapping, calibration and selected target', t => {
  const { dir, configFile } = fakeSensor(t);
  const before = readJSON(configFile);
  before.selected_target = 'host.a';
  before.motion.active_profile.sampling_frequency_hz = 800;
  before.motion.bias = [0.001, -0.001, 0];
  before.motion.filter.sensitivity = 900;
  before.output.movement_rate_hz = 40;
  saveJSON(configFile, before);
  const result = tune(dir, 1350, 80);
  assert.equal(result.status, 0, result.stderr);
  const expected = structuredClone(before);
  expected.motion.filter.sensitivity = 1350;
  expected.output.movement_rate_hz = 80;
  assert.deepEqual(readJSON(configFile), expected);
});
test('invalid tuning and active acquisition leave saved configuration unchanged', t => {
  const { dir, configFile } = fakeSensor(t), before = readJSON(configFile);
  for (const [sensitivity, rate] of [[0, 80], [1350, 0], [1350, 1001], ['NaN', 80]]) {
    assert.notEqual(tune(dir, sensitivity, rate).status, 0);
    assert.deepEqual(readJSON(configFile), before);
  }
  fs.writeFileSync(`${dir}/sensor-journal.json`, '{}');
  assert.notEqual(tune(dir, 1350, 80).status, 0);
  assert.deepEqual(readJSON(configFile), before);
});

test('an idle service configuration lock prevents direct tuning', async t => {
  const { lockConfig } = await import('../runtime/config-lock.mjs');
  const { dir, configFile } = fakeSensor(t), before = readJSON(configFile);
  const unlock = lockConfig(dir);
  try {
    const result = tune(dir, 1800, 100);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Configuration is in use/);
    assert.deepEqual(readJSON(configFile), before);
  } finally { unlock(); }
  assert.equal(tune(dir, 1800, 100).status, 0);
});

test('tune sets Bluetooth ownership and rejects unknown modes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airmouse-tune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(new URL('../config/airmouse.json', import.meta.url), path.join(dir, 'airmouse.json'));
  const run = mode => spawnSync(process.execPath, [new URL('../runtime/tune.mjs', import.meta.url).pathname, dir, '-', '-', mode], { encoding: 'utf8' });
  assert.equal(run('session').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'airmouse.json'))).bluetooth.ownership, 'session');
  assert.notEqual(run('sometimes').status, 0);
});
