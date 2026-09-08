import fs from 'node:fs';
import path from 'node:path';
import { readText, readJSON, saveJSON, equalSetting } from './storage.mjs';

const channels = ['accel_x', 'accel_y', 'accel_z', 'anglvel_x', 'anglvel_y', 'anglvel_z', 'timestamp'];
export const supportedGyroRanges = [500, 2000];
export const ownedSettings = [
  'buffer/enable', 'buffer/length', 'buffer/watermark', 'current_timestamp_clock',
  'in_accel_sampling_frequency', 'in_anglvel_sampling_frequency', 'in_anglvel_scale',
  'trigger/current_trigger',
  ...channels.map(c => `scan_elements/in_${c}_en`),
];

export class Sensor {
  constructor({ stateDir, sysfs, device, io, bootID } = {}) {
    this.root = sysfs ?? Sensor.discover();
    this.device = device ?? `/dev/${path.basename(this.root)}`;
    this.journalFile = path.join(stateDir, 'sensor-journal.json');
    this.bootID = bootID ?? readText('/proc/sys/kernel/random/boot_id');
    this.io = io ?? {
      read: key => readText(path.join(this.root, key)),
      readAsync: async key => (await fs.promises.readFile(path.join(this.root, key), 'utf8')).trim(),
      write: (key, value) => fs.writeFileSync(path.join(this.root, key), `${value}\n`),
    };
    this.identity = { name: this.io.read('name'), path: fs.realpathSync(this.root) };
    if (this.identity.name !== 'bmi323-imu') throw new Error('Unsupported sensor');
    this.fd = null;
    this.timer = null;
    this.record = null;
  }

  static discover() {
    const base = '/sys/bus/iio/devices';
    const found = fs.readdirSync(base).filter(n => /^iio:device\d+$/.test(n) && readText(`${base}/${n}/name`) === 'bmi323-imu');
    if (found.length !== 1) throw new Error('Expected one BMI323 sensor');
    return path.join(base, found[0]);
  }

  rates(candidates) {
    const available = sensor => this.io.read(`in_${sensor}_sampling_frequency_available`).split(/\s+/).map(Number);
    return candidates.filter(rate => available('accel').includes(rate) && available('anglvel').includes(rate));
  }

  snapshot() { return Object.fromEntries(ownedSettings.map(key => [key, this.io.read(key)])); }

  write(key, value) {
    value = String(value);
    const current = this.io.read(key);
    if (equalSetting(current, value)) return;
    const entry = this.record.values[key];
    if (!entry.allowed.some(v => equalSetting(v, current))) throw new Error(`Sensor ownership lost: ${key}`);
    if (!entry.allowed.includes(value)) entry.allowed.push(value);
    saveJSON(this.journalFile, this.record);
    try { this.io.write(key, value); }
    catch (error) { throw new Error(`Sensor write failed: ${key}: ${error.code ?? error.message}`); }
    if (!equalSetting(this.io.read(key), value)) throw new Error(`Sensor readback failed: ${key}`);
  }

  begin(rate, range = 500) {
    if (this.recoveryFailed || (this.record && this.record.bootID !== this.bootID)) throw new Error('Sensor recovery required before activation');
    if (!this.rates([rate]).length || (range !== null && !supportedGyroRanges.includes(range))) throw new Error('Unsupported sensor profile');
    const scale = range === null ? Number(this.io.read('in_anglvel_scale')) : (range * Math.PI / 180) / 32768;
    const scales = this.io.read('in_anglvel_scale_available').split(/\s+/);
    const selectedScale = scales.find(s => Math.abs(Number(s) - scale) < 0.000001);
    if (!selectedScale) throw new Error(`Gyro range unavailable: ${range ?? 'current'} degrees/second`);
    if (!this.record) {
      if (fs.existsSync(this.journalFile)) throw new Error('Sensor recovery required');
      if (this.io.read('buffer/enable') !== '0') throw new Error('Sensor buffer already owned');
      const baseline = this.snapshot();
      this.record = {
        version: 1, identity: this.identity, bootID: this.bootID,
        values: Object.fromEntries(Object.entries(baseline).map(([k, v]) => [k, { baseline: v, allowed: [v] }])),
      };
      saveJSON(this.journalFile, this.record);
    }
    try {
      this.pause();
      this.write('trigger/current_trigger', '');
      this.write('in_accel_sampling_frequency', rate);
      this.write('in_anglvel_sampling_frequency', rate);
      if (range !== null) this.write('in_anglvel_scale', selectedScale);
      this.write('current_timestamp_clock', 'monotonic');
      for (const channel of channels) this.write(`scan_elements/in_${channel}_en`, '1');
      this.write('buffer/length', '64');
      this.write('buffer/watermark', '1');
      this.layout = this.readLayout();
      this.accelScale = Number(this.io.read('in_accel_scale'));
      this.gyroScale = Number(this.io.read('in_anglvel_scale'));
      this.rate = rate;
      this.write('buffer/enable', '1');
      if (this.io.read('buffer/hwfifo_enabled') !== '1') throw new Error('Sensor FIFO did not enable');
    } catch (error) {
      try { this.restore(); } catch (restoreError) { throw new AggregateError([error, restoreError], 'Sensor activation and restoration failed'); }
      throw error;
    }
  }

  readLayout() {
    const fields = channels.map(name => {
      const type = this.io.read(`scan_elements/in_${name}_type`);
      const expected = name === 'timestamp' ? 'le:s64/64>>0' : 'le:s16/16>>0';
      if (type !== expected) throw new Error(`Unsupported scan layout: ${name}`);
      return { name, index: Number(this.io.read(`scan_elements/in_${name}_index`)), size: name === 'timestamp' ? 8 : 2 };
    }).sort((a, b) => a.index - b.index);
    if (new Set(fields.map(f => f.index)).size !== fields.length) throw new Error('Duplicate scan index');
    let bytes = 0;
    for (const field of fields) { bytes = Math.ceil(bytes / field.size) * field.size; field.offset = bytes; bytes += field.size; }
    return { fields, bytes: Math.ceil(bytes / 8) * 8 };
  }

  decode(buffer, generation) {
    const samples = [];
    if (buffer.length % this.layout.bytes) throw new Error('Incomplete IIO scan');
    for (let base = 0; base < buffer.length; base += this.layout.bytes) {
      const raw = Object.fromEntries(this.layout.fields.map(f => [f.name, f.size === 8 ? Number(buffer.readBigInt64LE(base + f.offset)) / 1e9 : buffer.readInt16LE(base + f.offset)]));
      samples.push({ generation, time: raw.timestamp, gyro: ['x', 'y', 'z'].map(a => raw[`anglvel_${a}`] * this.gyroScale), accel: ['x', 'y', 'z'].map(a => raw[`accel_${a}`] * this.accelScale) });
    }
    return samples;
  }

  start(generation, onSamples, onError) {
    if (!this.record || this.fd !== null) throw new Error('Invalid acquisition state');
    this.fd = fs.openSync(this.device, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const buffer = Buffer.alloc(this.layout.bytes * 64);
    this.lastData = performance.now();
    this.lastCheck = 0;
    const reader = this.reader = { checking: false };
    this.timer = setInterval(() => {
      try {
        const now = performance.now();
        if (reader.checking && now - reader.checkStarted > 500) throw new Error('Sensor health check stalled');
        if (!reader.checking && now - this.lastCheck > 250) {
          this.lastCheck = now;
          reader.checking = true; reader.checkStarted = now;
          this.checkAcquisition(reader).catch(error => {
            if (this.reader === reader) { this.closeReader(); onError(error); }
          }).finally(() => { reader.checking = false; });
        }
        let count;
        try { count = fs.readSync(this.fd, buffer, 0, buffer.length, null); }
        catch (error) { if (error.code !== 'EAGAIN') throw error; count = 0; }
        if (count) { this.lastData = now; onSamples(this.decode(buffer.subarray(0, count), generation)); }
        if (now - this.lastData > 250) throw new Error('Sensor stalled');
      } catch (error) { this.closeReader(); onError(error); }
    }, 2);
  }

  async checkAcquisition(reader) {
    const expected = {
      in_accel_sampling_frequency: String(this.rate), in_anglvel_sampling_frequency: String(this.rate),
      'buffer/enable': '1', current_timestamp_clock: 'monotonic',
      'trigger/current_trigger': '', 'buffer/hwfifo_enabled': '1',
    };
    for (const [key, value] of Object.entries(expected)) {
      const actual = await this.io.readAsync(key);
      if (this.reader !== reader) return;
      if (!equalSetting(actual, value)) throw new Error(`Acquisition changed externally: ${key}`);
    }
  }

  closeReader() {
    this.reader = null;
    clearInterval(this.timer); this.timer = null;
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
  }

  pause() {
    this.closeReader();
    if (this.record) this.write('buffer/enable', '0');
  }

  restore() {
    try { this.restoreBaseline(); this.recoveryFailed = false; }
    catch (error) { this.recoveryFailed = true; throw error; }
  }

  restoreBaseline() {
    this.closeReader();
    if (!this.record) {
      if (!fs.existsSync(this.journalFile)) return;
      this.record = readJSON(this.journalFile);
    }
    const r = this.record;
    const keys = Object.keys(r.values).sort();
    const validKeys = [ownedSettings, ownedSettings.filter(k => k !== 'trigger/current_trigger')];
    if (r.version !== 1 || JSON.stringify(r.identity) !== JSON.stringify(this.identity) || !validKeys.some(set => [...set].sort().join() === keys.join())) throw new Error('Recovery identity mismatch');
    if (r.bootID !== this.bootID) throw new Error('Recovery from earlier boot requires inspection of firmware sensor settings');
    const conflicts = keys.filter(k => !r.values[k].allowed.some(v => equalSetting(v, this.io.read(k))));
    if (conflicts.length) throw new Error(`Recovery blocked by external sensor changes: ${conflicts.join(', ')}`);
    this.write('buffer/enable', '0');
    for (const key of ownedSettings.filter(k => k !== 'buffer/enable' && r.values[k])) this.write(key, r.values[key].baseline);
    this.write('buffer/enable', r.values['buffer/enable'].baseline);
    fs.unlinkSync(this.journalFile);
    this.record = null;
  }
}
