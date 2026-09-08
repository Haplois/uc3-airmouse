import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export const launcherEntity = {
  entity_id: 'launch', entity_type: 'button', name: { en: 'Air mouse' },
  icon: 'uc:remote', features: [], attributes: { state: 'AVAILABLE' },
};
export const launcherDriver = {
  driver_id: 'airmouse', version: '0.2.0', min_core_api: '0.18.1',
  name: { en: 'Air mouse' }, description: { en: 'Launch the native Air mouse app' },
  icon: 'uc:remote', driver_url: 'ws://127.0.0.1:9989', enabled: true,
  device_discovery: false, setup_data_schema: {}, release_date: '2026-09-08',
};

export class LauncherIntegration {
  constructor({ port = 9989, log = message => console.error(message) } = {}) {
    this.failure = null;
    this.server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    this.wss = new WebSocketServer({ server: this.server, maxPayload: 16384, perMessageDeflate: false });
    // The launcher only serves Core's discovery of one button. Losing it must not stop an active mouse
    // session. ws re-emits HTTP server errors on the WebSocket server, so that is the one place to listen.
    this.wss.on('error', error => { this.failure = error; log(`Launcher integration unavailable: ${error.message}`); });
    this.wss.on('connection', ws => this.connect(ws));
    this.server.listen(port, '127.0.0.1');
  }
  send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 65536) { ws.terminate(); return; }
    ws.send(JSON.stringify(message));
  }
  event(ws, msg, msg_data, cat = 'DEVICE') { this.send(ws, { kind: 'event', msg, cat, msg_data }); }
  connect(ws) {
    let subscribed = false, alive = true;
    this.send(ws, { kind: 'resp', req_id: 0, msg: 'authentication', code: 200, msg_data: {} });
    ws.on('error', () => {});
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 2000);
    ws.on('close', () => clearInterval(heartbeat));
    ws.on('message', bytes => {
      let request;
      try { request = JSON.parse(bytes.toString()); } catch { ws.close(1007); return; }
      if (!request || typeof request !== 'object') { ws.close(1007); return; }
      if (request.kind === 'event') {
        if (request.msg === 'connect') this.event(ws, 'device_state', { state: 'CONNECTED' });
        return;
      }
      if (request.kind !== 'req' || !Number.isSafeInteger(request.id)) return;
      const reply = (msg, msg_data = {}, code = 200) => this.send(ws, { kind: 'resp', req_id: request.id, msg, code, msg_data });
      const ids = request.msg_data?.entity_ids;
      switch (request.msg) {
        case 'get_driver_version': reply('driver_version', { name: 'Air mouse', version: { api: '0.18.1', driver: '0.2.0' } }); break;
        case 'get_driver_metadata': reply('driver_metadata', launcherDriver); break;
        case 'get_device_state': reply('device_state', { state: 'CONNECTED' }); break;
        case 'get_available_entities': reply('available_entities', { available_entities: [launcherEntity] }); break;
        case 'get_entity_states': reply('entity_states', subscribed ? [launcherEntity] : []); break;
        case 'subscribe_events':
        case 'unsubscribe_events':
          if (!Array.isArray(ids)) { reply('result', {}, 400); break; }
          if (ids.includes('launch')) subscribed = request.msg === 'subscribe_events';
          reply('result');
          if (subscribed) this.event(ws, 'entity_change', launcherEntity, 'ENTITY');
          break;
        case 'setup_driver':
          reply('result');
          this.event(ws, 'driver_setup_change', { event_type: 'STOP', state: 'OK' });
          break;
        default:
          reply('result', { message: 'Launch this entity locally in the custom Remote UI' }, 501);
      }
    });
  }
  close() {
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close(); this.server.close();
  }
}
