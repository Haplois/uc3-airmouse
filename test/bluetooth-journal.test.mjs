import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BluetoothJournal } from '../runtime/bluetooth-journal.mjs';
import { connectionFromJournal } from '../runtime/bluetooth-link.mjs';
import { fakeSensor } from './helpers.mjs';

const peer = '00:11:22:33:44:55';
const entry = (cursor, message, time = '1000000') => ({ __CURSOR: cursor, MESSAGE: message, __REALTIME_TIMESTAMP: time });
const initial = [entry('c1', `New connection: handle 65, ${peer}`), entry('c2', '[1] connected (0x41)'), entry('c3', '[1] conn params: interval=6 latency=0 timeout=960')];
function setup(t) {
  const { dir } = fakeSensor(t), calls = [];
  let entries = [...initial];
  const journal = new BluetoothJournal(dir, { execute: async (command, args) => {
    calls.push(args);
    assert.equal(command, 'journalctl');
    const cursorIndex = args.indexOf('--cursor');
    const afterIndex = args.indexOf('--after-cursor');
    const from = cursorIndex >= 0 ? Math.max(0, entries.findIndex(e => e.__CURSOR === args[cursorIndex + 1])) : afterIndex >= 0 ? entries.findIndex(e => e.__CURSOR === args[afterIndex + 1]) + 1 : 0;
    let selected = entries.slice(from);
    if (args.includes('--lines=1')) selected = selected.slice(0, 1);
    if (args.includes('-g')) selected = selected.filter(e => /New connection:|connected|conn params:/.test(e.MESSAGE));
    const body = selected.map(e => JSON.stringify(e)).join('\n');
    return { stdout: body + (args.includes('--show-cursor') ? `\n-- cursor: ${entries.at(-1)?.__CURSOR ?? ''}\n` : '') };
  } });
  return { dir, journal, calls, setEntries: next => { entries = next; } };
}

test('journal cursor includes a parameter change whose realtime clock moved backward', async t => {
  const { journal, calls, setEntries, dir } = setup(t);
  await journal.read();
  setEntries([...initial, entry('c4', '[1] conn params: interval=48 latency=0 timeout=960', '1')]);
  const text = await journal.read();
  assert.equal(connectionFromJournal(text, 1, peer).interval, 48);
  assert.ok(calls[1].includes('--cursor'));
  assert.ok(!calls.flat().some(arg => ['--since', '--until'].includes(arg)));
  assert.equal(JSON.parse(fs.readFileSync(`${dir}/bluetooth-journal.json`)).cursor, 'c4');
});

test('restart resumes the saved cursor and an idle scan does not rewrite the cache', async t => {
  const { journal, dir } = setup(t);
  await journal.read();
  const before = fs.statSync(`${dir}/bluetooth-journal.json`).ino;
  const next = new BluetoothJournal(dir, { execute: async (_, args) => {
    if (args.includes('--cursor')) {
      assert.equal(args[args.indexOf('--cursor') + 1], 'c3');
      return { stdout: JSON.stringify(initial.at(-1)) };
    }
    assert.equal(args[args.indexOf('--after-cursor') + 1], 'c3');
    return { stdout: '-- cursor: c3\n' };
  } });
  assert.equal(connectionFromJournal(await next.read(), 1, peer).interval, 6);
  assert.equal(fs.statSync(`${dir}/bluetooth-journal.json`).ino, before);
});

test('missing cursor anchor rebuilds from retained journal instead of trusting old connection state', async t => {
  const { journal, calls, setEntries } = setup(t);
  await journal.read();
  setEntries([entry('c5', '[1] disconnected (0x41)')]);
  assert.throws(() => connectionFromJournal(journal.cache.text, 2, peer), /unavailable/);
  const text = await journal.read();
  assert.throws(() => connectionFromJournal(text, 1, peer), /unavailable/);
  assert.equal(calls.length, 3);
  assert.ok(!calls.at(-1).includes('--cursor'));
});

test('legacy wall-clock cache is rebuilt and a failed scan leaves the saved cursor unchanged', async t => {
  const { dir, journal, calls } = setup(t);
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  fs.writeFileSync(`${dir}/bluetooth-journal.json`, JSON.stringify({ boot, since: 99999, text: 'stale' }));
  await journal.read(); assert.ok(!calls[0].includes('--since'));
  const before = fs.readFileSync(`${dir}/bluetooth-journal.json`, 'utf8');
  journal.execute = async () => { throw new Error('journal timed out'); };
  await assert.rejects(journal.read(), /unavailable/);
  assert.equal(fs.readFileSync(`${dir}/bluetooth-journal.json`, 'utf8'), before);
});

test('non-metadata traffic advances the consumed cursor without changing connection state', async t => {
  const { journal, setEntries, calls } = setup(t);
  setEntries([...initial, entry('c4', 'ordinary Bluetooth traffic')]);
  const before = await journal.read();
  assert.equal(journal.cache.cursor, 'c4');
  setEntries([...initial, entry('c4', 'ordinary Bluetooth traffic'), entry('c5', 'more ordinary traffic')]);
  assert.equal(await journal.read(), before);
  assert.equal(journal.cache.cursor, 'c5');
  assert.equal(calls.at(-1)[calls.at(-1).indexOf('--after-cursor') + 1], 'c4');
});

test('runtime cursor scans stay bounded while standalone refresh can use its longer timeout', async () => {
  const options=[];
  const execute=async (command,args,execution)=>{
    assert.equal(command,'journalctl');options.push(execution);
    return {stdout:args.includes('--show-cursor')?'-- cursor: c1\n':`${JSON.stringify({__CURSOR:'c1'})}\n`};
  };
  const runtime=new BluetoothJournal('/unused',{execute});
  await runtime.scan('c1');
  const standalone=new BluetoothJournal('/unused',{execute,initialTimeout:60_000,incrementalTimeout:60_000});
  await standalone.scan('c1');await standalone.scan('c1',true);
  assert.deepEqual(options.map(option=>option.timeout),[3000,60_000,3000]);
});
