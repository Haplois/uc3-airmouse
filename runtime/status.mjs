import fs from 'node:fs/promises';

export class StatusSnapshot {
  constructor(file, { write = fs.writeFile, rename = fs.rename, onError = error => console.error(`Status snapshot: ${error.message}`) } = {}) {
    Object.assign(this, { file, write, rename, onError });
    this.pending = null;
    this.running = null;
  }

  publish(state) {
    this.pending = JSON.stringify(state) + '\n';
    if (!this.running) this.start();
  }

  start() {
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.pending !== null) this.start();
    });
  }

  async drain() {
    while (this.pending !== null) {
      const content = this.pending;
      this.pending = null;
      try {
        await this.write(`${this.file}.tmp`, content, { mode: 0o600 });
        await this.rename(`${this.file}.tmp`, this.file);
      } catch (error) { this.onError(error); }
    }
  }

  async flush() {
    while (this.running) await this.running;
  }
}
