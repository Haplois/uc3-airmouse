import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { CoreOutput } from '../runtime/output.mjs';
import { CoreRpc } from '../runtime/core-rpc.mjs';
import { fakeSensor } from './helpers.mjs';

function setup(t, request = async () => new Response('{}', { status: 200 }), options = {}) {
  const { dir } = fakeSensor(t);
  fs.writeFileSync(`${dir}/core-api-key`, 'test-only', { mode: 0o600 });
  const output = new CoreOutput({ stateDir: dir, request, ...options });
  output.execute = (id, command) => output.api(`/entities/${encodeURIComponent(id)}/command`, 'PUT', { cmd_id: 'remote.send_cmd', params: { command } }, 500);
  if (!options.paced) clearInterval(output.pace); t.after(() => output.close());
  output.connected = true; output.awake = true;
  output.targets = [{ id: 'host.a', ready: true, peer: 'test' }];
  output.open('host.a', 1);
  return { output, dir };
}

test('diagonal output is bounded and routed explicitly to one entity', async t => {
  const sent = [];
  const { output } = setup(t, async (url, request) => { sent.push([url, JSON.parse(request.body)]); return new Response('{}'); });
  output.move({ generation: 1, time: Number(process.hrtime.bigint()) / 1e9, dx: 500, dy: -500 });
  output.flush(); await output.busy;
  assert.deepEqual(sent.map(s => s[1].params.command), ['MOUSE_X_127', 'MOUSE_Y_-127']);
  assert.ok(sent.every(s => s[0].endsWith('/entities/host.a/command')));
  assert.equal(output.latencies.length, 2);
  assert.equal(output.metrics().acknowledged_movement_updates, 1);
});

test('400 Hz pacing alternates fractional periods without rounding the cap down to 333 Hz', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0; const times = [];
  const { output } = setup(t, async () => { times.push(now); return new Response('{}'); }, { clock: () => now, movementRateHz: 400 });
  output.move({ generation: 1, time: 0, dx: 1, dy: 0 }); output.flush(); await output.busy;
  for (now = 1; now <= 20; now++) {
    output.move({ generation: 1, time: now / 1000, dx: 1, dy: 0 });
    t.mock.timers.tick(1); await output.busy; await Promise.resolve();
  }
  assert.deepEqual(times, [0, 3, 5, 8, 10, 13, 15, 18, 20]);
});

test('raising the live output cap reschedules pending movement and a stall does not cause a catch-up burst', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0; const times = [];
  const { output } = setup(t, async () => { times.push(now); return new Response('{}'); }, { clock: () => now, movementRateHz: 100 });
  output.move({ generation: 1, time: 0, dx: 1, dy: 0 }); output.flush(); await output.busy;
  output.move({ generation: 1, time: 0, dx: 1, dy: 0 });
  output.setMovementRate(1000);
  now = 1; t.mock.timers.tick(1); await output.busy;
  assert.deepEqual(times, [0, 1]);
  now = 30;
  output.move({ generation: 1, time: now / 1000, dx: 1, dy: 0 });
  t.mock.timers.tick(29); await output.busy;
  assert.deepEqual(times, [0, 1, 30]);
  assert.equal(output.nextMovement, 31);
});
test('stop during X acknowledgement suppresses old Y and pending motion', async t => {
  let finish; const sent = [];
  const { output } = setup(t, (url, request) => { sent.push(JSON.parse(request.body).params.command); return new Promise(resolve => { finish = () => resolve(new Response('{}')); }); });
  const send = output.send(['MOUSE_X_10', 'MOUSE_Y_10'], 1);
  output.invalidate(2); finish(); await send;
  assert.deepEqual(sent, ['MOUSE_X_10']);
  assert.equal(output.pending, null);
});

test('the WebSocket movement path suppresses Y after stop without HTTP fallback', async t => {
  const { output } = setup(t, () => { throw new Error('Unexpected HTTP command'); });
  const ws = new EventEmitter(); ws.readyState = 1; const sent = [];
  ws.send = text => sent.push(JSON.parse(text));
  output.rpc = new CoreRpc(ws); output.execute = CoreOutput.prototype.execute;
  const movement = output.send(['MOUSE_X_10', 'MOUSE_Y_10'], 1);
  assert.equal(sent[0].msg, 'execute_entity_command');
  assert.equal(sent[0].msg_data.entity_id, 'host.a');
  output.invalidate(2);
  ws.emit('message', JSON.stringify({ kind: 'resp', req_id: sent[0].id, code: 200 }));
  await movement;
  assert.deepEqual(sent.map(m => m.msg_data.params.command), ['MOUSE_X_10']);
});

test('a lost WebSocket click is marked uncertain and is not retried over HTTP', async t => {
  const { output } = setup(t, () => { throw new Error('Unexpected HTTP fallback'); });
  const ws = new EventEmitter(); ws.readyState = 1; let sent = 0;
  ws.send = () => { sent++; };
  output.rpc = new CoreRpc(ws); output.execute = CoreOutput.prototype.execute;
  const click = output.sendAction('MOUSE_BTN_1', 1);
  const failed = assert.rejects(click, /uncertain/);
  ws.emit('close'); await failed;
  assert.equal(output.uncertain, true); assert.equal(sent, 1);
  await assert.rejects(output.sendAction('MOUSE_BTN_1', 1), /unavailable/);
});
test('ambiguous click is never retried and uncertainty survives restart', async t => {
  let calls = 0;
  const { output, dir } = setup(t, async () => { calls++; throw new Error('timeout'); });
  await assert.rejects(output.send(['MOUSE_BTN_1'], 1), /uncertain/);
  await assert.rejects(output.send(['MOUSE_BTN_1'], 1), /unavailable/);
  assert.equal(calls, 1); assert.equal(output.uncertain, true);
  const next = new CoreOutput({ stateDir: dir }); t.after(() => next.close());
  assert.equal(next.uncertain, true);
});

test('a physical click waits for movement and is sent exactly once', async t => {
  const sent = []; let finish;
  const { output } = setup(t, (url, request) => {
    sent.push(JSON.parse(request.body).params.command);
    if (sent.length === 1) return new Promise(resolve => { finish = () => resolve(new Response('{}')); });
    return Promise.resolve(new Response('{}'));
  });
  const movement = output.send(['MOUSE_X_10', 'MOUSE_Y_10'], 1);
  const click = output.sendAction('MOUSE_BTN_1', 1);
  assert.deepEqual(sent, ['MOUSE_X_10']);
  finish(); await Promise.all([movement, click]);
  assert.deepEqual(sent, ['MOUSE_X_10', 'MOUSE_Y_10', 'MOUSE_BTN_1']);
});

test('stop cancels a click waiting for movement', async t => {
  const sent = []; let finish;
  const { output } = setup(t, (url, request) => {
    sent.push(JSON.parse(request.body).params.command);
    return new Promise(resolve => { finish = () => resolve(new Response('{}')); });
  });
  const movement = output.send(['MOUSE_X_10'], 1);
  const click = output.sendAction('MOUSE_BTN_2', 1);
  const cancelled = assert.rejects(click, /unavailable/);
  output.invalidate(2); finish();
  await Promise.all([movement, cancelled]);
  assert.deepEqual(sent, ['MOUSE_X_10']);
});
test('stale samples cannot enter a later session and target switch requires proof', async t => {
  const { output } = setup(t);
  output.invalidate(2);
  output.move({ generation: 1, time: Number(process.hrtime.bigint()) / 1e9, dx: 1, dy: 1 });
  output.move({ generation: 2, time: 1, dx: 1, dy: 1 });
  assert.equal(output.pending, null);
  output.used = true;
  await assert.rejects(output.quiesce({ switching: true }), /isolation/);
});
test('frequent movement ticks retain one bounded batch while Core is slow', async t => {
  const sent = []; let finish;
  const { output } = setup(t, (url, request) => {
    sent.push(JSON.parse(request.body).params.command);
    return new Promise(resolve => { finish = () => resolve(new Response('{}')); });
  });
  const move = () => output.move({ generation: 1, time: Number(process.hrtime.bigint()) / 1e9, dx: 10, dy: 0 });
  move(); output.flush();
  for (let i = 0; i < 20; i++) { move(); output.flush(); }
  assert.deepEqual(sent, ['MOUSE_X_10']);
  assert.equal(output.pending.dx, 127);
  finish(); await output.busy;
  output.flush();
  assert.deepEqual(sent, ['MOUSE_X_10', 'MOUSE_X_127']);
  finish(); await output.busy;
  assert.equal(output.pending, null);
});

test('unchanged Bluetooth events do not republish status during pointer movement', t => {
  const { output } = setup(t);
  let publications = 0;
  const socket = new EventEmitter();
  socket.terminate = () => socket.emit('close');
  output.socketFactory = () => socket;
  output.onState = () => publications++;
  output.start();
  for (let i = 0; i < 80; i++) {
    socket.emit('message', Buffer.from(JSON.stringify({ kind: 'event', msg: 'entity_change', msg_data: {
      entity_id: 'host.a', attributes: { state: 'UNKNOWN' },
    } })));
  }
  assert.equal(publications, 0, 'Repeated ready events must not trigger disk writes and UI updates on the movement path');
  socket.emit('message', Buffer.from(JSON.stringify({ kind: 'event', msg: 'entity_change', msg_data: {
    entity_id: 'host.a', attributes: { state: 'UNAVAILABLE' },
  } })));
  assert.equal(publications, 1);
  assert.equal(output.ready('host.a'), false);
});

test('fresh movement resumes after a delayed acknowledgement without waiting for another polling tick', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = Number(process.hrtime.bigint()) / 1e6, finish;
  const sent = [];
  const { output } = setup(t, (url, request) => {
    sent.push(JSON.parse(request.body).params.command);
    if (sent.length === 1) return new Promise(resolve => { finish = () => resolve(new Response('{}')); });
    return Promise.resolve(new Response('{}'));
  }, { paced: true, clock: () => now });
  output.move({ generation: 1, time: now / 1000, dx: 2, dy: 0 });
  output.flush();
  const first = output.busy;
  now += 30; t.mock.timers.tick(30);
  output.move({ generation: 1, time: now / 1000, dx: 3, dy: 0 });
  finish(); await first; await Promise.resolve();
  now += 1; t.mock.timers.tick(1);
  assert.deepEqual(sent, ['MOUSE_X_2', 'MOUSE_X_3']);
  await output.busy;
});

test('completion-driven pacing respects the rate limit and stop cancels its next dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = Number(process.hrtime.bigint()) / 1e6;
  const sent = [];
  const { output } = setup(t, async (url, request) => {
    sent.push(JSON.parse(request.body).params.command);
    return new Response('{}');
  }, { clock: () => now });
  output.move({ generation: 1, time: now / 1000, dx: 1, dy: 0 });
  output.flush(); await output.busy; await Promise.resolve();
  output.move({ generation: 1, time: now / 1000, dx: 2, dy: 0 });
  now += 12; t.mock.timers.tick(12);
  assert.deepEqual(sent, ['MOUSE_X_1']);
  now += 1; t.mock.timers.tick(1);
  assert.deepEqual(sent, ['MOUSE_X_1', 'MOUSE_X_2']);
  await output.busy; await Promise.resolve();
  output.move({ generation: 1, time: now / 1000, dx: 3, dy: 0 });
  output.invalidate(2);
  now += 30; t.mock.timers.tick(30);
  assert.deepEqual(sent, ['MOUSE_X_1', 'MOUSE_X_2']);
});

test('a stalled acknowledgement cannot refresh an old accumulated movement window', async t => {
  let now = 1000, finish;
  const sent = [];
  const { output } = setup(t, async (url, request) => {
    sent.push(JSON.parse(request.body).params.command);
    if (sent.length === 1) await new Promise(resolve => { finish = resolve; });
    return new Response('{}');
  }, { clock: () => now });
  output.move({ generation: 1, time: 1, dx: 1, dy: 0 }); output.flush();
  const first = output.busy;
  for (let i = 1; i <= 30; i++) { now = 1000 + i * 10; output.move({ generation: 1, time: now / 1000, dx: 1, dy: 0 }); }
  finish(); await first; output.flush(); await output.busy;
  assert.ok(Number(sent[1].split('_').at(-1)) <= 6, JSON.stringify(sent));
});

test('movement expires before Y when X acknowledgement takes 300 ms', async t => {
  let now = 1000, finish;
  const sent = [];
  const { output } = setup(t, async (url, request) => {
    sent.push(JSON.parse(request.body).params.command);
    if (sent.length === 1) await new Promise(resolve => { finish = resolve; });
    return new Response('{}');
  }, { clock: () => now });
  output.move({ generation: 1, time: 1, dx: 5, dy: 6 }); output.flush();
  const first = output.busy;
  now = 1300; finish(); await first;
  assert.deepEqual(sent, ['MOUSE_X_5']);
  assert.equal(output.metrics().acknowledged_movement_updates, 0);
});

test('a pre-transmission socket failure stops without persistent delivery uncertainty', async t => {
  const { output, dir } = setup(t);
  const ws = new EventEmitter(); ws.readyState = 2; let sends = 0;
  ws.send = () => { sends++; };
  output.rpc = new CoreRpc(ws); output.execute = CoreOutput.prototype.execute;
  await assert.rejects(output.sendAction('MOUSE_BTN_1', 1), /not sent/);
  await output.quiesce();
  const restarted = new CoreOutput({ stateDir: dir }); t.after(() => restarted.close());
  assert.equal(sends, 0); assert.equal(restarted.uncertain, false);
});

test('quiesce is shared and clears resolved delivery before a slow timing restoration', async t => {
  const finishes = []; let releases = 0;
  const { output, dir } = setup(t, undefined, { link: { release: async () => {
    releases++; await new Promise(resolve => { finishes.push(resolve); });
  } } });
  const first = output.quiesce();
  const second = output.quiesce();
  await Promise.resolve();
  try {
    assert.equal(fs.existsSync(`${dir}/output-session.json`), false);
    assert.throws(() => output.open('host.a', 3), /cleanup/);
    assert.equal(releases, 1);
  } finally { finishes.forEach(finish => finish()); await Promise.all([first, second]); }
  output.open('host.a', 3);
  assert.ok(output.endpoint);
});
