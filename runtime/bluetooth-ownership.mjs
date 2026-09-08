import fs from 'node:fs';
import path from 'node:path';

// The service runs unprivileged. It asks for a Bluetooth takeover or release by writing one word
// into its runtime directory; a root systemd path unit runs deploy/owned-bluetooth.sh `request`,
// which accepts only those two words. The helper writes `bluetooth-request.failed` there when a
// takeover fails or Bluetooth was released by an explicit rollback, which holds automatic
// requests until the app is opened again or the setting changes.
export const ownershipModes = ['always', 'session', 'never'];

export class OwnershipRequests {
  constructor({ dir = '/run/airmouse', helper = '/mnt/data/airmouse/bluetooth/owned-bluetooth.sh' } = {}) {
    this.dir = dir; this.helper = helper;
    this.file = path.join(dir, 'bluetooth-request');
    this.marker = path.join(dir, 'bluetooth-request.failed');
  }
  installed() { return fs.existsSync(this.helper); }
  failed() {
    try { return fs.readFileSync(this.marker, 'utf8').trim() || 'Bluetooth takeover failed'; }
    catch { return ''; }
  }
  clearFailed() { fs.rmSync(this.marker, { force: true }); }
  pending() { return fs.existsSync(this.file); }
  request(kind) {
    if (!['takeover', 'rollback'].includes(kind)) throw new Error('Unknown Bluetooth ownership request');
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${kind}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  cancel() { fs.rmSync(this.file, { force: true }); }
}
