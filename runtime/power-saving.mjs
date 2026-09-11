import fs from 'node:fs';

export class MotionActivity {
  constructor(bias = [0, 0, 0]) { this.bias = bias; this.accel = null; }
  moving(sample) {
    const rotating = sample.gyro.some((value, axis) => Math.abs(value - this.bias[axis]) > 0.035);
    const translating = this.accel && sample.accel.some((value, axis) => Math.abs(value - this.accel[axis]) > 0.8);
    this.accel = this.accel ? this.accel.map((value, axis) => value * .98 + sample.accel[axis] * .02) : [...sample.accel];
    return rotating || !!translating;
  }
}

// Leases expire even if the service crashes. Screen idle remains independent of standby.
export class StandbyLease {
  constructor({ stateDir, request, onError = console.error, refreshMs = 5000 } = {}) {
    this.request = request ?? (async (endpoint, method, body) => {
      const key = fs.readFileSync(`${stateDir}/core-api-key`, 'utf8').trim();
      const response = await fetch(`http://127.0.0.1/api/system/power/standby_inhibitors${endpoint}`, {
        method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000),
      });
      if (!response.ok && response.status !== 404) throw new Error(`Standby lease: HTTP ${response.status}`);
      return response.ok ? response.json() : {};
    });
    this.onError = onError; this.refreshMs = refreshMs; this.active = false;
    this.queue = Promise.resolve(); this.ids = new Set();
  }
  update(active) {
    if (this.active === active) return;
    this.active = active;
    clearInterval(this.timer); this.timer = null;
    if (active) this.timer = setInterval(() => this.refresh(), this.refreshMs);
    this.refresh();
  }
  refresh() {
    if (this.pending) return this.queue;
    this.pending = true;
    this.queue = this.queue.then(async () => {
      const previous = [...this.ids];
      if (this.active) {
        const result = await this.request('', 'POST', { who: 'Air mouse', why: 'Motion input active', delay: 15 });
        if (typeof result.id !== 'string') throw new Error('Standby lease missing identifier');
        this.ids.add(result.id);
      }
      for (const id of this.active ? previous : [...this.ids]) {
        await this.request(`/${encodeURIComponent(id)}`, 'DELETE'); this.ids.delete(id);
      }
    }).catch(this.onError).finally(() => {
      this.pending = false;
      if (!this.active && this.ids.size) {
        // Failed deletion is bounded by the server's 15-second expiry.
        this.ids.clear();
      }
    });
    return this.queue;
  }
  async close() { this.update(false); await this.queue; if (this.ids.size) await this.refresh(); }
}
