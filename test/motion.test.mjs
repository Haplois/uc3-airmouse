import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionFilter, calibrate } from '../runtime/motion.mjs';
import fs from 'node:fs';

const sample = (time, gyro = [0, 0, 0], generation = 1) => ({ time, gyro, accel: [0, 0, -9.80665], generation });
const replay = (hz, gyro) => {
  const filter = new MotionFilter({ generation: 1 });
  let dx = 0, dy = 0;
  for (let i = 0; i <= hz; i++) { const d = filter.step(sample(1 + i / hz, gyro)); if (d) { dx += d.dx; dy += d.dy; } }
  return { dx, dy };
};

test('stationary noise and bias produce no counts at every supported rate', () => {
  for (const hz of [50, 100, 200, 400, 800]) assert.deepEqual(replay(hz, [0.002, -0.003, 0.002]), { dx: 0, dy: 0 });
});
test('horizontal direction follows the corrected hand mapping without vertical motion', () => {
  const right = replay(800, [0, 0, 0.2]);
  const left = replay(800, [0, 0, -0.2]);
  assert.ok(right.dx > 160, `Right movement produced ${right.dx} counts`);
  assert.equal(left.dx, -right.dx);
  assert.equal(right.dy, 0); assert.equal(left.dy, 0);
});
test('recorded tip-up and tip-down motion primarily moves vertically in the labeled direction', () => {
  const { samples } = JSON.parse(fs.readFileSync(new URL('./fixtures/pitch-motion.json', import.meta.url)));
  const filter = new MotionFilter({ generation: 1 });
  let horizontal = 0, vertical = 0, up = 0, down = 0;
  for (const sample of samples) {
    const delta = filter.step(sample);
    if (!delta) continue;
    horizontal += Math.abs(delta.dx); vertical += Math.abs(delta.dy);
    const elapsed = sample.time - 1;
    if (elapsed >= 3 && elapsed < 4) up += delta.dy;
    if (elapsed >= 4.5 && elapsed < 6.5) down += delta.dy;
  }
  assert.ok(vertical > horizontal * 5, `Vertical ${vertical}, horizontal ${horizontal}`);
  assert.ok(up < -500, `Up stroke produced ${up}`);
  assert.ok(down > 500, `Down stroke produced ${down}`);
});
test('pitch direction survives wrist roll and a tilted pointing pose', () => {
  for (const tilt of [-Math.PI / 3, 0, Math.PI / 3]) {
    for (const roll of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
      const rotate = ([x, y, z]) => [x, y * Math.cos(roll) - z * Math.sin(roll), y * Math.sin(roll) + z * Math.cos(roll)];
      const gyro = rotate([0, -0.2, 0]);
      const accel = rotate([-9.80665 * Math.sin(tilt), 0, -9.80665 * Math.cos(tilt)]);
      const filter = new MotionFilter({ generation: 1 });
      let dx = 0, dy = 0;
      for (let i = 0; i <= 800; i++) {
        const d = filter.step({ time: 1 + i / 800, gyro, accel, generation: 1 });
        if (d) { dx += d.dx; dy += d.dy; }
      }
      assert.equal(dx, 0); assert.ok(dy < -160, `Tilt ${tilt}, roll ${roll}: ${dy}`);
    }
  }
});
test('deterministic diagonal replay is nearly sampling-rate independent', () => {
  const reference = replay(400, [0, 0.2, 0.2]);
  assert.ok(reference.dx > 160 && reference.dy > 160);
  assert.equal(reference.dx, reference.dy);
  for (const hz of [50, 100, 200, 800]) assert.ok(Math.abs(replay(hz, [0, 0.2, 0.2]).dx - reference.dx) <= 2);
});
test('sample generation, backward time and gaps cannot inject movement', () => {
  const filter = new MotionFilter({ generation: 1 });
  assert.equal(filter.step(sample(1, [0, 0, 100], 0)), null);
  assert.equal(filter.step(sample(1)), null);
  assert.equal(filter.step(sample(1.1, [0, 0, 100])), null);
  assert.equal(filter.step(sample(1.05, [0, 0, 100])), null);
  assert.deepEqual(filter.step(sample(1.06)), { generation: 1, time: 1.06, dx: 0, dy: 0 });
});
test('calibration rejects moving recordings and accepts stationary bias', () => {
  const samples = Array.from({ length: 401 }, (_, i) => sample(1 + i / 400, [0.002, -0.003, 0]));
  const bias = calibrate(samples); assert.ok(Math.abs(bias[0] - 0.002) < 1e-10);
  samples[100].gyro[0] = 0.2;
  assert.throws(() => calibrate(samples), /Keep the remote still/);
});
