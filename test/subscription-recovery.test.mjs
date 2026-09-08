import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTlv, recover } from '../bluetooth/recover-subscriptions.mjs';

function tlv(entries) {
  const chunks = [Buffer.from('BTstack\0')];
  for (const [tag, value] of entries) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(tag); header.writeUInt32BE(value.length, 4);
    chunks.push(header, value);
  }
  return Buffer.concat(chunks);
}
function fixture() {
  const bond = Buffer.from('synthetic-bond');
  const ccc = Buffer.from([1, 0, 0, 0, 0x19, 0, 1, 3]);
  const current = [[0x42544442, Buffer.from('18daa8d4190df0e4c16f8b7cfab0003a', 'hex')], [0x42544403, bond]];
  const backup = [[0x42544442, Buffer.from('800f9d3a0e9ab38551738161d2baf218', 'hex')], [0x42544403, bond], [0x42544313, ccc]];
  return { current, backup, ccc };
}
test('restores saved subscriptions, preserves bonds, and is idempotent', () => {
  const { current, backup } = fixture();
  const result = recover(tlv(current), tlv(backup));
  assert.deepEqual(result.recovered, [{ slot: 3, handle: 0x19 }]);
  assert.deepEqual(parseTlv(result.bytes).get(0x42544403), current[1][1]);
  assert.equal(recover(result.bytes, tlv(backup)).recovered.length, 0);
});
test('never restores subscriptions for deleted or replaced bonds', () => {
  const { current, backup } = fixture();
  current[1][1] = Buffer.from('new-bond-in-same-slot');
  assert.equal(recover(tlv(current), tlv(backup)).recovered.length, 0);
  current.pop();
  assert.equal(recover(tlv(current), tlv(backup)).recovered.length, 0);
});
test('keeps an explicit disabled current subscription', () => {
  const { current, backup, ccc } = fixture();
  const disabled = Buffer.from(ccc); disabled[6] = 0;
  current.push([0x42544302, disabled]);
  const result = recover(tlv(current), tlv(backup));
  assert.equal(result.recovered.length, 0);
  assert.deepEqual(parseTlv(result.bytes).get(0x42544302), disabled);
});
test('honors tombstones and rejects truncated files and unknown schemas', () => {
  const { current, backup } = fixture();
  backup.push([0x42544313, Buffer.alloc(0)]);
  assert.equal(recover(tlv(current), tlv(backup)).recovered.length, 0);
  assert.throws(() => parseTlv(tlv(current).subarray(0, -1)), /Invalid TLV/);
  current[0][1] = Buffer.alloc(16);
  assert.throws(() => recover(tlv(current), tlv(backup)), /verified/);
});
test('offline recovery preserves file owner, group and permissions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airmouse-recovery-'));
  try {
    const { current, backup } = fixture();
    const destination = path.join(directory, 'bonds.tlv'), saved = path.join(directory, 'backup.tlv');
    fs.writeFileSync(destination, tlv(current), { mode: 0o640 });
    fs.writeFileSync(saved, tlv(backup), { mode: 0o600 });
    if (process.getuid() === 0) fs.chownSync(destination, 946, 113);
    const before = fs.statSync(destination);
    const run = spawnSync(process.execPath, ['bluetooth/recover-subscriptions.mjs', directory, saved, 'apply'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const after = fs.statSync(destination);
    for (const field of ['uid', 'gid', 'mode']) assert.equal(after[field], before[field]);
    assert.equal(parseTlv(fs.readFileSync(destination)).size, 3);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
