import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BluetoothLink, connectionFromJournal, exchange, hciCommand, updateParameters } from '../runtime/bluetooth-link.mjs';
import { compactJournal } from '../runtime/bluetooth-journal.mjs';

const peer = '00:11:22:33:44:AA';
const baseline = `New connection: handle 65, ${peer}\n[1] connected (0x41)\n[1] conn params: interval=48 latency=0 timeout=960`;
const fast = '\n[1] conn params: interval=6 latency=0 timeout=960';

test('incremental journal compaction preserves identity across many timing updates', () => {
  let text = baseline;
  for (let i = 0; i < 1100; i++) text = compactJournal(text + fast);
  assert.equal(connectionFromJournal(text, 1, peer).interval, 6);
  assert.ok(text.length < 200);
  assert.throws(() => connectionFromJournal(compactJournal(text + '\n[1] disconnected (0x41)'), 1, peer), /unavailable/);
});

test('a connection split across journal reads retains its address until profile assignment', () => {
  let text = compactJournal(`New connection: handle 65, ${peer}`);
  text = compactJournal(text + '\n[1] connected (0x41)');
  text = compactJournal(text + '\n[1] conn params: interval=6 latency=0 timeout=960');
  assert.equal(connectionFromJournal(text, 1, peer).interval, 6);
});

test('connection lookup rejects disconnect, different host and missing timing', () => {
  assert.equal(connectionFromJournal(baseline, 1, peer).handle, 65);
  for (const log of [baseline + '\n[1] disconnected (0x41)', baseline.replace(peer, '00:11:22:33:44:55'), '[1] connected (0x41)']) {
    assert.throws(() => connectionFromJournal(log, 1, peer), /unavailable/);
  }
});

test('connection update encodes only the standard HCI timing command', () => {
  assert.equal(hciCommand(0x2013, updateParameters(65, 6, 0, 960)).toString('hex'), '01000000110013200e4100060006000000c00300000000');
  assert.throws(() => updateParameters(65, 1, 0, 960), /Invalid/);
  assert.throws(() => updateParameters(65, 3200, 499, 10), /Invalid/);
});

test('fragmented daemon frames ignore unrelated events and reject a controller error', async () => {
  const socket = new EventEmitter(); socket.setNoDelay = () => {}; socket.destroy = () => {}; socket.write = () => {};
  const pending = exchange(0x2013, updateParameters(65, 6, 0, 960), () => undefined, () => socket);
  const failed = assert.rejects(pending, /rejected \(12\)/);
  const frame = Buffer.from('0400000006000f040c011320', 'hex');
  socket.emit('data', frame.subarray(0, 3)); socket.emit('data', frame.subarray(3));
  await failed;
});

function fixture() {
  let log = baseline;
  const calls = [];
  const link = new BluetoothLink({ verify: async () => {}, journal: async () => log, command: async (opcode, parameters, accept) => {
    calls.push([opcode, Buffer.from(parameters)]);
    if (opcode === 0x1405) return accept(Buffer.from('0e07010514004100be', 'hex'));
    const interval = parameters.readUInt16LE(2);
    log += `\n[1] conn params: interval=${interval} latency=0 timeout=960`;
    const event = Buffer.from('3e0a0300410006000000c003', 'hex'); event.writeUInt16LE(interval, 6);
    return accept(event);
  } });
  return { link, calls, log: text => { log = text; } };
}

test('selected peer gets a confirmed fast interval and the previous timing is restored', async () => {
  const { link, calls } = fixture();
  await link.acquire({ id: 'uc_bt.main.profile1', peer });
  assert.equal(link.metrics().connection_interval_ms, 7.5);
  await link.check(); await link.release();
  assert.deepEqual(calls.map(c => c[0]), [0x1405, 0x2013, 0x2013]);
  assert.equal(calls[2][1].readUInt16LE(2), 48);
  assert.equal(link.active, null);
});

test('restoration never updates a reused connection handle or another host', async () => {
  const { link, calls, log } = fixture();
  await link.acquire({ id: 'uc_bt.main.profile1', peer });
  log(baseline + fast + '\n[1] disconnected (0x41)\nNew connection: handle 65, 00:11:22:33:44:55\n[1] connected (0x41)\n[1] conn params: interval=6 latency=0 timeout=960');
  await assert.rejects(link.check(), /unavailable/);
  await link.release(); assert.equal(calls.length, 2);
});

test('slow renegotiation is detected and host-owned timing is preserved on stop', async () => {
  const { link, calls, log } = fixture();
  await link.acquire({ id: 'uc_bt.main.profile1', peer });
  log(baseline + fast + '\n[1] conn params: interval=24 latency=0 timeout=960');
  await assert.rejects(link.check(), /lost/);
  await link.release(); assert.equal(calls.length, 2);
});

test('failed restoration retains ownership for retry and concurrent releases share work', async () => {
  const { link } = fixture();
  await link.acquire({ id: 'uc_bt.main.profile1', peer });
  const restore = link.update.bind(link);
  let attempts = 0;
  link.update = async (...args) => { if (++attempts === 1) throw new Error('restore failed'); return restore(...args); };
  await assert.rejects(link.release(), /restore failed/);
  assert.ok(link.active);
  await Promise.all([link.release(), link.release()]);
  assert.equal(attempts, 2); assert.equal(link.active, null);
});

test('a host timeout-only change is preserved on release', async () => {
  const { link, calls, log } = fixture();
  await link.acquire({ id: 'uc_bt.main.profile1', peer });
  log(baseline + '\n[1] conn params: interval=6 latency=0 timeout=1200');
  await assert.rejects(link.check(), /lost/);
  await link.release(); assert.equal(calls.length, 2);
});

test('journal read failure cannot discard timing restoration ownership', async () => {
  const { link } = fixture();
  await link.acquire({ id: 'uc_bt.main.profile1', peer });
  const read = link.journal;
  link.journal = async () => { throw new Error('journal unavailable'); };
  await assert.rejects(link.release(), /journal unavailable/);
  assert.ok(link.active);
  link.journal = read; await link.release(); assert.equal(link.active, null);
});

test('a release ordered after reacquisition restores that new acquisition too', async () => {
  const { link } = fixture();
  await link.acquire({ id: 'uc_bt.main.profile1', peer });
  const update = link.update.bind(link);
  let finish;
  link.update = async (...args) => {
    if (!finish) await new Promise(resolve => { finish = resolve; });
    return update(...args);
  };
  const first = link.release();
  while (!finish) await Promise.resolve();
  const acquisition = link.acquire({ id: 'uc_bt.main.profile1', peer });
  const last = link.release();
  finish(); await Promise.all([first, acquisition, last]);
  assert.equal(link.active, null);
});

test('a connected peer with missing timing retains restoration state', async () => {
  const { link, log } = fixture();
  await link.acquire({ id: 'uc_bt.main.profile1', peer });
  log(`New connection: handle 65, ${peer}\n[1] connected (0x41)`);
  await assert.rejects(link.release(), /unavailable/);
  assert.ok(link.active);
});
