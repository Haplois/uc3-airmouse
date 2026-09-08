import fs from 'node:fs';
import { readText } from './storage.mjs';

const base = '/mnt/data/airmouse/state';
const keyFile = `${base}/core-api-key`;
const mode = process.argv[2] ?? 'key';
let authorization;
if (mode === 'key' && !fs.existsSync(keyFile)) {
  const pin = fs.readFileSync(0, 'utf8').trim();
  if (!/^\d{4}$/.test(pin)) throw new Error('Expected current Web Config PIN on stdin');
  const response = await fetch('http://127.0.0.1/api/auth/api_keys', {
    method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`web-configurator:${pin}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Remote 3 air mouse', scopes: ['admin'], active: true }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`API key provisioning returned HTTP ${response.status}`);
  const result = await response.json();
  if (!result.api_key) throw new Error('Missing API key');
  fs.writeFileSync(keyFile, result.api_key + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ key_stored: true, active: result.active }));
}
authorization = `Bearer ${readText(keyFile)}`;
async function api(endpoint, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1/api${endpoint}`, {
    method, headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Core ${endpoint} returned HTTP ${response.status}. Check API-key approval on the remote.`);
  return response.status === 204 ? null : response.json();
}
if (mode === 'targets') {
  console.log(JSON.stringify(await api('/remotes?kind=BT&limit=100'), null, 2));
} else {
  await api('/system');
  console.log('Persistent Core API key is active.');
}
