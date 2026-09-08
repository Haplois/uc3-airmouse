import net from 'node:net';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BluetoothJournal } from './bluetooth-journal.mjs';

const firmwareHash = '8cc84d484e1fd30514d276d234c5e339c28ea92f4fda14fe75092d3263913930';

export function connectionFromJournal(text, profile, peer, { allowDisconnected = false } = {}) {
  const addresses = new Map();
  let handle, parameters;
  for (const line of text.split('\n')) {
    let match = /New connection: handle (\d+), ([0-9A-F:]{17})/i.exec(line);
    if (match) addresses.set(Number(match[1]), match[2].toUpperCase());
    match = /\[(\d+)\] (connected|disconnected) \(0x([\da-f]+)\)/i.exec(line);
    if (match && Number(match[1]) === profile) {
      handle = match[2] === 'connected' ? parseInt(match[3], 16) : undefined;
      parameters = undefined;
    }
    match = /\[(\d+)\] conn params: interval=(\d+) latency=(\d+) timeout=(\d+)/.exec(line);
    if (match && Number(match[1]) === profile) parameters = { interval: Number(match[2]), latency: Number(match[3]), timeout: Number(match[4]) };
  }
  if (allowDisconnected && (handle === undefined || addresses.has(handle) && addresses.get(handle) !== peer.toUpperCase())) return null;
  if (handle === undefined || addresses.get(handle) !== peer.toUpperCase() || !parameters) throw new Error('Bluetooth connection identity or timing unavailable');
  return { handle, ...parameters };
}

export function hciCommand(opcode, parameters) {
  const frame = Buffer.alloc(9 + parameters.length);
  frame.writeUInt16LE(1, 0);
  frame.writeUInt16LE(3 + parameters.length, 4);
  frame.writeUInt16LE(opcode, 6);
  frame[8] = parameters.length;
  parameters.copy(frame, 9);
  return frame;
}

export function updateParameters(handle, interval, latency, timeout) {
  if (![handle, interval, latency, timeout].every(Number.isInteger) || handle < 0 || handle > 0xeff || interval < 6 || interval > 3200 || latency < 0 || latency > 499 || timeout < 10 || timeout > 3200 || timeout * 10 <= (1 + latency) * interval * 2.5) throw new Error('Invalid Bluetooth connection parameters');
  const parameters = Buffer.alloc(14);
  [handle, interval, interval, latency, timeout].forEach((v, i) => parameters.writeUInt16LE(v, i * 2));
  return parameters;
}

export function exchange(opcode, parameters, accept, socketFactory = () => net.createConnection({ host: '127.0.0.1', port: 13333 })) {
  return new Promise((resolve, reject) => {
    const socket = socketFactory();
    let data = Buffer.alloc(0), finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Bluetooth connection update timed out')), 2500);
    socket.setNoDelay(true);
    socket.on('connect', () => socket.write(hciCommand(opcode, parameters)));
    socket.on('error', () => finish(new Error('Bluetooth daemon unavailable')));
    socket.on('close', () => finish(new Error('Bluetooth daemon disconnected')));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      try {
        while (data.length >= 6) {
          const size = data.readUInt16LE(4);
          if (size > 4096) throw new Error('Invalid Bluetooth daemon frame');
          if (data.length < size + 6) break;
          const type = data.readUInt16LE(0), event = data.subarray(6, size + 6);
          data = data.subarray(size + 6);
          if (type !== 4 || event.length < 2) continue;
          if (event[0] === 0x0f && event.length >= 6 && event.readUInt16LE(4) === opcode && event[2]) throw new Error(`Bluetooth command rejected (${event[2]})`);
          const value = accept(event);
          if (value !== undefined) { finish(null, value); return; }
        }
      } catch (error) { finish(error); }
    });
  });
}

export class BluetoothLink {
  constructor({ stateDir, journal, command = exchange, verify = async () => {
    const binary = await fs.readFile('/opt/uc/bt/hog_keyboard');
    if (createHash('sha256').update(binary).digest('hex') !== firmwareHash) throw new Error('Bluetooth timing adapter requires verification on this firmware');
  } } = {}) {
    const index = new BluetoothJournal(stateDir);
    this.journal = journal ?? (() => index.read()); this.command = command; this.verify = verify; this.active = null;
    this.queue = Promise.resolve();
  }

  serialize(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  acquire(target) {
    return this.serialize(async () => {
      await this.restore();
      return this.negotiate(target);
    });
  }

  async negotiate(target) {
    const match = /^uc_bt\.main\.profile([1-9]\d*)$/.exec(target.id);
    if (!match || !/^[\dA-F]{2}(?::[\dA-F]{2}){5}$/i.test(target.peer ?? '')) throw new Error('Unsupported Bluetooth target identity');
    await this.verify();
    const profile = Number(match[1]);
    const previous = connectionFromJournal(await this.journal(), profile, target.peer);
    const parameters = Buffer.alloc(2); parameters.writeUInt16LE(previous.handle);
    await this.command(0x1405, parameters, event => {
      if (event[0] !== 0x0e || event.length < 9 || event.readUInt16LE(3) !== 0x1405 || event.readUInt16LE(6) !== previous.handle) return;
      if (event[5]) throw new Error('Bluetooth connection no longer exists');
      return true;
    });
    // Re-read after the live-handle check so a journalled disconnect invalidates it.
    const current = connectionFromJournal(await this.journal(), profile, target.peer);
    if (current.handle !== previous.handle) throw new Error('Bluetooth connection changed');
    const actual = await this.update(current.handle, 6, 0, current.timeout);
    this.active = { profile, peer: target.peer, previous: current, ...actual };
    if (actual.interval !== 6 || actual.latency !== 0) throw new Error('Bluetooth host did not accept the fast connection interval');
    return this.active;
  }

  async update(handle, interval, latency, timeout) {
    return this.command(0x2013, updateParameters(handle, interval, latency, timeout), event => {
      if (event[0] !== 0x3e || event.length < 12 || event[2] !== 3 || event.readUInt16LE(4) !== handle) return;
      if (event[3]) throw new Error(`Bluetooth connection update rejected (${event[3]})`);
      return { handle, interval: event.readUInt16LE(6), latency: event.readUInt16LE(8), timeout: event.readUInt16LE(10) };
    });
  }

  release() {
    return this.serialize(() => this.restore());
  }

  async restore() {
    const active = this.active;
    if (!active) return;
    if (['interval', 'latency', 'timeout'].every(key => active.previous[key] === active[key])) { this.active = null; return; }
    const journal = await this.journal();
    const current = connectionFromJournal(journal, active.profile, active.peer, { allowDisconnected: true });
    if (!current || ['handle', 'interval', 'latency', 'timeout'].some(key => current[key] !== active[key])) { this.active = null; return; }
    await this.update(active.handle, active.previous.interval, active.previous.latency, active.previous.timeout);
    this.active = null;
  }

  async check() {
    const active = this.active;
    if (!active) return;
    const current = connectionFromJournal(await this.journal(), active.profile, active.peer);
    if (this.active !== active) return;
    if (current.handle !== active.handle || current.interval !== 6 || current.latency !== 0 || current.timeout !== active.timeout) throw new Error('Bluetooth fast connection interval or ownership was lost');
  }

  metrics() { return this.active ? { connection_interval_ms: this.active.interval * 1.25, peripheral_latency: this.active.latency, host_report_rate_hz: 'unmeasured' } : null; }
}
