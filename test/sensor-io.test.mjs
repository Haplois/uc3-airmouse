import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

test('native readiness adapter delivers bytes, closes inside callbacks, and rejects foreign wake inputs', async t => {
  const binary = execFileSync('python3', ['tools/airmouse-sensor-io-build', '--arch', 'host'], { encoding: 'utf8' }).trim();
  const io = createRequire(import.meta.url)(binary);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airmouse-io-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fifo = path.join(dir, 'data'); execFileSync('mkfifo', [fifo]);
  const writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  t.after(() => fs.closeSync(writer));
  assert.throws(() => io.watch(fifo, true, true, () => {}), /BMI323/);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No readiness callback')), 1000);
    const handle = io.watch(fifo, false, false, (error, bytes) => {
      clearTimeout(timeout); io.close(handle); io.close(handle);
      try { assert.equal(error, null); assert.equal(bytes.toString(), 'sensor sample'); resolve(); } catch (error) { reject(error); }
    });
    fs.writeSync(writer, 'sensor sample');
  });
});
