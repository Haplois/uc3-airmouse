import fs from 'node:fs';
import WebSocket from 'ws';
import { readText, readJSON, saveJSON } from './storage.mjs';
import { CoreRpc, CommandNotSent } from './core-rpc.mjs';
import { validateOutputRate } from './output-rate.mjs';

export class CoreOutput {
  constructor({ stateDir, onState = () => {}, onStop = () => {}, request = fetch, movementRateHz = 80, socketFactory = (...args) => new WebSocket(...args), clock = () => Number(process.hrtime.bigint()) / 1e6, link } = {}) {
    validateOutputRate(movementRateHz);
    this.stateDir = stateDir; this.onState = onState; this.onStop = onStop; this.request = request;
    this.socketFactory = socketFactory;
    this.link = link;
    this.clock = clock;
    this.targets = []; this.connected = false; this.awake = false; this.connection = 0;
    this.pending = null; this.busy = null; this.endpoint = null; this.generation = 0;
    this.uncertain = fs.existsSync(`${stateDir}/output-session.json`);
    this.latencies = []; this.dropped = 0; this.acknowledgedMovementUpdates = 0;
    this.used = fs.existsSync(`${stateDir}/output-used.json`); this.closed = false;
    this.movementRateHz = movementRateHz;
    this.movementIntervalMs = 1000 / movementRateHz;
    this.lastMovement = -Infinity;
    this.nextMovement = -Infinity;
    this.pace = null;
    this.quiescing = null;
  }

  async api(endpoint, method = 'GET', body, timeout = 1500) {
    const keyFile = `${this.stateDir}/core-api-key`;
    if ((fs.statSync(keyFile).mode & 0o077) !== 0) throw new Error('Core API key permissions must be 0600');
    const response = await this.request(`http://127.0.0.1/api${endpoint}`, {
      method, headers: { Authorization: `Bearer ${readText(keyFile)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Core HTTP ${response.status}`);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  start() {
    const connect = () => {
      if (this.closed) return;
      try {
        const ws = this.socketFactory('ws://127.0.0.1/ws', { headers: { 'API-KEY': readText(`${this.stateDir}/core-api-key`) }, maxPayload: 1024 * 1024, handshakeTimeout: 3000 });
        this.ws = ws;
        this.rpc = new CoreRpc(ws);
        let live = true;
        ws.on('pong', () => { live = true; });
        ws.on('message', data => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.msg === 'authentication') {
              if (msg.code !== 200) { ws.close(); return; }
              ws.send(JSON.stringify({ kind: 'req', id: 1, msg: 'subscribe_events', msg_data: { channels: ['all'] } }));
            } else if (msg.kind === 'resp' && msg.req_id === 1 && msg.code === 200) {
              this.connected = true; this.connection++; this.refresh();
            } else if (msg.msg === 'power_mode_change') {
              this.awake = msg.msg_data?.mode === 'NORMAL';
              if (!this.awake) this.onStop('Standby');
              this.onState();
            } else if (msg.msg === 'entity_change') {
              const change = msg.msg_data;
              const target = this.targets.find(t => t.id === change?.entity_id);
              if (target) {
                const wasReady = target.ready;
                if (change.attributes?.state) target.ready = change.attributes.state === 'UNKNOWN';
                if (change.event_type === 'DELETE') target.ready = false;
                if (!target.ready && target.id === this.endpoint?.id) this.onStop('Bluetooth disconnected');
                if (target.ready !== wasReady) this.onState();
              }
            }
          } catch { this.lost('Invalid Core response'); ws.terminate(); }
        });
        const heartbeat = setInterval(() => { if (!live) ws.terminate(); else { live = false; ws.ping(); } }, 2000);
        ws.on('error', () => {});
        ws.on('close', () => { clearInterval(heartbeat); this.lost('Core connection lost'); if (!this.closed) this.retry = setTimeout(connect, 2000); });
      } catch { this.lost('Core credential unavailable'); this.retry = setTimeout(connect, 2000); }
    };
    connect();
    this.poll = setInterval(() => { if (this.connected) this.refresh(); }, 1000);
  }

  lost(reason) {
    this.connected = false; this.awake = false;
    for (const target of this.targets) target.ready = false;
    this.onStop(reason); this.onState();
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    const connection = this.connection;
    try {
      const [remotes, power] = await Promise.all([this.api('/remotes?kind=BT&limit=100'), this.api('/system/power')]);
      const targets = [];
      for (const remote of remotes) {
        const id = remote.entity_id;
        const [pair, info] = await Promise.all([this.api(`/remotes/${encodeURIComponent(id)}/bt/pairing`), this.api(`/remotes/${encodeURIComponent(id)}/bt`)]);
        const name = typeof remote.name === 'string' ? remote.name : remote.name?.en ?? remote.name?.en_US ?? Object.values(remote.name ?? {}).find(value => typeof value === 'string' && value);
        if (pair.paired && info.peripherals?.mouse === true) targets.push({ id, name: name || id, peer: pair.peer?.address, ready: remote.attributes?.state === 'UNKNOWN' });
      }
      if (!this.connected || connection !== this.connection) return;
      this.targets = targets; this.awake = power.mode === 'NORMAL';
      if (!this.awake || (this.endpoint && (!this.ready(this.endpoint.id) || targets.find(t => t.id === this.endpoint.id)?.peer !== this.endpoint.peer))) this.onStop('Target or remote unavailable');
      if (this.endpoint) {
        try { await this.link?.check(); } catch (error) { this.onStop(error.message); }
      }
      this.onState();
    } catch { this.lost('Core status unavailable'); this.ws?.terminate(); }
    finally { this.refreshing = false; }
  }

  ready(id) { return this.connected && this.awake && this.targets.some(t => t.id === id && t.ready); }

  setMovementRate(rate) {
    validateOutputRate(rate);
    this.movementRateHz = rate; this.movementIntervalMs = 1000 / rate;
    this.nextMovement = this.lastMovement + this.movementIntervalMs;
    clearTimeout(this.pace); this.pace = null;
    this.scheduleFlush();
  }

  metrics() {
    const values = [...this.latencies].sort((a, b) => a - b);
    return { requested_movement_rate_hz: this.movementRateHz, acknowledged_movement_updates: this.acknowledgedMovementUpdates, movement_interval_ms: this.movementIntervalMs, bluetooth: this.link?.metrics() ?? null, core_response_ms: values.length ? { count: values.length, p50: values[Math.floor((values.length - 1) * 0.5)], p95: values[Math.floor((values.length - 1) * 0.95)], max: values.at(-1) } : null, dropped_movement: this.dropped, host_latency: 'unmeasured' };
  }

  async prepare(id) {
    if (this.quiescing) throw new Error('Output cleanup is still in progress');
    if (!this.link) return;
    if (!this.ready(id)) throw new Error('Bluetooth target is unavailable');
    this.preparing = this.link.acquire({ ...this.targets.find(t => t.id === id) });
    try { await this.preparing; } finally { this.preparing = null; }
  }

  open(id, generation) {
    if (this.quiescing) throw new Error('Output cleanup is still in progress');
    if (this.uncertain || this.busy) throw new Error('Previous output delivery is unresolved');
    if (!this.ready(id)) throw new Error('Bluetooth target is unavailable');
    this.endpoint = { ...this.targets.find(t => t.id === id), connection: this.connection };
    this.generation = generation;
    saveJSON(`${this.stateDir}/output-session.json`, { endpoint: this.endpoint.id, connection: this.connection, peer: this.endpoint.peer });
    return this.endpoint;
  }

  invalidate(generation) { this.generation = generation; this.pending = null; clearTimeout(this.pace); this.pace = null; }

  move(delta) {
    if (delta.generation !== this.generation || !this.endpoint || this.uncertain || this.quiescing) return;
    const now = this.clock() / 1000;
    if (now - delta.time > 0.075 || delta.time > now + 0.005) { this.dropped++; return; }
    if (!this.pending || delta.time - this.pending.started > 0.05) {
      if (this.pending) this.dropped++;
      this.pending = { ...delta, started: delta.time };
    }
    else {
      this.pending.dx = Math.max(-127, Math.min(127, this.pending.dx + delta.dx));
      this.pending.dy = Math.max(-127, Math.min(127, this.pending.dy + delta.dy));
      this.pending.time = delta.time;
    }
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.closed || this.quiescing || this.busy || !this.pending || this.pace) return;
    const wait = Math.max(0, this.nextMovement - this.clock());
    this.pace = setTimeout(() => {
      this.pace = null;
      if (this.clock() < this.nextMovement) this.scheduleFlush();
      else this.flush();
    }, Math.ceil(wait));
  }

  flush() {
    clearTimeout(this.pace); this.pace = null;
    if (this.busy || !this.pending) return;
    const delta = this.pending; this.pending = null;
    const deadline = (delta.started + 0.075) * 1000;
    if (this.clock() > deadline) { this.dropped++; return; }
    const commands = [['X', delta.dx], ['Y', delta.dy]].filter(([, v]) => v).map(([axis, v]) => `MOUSE_${axis}_${Math.max(-127, Math.min(127, Math.trunc(v)))}`);
    if (commands.length) {
      this.lastMovement = this.clock();
      this.nextMovement = this.lastMovement - this.nextMovement < this.movementIntervalMs
        ? this.nextMovement + this.movementIntervalMs : this.lastMovement + this.movementIntervalMs;
      this.send(commands, delta.generation, deadline).catch(() => {});
    }
  }

  async send(commands, generation, deadline = Infinity) {
    if (this.busy || this.quiescing || this.uncertain || generation !== this.generation || !this.endpoint || !this.ready(this.endpoint.id)) throw new Error('Output unavailable or busy');
    const endpoint = { ...this.endpoint };
    const task = (async () => {
      let acknowledged = 0;
      for (const command of commands) {
        if (this.quiescing || generation !== this.generation || endpoint.connection !== this.connection || !this.ready(endpoint.id)) break;
        if (this.clock() > deadline) { this.dropped++; break; }
        const start = performance.now();
        if (!this.used) {
          saveJSON(`${this.stateDir}/output-used.json`, { endpoint: endpoint.id, isolation_verified: false });
          this.used = true;
        }
        try {
          await this.execute(endpoint.id, command);
          acknowledged++;
          this.latencies.push(performance.now() - start);
          if (this.latencies.length > 256) this.latencies.shift();
        } catch (error) {
          const notSent = error instanceof CommandNotSent;
          this.uncertain = !notSent;
          const reason = `${notSent ? 'Output command not sent' : 'Output delivery uncertain'}: ${error.message}`;
          this.onStop(reason); this.onState();
          throw new Error(`${reason}; action was not replayed`, { cause: error });
        }
      }
      if (Number.isFinite(deadline) && acknowledged === commands.length) this.acknowledgedMovementUpdates++;
    })();
    this.busy = task;
    try { await task; } finally {
      if (this.busy === task) this.busy = null;
      this.scheduleFlush();
    }
  }

  async sendAction(command, generation) {
    if (this.busy) await this.busy;
    return this.send([command], generation);
  }

  async execute(entity_id, command) {
    if (!this.rpc || !this.connected) throw new CommandNotSent('Core command socket unavailable');
    await this.rpc.request('execute_entity_command', { entity_id, cmd_id: 'remote.send_cmd', params: { command } });
  }

  async quiesce({ switching = false } = {}) {
    this.pending = null; clearTimeout(this.pace); this.pace = null;
    if (!this.quiescing) {
      this.quiescing = (async () => {
        if (this.busy) await this.busy.catch(() => {});
        if (this.preparing) await this.preparing.catch(() => {});
        this.endpoint = null;
        if (!this.uncertain) {
          const file = `${this.stateDir}/output-session.json`;
          if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        await this.link?.release();
      })().finally(() => { this.quiescing = null; });
    }
    await this.quiescing;
    if (this.uncertain) throw new Error('Output delivery unresolved; verify old host before resetting output');
    if (switching && this.used) throw new Error('Host-observed target isolation has not been verified');
  }

  close() { this.closed = true; clearTimeout(this.pace); clearInterval(this.poll); clearTimeout(this.retry); this.ws?.terminate(); }
}
