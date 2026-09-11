import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const installer = new URL('../deploy/install.sh', import.meta.url).pathname;
function fixture(t, { active = true, enabled = true, previous = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airmouse-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = `${dir}/bin`, base = `${dir}/app`, units = `${dir}/units`, udev = `${dir}/udev`;
  for (const p of [bin, units, udev, `${base}/state`, `${dir}/run`]) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(`${base}/fake-systemd.json`, JSON.stringify({ active, enabled }));
  for (const release of ['old', 'new']) {
    for (const sub of ['runtime', 'deploy', 'config']) fs.mkdirSync(`${base}/releases/${release}/${sub}`, { recursive: true });
    for (const file of ['runtime/main.mjs', 'runtime/bluetooth-journal.mjs', 'runtime/permissions.mjs', 'deploy/ready.mjs', 'deploy/airmouse.service', 'deploy/99-airmouse-wake.rules', 'config/airmouse.json']) fs.writeFileSync(`${base}/releases/${release}/${file}`, release);
  }
  if (previous) { fs.symlinkSync('releases/old', `${base}/current`); fs.writeFileSync(`${units}/airmouse.service`, 'original unit'); }
  fs.writeFileSync(`${base}/state/airmouse.json`, 'user tuning');
  const stub = new URL('./fixtures/installer-command.py', import.meta.url).pathname;
  fs.copyFileSync(stub, `${bin}/fixture`); fs.chmodSync(`${bin}/fixture`, 0o755);
  for (const command of ['node', 'systemctl', 'id', 'chown']) fs.symlinkSync('fixture', `${bin}/${command}`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AIRMOUSE_BASE: base, AIRMOUSE_RUN_DIR: `${dir}/run`, AIRMOUSE_UNIT_DIR: units, AIRMOUSE_UDEV_DIR: udev };
  return { base, units, udev, env, run: fail => exec('/bin/sh', [installer, 'new'], { env: { ...env, INSTALL_FAIL: fail ?? '' }, timeout: 10000 }), state: () => JSON.parse(fs.readFileSync(`${base}/fake-systemd.json`)) };
}

for (const fail of ['permissions', 'journal', 'journal-ownership', 'start', 'readiness']) {
  test(`failed installation at ${fail} restores the old release, unit and running state`, async t => {
    const f = fixture(t);
    await assert.rejects(f.run(fail));
    assert.equal(fs.readlinkSync(`${f.base}/current`), 'releases/old');
    assert.equal(fs.readFileSync(`${f.units}/airmouse.service`, 'utf8'), 'original unit');
    assert.deepEqual(f.state(), { active: true, enabled: true });
    assert.equal(fs.readFileSync(`${f.base}/state/airmouse.json`, 'utf8'), 'user tuning');
  });
}
test('successful installation selects the new release and retains user tuning', async t => {
  const f = fixture(t); await f.run();
  assert.equal(fs.readlinkSync(`${f.base}/current`), 'releases/new');
  assert.equal(fs.readFileSync(`${f.base}/previous`, 'utf8').trim(), 'releases/old');
  assert.deepEqual(f.state(), { active: true, enabled: true });
  assert.equal(fs.readFileSync(`${f.base}/state/airmouse.json`, 'utf8'), 'user tuning');
  assert.equal(fs.readFileSync(`${f.udev}/99-airmouse-wake.rules`, 'utf8'), 'new');
});
test('rollback preserves an intentionally stopped and disabled old installation', async t => {
  const f = fixture(t, { active: false, enabled: false }); await assert.rejects(f.run('start'));
  assert.deepEqual(f.state(), { active: false, enabled: false });
  assert.equal(fs.readlinkSync(`${f.base}/current`), 'releases/old');
});
test('failed first installation leaves no selected release or enabled service', async t => {
  const f = fixture(t, { active: false, enabled: false, previous: false }); await assert.rejects(f.run('start'));
  assert.equal(fs.existsSync(`${f.base}/current`), false);
  assert.equal(fs.existsSync(`${f.units}/airmouse.service`), false);
  assert.deepEqual(f.state(), { active: false, enabled: false });
});

test('failed installation restores the previous sensor drop-in or its absence', async t => {
  const withDropIn = fixture(t);
  fs.mkdirSync(`${withDropIn.units}/airmouse.service.d`, { recursive: true });
  fs.writeFileSync(`${withDropIn.units}/airmouse.service.d/sensor.conf`, 'previous drop-in');
  await assert.rejects(withDropIn.run('start'));
  assert.equal(fs.readFileSync(`${withDropIn.units}/airmouse.service.d/sensor.conf`, 'utf8'), 'previous drop-in');
  const without = fixture(t);
  await assert.rejects(without.run('start'));
  assert.equal(fs.existsSync(`${without.units}/airmouse.service.d/sensor.conf`), false);
});
test('failed installation restores the previous wake-device rule or its absence', async t => {
  const withRule = fixture(t);
  fs.writeFileSync(`${withRule.udev}/99-airmouse-wake.rules`, 'previous rule');
  await assert.rejects(withRule.run('start'));
  assert.equal(fs.readFileSync(`${withRule.udev}/99-airmouse-wake.rules`, 'utf8'), 'previous rule');
  const without = fixture(t);
  await assert.rejects(without.run('start'));
  assert.equal(fs.existsSync(`${without.udev}/99-airmouse-wake.rules`), false);
});
test('syntax failure is detected before stopping the working service', async t => {
  const f = fixture(t); await assert.rejects(f.run('syntax'));
  assert.deepEqual(f.state(), { active: true, enabled: true });
  assert.equal(fs.readlinkSync(`${f.base}/current`), 'releases/old');
  assert.ok(!fs.readFileSync(`${f.base}/commands.log`, 'utf8').includes('systemctl stop'));
});
test('failed installation preserves unresolved sensor recovery and its backup', async t => {
  const f = fixture(t);
  fs.writeFileSync(`${f.base}/state/sensor-journal.json`, 'unresolved baseline');
  const failure = await f.run().then(() => null, error => error);
  assert.match(failure.stderr, /Sensor recovery is unresolved/);
  assert.equal(fs.readFileSync(`${f.base}/state/sensor-journal.json`, 'utf8'), 'unresolved baseline');
  assert.equal(fs.readlinkSync(`${f.base}/current`), 'releases/old');
  assert.equal(f.state().active, false);
  assert.ok(fs.readdirSync(f.base).some(name => name.startsWith('.install.')));
});
