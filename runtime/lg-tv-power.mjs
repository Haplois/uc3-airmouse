import dgram from 'node:dgram';
import { isIP } from 'node:net';

export function wakePacket(mac) {
  if (typeof mac !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) throw new Error('Configure the LG TV network MAC address');
  const address = Buffer.from(mac.replaceAll(':', ''), 'hex');
  if (address[0] & 1 || address.every(byte => byte === 0)) throw new Error('Invalid LG TV network MAC address');
  return Buffer.concat([Buffer.alloc(6, 255), ...Array(16).fill(address)]);
}

export async function wakeOnLAN({ mac, broadcast } = {}, port = 9) {
  const packet = wakePacket(mac);
  if (isIP(broadcast ?? '') !== 4) throw new Error('Configure the LG TV wake broadcast address');
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('LG TV wake packet timed out')), 2000);
    socket.once('error', finish);
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(packet, port, broadcast, error => finish(error));
      } catch (error) { finish(error); }
    });
  });
}
