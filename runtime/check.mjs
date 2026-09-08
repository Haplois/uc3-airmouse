import fs from 'node:fs';
import assert from 'node:assert/strict';
import { readText, readJSON } from './storage.mjs';

const stateDir = '/mnt/data/airmouse/state';
async function api(endpoint, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1/api${endpoint}`, { method, headers: { Authorization: `Bearer ${readText(`${stateDir}/core-api-key`)}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  return response.json();
}
const instances = (await api('/intg/instances?limit=100')).filter(i => i.driver_id === 'airmouse');
const entities = (await api('/entities?limit=100')).filter(e => e.integration_id === 'airmouse.main' || instances.some(i => e.integration_id === i.integration_id));
if (process.argv[2] === 'inspect') {
  console.log(JSON.stringify({ instances, entities, power: await api('/system/power') }, null, 2));
} else {
  assert.equal(instances.length, 1, 'Expected one Air mouse launcher integration');
  const launcher = `${instances[0].integration_id}.launch`;
  assert.deepEqual(entities.map(e => [e.entity_id, e.entity_type]), [[launcher, 'button']], 'Only the launcher button may remain');
  const installed = await api('/system/install/ui');
  assert.ok(installed.active, 'Custom native UI is not active');
  const pages = [];
  for (const profile of await api('/profiles')) pages.push(...await api(`/profiles/${encodeURIComponent(profile.profile_id)}/pages`));
  const placements = pages.filter(page => page.items.some(item => item.entity_id === launcher));
  assert.ok(placements.length, 'Launcher button is not placed on a page');
  assert.ok(pages.every(page => page.items.every(item => item.entity_id === launcher || !item.entity_id?.startsWith('airmouse.main.'))), 'Legacy Air mouse page items remain');
  assert.ok(fs.statSync('/mnt/data/airmouse/ui/control.sock').isSocket());
  console.log(JSON.stringify({ native_ui_active: true, launcher_entity: launcher, pages: placements.map(p => p.name), pointer: readJSON(`${stateDir}/status.json`).pointer }));
}
