import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { StatusSnapshot } from '../runtime/status.mjs';
import { fakeSensor } from './helpers.mjs';

test('slow diagnostic storage retains only the newest pending state and never blocks publication', async () => {
  const writes = [], renames = [];
  let finish;
  const snapshot = new StatusSnapshot('/status.json', {
    write: (file, content) => {
      writes.push(JSON.parse(content));
      return new Promise(resolve => { finish = resolve; });
    },
    rename: async (...args) => { renames.push(args); },
  });
  snapshot.publish({ pointer: true, sequence: 0 });
  for (let i = 1; i <= 800; i++) snapshot.publish({ pointer: i < 800, sequence: i });
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(snapshot.pending), { pointer: false, sequence: 800 });
  finish(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(writes, [{ pointer: true, sequence: 0 }, { pointer: false, sequence: 800 }]);
  finish(); await snapshot.flush();
  assert.equal(renames.length, 2);
  assert.equal(snapshot.running, null);
});

test('status is atomically replaced with the final stopped state', async t => {
  const { dir } = fakeSensor(t);
  const snapshot = new StatusSnapshot(`${dir}/status.json`);
  snapshot.publish({ pointer: true });
  snapshot.publish({ pointer: false });
  await snapshot.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(`${dir}/status.json`, 'utf8')), { pointer: false });
  assert.equal(fs.statSync(`${dir}/status.json`).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${dir}/status.json.tmp`), false);
});
