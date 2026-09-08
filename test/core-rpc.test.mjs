import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CoreRpc } from '../runtime/core-rpc.mjs';

function setup(t) {
  const ws = new EventEmitter(); ws.readyState = 1; ws.sent = [];
  ws.send = text => ws.sent.push(JSON.parse(text));
  const rpc = new CoreRpc(ws);
  t.after(() => ws.emit('close'));
  const reply = (req_id, code = 200) => ws.emit('message', JSON.stringify({ kind: 'resp', req_id, code }));
  return { ws, rpc, reply };
}

test('Core commands reuse the connection and wait for their own response', async t => {
  const { ws, rpc, reply } = setup(t);
  const data = { entity_id: 'host.a', cmd_id: 'remote.send_cmd', params: { command: 'MOUSE_X_1' } };
  const result = rpc.request('execute_entity_command', data);
  assert.deepEqual(ws.sent, [{ kind: 'req', id: 2, msg: 'execute_entity_command', msg_data: data }]);
  reply(1); assert.ok(rpc.pending);
  await assert.rejects(rpc.request('execute_entity_command', data), /busy/);
  reply(2); await result;
  assert.equal(rpc.pending, null);
});

test('Core response timeout is bounded and never replays a command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ws, rpc, reply } = setup(t);
  const result = rpc.request('execute_entity_command', {});
  const failed = assert.rejects(result, /timed out/);
  t.mock.timers.tick(500); await failed;
  reply(2);
  assert.equal(ws.sent.length, 1); assert.equal(rpc.pending, null);
});

test('Core errors and socket loss reject pending commands', async t => {
  const { ws, rpc, reply } = setup(t);
  const first = rpc.request('execute_entity_command', {});
  const rejected = assert.rejects(first, /503/); reply(2, 503); await rejected;
  const second = rpc.request('execute_entity_command', {});
  const lost = assert.rejects(second, /closed/); ws.emit('close'); await lost;
  assert.equal(rpc.pending, null);
});
