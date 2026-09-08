const norm = v => Math.hypot(...v);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class MotionFilter {
  constructor({ sensitivity = 900, deadband = 0.012, smoothingMs = 18, bias = [0, 0, 0], generation = 0, forwardAxis = [1, 0, 0] } = {}) {
    Object.assign(this, { sensitivity, deadband, smoothingMs, bias, generation, forwardAxis });
    this.reset();
  }
  reset() { this.last = null; this.filtered = [0, 0]; this.remainder = [0, 0]; this.gravity = null; }
  step(sample) {
    if (sample.generation !== this.generation) return null;
    if (![sample.time, ...sample.gyro, ...sample.accel].every(Number.isFinite)) { this.reset(); return null; }
    const dt = this.last === null ? 0 : sample.time - this.last;
    if (dt <= 0 || dt > 0.05) { this.reset(); this.last = sample.time; return null; }
    this.last = sample.time;
    const length = norm(sample.accel);
    if (length > 7 && length < 12) {
      const alpha = 1 - Math.exp(-dt / 0.3);
      const direction = sample.accel.map(v => v / length);
      this.gravity = this.gravity ? this.gravity.map((v, i) => v + alpha * (direction[i] - v)) : direction;
    }
    if (!this.gravity) return null;
    const up = this.gravity.map(v => -v / norm(this.gravity));
    const right = cross(this.forwardAxis, up);
    const rightLength = norm(right);
    if (rightLength < 0.2) { this.remainder = [0, 0]; return null; }
    const pitch = right.map(v => v / rightLength);
    const gyro = sample.gyro.map((v, i) => v - this.bias[i]);
    const raw = [dot(gyro, up), -dot(gyro, pitch)];
    const alpha = 1 - Math.exp(-dt / (this.smoothingMs / 1000));
    this.filtered = this.filtered.map((v, i) => v + alpha * (raw[i] - v));
    const delta = this.filtered.map((v, i) => {
      const velocity = Math.abs(v) <= this.deadband ? 0 : v - Math.sign(v) * this.deadband;
      const counts = velocity * dt * this.sensitivity + this.remainder[i];
      const integer = Math.trunc(counts);
      this.remainder[i] = counts - integer;
      return integer;
    });
    return { generation: this.generation, time: sample.time, dx: delta[0], dy: delta[1] };
  }
}

export function calibrate(samples) {
  if (samples.length < 50 || samples.at(-1).time - samples[0].time < 1) throw new Error('Calibration needs one second of samples');
  const mean = [0, 1, 2].map(i => samples.reduce((sum, s) => sum + s.gyro[i], 0) / samples.length);
  if (norm(mean) > 0.08) throw new Error('Keep the remote still during calibration');
  for (const s of samples) {
    if (![s.time, ...s.gyro, ...s.accel].every(Number.isFinite) || Math.abs(norm(s.accel) - 9.80665) > 0.6 || norm(s.gyro.map((v, i) => v - mean[i])) > 0.025) throw new Error('Keep the remote still during calibration');
  }
  return mean;
}
