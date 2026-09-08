import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Sensor, supportedGyroRanges } from './sensor.mjs';

const [stateDir, rateText = '50', durationText = '3', rangeMode = '500', output] = process.argv.slice(2);
const rate = Number(rateText), duration = Number(durationText);
if (!stateDir || ![50, 100, 200, 400, 800, 1600].includes(rate) || !(duration > 0 && duration <= 10)) throw new Error('Usage: record.mjs STATE_DIR RATE SECONDS[<=10] [500|2000|keep-range] [OUTPUT]');
const sensor = new Sensor({ stateDir });
sensor.restore();
const baseline = sensor.snapshot();
let samples = [], failure;
const arrivalAges = [], batches = [], callbackGaps = [], attributeTimes = {};
const readTimes = [];
const loopDelay = monitorEventLoopDelay({ resolution: 2 });
const readSync = fs.readSync;
fs.readSync = (...args) => {
  const start = performance.now();
  try { return readSync(...args); }
  finally { if (measuring && args[0] === sensor.fd && readTimes.length < 10000) readTimes.push(performance.now() - start); }
};
let lastArrival, measuring = false;
const read = sensor.io.read;
sensor.io.read = key => {
  const start = performance.now();
  const value = read(key);
  if (measuring) {
    const times = attributeTimes[key] ??= [];
    if (times.length < 1000) times.push(performance.now() - start);
  }
  return value;
};
const readAsync = sensor.io.readAsync;
sensor.io.readAsync = async key => {
  const start = performance.now();
  const value = await readAsync(key);
  if (measuring) {
    const times = attributeTimes[key] ??= [];
    if (times.length < 1000) times.push(performance.now() - start);
  }
  return value;
};
let finish;
const done = new Promise(resolve => { finish = resolve; });
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { failure = new Error(sig); finish(); });
try {
  if (rangeMode !== 'keep-range' && !supportedGyroRanges.includes(Number(rangeMode))) throw new Error('Invalid range mode');
  sensor.begin(rate, rangeMode === 'keep-range' ? null : Number(rangeMode));
  measuring = true;
  loopDelay.enable();
  sensor.start(1, batch => {
    if (samples.length >= rate * 12) { failure = new Error('Capture limit'); finish(); return; }
    const arrival = Number(process.hrtime.bigint()) / 1e9;
    if (lastArrival !== undefined) callbackGaps.push((arrival - lastArrival) * 1000);
    lastArrival = arrival;
    batches.push(batch.length);
    for (const sample of batch) arrivalAges.push((arrival - sample.time) * 1000);
    samples.push(...batch);
  }, error => { failure = error; finish(); });
  const timeout = setTimeout(finish, duration * 1000);
  await done;
  clearTimeout(timeout);
} finally { measuring = false; fs.readSync = readSync; loopDelay.disable(); sensor.restore(); }
if (failure) throw failure;
if (samples.length < 2) throw new Error('No usable samples');
const gaps = samples.slice(1).map((s, i) => (s.time - samples[i].time) * 1000).sort((a, b) => a - b);
const percentile = p => gaps[Math.floor((gaps.length - 1) * p)];
const gyroMean = [0, 1, 2].map(i => samples.reduce((sum, s) => sum + s.gyro[i], 0) / samples.length);
if (output) fs.writeFileSync(output, samples.map(s => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0], p50: sorted[Math.floor((sorted.length - 1) * 0.5)], p95: sorted[Math.floor((sorted.length - 1) * 0.95)], max: sorted.at(-1) };
};
console.log(JSON.stringify({ requested_hz: rate, samples: samples.length, actual_hz: (samples.length - 1) / (samples.at(-1).time - samples[0].time), gap_ms: { min: gaps[0], p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: gaps.at(-1) }, delivery: { sample_age_ms: summary(arrivalAges), callback_gap_ms: summary(callbackGaps), batch_size: summary(batches), device_read_ms: summary(readTimes), event_loop_delay_ms: { p50: loopDelay.percentile(50) / 1e6, p95: loopDelay.percentile(95) / 1e6, max: loopDelay.max / 1e6 }, samples_older_than_75_ms: arrivalAges.filter(age => age > 75).length, future_samples_over_5_ms: arrivalAges.filter(age => age < -5).length, attribute_read_ms: Object.fromEntries(Object.entries(attributeTimes).map(([key, times]) => [key, summary(times)])) }, gyro_mean_rad_s: gyroMean, restored: JSON.stringify(baseline) === JSON.stringify(sensor.snapshot()) }, null, 2));
