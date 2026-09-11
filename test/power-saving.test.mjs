import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionActivity, StandbyLease } from '../runtime/power-saving.mjs';

test('motion detection rejects calibrated noise and detects rotation or pickup', () => {
  const activity = new MotionActivity([.01, -.02, .005]);
  for (let i = 0; i < 1000; i++) assert.equal(activity.moving({ gyro: [.011, -.019, .004], accel: [0, 0, 9.81] }), false);
  assert.equal(activity.moving({ gyro: [.06, -.02, .005], accel: [0, 0, 9.81] }), true);
  assert.equal(activity.moving({ gyro: [.01, -.02, .005], accel: [0, 2, 9.81] }), true);
});

test('standby leases expire, renew before removal, and delete only their own ids', async () => {
  const calls = []; let next = 0;
  const lease = new StandbyLease({ request: async (path, method, body) => { calls.push({ path, method, body }); return method === 'POST' ? { id: `lease-${++next}` } : {}; } });
  lease.update(true); await lease.queue;
  assert.equal(calls[0].body.delay, 15);
  await lease.refresh();
  assert.deepEqual(calls.map(call => [call.path, call.method]), [['', 'POST'], ['', 'POST'], ['/lease-1', 'DELETE']]);
  await lease.close();
  assert.equal(calls.at(-1).path, '/lease-2');
  assert.equal(lease.timer, null);
});

test('stopping while lease creation is in flight removes the returned lease', async () => {
  let complete; const deleted = [];
  const lease = new StandbyLease({ request: async (path, method) => {
    if (method === 'POST') return new Promise(resolve => { complete = resolve; });
    deleted.push(path); return {};
  } });
  lease.update(true); await Promise.resolve();
  lease.update(false); complete({ id: 'owned' }); await lease.close();
  assert.deepEqual(deleted, ['/owned']);
});
