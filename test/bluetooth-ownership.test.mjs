import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Controller } from '../runtime/controller.mjs';
import { OwnershipRequests } from '../runtime/bluetooth-ownership.mjs';
import { fakeSensor, fakeOutput } from './helpers.mjs';
import { readJSON, saveJSON } from '../runtime/storage.mjs';

function setup(t, { mode = 'always', backend = 'core', installed = true } = {}) {
  const fixture = fakeSensor(t), output = fakeOutput();
  output.backend = backend;
  const config = readJSON(fixture.configFile); config.bluetooth = { ownership: mode }; saveJSON(fixture.configFile, config);
  const runDir = path.join(fixture.dir, 'run'); fs.mkdirSync(runDir);
  const helper = path.join(fixture.dir, 'owned-bluetooth.sh'); if (installed) fs.writeFileSync(helper, '');
  const ownership = new OwnershipRequests({ dir: runDir, helper });
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile, ownership, releaseGraceMs: 30, ownershipStartupMs: 0 });
  t.after(() => { clearTimeout(controller.releaseTimer); return controller.stop(); });
  const request = () => fs.existsSync(ownership.file) ? fs.readFileSync(ownership.file, 'utf8').trim() : null;
  return { ...fixture, output, controller, ownership, request, runDir };
}

test('always requests a takeover at start on the Core backend and nothing once owned', t => {
  const { controller, request, ownership, output } = setup(t);
  assert.equal(request(), 'takeover'); assert.equal(controller.state().ownership_status, 'Taking over Bluetooth');
  output.backend = 'owned'; ownership.cancel(); controller.applyOwnership();
  assert.equal(request(), null); assert.equal(controller.state().ownership_status, '');
});

test('never releases an owned stack and stays quiet on the Core backend', t => {
  const owned = setup(t, { mode: 'never', backend: 'owned' });
  assert.equal(owned.request(), 'rollback');
  const core = setup(t, { mode: 'never' });
  assert.equal(core.request(), null); assert.equal(core.controller.state().ownership_status, '');
});

test('session takes over on app open and releases after the grace period, unless reopened', async t => {
  const { controller, request, ownership, output } = setup(t, { mode: 'session' });
  assert.equal(request(), null);
  controller.acquireControl(); assert.equal(request(), 'takeover');
  output.backend = 'owned'; ownership.cancel(); controller.applyOwnership(); assert.equal(request(), null);
  await controller.releaseControl('Air mouse screen closed');
  assert.equal(request(), null); assert.ok(controller.releaseTimer);
  controller.acquireControl(); assert.equal(controller.releaseTimer, null);
  await controller.releaseControl('Air mouse screen closed');
  await delay(60);
  assert.equal(request(), 'rollback'); assert.equal(controller.state().ownership_status, 'Releasing Bluetooth');
});

test('a failed takeover is shown once per app session and retried on reopen', t => {
  const { controller, request, ownership } = setup(t);
  ownership.cancel(); fs.writeFileSync(ownership.marker, 'Controller probe failed\n');
  controller.applyOwnership();
  assert.equal(request(), null); assert.equal(controller.state().ownership_status, 'Controller probe failed');
  controller.acquireControl();
  assert.equal(request(), 'takeover'); assert.equal(fs.existsSync(ownership.marker), false);
});

test('changing the setting persists, applies immediately, and is refused while pointing', async t => {
  const { controller, request, ownership, configFile, output } = setup(t, { mode: 'never' });
  controller.nativeControl = true; controller.target = 'host.a';
  await controller.apply({ type: 'bluetooth_ownership', mode: 'always' });
  assert.equal(readJSON(configFile).bluetooth.ownership, 'always'); assert.equal(request(), 'takeover');
  output.backend = 'owned'; ownership.cancel(); controller.applyOwnership();
  await controller.apply({ type: 'on' });
  await assert.rejects(controller.apply({ type: 'bluetooth_ownership', mode: 'never' }), /Pause pointing/);
  await controller.stop();
  await controller.apply({ type: 'bluetooth_ownership', mode: 'never' });
  assert.equal(request(), 'rollback');
  await assert.rejects(controller.apply({ type: 'bluetooth_ownership', mode: 'sometimes' }), /Unknown/);
});

test('a missing Bluetooth backend is reported instead of requested', t => {
  const { controller, request } = setup(t, { installed: false });
  assert.equal(request(), null); assert.equal(controller.state().ownership_status, 'Bluetooth backend is not installed');
});

test('the first automatic request waits for the startup delay', async t => {
  const fixture = fakeSensor(t), output = fakeOutput();
  const runDir = path.join(fixture.dir, 'run'); fs.mkdirSync(runDir);
  const helper = path.join(fixture.dir, 'owned-bluetooth.sh'); fs.writeFileSync(helper, '');
  const ownership = new OwnershipRequests({ dir: runDir, helper });
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile, ownership, ownershipStartupMs: 40 });
  t.after(() => { clearTimeout(controller.startupTimer); return controller.stop(); });
  assert.equal(fs.existsSync(ownership.file), false);
  await delay(80);
  assert.equal(fs.readFileSync(ownership.file, 'utf8').trim(), 'takeover');
});
