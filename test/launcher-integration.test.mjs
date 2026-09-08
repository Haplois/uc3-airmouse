import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { LauncherIntegration } from '../runtime/launcher-integration.mjs';

test('Core discovers and subscribes to one launcher without controlling pointing', async t => {
  const integration = new LauncherIntegration({ port: 0 });
  t.after(() => integration.close());
  await once(integration.server, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${integration.server.address().port}`);
  const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  t.after(() => ws.terminate());
  await once(ws, 'open');
  let id = 0;
  async function request(msg, msg_data = {}) {
    const pending = ++id;
    ws.send(JSON.stringify({ kind: 'req', id: pending, msg, msg_data }));
    while (!messages.some(m => m.req_id === pending)) await once(ws, 'message');
    return messages.find(m => m.req_id === pending);
  }
  const available = await request('get_available_entities');
  assert.deepEqual(available.msg_data.available_entities.map(e => [e.entity_id, e.entity_type]), [['launch', 'button']]);
  assert.deepEqual((await request('get_entity_states')).msg_data, []);
  assert.equal((await request('subscribe_events', { entity_ids: ['launch'] })).code, 200);
  assert.equal((await request('get_entity_states')).msg_data[0].attributes.state, 'AVAILABLE');
  ws.send(JSON.stringify({ kind: 'event', msg: 'enter_standby' }));
  assert.equal((await request('get_device_state')).msg_data.state, 'CONNECTED');
  assert.equal((await request('entity_command', { entity_id: 'launch', entity_type: 'button', cmd_id: 'button.push' })).code, 501);
  assert.equal((await request('subscribe_events', { entity_ids: 'launch' })).code, 400);
  await request('unsubscribe_events', { entity_ids: ['launch'] });
  assert.deepEqual((await request('get_entity_states')).msg_data, []);
});

test('a launcher port conflict is reported without stopping the service', async t => {
  const occupant = new LauncherIntegration({ port: 0 });
  t.after(() => occupant.close());
  await once(occupant.server, 'listening');
  const messages = [];
  const integration = new LauncherIntegration({ port: occupant.server.address().port, log: message => messages.push(message) });
  t.after(() => integration.close());
  await once(integration.wss, 'error');
  assert.equal(integration.failure.code, 'EADDRINUSE');
  assert.match(messages[0], /Launcher integration unavailable/);
});
