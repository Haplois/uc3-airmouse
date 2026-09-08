import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sensor, ownedSettings } from '../runtime/sensor.mjs';
import { saveJSON } from '../runtime/storage.mjs';

export function fakeSensor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airmouse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = Object.fromEntries(ownedSettings.map(k => [k, '0']));
  Object.assign(settings, {
    name: 'bmi323-imu', 'buffer/length': '2', 'buffer/watermark': '1',
    current_timestamp_clock: 'realtime', in_accel_sampling_frequency: '50.000000', in_anglvel_sampling_frequency: '50.000000',
    'trigger/current_trigger': 'bmi323-imu-trig-1',
    in_anglvel_scale: '0.001065', in_accel_scale: '0.002394',
    in_accel_sampling_frequency_available: '50 100 200 400 800', in_anglvel_sampling_frequency_available: '50 100 200 400',
    in_anglvel_scale_available: '0.000066 0.000133 0.000266 0.000532 0.001065',
  });
  ['accel_x', 'accel_y', 'accel_z', 'anglvel_x', 'anglvel_y', 'anglvel_z', 'timestamp'].forEach((c, i) => {
    settings[`scan_elements/in_${c}_index`] = String(i);
    settings[`scan_elements/in_${c}_type`] = i === 6 ? 'le:s64/64>>0' : 'le:s16/16>>0';
  });
  let writes = [], failAt = -1;
  const io = { read: k => { if (k === 'buffer/hwfifo_enabled') return settings['trigger/current_trigger'] === '' && settings['buffer/enable'] === '1' ? '1' : '0'; if (!(k in settings)) throw new Error(k); return settings[k]; }, write: (k, v) => { writes.push(k); if (writes.length === failAt) throw new Error('Injected sensor write failure'); settings[k] = v; } };
  const sensor = new Sensor({ stateDir: dir, sysfs: dir, device: '/nonexistent', io, bootID: 'test-boot' });
  sensor.start = (generation, onSamples, onError) => { sensor.callback = onSamples; sensor.onError = onError; sensor.captureGeneration = generation; };
  const configFile = path.join(dir, 'airmouse.json');
  saveJSON(configFile, JSON.parse(fs.readFileSync(new URL('../config/airmouse.json', import.meta.url), 'utf8')));
  return { dir, sensor, settings, io, configFile, writes, fail: n => { failAt = n; } };
}

export function fakeOutput() {
  return {
    backend: 'core', buttonEdges: false,
    movementRateHz: 80, acknowledgedMovementUpdates: 0,
    setMovementRate(rate) { this.movementRateHz = rate; },
    metrics() { return { acknowledged_movement_updates: this.acknowledgedMovementUpdates, dropped_movement: 0 }; },
    targets: [{ id: 'host.a', name: 'A', ready: true }, { id: 'host.b', name: 'B', ready: true }], connected: true,
    ready(id) { return this.connected && this.targets.some(t => t.id === id && t.ready); },
    invalidate(generation) { this.generation = generation; },
    open(id, generation) { if (this.uncertain) throw new Error('Unresolved delivery'); this.endpoint = id; this.generation = generation; },
    quiesceCalls: 0, async quiesce() { this.quiesceCalls++; this.endpoint = null; },
    moves: [], move(delta) { if (delta.generation === this.generation) this.moves.push(delta); },
    async send(commands, generation) { this.sent = { commands, generation }; },
    async sendAction(command, generation) { return this.send([command], generation); },
    buttonCalls: [], async button(button, down, generation) { this.buttonCalls.push({ button, down, generation }); },
    pairCalls: 0, async pair() { this.pairCalls++; },
    selectCalls: [], async select(id) { this.selectCalls.push(id); this.selectedTarget = id; },
    renameCalls: [], async rename(id, name) { this.renameCalls.push({ id, name }); },
    reorderCalls: [], async reorder(ids) { this.reorderCalls.push([...ids]); },
    forgetCalls: [], async forget(id) { this.forgetCalls.push(id); },
    cancelPairingCalls: 0, async cancelPairing() { this.cancelPairingCalls++; },
  };
}
