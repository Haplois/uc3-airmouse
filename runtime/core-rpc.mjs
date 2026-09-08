export class CommandNotSent extends Error {}

export class CoreRpc {
  constructor(ws) {
    this.ws = ws; this.nextID = 2; this.pending = null;
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { this.finish(new Error('Invalid Core response')); return; }
      if (message.kind !== 'resp' || message.req_id !== this.pending?.id) return;
      this.finish(message.code >= 200 && message.code < 300 ? null : new Error(`Core returned ${message.code}`), message);
    });
    ws.on('close', () => this.finish(new Error('Core socket closed')));
    ws.on('error', () => this.finish(new Error('Core socket failed')));
  }

  request(msg, msg_data, timeout = 500) {
    if (this.pending || this.ws.readyState !== 1) return Promise.reject(new CommandNotSent('Core socket unavailable or busy'));
    return new Promise((resolve, reject) => {
      const id = this.nextID++;
      const timer = setTimeout(() => this.finish(new Error('Core response timed out')), timeout);
      this.pending = { id, resolve, reject, timer };
      try { this.ws.send(JSON.stringify({ kind: 'req', id, msg, msg_data })); }
      catch (error) { this.finish(error); }
    });
  }

  finish(error, message) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null; clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(message);
  }
}
