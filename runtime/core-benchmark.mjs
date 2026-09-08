import fs from 'node:fs';
import WebSocket from 'ws';
const stateDir = '/mnt/data/airmouse/state';
const key = fs.readFileSync(`${stateDir}/core-api-key`, 'utf8').trim();
const { selected_target: entity_id } = JSON.parse(fs.readFileSync(`${stateDir}/airmouse.json`, 'utf8'));
if (!entity_id) throw new Error('No selected target');
const ws = new WebSocket('ws://127.0.0.1/ws', { headers: { 'API-KEY': key }, handshakeTimeout: 3000, maxPayload: 1024 * 1024 });
let finishAuth, failAuth, pending, id = 1;
const authenticated = new Promise((resolve, reject) => { finishAuth = resolve; failAuth = reject; });
const deadline = setTimeout(() => { failAuth(new Error('Benchmark timed out')); pending?.reject(new Error('Benchmark timed out')); ws.terminate(); }, 15000);
ws.on('error', error => { failAuth(error); pending?.reject(error); });
ws.on('close', () => { failAuth(new Error('Socket closed')); pending?.reject(new Error('Socket closed')); });
ws.on('message', raw => {
  const message = JSON.parse(raw);
  if (message.msg === 'authentication') return message.code === 200 ? finishAuth() : failAuth(new Error('Authentication failed'));
  if (message.kind === 'resp' && message.req_id === pending?.id) {
    if (message.code === 200) pending.resolve(); else pending.reject(new Error(`Core returned ${message.code}`));
  }
});
const summarize = values => { values.sort((a, b) => a - b); return { count: values.length, p50_ms: values[Math.floor(values.length * .5)], p95_ms: values[Math.floor(values.length * .95)], max_ms: values.at(-1) }; };
try {
  await authenticated;
  const http = [], socket = [];
  for (let i = 0; i < 40; i++) {
    let start = performance.now();
    const response = await fetch(`http://127.0.0.1/api/entities/${encodeURIComponent(entity_id)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.json();
    http.push(performance.now() - start);
    start = performance.now();
    await new Promise((resolve, reject) => {
      pending = { id: id++, resolve, reject };
      ws.send(JSON.stringify({ kind: 'req', id: pending.id, msg: 'get_entity', msg_data: { entity_id } }));
    });
    pending = null;
    socket.push(performance.now() - start);
  }
  console.log(JSON.stringify({ read_only: true, http: summarize(http.slice(1)), websocket: summarize(socket.slice(1)) }));
} finally { clearTimeout(deadline); pending = null; ws.terminate(); }
