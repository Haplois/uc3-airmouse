import net from 'node:net';
import fs from 'node:fs';

const peerPattern = /^[0-9a-f]{8}$/;
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/u;

function exactFields(command, expected) {
  return Object.keys(command).sort().join(',') === [...expected].sort().join(',');
}

function validName(value) {
  return typeof value === 'string' && value.isWellFormed() && !controlPattern.test(value) && Buffer.byteLength(value, 'utf8') <= 48;
}

// Access is granted by a 2750 airmouse:ucui directory and a 0660 socket.
export class NativeUI {
  constructor(controller, path, { heartbeatMs = 500, leaseMs = 2500 } = {}) {
    this.controller = controller; this.owner = null;
    if (fs.existsSync(path)) {
      if (!fs.lstatSync(path).isSocket()) throw new Error('Native UI path is not a socket');
      fs.unlinkSync(path);
    }
    this.server = net.createServer(socket => this.connect(socket, leaseMs));
    this.server.on('error', error => { console.error(`Native UI: ${error.message}`); this.owner?.destroy(); });
    this.server.listen(path, () => fs.chmodSync(path, 0o660));
    this.timer = setInterval(() => this.publish(), heartbeatMs);
  }
  send(socket, message) {
    if (socket.destroyed) return;
    if (socket.writableLength > 65536) return socket.destroy();
    socket.write(JSON.stringify(message) + '\n');
  }
  publish() {
    if (this.owner) this.send(this.owner, { state: this.controller.state(), version: 1 });
  }
  connect(socket, leaseMs) {
    socket.on('error', () => {});
    if (this.owner) { socket.destroy(); return; }
    this.owner = socket; this.controller.acquireControl();
    let buffer = '', highest = 0, busy = false, buttonPending = 0, epoch = 0, lastSeen = performance.now();
    socket.setEncoding('utf8');
    const lease = setInterval(() => { if (performance.now() - lastSeen >= leaseMs) socket.destroy(); }, Math.min(500, leaseMs / 2));
    socket.on('close', () => {
      epoch++; clearInterval(lease);
      if (this.owner !== socket) return;
      this.owner = null;
      this.controller.releaseControl('Air mouse screen closed').catch(() => {});
    });
    socket.on('data', chunk => {
      lastSeen = performance.now(); buffer += chunk;
      if (buffer.length > 16384) return socket.destroy();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let command;
        try { command = JSON.parse(raw); } catch { socket.destroy(); return; }
        if (command?.type === 'ping') continue;
        if (!Number.isSafeInteger(command?.id) || command.id <= highest) { socket.destroy(); return; }
        highest = command.id;
        const reply = (ok, error) => this.send(socket, { id: command.id, ok, error });
        if (command.type === 'off') {
          epoch++;
          const reason = ['Paused for Settings', 'Paused to choose a device', 'Paused for calibration', 'Paused for standby', 'Pointer off'].includes(command.reason) ? command.reason : 'Pointer off';
          this.controller.stop(reason).then(() => { this.publish(); reply(true); }, error => { this.publish(); reply(false, error.message); });
          continue;
        }
        if (command.type === 'button') {
          const fields = Object.keys(command).sort().join(',');
          if (fields !== 'button,down,id,type' || ![1, 2].includes(command.button) || typeof command.down !== 'boolean') {
            reply(false, 'Invalid mouse button edge'); continue;
          }
          if (buttonPending >= 16) { socket.destroy(); continue; }
          buttonPending++;
          this.controller.button(command.button, command.down)
            .then(() => reply(true), error => reply(false, error.message))
            .finally(() => { buttonPending--; this.publish(); });
          continue;
        }
        if (busy) { reply(false, 'Previous action is still completing'); continue; }
        busy = true;
        const current = epoch;
        this.apply(command, () => current === epoch && !socket.destroyed).then(() => reply(true), error => reply(false, error.message)).finally(() => { busy = false; this.publish(); });
      }
    });
    this.publish();
  }
  async apply(command, live) {
    const controller = this.controller;
    if (command.type === 'on') {
      if (controller.pointer) return;
      await controller.apply({ type: 'output_policy', rate: controller.outputRate });
      if (live()) await controller.apply({ type: 'on' });
    } else if (command.type === 'target' && typeof command.target === 'string'
        && (exactFields(command, ['id', 'target', 'type']) || (exactFields(command, ['id', 'keep_pointer', 'target', 'type']) && typeof command.keep_pointer === 'boolean'))) {
      await controller.apply({ type: 'target', id: command.target, ...(command.keep_pointer === undefined ? {} : { keep_pointer: command.keep_pointer }) });
    } else if (['theme', 'speed', 'calibrate'].includes(command.type)) {
      await controller.apply(command);
    } else if (command.type === 'bluetooth_ownership' && exactFields(command, ['id', 'mode', 'type']) && typeof command.mode === 'string') {
      await controller.apply({ type: 'bluetooth_ownership', mode: command.mode });
    } else if (command.type === 'swap_click_buttons' && exactFields(command, ['id', 'swapped', 'type']) && typeof command.swapped === 'boolean') {
      await controller.apply({ type: 'swap_click_buttons', swapped: command.swapped });
    } else if (command.type === 'output_rate') {
      await controller.apply({ type: 'output_policy', rate: command.rate });
    } else if (command.type === 'media' && exactFields(command, ['id', 'type', 'key'])) {
      await controller.apply({ type: 'media', key: command.key });
    } else if (command.type === 'key' && exactFields(command, ['id', 'type', 'key']) && ['up', 'down', 'left', 'right'].includes(command.key)) {
      await controller.apply({ type: 'key', key: command.key });
    } else if (command.type === 'disconnect' && exactFields(command, ['id', 'type'])) {
      await controller.apply({ type: 'disconnect' });
    } else if (command.type === 'pair' && exactFields(command, ['id', 'type'])) {
      await controller.apply({ type: 'pair' });
    } else if (command.type === 'rename' && exactFields(command, ['id', 'name', 'target', 'type'])
        && typeof command.target === 'string' && peerPattern.test(command.target) && validName(command.name)) {
      await controller.apply({ type: 'rename', id: command.target, name: command.name });
    } else if (command.type === 'reorder' && exactFields(command, ['id', 'targets', 'type']) && Array.isArray(command.targets)
        && command.targets.length <= 4 && new Set(command.targets).size === command.targets.length
        && command.targets.every(target => typeof target === 'string' && peerPattern.test(target))) {
      await controller.apply({ type: 'reorder', ids: command.targets });
    } else if (command.type === 'forget' && exactFields(command, ['id', 'target', 'type'])
        && typeof command.target === 'string' && peerPattern.test(command.target)) {
      await controller.apply({ type: 'forget', id: command.target });
    } else if (command.type === 'cancel_pairing' && exactFields(command, ['id', 'type'])) {
      await controller.apply({ type: 'cancel_pairing' });
    } else if (command.type === 'click' && [1, 2].includes(command.button) && !controller.output.buttonEdges) {
      await controller.apply({ type: 'action', command: `MOUSE_BTN_${command.button}` });
    } else if (command.type === 'scroll' && [-1, 1].includes(command.direction)) {
      await controller.apply({ type: 'action', command: `MOUSE_WHEEL_${-command.direction}` });
    } else throw new Error('Unsupported native UI command');
  }
  close() {
    clearInterval(this.timer); this.owner?.destroy(); this.server.close();
  }
}
