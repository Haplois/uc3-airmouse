import fs from 'node:fs';
import assert from 'node:assert/strict';
import { launcherDriver } from '/mnt/data/airmouse/current/runtime/launcher-integration.mjs';

const base = '/mnt/data/airmouse/state';
const key = fs.readFileSync(`${base}/core-api-key`, 'utf8').trim();
const mode = process.argv[2];
assert.ok(['prepare', 'apply', 'verify'].includes(mode));
async function api(path, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1/api' + path, {
    method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function pages() {
  const result = [];
  for (const profile of await api('/profiles')) result.push(...await api(`/profiles/${encodeURIComponent(profile.profile_id)}/pages`));
  return result;
}
const pagePath = page => `/profiles/${encodeURIComponent(page.profile_id)}/pages/${encodeURIComponent(page.page_id)}`;
let instances = (await api('/intg/instances?limit=100')).filter(i => i.driver_id === 'airmouse');
assert.ok(instances.length <= 1, 'Multiple Air mouse integrations; no layout changes made');
if (mode === 'prepare') {
  const backup = `${base}/native-home-backup-${Date.now()}.json`;
  fs.writeFileSync(backup, JSON.stringify({ pages: await pages(), entities: await api('/entities?limit=100'),
    config: JSON.parse(fs.readFileSync(`${base}/airmouse.json`)) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const drivers = await api('/intg/drivers');
  const driver = drivers.find(d => d.driver_id === 'airmouse');
  if (!driver) await api('/intg/drivers', 'POST', launcherDriver);
  else assert.ok(driver.enabled && driver.driver_url === launcherDriver.driver_url, 'Existing Air mouse driver must use the local launcher service');
  if (!instances.length) {
    await api('/intg/setup', 'POST', { driver_id: 'airmouse', setup_data: {} });
    for (let attempt = 0; attempt < 20 && !instances.length; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      instances = (await api('/intg/instances?limit=100')).filter(i => i.driver_id === 'airmouse');
    }
  }
  assert.equal(instances.length, 1, 'Air mouse integration setup did not complete');
  const prefix = `/intg/instances/${encodeURIComponent(instances[0].integration_id)}`;
  await api(`${prefix}/entities?reload=true&filter=ALL`);
  const entityId = `${instances[0].integration_id}.launch`;
  if (!(await api('/entities?limit=100')).some(e => e.entity_id === entityId)) await api(`${prefix}/entities`, 'POST', ['launch']);
  assert.match(entityId, /^[a-zA-Z0-9_.-]+$/);
  const directory = '/etc/systemd/system/remote-ui-custom.service.d';
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(`${directory}/airmouse-launcher.conf`, `[Service]\nEnvironment=AIRMOUSE_LAUNCH_ENTITY_ID=${entityId}\n`);
  console.log(JSON.stringify({ prepared: true, entity_id: entityId, backup }));
} else {
  assert.equal(instances.length, 1, 'Run prepare first');
  const entityId = `${instances[0].integration_id}.launch`;
  const installed = await api('/system/install/ui');
  assert.ok(installed.active && /^0\.74\.5-airmouse\.(\d+)$/.test(installed.release?.version) &&
    Number(installed.release.version.split('.').at(-1)) >= 9, 'Activate the entity launcher UI first');
  const entities = await api('/entities?limit=100');
  assert.ok(entities.some(e => e.entity_id === entityId && e.entity_type === 'button'), 'Launcher button entity missing');
  const allPages = await pages();
  if (mode === 'apply' && !allPages.some(p => p.items.some(i => i.entity_id === entityId))) {
    const destinations = allPages.filter(p => p.name === 'Living room');
    assert.equal(destinations.length, 1, 'Expected one Living room page for initial placement');
    const destination = await api(pagePath(destinations[0]));
    await api(pagePath(destination), 'PATCH', { items: [...destination.items, { entity_id: entityId }] });
  }
  const after = await pages();
  const placements = after.filter(p => p.items.some(i => i.entity_id === entityId));
  assert.ok(placements.length, 'Launcher entity is not placed on a page');
  console.log(JSON.stringify({ entity_id: entityId, entity_type: 'button', pages: placements.map(p => p.name) }));
}
