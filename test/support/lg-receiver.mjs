// Observed LG OLED77G3PSA receiver contract; see docs/lg-tv.md.
export class LgWakeDetector {
  constructor() {
    this.direction = 0; this.changes = 0; this.samples = 0; this.flat = true;
    this.threshold = 1500; this.timeout = 1000; this.started = null; this.result = 0;
  }

  step([x, y, z], now) {
    if (this.result) return this.result;
    this.started ??= now;
    if (now - this.started > this.timeout) this.result = -1;
    if (this.result) return this.result;
    this.samples++;
    if (this.changes > 3) this.threshold = 1000;
    if (this.changes > 0 && (Math.abs(x) > 3000 || Math.abs(y) > 3000)) this.flat = false;
    if ((Math.abs(x) > 3000 && Math.abs(x) > Math.abs(z)) || (Math.abs(y) > 3000 && Math.abs(y) > Math.abs(z))) return 0;
    if (this.samples > 7 && Math.abs(z) > this.threshold) {
      const direction = z > 0 ? 2 : 1;
      if (direction !== this.direction) {
        this.direction = direction; this.changes++; this.samples = 0; this.timeout = 800;
      }
    }
    if (this.changes >= (this.flat ? 3 : 4)) this.result = 1;
    return this.result;
  }
}
