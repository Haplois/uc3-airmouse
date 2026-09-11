import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Sensor } from './sensor.mjs';

const base = '/mnt/data/airmouse';
const sensor = new Sensor({ stateDir: `${base}/state` });
const baseline = sensor.snapshot();
const events = () => Object.fromEntries(fs.readdirSync(`${sensor.root}/events`).filter(n => !n.endsWith('_available')).map(n => [n, fs.readFileSync(`${sensor.root}/events/${n}`, 'utf8')]));
const wake = events();
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  run('systemd-run', ['--unit=airmouse-crash', '--collect', '-p', 'User=airmouse', '-p', 'Group=airmouse', '-p', 'SupplementaryGroups=input', '-p', 'RuntimeDirectory=airmouse', '-p', `ExecStopPost=/usr/bin/node ${base}/current/runtime/main.mjs recover`, '-E', `AIRMOUSE_STATE=${base}/state`, '/usr/bin/flock', '-F', '-n', '/run/airmouse/sensor.lock', '/usr/bin/node', `${base}/current/runtime/record.mjs`, `${base}/state`, '400', '10', 'keep-range']);
  let active = false;
  for (let i = 0; i < 40; i++) {
    if (sensor.io.read('buffer/enable') === '1') { active = true; break; }
    await delay(100);
  }
  assert.equal(active, true, 'Recorder never activated');
  assert.deepEqual(events(), wake, 'Wake attributes changed during acquisition');
  run('systemctl', ['kill', '--signal=KILL', '--kill-whom=main', 'airmouse-crash.service']);
  for (let i = 0; i < 50 && fs.existsSync(`${base}/state/sensor-journal.json`); i++) await delay(100);
  assert.deepEqual(sensor.snapshot(), baseline);
  assert.deepEqual(events(), wake);
  assert.equal(fs.existsSync(`${base}/state/sensor-journal.json`), false);
  console.log(JSON.stringify({ killed_active_recorder: true, stop_hook_restored_baseline: true, wake_attributes_unchanged: true }));
} finally {
  try { run('systemctl', ['stop', 'airmouse-crash.service']); } catch {}
  sensor.restore();
}
