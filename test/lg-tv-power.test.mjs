import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { wakeOnLAN, wakePacket } from '../runtime/lg-tv-power.mjs';

test('Wake-on-LAN emits one complete magic packet to the configured destination', async t => {
  const receiver = dgram.createSocket('udp4');
  t.after(() => receiver.close());
  receiver.bind(0, '127.0.0.1');
  await once(receiver, 'listening');
  const received = once(receiver, 'message');
  await wakeOnLAN({ mac: '02:11:22:33:44:55', broadcast: '127.0.0.1' }, receiver.address().port);
  const [packet] = await received;
  assert.equal(packet.length, 102);
  assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 255));
  for (let offset = 6; offset < 102; offset += 6) assert.equal(packet.subarray(offset, offset + 6).toString('hex'), '021122334455');
});

test('missing and invalid TV wake configuration fail before sending', async () => {
  for (const mac of ['', 'ff:ff:ff:ff:ff:ff', '00:00:00:00:00:00', 'not-a-mac']) assert.throws(() => wakePacket(mac));
  await assert.rejects(wakeOnLAN(), /MAC address/);
  await assert.rejects(wakeOnLAN({ mac: '02:11:22:33:44:55', broadcast: 'example.com' }), /broadcast address/);
});
