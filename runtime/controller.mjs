import { themes, sensorRates, samplingPolicy } from './ui-policy.mjs';
import { setImmediate as yieldIO, setTimeout as delay } from 'node:timers/promises';
import { readJSON, saveJSON } from './storage.mjs';
import { MotionFilter, calibrate } from './motion.mjs';
import { supportedGyroRanges } from './sensor.mjs';
import { validateOutputRate } from './output-rate.mjs';
import { ownershipModes } from './bluetooth-ownership.mjs';

export class Controller {
  constructor({ sensor, output, configFile, publish = () => {}, save = saveJSON, switchTimeoutMs = 3000, ownership = null, releaseGraceMs = 10_000, ownershipStartupMs = 5_000 }) {
    Object.assign(this, { sensor, output, configFile, publish, save, ownership, releaseGraceMs });
    this.config = readJSON(configFile);
    if (this.config.config_version !== 1 || this.config.motion.inactive_profile !== 'restore_previous') throw new Error('Unsupported configuration');
    if (!supportedGyroRanges.includes(this.config.motion.active_profile.gyroscope.range_degrees_per_second)) throw new Error('Unsupported configured gyro range');
    this.rate = this.config.motion.active_profile.sampling_frequency_hz;
    this.outputRate = validateOutputRate(this.config.output?.movement_rate_hz ?? 80);
    this.rates = sensor.rates([...new Set([...this.config.ui.sampling_frequency_options_hz, ...sensorRates])].sort((a, b) => a - b));
    // Target ownership: the owned daemon owns selection and syncOutput() mirrors it. The Core backend
    // owns nothing persistent, so `selected_target` in the config is its saved selection and the
    // fallback after a rollback or reboot to the firmware backend.
    this.target = output.defaultTarget ?? this.config.selected_target ?? '';
    this.pointer = false; this.generation = 0; this.nativeControl = false;
    this.error = ''; this.reason = 'Restarted'; this.queue = Promise.resolve(); this.queued = 0;
    this.cleanup = Promise.resolve(); this.calibrating = false;
    this.switchTimeoutMs = switchTimeoutMs; this.switching = null; this.lastSwitchMs = null;
    if (!ownershipModes.includes(this.config.bluetooth?.ownership ?? 'always')) throw new Error('Unsupported Bluetooth ownership setting');
    this.releaseTimer = null; this.takeoverAttempted = false;
    this.syncOutput();
    // The first policy check waits so an installer's readiness probe never overlaps a takeover restart.
    if (ownershipStartupMs > 0) this.startupTimer = setTimeout(() => { this.startupTimer = null; this.applyOwnership(); this.changed(); }, ownershipStartupMs);
    else this.applyOwnership();
  }

  get ownershipMode() { return this.config.bluetooth?.ownership ?? 'always'; }

  // Bluetooth ownership policy. `always`: own the stack whenever the service runs. `session`: own it
  // while the app is open, release it a grace period after close. `never`: leave stock Bluetooth alone.
  // Requests go through a root path unit; this only writes the request file and reports outcome.
  applyOwnership() {
    const requests = this.ownership;
    if (!requests) return;
    clearTimeout(this.releaseTimer); this.releaseTimer = null;
    const owned = this.output.backend === 'owned';
    const mode = this.ownershipMode;
    const wantOwned = mode === 'always' || (mode === 'session' && this.nativeControl);
    if (!requests.installed()) { this.ownershipStatus = mode === 'never' ? '' : 'Bluetooth backend is not installed'; return; }
    if (wantOwned && !owned) {
      const failure = requests.failed();
      if (failure && this.takeoverAttempted) { this.ownershipStatus = failure; return; }
      if (failure) requests.clearFailed();
      this.takeoverAttempted = true;
      this.ownershipStatus = 'Taking over Bluetooth';
      requests.request('takeover');
    } else if (!wantOwned && owned) {
      if (mode === 'session' && !this.nativeControl) {
        this.ownershipStatus = '';
        this.releaseTimer = setTimeout(() => { this.releaseTimer = null; if (!this.nativeControl && this.output.backend === 'owned') { this.ownershipStatus = 'Releasing Bluetooth'; requests.request('rollback'); } }, this.releaseGraceMs);
      } else { this.ownershipStatus = 'Releasing Bluetooth'; requests.request('rollback'); }
    } else {
      requests.cancel(); this.ownershipStatus = '';
    }
  }

  state() {
    const target = this.output.targets.find(t => t.id === this.target);
    const ownedBluetooth = this.output.backend === 'owned';
    return {
      theme: this.config.ui.theme ?? 'black',
      speed: Math.max(10, Math.min(100, Math.round((this.currentTuning().sensitivity ?? this.config.motion.filter.sensitivity) / 30))),
      sampling_policy: samplingPolicy(this.outputRate, this.rates),
      applied_sampling: this.pointer || this.calibrating ? this.rate : null,
      calibrating: this.calibrating, error: this.error,
      pointer: this.pointer, pointer_enabled: this.pointer || !!this.switching?.resume,
      switching: !!this.switching, last_switch_ms: this.lastSwitchMs, generation: this.generation, target: this.target,
      target_name: target?.name ?? '', targets: this.output.targets,
      rate: this.rate, rates: this.rates, core_connected: this.output.connected,
      bluetooth_backend: this.output.backend ?? 'core', button_edges: this.output.buttonEdges === true,
      paired: ownedBluetooth && !!this.output.paired, pairing: ownedBluetooth && !!this.output.pairing,
      device_management: ownedBluetooth && this.output.deviceManagement === true,
      host_limit: ownedBluetooth ? this.output.hostLimit ?? 1 : 0,
      buttons: ownedBluetooth ? this.output.buttons : 0,
      output_rate: this.outputRate,
      gyro_range_degrees_per_second: this.config.motion.active_profile.gyroscope.range_degrees_per_second,
      control_connected: !!this.nativeControl, ready: this.nativeControl && this.output.ready(this.target),
      status: this.error || (this.switching ? 'Connecting' : this.calibrating ? 'Keep still' : this.pointer ? 'Pointing' : !this.output.connected ? ownedBluetooth ? 'Bluetooth service unavailable' : 'Core unavailable' : ownedBluetooth && this.output.pairing ? 'Pairing' : ownedBluetooth && !this.output.paired ? 'Pair a computer' : !this.target ? 'Select a target' : this.output.ready(this.target) ? 'Ready' : 'Target unavailable'),
      stop_reason: this.reason, output_uncertain: this.output.uncertain,
      bluetooth_ownership: this.ownershipMode, ownership_status: this.ownershipStatus ?? '',
      output_metrics: this.output.metrics?.() ?? null,
    };
  }

  changed() { this.publish(this.state()); }

  syncOutput() {
    if (this.output.backend !== 'owned' || this.output.deviceManagement !== true) return;
    if (this.switching && !this.output.connected) this.stop('Bluetooth service unavailable').catch(() => {});
    const selected = this.output.selectedTarget ?? '';
    if (selected !== this.target) {
      if (this.pointer || this.calibrating || this.output.endpoint || this.sensor.record) this.stop('Bluetooth target changed').catch(() => {});
      this.target = selected;
    }
    this.migrateLegacyTuning();
  }

  migrateLegacyTuning() {
    const legacy = this.output.targets.find(target => target.legacy);
    if (!legacy || this.config.owned_bluetooth?.legacy_device) return;
    const targetTuning = { ...this.config.target_tuning };
    const source = targetTuning['airmouse.host'] ?? targetTuning[this.config.selected_target];
    if (!Object.hasOwn(targetTuning, legacy.id) && source) targetTuning[legacy.id] = structuredClone(source);
    try {
      this.persist({
        ...this.config,
        target_tuning: targetTuning,
        owned_bluetooth: { ...this.config.owned_bluetooth, legacy_device: legacy.id },
      });
      if (this.error.startsWith('Bluetooth tuning migration failed:')) this.error = '';
    } catch (error) { this.error = `Bluetooth tuning migration failed: ${error.message}`; }
  }

  stop(reason = 'Pointer off') {
    clearTimeout(this.switching?.timer);
    this.switching?.abort.abort(); this.switching = null;
    this.generation++;
    this.pointer = false; this.calibrating = false; this.reason = reason;
    clearTimeout(this.idle);
    this.output.invalidate(this.generation);
    try { this.sensor.restore(); } catch (error) { this.error = error.message; }
    this.changed();
    this.cleanup = this.output.quiesce();
    this.cleanup.catch(error => { this.error = error.message; this.changed(); });
    return this.cleanup;
  }

  // The native UI layer reports its ownership here; only the controller writes control state.
  acquireControl() { this.nativeControl = true; this.takeoverAttempted = false; this.applyOwnership(); }
  releaseControl(reason) { this.nativeControl = false; const stopped = this.stop(reason); this.applyOwnership(); return stopped; }

  apply(command) {
    if (command.type === 'off') return this.stop();
    // Capacity is checked before any command may stop pointing, so a rejected request changes nothing.
    if (this.queued >= 16) return Promise.reject(new Error('Control queue full'));
    const managed = this.output.backend === 'owned' && this.output.deviceManagement === true;
    if (command.type === 'target' && !managed && this.output.defaultTarget && command.id !== this.output.defaultTarget) return Promise.reject(new Error('Unknown target'));
    let transfer;
    if (command.type === 'target' && command.id !== this.target) {
      if (command.id && !this.output.targets.some(t => t.id === command.id)) return Promise.reject(new Error('Unknown target'));
      const resume = command.keep_pointer === true && (this.pointer || !!this.switching?.resume);
      this.stop('Target changed');
      if (managed && command.keep_pointer === true) {
        transfer = { target: command.id, resume, generation: this.generation, started: performance.now(), abort: new AbortController() };
        transfer.timer = setTimeout(() => {
          if (this.switching !== transfer) return;
          const name = this.output.targets.find(t => t.id === transfer.target)?.name || 'Computer';
          this.stop('Switch failed').catch(() => {});
          this.error = `${name} did not reconnect or activate; pointing is off`;
          this.changed();
        }, this.switchTimeoutMs);
        this.switching = transfer; this.changed();
      }
    }
    if ((this.output.backend === 'owned' && command.type === 'pair') || (managed && command.type === 'forget')) {
      this.stop(command.type === 'pair' ? 'Pairing' : 'Forgetting device');
    }
    const generation = this.generation;
    this.queued++;
    const task = this.queue.then(async () => {
      if (generation !== this.generation) throw new Error('Command invalidated by stop');
      switch (command.type) {
        case 'media': {
          if (typeof this.output.media !== 'function') throw new Error('Media controls require the owned Bluetooth backend');
          return this.output.media(this.target, command.key);
        }
        case 'on': return this.activate();
        case 'target': {
          if (command.id === this.target) {
            if (transfer) void this.finishSwitch(transfer);
            return;
          }
          await this.cleanup;
          if (generation !== this.generation) return;
          if (managed) {
            try { await this.output.select(command.id); }
            catch (error) { this.error = error.message; this.changed(); throw error; }
            if (generation !== this.generation) return;
            this.target = command.id; this.error = ''; this.changed();
            if (transfer) void this.finishSwitch(transfer);
            return;
          }
          await this.output.quiesce({ switching: true });
          if (generation !== this.generation) return;
          this.persist({ ...this.config, selected_target: command.id });
          this.target = command.id; this.error = ''; this.changed(); return;
        }
        case 'resume_switch': {
          if (command.transfer !== this.switching || generation !== command.transfer.generation) return;
          return this.activate();
        }
        case 'theme': {
          if (!themes.includes(command.theme)) throw new Error('Unknown color theme');
          this.persist({ ...this.config, ui: { ...this.config.ui, theme: command.theme } });
          this.changed(); return;
        }
        case 'bluetooth_ownership': {
          if (!ownershipModes.includes(command.mode)) throw new Error('Unknown Bluetooth ownership setting');
          if (command.mode === this.ownershipMode) return;
          if (this.pointer || this.calibrating) throw new Error('Pause pointing before changing Bluetooth ownership');
          this.persist({ ...this.config, bluetooth: { ...this.config.bluetooth, ownership: command.mode } });
          this.takeoverAttempted = false;
          this.applyOwnership(); this.changed(); return;
        }
        case 'speed': {
          if (!Number.isInteger(command.speed) || command.speed < 10 || command.speed > 100) throw new Error('Speed must be 10–100');
          if (this.pointer) throw new Error('Pause pointing before changing speed');
          if (!this.target) throw new Error('Select a target before changing speed');
          const tuning = { ...this.config.target_tuning, [this.target]: { ...this.config.target_tuning?.[this.target], sensitivity: command.speed * 30 } };
          this.persist({ ...this.config, target_tuning: tuning }); this.changed(); return;
        }
        case 'output_policy': {
          const policy = samplingPolicy(command.rate, this.rates);
          if (!policy.selected) throw new Error('No supported sensor rate');
          if (this.pointer) throw new Error('Pause pointing before changing output limit');
          if (this.rate === policy.selected && this.outputRate === command.rate) return;
          const config = structuredClone(this.config);
          config.motion.active_profile.sampling_frequency_hz = policy.selected;
          config.output = { ...config.output, movement_rate_hz: command.rate };
          this.persist(config);
          this.rate = policy.selected; this.outputRate = command.rate;
          this.output.setMovementRate(command.rate);
          this.changed(); return;
        }
        case 'calibrate': return this.calibrate();
        case 'pair': {
          if (this.output.backend !== 'owned' || typeof this.output.pair !== 'function') throw new Error('Pairing is unavailable for this Bluetooth backend');
          await this.cleanup;
          try { await this.output.pair(); this.error = ''; this.changed(); return; }
          catch (error) { this.error = error.message; this.changed(); throw error; }
        }
        case 'rename': {
          if (!managed || typeof this.output.rename !== 'function') throw new Error('Bluetooth device management is unavailable');
          if (this.pointer || this.calibrating) throw new Error('Pause pointing before managing devices');
          try { await this.output.rename(command.id, command.name); this.error = ''; this.changed(); return; }
          catch (error) { this.error = error.message; this.changed(); throw error; }
        }
        case 'reorder': {
          if (!managed || typeof this.output.reorder !== 'function') throw new Error('Bluetooth device management is unavailable');
          if (this.pointer || this.calibrating) throw new Error('Pause pointing before managing devices');
          try { await this.output.reorder(command.ids); this.error = ''; this.changed(); return; }
          catch (error) { this.error = error.message; this.changed(); throw error; }
        }
        case 'forget': {
          if (!managed || typeof this.output.forget !== 'function') throw new Error('Bluetooth device management is unavailable');
          await this.cleanup;
          try {
            await this.output.forget(command.id);
            if (this.target === command.id) this.target = '';
            this.error = ''; this.changed(); return;
          } catch (error) { this.error = error.message; this.changed(); throw error; }
        }
        case 'cancel_pairing': {
          if (!managed || typeof this.output.cancelPairing !== 'function') throw new Error('Bluetooth device management is unavailable');
          if (this.pointer || this.calibrating) throw new Error('Pause pointing before managing devices');
          try { await this.output.cancelPairing(); this.error = ''; this.changed(); return; }
          catch (error) { this.error = error.message; this.changed(); throw error; }
        }
        case 'action': {
          if (!this.pointer) throw new Error('Turn pointer on before clicking or scrolling');
          if (!['MOUSE_BTN_1', 'MOUSE_BTN_2', 'MOUSE_WHEEL_1', 'MOUSE_WHEEL_-1'].includes(command.command)) throw new Error('Unsupported action');
          await this.output.sendAction(command.command, generation);
          this.touch(); return;
        }
        default: throw new Error('Unsupported command');
      }
    }).catch(error => {
      if (transfer && this.switching === transfer) {
        this.stop('Switch failed').catch(() => {}); this.error = error.message; this.changed();
      }
      throw error;
    }).finally(() => { this.queued--; });
    this.queue = task.catch(() => {});
    return task;
  }

  async finishSwitch(transfer) {
    const live = () => this.switching === transfer && this.generation === transfer.generation;
    try {
      while (live()) {
        if (!this.nativeControl || !this.output.connected || !this.output.targets.some(t => t.id === transfer.target)) throw new Error('Computer switch interrupted');
        if (this.output.ready(transfer.target)) break;
        if (performance.now() - transfer.started >= this.switchTimeoutMs) throw new Error('Computer did not reconnect; pointing is off');
        await delay(20, undefined, { signal: transfer.abort.signal });
      }
      if (!live()) return;
      this.lastSwitchMs = Math.round(performance.now() - transfer.started);
      if (transfer.resume) await this.apply({ type: 'resume_switch', transfer });
      if (live()) { clearTimeout(transfer.timer); this.switching = null; this.changed(); }
    } catch (error) {
      if (!live()) return;
      this.stop('Switch failed').catch(() => {}); this.error = error.message; this.changed();
    }
  }

  persist(config) { this.save(this.configFile, config); this.config = config; }

  currentTuning() {
    const direct = this.config.target_tuning?.[this.target];
    if (direct) return direct;
    const legacy = this.output.backend === 'owned' && (this.output.deviceManagement !== true
      || this.output.targets.some(target => target.id === this.target && target.legacy));
    return legacy ? this.config.target_tuning?.['airmouse.host'] ?? this.config.target_tuning?.[this.config.selected_target] ?? {} : {};
  }

  async button(button, down) {
    if (![1, 2].includes(button) || typeof down !== 'boolean') throw new Error('Invalid mouse button edge');
    if (!this.output.buttonEdges || typeof this.output.button !== 'function') throw new Error('Mouse button edges are unavailable');
    if (!this.pointer) {
      if (!down) return;
      throw new Error('Turn pointer on before pressing a mouse button');
    }
    const generation = this.generation;
    try {
      await this.output.button(button, down, generation);
      if (this.pointer && generation === this.generation) this.touch();
    } catch (error) {
      if (this.pointer && generation === this.generation) {
        this.error = error.message;
        await this.stop('Button output failed').catch(() => {});
      }
      throw error;
    }
  }

  async activate() {
    if (this.pointer) return;
    const generation = this.generation;
    await this.cleanup.catch(() => this.output.quiesce());
    if (generation !== this.generation) return;
    if (!this.nativeControl || !this.output.ready(this.target)) throw new Error('Control or Bluetooth target unavailable');
    if (!this.rates.includes(this.rate)) throw new Error('Configured sampling rate is unsupported');
    if (this.output.uncertain) throw new Error('Previous output delivery is unresolved');
    try {
      await this.output.prepare?.(this.target);
      if (generation !== this.generation) return;
      this.sensor.begin(this.rate, this.config.motion.active_profile.gyroscope.range_degrees_per_second);
      await yieldIO();
      if (generation !== this.generation) return;
      await this.output.open(this.target, generation);
      if (generation !== this.generation) return;
      this.resume(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error.message; await this.stop('Activation failed'); throw error;
    }
  }

  resume(generation) {
    const targetTuning = this.currentTuning();
    this.filter = new MotionFilter({ ...this.config.motion.filter, ...targetTuning, bias: this.config.motion.bias ?? [0, 0, 0], generation });
    this.sensor.start(generation, samples => {
      if (!this.pointer || generation !== this.generation) return;
      for (const sample of samples) {
        const delta = this.filter.step(sample);
        if (delta && (delta.dx || delta.dy)) { this.output.move(delta); this.touch(); }
      }
    }, error => { this.error = error.message; this.stop('Sensor failed'); });
    this.pointer = true; this.error = ''; this.touch(); this.changed();
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop('Idle timeout'), this.config.motion.idle_timeout_seconds ? this.config.motion.idle_timeout_seconds * 1000 : 60_000);
  }

  async calibrate() {
    await this.stop('Calibration');
    const generation = this.generation;
    this.calibrating = true; this.changed();
    let samples = [], failure;
    try {
      this.sensor.begin(this.rate, this.config.motion.active_profile.gyroscope.range_degrees_per_second);
      this.sensor.start(generation, batch => {
        if (generation === this.generation && samples.length < this.rate * 2) samples.push(...batch);
      }, error => { failure = error; this.stop('Sensor failed'); });
      await delay(1500);
      if (failure) throw failure;
      if (generation !== this.generation) return;
      const bias = calibrate(samples);
      this.persist({ ...this.config, motion: { ...this.config.motion, bias } });
      this.error = '';
    } catch (error) { this.error = error.message; throw error; }
    finally { if (generation === this.generation) await this.stop(this.error ? 'Calibration failed' : 'Calibration complete'); }
  }
}
