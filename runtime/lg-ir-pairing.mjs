import fs from 'node:fs';

const registration = JSON.parse(fs.readFileSync(new URL('../config/ir/lg-mr23-pairing.json', import.meta.url), 'utf8'));

export class LGIRPairing {
  constructor({ stateDir, request = fetch }) {
    this.stateDir = stateDir;
    this.request = request;
  }

  async api(path, method, body, signal) {
    signal.throwIfAborted();
    const keyFile = `${this.stateDir}/core-api-key`;
    if ((fs.statSync(keyFile).mode & 0o077) !== 0) throw new Error('Core API key permissions must be 0600');
    const response = await this.request(`http://127.0.0.1/api${path}`, {
      method, redirect: 'error',
      headers: { Authorization: `Bearer ${fs.readFileSync(keyFile, 'utf8').trim()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) throw new Error(`IR pairing returned HTTP ${response.status}`);
    return method === 'GET' ? response.json() : null;
  }

  async pair(output, signal) {
    const emitters = await this.api('/ir/emitters?active=true', 'GET', undefined, signal);
    const internal = emitters.filter(emitter => emitter.type === 'INTERNAL' && emitter.active);
    if (internal.length !== 1 || typeof internal[0].device_id !== 'string' || !internal[0].device_id) {
      throw new Error('Remote 3 infrared output is unavailable');
    }
    signal.throwIfAborted();
    try {
      await output.pair('lg-tv');
      await output.waitForPairing({ signal });
      signal.throwIfAborted();
      await this.api(`/ir/emitters/${encodeURIComponent(internal[0].device_id)}/send`, 'PUT', {
        format: registration.format, code: registration.code, repeat: registration.repeat,
      }, signal);
    } catch (error) {
      try { await output.cancelPairing(); }
      catch { throw new Error(`${error.message}; Bluetooth pairing could not be cancelled`); }
      throw error;
    }
  }
}
