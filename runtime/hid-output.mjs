import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { validateOutputRate } from './output-rate.mjs';
import { targetProfile, arrowKeys, lgKeys, lgMediaKeys } from './target-profile.mjs';

const targetID = 'airmouse.host';
const requiredStateKeys = ['active', 'buttons', 'dropped_motion', 'error', 'interval_ms', 'paired', 'pairing', 'ready', 'reports_sent'];
const optionalStateKeys = new Set(['connected', 'working']);
const requiredV2StateKeys = [...requiredStateKeys, 'connected', 'connected_device', 'devices', 'host_limit', 'selected', 'working'];
const peerPattern = /^[0-9a-f]{8}$/;
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/u;

function validDaemonState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!requiredStateKeys.every(key => Object.hasOwn(value, key))) return false;
  if (keys.some(key => !requiredStateKeys.includes(key) && !optionalStateKeys.has(key))) return false;
  if (!['ready', 'paired', 'pairing', 'active'].every(key => typeof value[key] === 'boolean')) return false;
  if ([...optionalStateKeys].some(key => Object.hasOwn(value, key) && typeof value[key] !== 'boolean')) return false;
  if (!Number.isInteger(value.buttons) || value.buttons < 0 || value.buttons > 3) return false;
  if (value.interval_ms !== null && (!Number.isFinite(value.interval_ms) || value.interval_ms < 0)) return false;
  if (!['reports_sent', 'dropped_motion'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return false;
  return typeof value.error === 'string';
}

function validName(value, { empty = true } = {}) {
  return typeof value === 'string' && (empty || value.length > 0) && value.isWellFormed()
    && !controlPattern.test(value) && Buffer.byteLength(value, 'utf8') <= 48;
}

function validV2DaemonState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(',') !== [...requiredV2StateKeys].sort().join(',')) return false;
  if (!['ready', 'paired', 'pairing', 'active', 'connected', 'working'].every(key => typeof value[key] === 'boolean')) return false;
  if (!Number.isInteger(value.buttons) || value.buttons < 0 || value.buttons > 3) return false;
  if (value.interval_ms !== null && (!Number.isFinite(value.interval_ms) || value.interval_ms < 0)) return false;
  if (!['reports_sent', 'dropped_motion'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return false;
  if (typeof value.error !== 'string' || !validName(value.selected) || !validName(value.connected_device)) return false;
  if ((value.selected && !peerPattern.test(value.selected)) || (value.connected_device && !peerPattern.test(value.connected_device))) return false;
  if (value.host_limit !== 4 || !Array.isArray(value.devices) || value.devices.length > value.host_limit) return false;
  const ids = new Set();
  for (const device of value.devices) {
    if (!device || typeof device !== 'object' || Array.isArray(device)
        || Object.keys(device).sort().join(',') !== 'bluetooth_name,custom_name,id,legacy,name'
        || !peerPattern.test(device.id) || ids.has(device.id) || typeof device.legacy !== 'boolean'
        || !validName(device.name, { empty: false }) || !validName(device.bluetooth_name) || !validName(device.custom_name)) return false;
    const resolved = device.custom_name || device.bluetooth_name;
    if ((resolved && device.name !== resolved) || (!resolved && !/^Computer [1-9][0-9]*$/.test(device.name))) return false;
    ids.add(device.id);
  }
  if ((value.selected && !ids.has(value.selected)) || (value.connected_device && !ids.has(value.connected_device))) return false;
  if (value.paired !== (value.devices.length > 0)) return false;
  if (value.ready && (!value.working || !value.selected || value.connected_device !== value.selected || value.pairing || !value.connected)) return false;
  if (value.active && !value.ready) return false;
  return true;
}

function requirePeer(value) {
  if (typeof value !== 'string' || !peerPattern.test(value)) throw new Error('Invalid Bluetooth device ID');
  return value;
}

export class HidOutput {
  constructor({
    socketPath = '/run/airmouse-bt/control.sock',
    socketFactory = path => net.createConnection(path),
    onState = () => {}, onStop = () => {}, movementRateHz = 80,
    clock = () => Number(process.hrtime.bigint()) / 1e6,
    heartbeatMs = 250, requestTimeoutMs = 1500, metadataRequestTimeoutMs = 5000, retryMs = 1000,
  } = {}) {
    validateOutputRate(movementRateHz);
    Object.assign(this, { socketPath, socketFactory, onState, onStop, clock, heartbeatMs, requestTimeoutMs, metadataRequestTimeoutMs, retryMs });
    this.backend = 'owned'; this.buttonEdges = true; this.defaultTarget = targetID;
    this.protocolVersion = 1; this.deviceManagement = false; this.hostLimit = 1; this.selectedTarget = targetID; this.connectedDevice = '';
    this.targets = [{ id: targetID, name: 'Paired computer', ready: false, connected: false, legacy: true }];
    this.connected = false; this.paired = false; this.pairing = false; this.active = false; this.buttons = 0;
    this.daemon = { ready: false, paired: false, pairing: false, active: false, buttons: 0, interval_ms: null, reports_sent: 0, dropped_motion: 0, error: '' };
    this.endpoint = null; this.sessionTarget = null; this.generation = 0; this.desiredButtons = 0; this.sessionMayBeActive = false;
    this.pendingRequests = new Map(); this.ignoredResponses = new Set(); this.nextID = 1; this.buffer = Buffer.alloc(0); this.closed = false; this.started = false;
    this.movementRateHz = movementRateHz; this.movementIntervalMs = 1000 / movementRateHz;
    this.lgSamples = []; this.lastLgSample = -Infinity; this.lastLgBucket = -Infinity;
    this.pendingMovement = null; this.lastMovement = -Infinity; this.nextMovement = -Infinity; this.pace = null;
    this.sentMovement = 0; this.dropped = 0; this.uncertain = false; this.quiescing = null;
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.connect();
  }

  connect() {
    if (this.closed || this.socket) return;
    let socket;
    try { socket = this.socketFactory(this.socketPath); }
    catch { this.scheduleRetry(); return; }
    this.socket = socket; this.buffer = Buffer.alloc(0);
    socket.on('connect', () => {
      if (this.socket !== socket || this.closed) return socket.destroy();
      this.writeLine('PING 0\n', false);
      this.heartbeat = setInterval(() => this.writeLine('PING 0\n', false), this.heartbeatMs);
    });
    socket.on('data', chunk => this.receive(socket, chunk));
    socket.on('error', () => {});
    socket.on('close', () => this.disconnected(socket));
  }

  scheduleRetry() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, this.retryMs);
  }

  disconnected(socket) {
    if (this.socket !== socket) return;
    this.socket = null; clearInterval(this.heartbeat); this.heartbeat = null;
    const reason = this.closeReason ?? 'Bluetooth HID daemon unavailable'; this.closeReason = null;
    const shouldStop = this.sessionMayBeActive || !!this.endpoint || this.daemon.active || this.daemon.buttons !== 0;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer); pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
    this.ignoredResponses.clear();
    this.connected = false; this.pairing = false; this.active = false; this.buttons = 0;
    if (this.deviceManagement) {
      this.paired = this.targets.length > 0;
      this.daemon = { ...this.daemon, working: false, connected: false, connected_device: '', ready: false, pairing: false, active: false, buttons: 0, interval_ms: null, error: reason };
      this.targets = this.targets.map(target => ({ ...target, ready: false, connected: false }));
      this.connectedDevice = '';
    } else {
      this.paired = false;
      this.daemon = { ready: false, paired: false, pairing: false, active: false, buttons: 0, interval_ms: null, reports_sent: 0, dropped_motion: 0, error: reason };
      this.targets[0] = { ...this.targets[0], ready: false, connected: false };
    }
    this.endpoint = null; this.sessionTarget = null; this.desiredButtons = 0; this.sessionMayBeActive = false;
    this.pendingMovement = null; this.lgSamples = []; this.lastLgSample = this.lastLgBucket = -Infinity; clearTimeout(this.pace); this.pace = null;
    if (shouldStop) this.onStop(reason);
    this.publish(); this.scheduleRetry();
  }

  abort(reason) {
    if (!this.socket) return;
    this.closeReason = reason;
    this.socket.destroy();
  }

  receive(socket, chunk) {
    if (this.socket !== socket) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (this.buffer.length > 8192) return this.abort('Invalid Bluetooth HID daemon response');
    while (this.buffer.includes(0x0a)) {
      const end = this.buffer.indexOf(0x0a), bytes = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      if (!bytes.length || bytes.length > 4096) { this.abort('Invalid Bluetooth HID daemon response'); return; }
      let raw;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { this.abort('Invalid Bluetooth HID daemon response'); return; }
      let message;
      try { message = JSON.parse(raw); }
      catch { this.abort('Invalid Bluetooth HID daemon response'); return; }
      const messageKeys = message && typeof message === 'object' && !Array.isArray(message) ? Object.keys(message).sort().join(',') : '';
      if (messageKeys === 'state,version' && ((message.version === 1 && validDaemonState(message.state))
          || (message.version === 2 && validV2DaemonState(message.state)))) {
        this.acceptState(message.state, message.version);
        continue;
      }
      if (!['id,ok', 'error,id,ok'].includes(messageKeys) || !Number.isSafeInteger(message.id) || message.id <= 0
          || typeof message.ok !== 'boolean' || (!message.ok && typeof message.error !== 'string')
          || (message.error !== undefined && typeof message.error !== 'string')) {
        this.abort('Invalid Bluetooth HID daemon response'); return;
      }
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        if (this.ignoredResponses.delete(message.id)) continue;
        this.abort('Unexpected Bluetooth HID daemon response'); return;
      }
      this.pendingRequests.delete(message.id); clearTimeout(pending.timer);
      if (message.ok) pending.resolve();
      else {
        const error = new Error(message.error || `${pending.command} failed`);
        pending.reject(error);
        if (pending.fatal) { this.abort(`Bluetooth ${pending.command.toLowerCase()} failed: ${error.message}`); return; }
      }
    }
  }

  acceptState(state, version = 1) {
    this.connected = true;
    const wasReady = this.daemon.ready, wasActive = this.daemon.active, endpointID = this.endpoint?.id ?? this.sessionTarget;
    this.daemon = { ...state };
    this.paired = state.paired; this.pairing = state.pairing; this.active = state.active; this.buttons = state.buttons;
    this.protocolVersion = version;
    if (version === 2) {
      this.deviceManagement = true; this.hostLimit = state.host_limit; this.defaultTarget = null;
      this.selectedTarget = state.selected; this.connectedDevice = state.connected_device;
      this.targets = state.devices.map(device => ({
        ...device,
        ready: state.ready && device.id === state.selected,
        connected: device.id === state.connected_device,
      }));
    } else {
      this.deviceManagement = false; this.hostLimit = 1; this.defaultTarget = targetID;
      this.selectedTarget = targetID; this.connectedDevice = state.connected ? targetID : '';
      this.targets = [{ id: targetID, name: 'Paired computer', ready: state.ready, connected: !!state.connected, legacy: true }];
    }
    if (state.active) this.sessionMayBeActive = true;
    const endpointChanged = endpointID && version === 2 && (state.selected !== endpointID || state.connected_device !== endpointID);
    if ((this.endpoint || this.sessionMayBeActive) && !this.quiescing && (endpointChanged || (wasReady && !state.ready) || (wasActive && !state.active))) {
      this.onStop(state.error || (wasActive && !state.active ? 'Bluetooth input session ended' : 'Bluetooth host disconnected'));
    }
    this.publish();
  }

  publish() {
    const current = JSON.stringify({ connected: this.connected, daemon: this.daemon });
    if (current === this.published) return;
    this.published = current; this.onState();
  }

  writeLine(line, critical) {
    if (Buffer.byteLength(line) > 128) throw new Error('Bluetooth command exceeds protocol limit');
    const socket = this.socket;
    if ((!this.connected && line !== 'PING 0\n') || !socket || socket.destroyed || !socket.writable) return false;
    if (socket.writableLength + Buffer.byteLength(line) > 4096) {
      if (critical) this.abort('Bluetooth command buffer full');
      return false;
    }
    try { socket.write(line); return true; }
    catch {
      if (critical) this.abort('Bluetooth HID daemon write failed');
      return false;
    }
  }

  request(command, parameters = [], { fatal = false, priority = false, timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.connected) return Promise.reject(new Error('Bluetooth HID daemon unavailable'));
    if (!priority && this.pendingRequests.size >= 16) {
      const error = new Error('Bluetooth request queue full');
      this.abort(error.message); return Promise.reject(error);
    }
    if (!Number.isSafeInteger(this.nextID) || this.nextID > 0xffffffff) {
      const error = new Error('Bluetooth request identity exhausted');
      this.abort(error.message); return Promise.reject(error);
    }
    const id = this.nextID++, line = `${command} ${id}${parameters.length ? ` ${parameters.join(' ')}` : ''}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abort(`Bluetooth ${command.toLowerCase()} timed out`), timeoutMs);
      this.pendingRequests.set(id, { command, fatal, resolve, reject, timer });
      if (!this.writeLine(line, true)) {
        clearTimeout(timer); this.pendingRequests.delete(id);
        reject(new Error('Bluetooth HID daemon unavailable'));
      }
    });
  }

  ready(id) { return id === this.selectedTarget && this.connected && this.daemon.ready; }

  async prepare(id) {
    if (this.quiescing) throw new Error('Output cleanup is still in progress');
    if (!this.ready(id)) throw new Error('Bluetooth host is unavailable');
  }

  async open(id, generation) {
    if (this.quiescing) throw new Error('Output cleanup is still in progress');
    if (!this.ready(id)) throw new Error('Bluetooth host is unavailable');
    this.generation = generation; this.desiredButtons = 0; this.sessionMayBeActive = true; this.sessionTarget = id;
    try { await this.request('OPEN'); }
    catch (error) {
      this.sessionMayBeActive = this.daemon.active;
      if (!this.sessionMayBeActive) this.sessionTarget = null;
      throw error;
    }
    if (generation !== this.generation) return null;
    this.endpoint = { ...this.targets.find(target => target.id === id) };
    return this.endpoint;
  }

  setMovementRate(rate) {
    validateOutputRate(rate);
    this.movementRateHz = rate; this.movementIntervalMs = 1000 / rate;
    this.nextMovement = this.lastMovement + (targetProfile(this.endpoint) === 'lg-tv' ? 10 : this.movementIntervalMs);
    clearTimeout(this.pace); this.pace = null; this.scheduleFlush();
  }

  move(delta) {
    if (targetProfile(this.endpoint) === 'lg-tv') return;
    if (delta.generation !== this.generation || !this.endpoint || this.quiescing || !this.ready(this.endpoint.id)) return;
    const now = this.clock() / 1000;
    if (now - delta.time > 0.075 || delta.time > now + 0.005) { this.dropped++; return; }
    if (!this.pendingMovement || delta.time - this.pendingMovement.started > 0.05) {
      if (this.pendingMovement) this.dropped++;
      this.pendingMovement = { ...delta, started: delta.time };
    } else {
      this.pendingMovement.dx = Math.max(-32767, Math.min(32767, this.pendingMovement.dx + delta.dx));
      this.pendingMovement.dy = Math.max(-32767, Math.min(32767, this.pendingMovement.dy + delta.dy));
      this.pendingMovement.time = delta.time;
    }
    this.scheduleFlush();
  }

  imu(sample) {
    if (!sample || sample.generation !== this.generation || targetProfile(this.endpoint) !== 'lg-tv' || this.quiescing || !this.ready(this.endpoint.id)) return;
    const now = this.clock() / 1000;
    if (!Number.isFinite(sample.time) || now - sample.time > 0.075 || sample.time > now + 0.005
        || !Array.isArray(sample.axes) || sample.axes.length !== 6 || !sample.axes.every(value => Number.isInteger(value) && value >= -32768 && value <= 32767)) { this.dropped++; return; }
    const bucket = Math.floor(sample.time * 100);
    if (sample.time < this.lastLgSample || bucket <= this.lastLgBucket) return;
    this.lastLgSample = sample.time;
    const latest = this.lgSamples.at(-1);
    const pending = { ...sample, axes: [...sample.axes], started: sample.time, bucket };
    if (latest?.bucket === bucket) this.lgSamples[this.lgSamples.length - 1] = pending;
    else this.lgSamples.push(pending);
    while (this.lgSamples.length > 8 || this.lgSamples[0]?.time < now - 0.075) {
      this.lgSamples.shift(); this.dropped++;
    }
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.closed || this.quiescing || (!this.pendingMovement && !this.lgSamples.length) || this.pace) return;
    const wait = Math.max(0, this.nextMovement - this.clock());
    this.pace = setTimeout(() => {
      this.pace = null;
      if (this.clock() < this.nextMovement) this.scheduleFlush();
      else this.flush();
    }, Math.ceil(wait));
  }

  flush() {
    clearTimeout(this.pace); this.pace = null;
    const delta = this.lgSamples.shift() ?? this.pendingMovement; this.pendingMovement = null;
    try {
      if (!delta || delta.generation !== this.generation || !this.endpoint || !this.ready(this.endpoint.id)) return;
      if (this.clock() > (delta.started + 0.075) * 1000) { this.dropped++; return; }
      let line;
      if (delta.axes) {
        this.lastLgBucket = delta.bucket;
        line = `IMU 0 ${delta.axes.join(' ')}\n`;
      } else {
        const dx = Math.max(-32767, Math.min(32767, Math.trunc(delta.dx)));
        const dy = Math.max(-32767, Math.min(32767, Math.trunc(delta.dy)));
        if (!dx && !dy) return;
        line = `MOVE 0 ${dx} ${dy}\n`;
      }
      if (!this.writeLine(line, false)) { this.dropped++; return; }
      this.sentMovement++; this.lastMovement = this.clock();
      const interval = delta.axes ? 10 : this.movementIntervalMs;
      this.nextMovement = this.lastMovement - this.nextMovement < interval
        ? this.nextMovement + interval : this.lastMovement + interval;
    } finally { this.scheduleFlush(); }
  }

  async button(button, down, generation) {
    if (![1, 2].includes(button) || typeof down !== 'boolean') throw new Error('Invalid mouse button edge');
    if (generation !== this.generation || !this.endpoint || !this.ready(this.endpoint.id)) {
      if (!down) return;
      throw new Error('Bluetooth output unavailable');
    }
    const bit = 1 << (button - 1), mask = down ? this.desiredButtons | bit : this.desiredButtons & ~bit;
    if (mask === this.desiredButtons) return;
    this.flush();
    this.desiredButtons = mask;
    try { await this.request('BUTTON', [mask], { fatal: true }); }
    catch (error) { this.desiredButtons = 0; throw error; }
  }

  async sendAction(command, generation) {
    if (generation !== this.generation || !this.endpoint || !this.ready(this.endpoint.id)) throw new Error('Bluetooth output unavailable');
    const match = /^MOUSE_WHEEL_(-?1)$/.exec(command);
    if (!match) throw new Error('Owned Bluetooth buttons require physical edges');
    this.flush();
    await this.request('SCROLL', [Number(match[1])], { fatal: true });
  }

  pair(profile = 'computer') {
    if (!['computer', 'lg-tv'].includes(profile)) return Promise.reject(new Error('Unknown Bluetooth profile'));
    if (this.deviceManagement && this.targets.length >= this.hostLimit) return Promise.reject(new Error('Bluetooth device limit reached'));
    return this.request(profile === 'lg-tv' ? 'PAIR_LG' : 'PAIR', [], { timeoutMs: this.metadataRequestTimeoutMs });
  }
  async waitForPairing({ signal, timeoutMs = 5000 }) {
    const deadline = performance.now() + timeoutMs;
    while (true) {
      signal.throwIfAborted();
      if (!this.connected) throw new Error('Bluetooth service disconnected during pairing');
      if (this.daemon.error) throw new Error(this.daemon.error);
      if (this.daemon.working && this.daemon.pairing && !this.daemon.connected) return;
      if (performance.now() >= deadline) throw new Error('Bluetooth pairing did not become ready');
      await delay(25, undefined, { signal });
    }
  }
  media(id, key) {
    if (targetProfile(this.targets.find(target => target.id === id)) === 'lg-tv') {
      if (!Object.hasOwn(lgMediaKeys, key)) return Promise.reject(new Error('This media key is not supported by the LG Bluetooth profile'));
      return this.keyboardUsage(id, lgMediaKeys[key], 'LGKEY');
    }
    const usages = { play_pause: 0xcd, previous: 0xb6, next: 0xb5, stop: 0xb7, mute: 0xe2, volume_up: 0xe9, volume_down: 0xea };
    if (!Object.hasOwn(usages, key)) return Promise.reject(new Error('Unknown media key'));
    if (!this.ready(id) || this.quiescing) return Promise.reject(new Error('Bluetooth host is unavailable'));
    this.sessionMayBeActive = true;
    return this.request('MEDIA', [usages[key]]);
  }

  async select(id) {
    requirePeer(id); this.requireManagedTarget(id);
    return this.request('SELECT', [id], { timeoutMs: this.metadataRequestTimeoutMs });
  }
  disconnectTarget() {
    if (!this.deviceManagement) return Promise.reject(new Error('Bluetooth device management is unavailable'));
    return this.request('DISCONNECT', [], { timeoutMs: this.metadataRequestTimeoutMs });
  }
  // Restart the daemon's fast advertising window so a nearby host picks the remote up sooner.
  reconnect() {
    if (!this.deviceManagement) return Promise.reject(new Error('Bluetooth device management is unavailable'));
    if (!this.selectedTarget) return Promise.reject(new Error('No computer is selected'));
    return this.request('RECONNECT', [], { timeoutMs: this.metadataRequestTimeoutMs });
  }
  key(id, key) {
    const usages = targetProfile(this.targets.find(target => target.id === id)) === 'lg-tv' ? lgKeys : arrowKeys;
    if (!Object.hasOwn(usages, key)) return Promise.reject(new Error('Unknown arrow key'));
    return this.keyboardUsage(id, usages[key], usages === lgKeys ? 'LGKEY' : 'KEY');
  }
  keyboardUsage(id, usage, command = 'KEY') {
    if (!this.ready(id) || this.quiescing) return Promise.reject(new Error('Bluetooth host is unavailable'));
    this.sessionMayBeActive = true;
    return this.request(command, [usage]);
  }

  async rename(id, name) {
    requirePeer(id); this.requireManagedTarget(id);
    if (!validName(name)) return Promise.reject(new Error('Invalid Bluetooth device name'));
    const encoded = name ? Buffer.from(name, 'utf8').toString('hex') : '-';
    return this.request('RENAME', [id, encoded], { timeoutMs: this.metadataRequestTimeoutMs });
  }

  async reorder(ids) {
    if (!this.deviceManagement || !Array.isArray(ids)) return Promise.reject(new Error('Bluetooth device management is unavailable'));
    const current = this.targets.map(target => target.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !peerPattern.test(id))
        || ids.some(id => !current.includes(id))) return Promise.reject(new Error('Invalid Bluetooth device order'));
    return this.request('REORDER', [ids.length ? ids.join(',') : '-'], { timeoutMs: this.metadataRequestTimeoutMs });
  }

  async forget(id) {
    requirePeer(id); this.requireManagedTarget(id);
    return this.request('FORGET', [id], { timeoutMs: this.metadataRequestTimeoutMs });
  }

  async cancelPairing() {
    if (!this.deviceManagement) return Promise.reject(new Error('Bluetooth device management is unavailable'));
    return this.request('CANCEL_PAIR', [], { timeoutMs: this.metadataRequestTimeoutMs });
  }

  requireManagedTarget(id) {
    if (!this.deviceManagement) throw new Error('Bluetooth device management is unavailable');
    if (!this.targets.some(target => target.id === id)) throw new Error('Unknown Bluetooth device');
  }

  invalidate(generation) {
    this.generation = generation; this.endpoint = null; this.sessionTarget = null; this.desiredButtons = 0; this.pendingMovement = null;
    this.lgSamples = []; this.lastLgSample = this.lastLgBucket = -Infinity;
    clearTimeout(this.pace); this.pace = null;
  }

  async quiesce() {
    this.pendingMovement = null; this.lgSamples = []; this.lastLgSample = this.lastLgBucket = -Infinity; clearTimeout(this.pace); this.pace = null; this.desiredButtons = 0; this.endpoint = null; this.sessionTarget = null;
    if (!this.sessionMayBeActive) return;
    if (!this.quiescing) {
      this.quiescing = (async () => {
        if (!this.connected) { this.sessionMayBeActive = false; return; }
        const stopID = this.nextID;
        for (const [id, pending] of this.pendingRequests) {
          if (id >= stopID || !['OPEN', 'BUTTON', 'SCROLL', 'MEDIA', 'KEY', 'LGKEY'].includes(pending.command)) continue;
          clearTimeout(pending.timer); this.pendingRequests.delete(id);
          while (this.ignoredResponses.size >= 32) this.ignoredResponses.delete(this.ignoredResponses.values().next().value);
          this.ignoredResponses.add(id);
          pending.reject(new Error('Bluetooth input invalidated by stop'));
        }
        await this.request('STOP', [], { fatal: true, priority: true });
        this.sessionMayBeActive = false;
      })().finally(() => { this.quiescing = null; });
    }
    return this.quiescing;
  }

  metrics() {
    // dropped_movement includes the daemon's own motion drops: coalesced-stale and queue-full.
    return {
      requested_movement_rate_hz: this.movementRateHz,
      submitted_movement_updates: this.sentMovement,
      dropped_movement: this.dropped + this.daemon.dropped_motion,
      bluetooth: { connection_interval_ms: this.daemon.interval_ms, reports_sent: this.daemon.reports_sent },
    };
  }

  close() {
    this.closed = true; clearTimeout(this.pace); clearTimeout(this.retry); clearInterval(this.heartbeat);
    this.retry = null; this.heartbeat = null; this.socket?.destroy();
  }
}
