import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hashTag = 0x42544442;
const oldHash = '800f9d3a0e9ab38551738161d2baf218';
const newHash = '18daa8d4190df0e4c16f8b7cfab0003a';

export function parseTlv(bytes) {
  if (bytes.length < 8 || bytes.subarray(0, 7).toString() !== 'BTstack') throw new Error('Invalid TLV header');
  const entries = new Map();
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('Truncated TLV header');
    const tag = bytes.readUInt32BE(offset), size = bytes.readUInt32BE(offset + 4);
    offset += 8;
    if (size > 2048 || offset + size > bytes.length) throw new Error('Invalid TLV value size');
    if (size) entries.set(tag, bytes.subarray(offset, offset + size));
    else entries.delete(tag);
    offset += size;
  }
  return entries;
}

export function recover(currentBytes, backupBytes) {
  const current = parseTlv(currentBytes), backup = parseTlv(backupBytes);
  if (current.get(hashTag)?.toString('hex') !== newHash || backup.get(hashTag)?.toString('hex') !== oldHash)
    throw new Error('Recovery requires the verified mouse-v1 to media-v2 layouts');
  const existing = new Set(), occupied = new Set();
  let sequence = 0;
  for (let index = 0; index < 20; index++) {
    const entry = current.get(0x42544300 + index);
    if (!entry) continue;
    if (entry.length !== 8) throw new Error('Invalid current subscription');
    occupied.add(index);
    existing.add(`${entry[7]}:${entry.readUInt16LE(4)}`);
    sequence = Math.max(sequence, entry.readUInt32LE(0));
  }
  const recovered = [];
  for (let index = 0; index < 20; index++) {
    const entry = backup.get(0x42544300 + index);
    if (!entry) continue;
    if (entry.length !== 8) throw new Error('Invalid backup subscription');
    const slot = entry[7], handle = entry.readUInt16LE(4), key = `${slot}:${handle}`;
    const bond = current.get(0x42544400 + slot), oldBond = backup.get(0x42544400 + slot);
    if (!bond || !oldBond || !bond.equals(oldBond) || existing.has(key)) continue;
    if (![0x13, 0x19, 0x1f].includes(handle) || entry[6] !== 1) continue;
    const free = Array.from({ length: 20 }, (_, i) => i).find(i => !occupied.has(i));
    if (free === undefined || sequence === 0xffffffff) throw new Error('Subscription store is full');
    const value = Buffer.from(entry);
    value.writeUInt32LE(++sequence, 0);
    current.set(0x42544300 + free, value);
    occupied.add(free); existing.add(key);
    recovered.push({ slot, handle });
  }
  const parts = [currentBytes.subarray(0, 8)];
  for (const [tag, value] of current) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(tag); header.writeUInt32BE(value.length, 4);
    parts.push(header, value);
  }
  return { bytes: Buffer.concat(parts), recovered };
}

function main() {
  // The deployment wrapper holds the daemon's owner.lock for this entire process.
  const [state, backup, apply] = process.argv.slice(2);
  if (!state || !backup || !['dry-run', 'apply'].includes(apply)) throw new Error('Expected state directory, backup, dry-run|apply');
  const destination = path.join(state, 'bonds.tlv');
  const metadata = fs.statSync(destination);
  const before = fs.readFileSync(destination);
  const result = recover(before, fs.readFileSync(backup));
  if (apply === 'apply' && result.recovered.length) {
    const suffix = `${Date.now()}-${process.pid}`;
    const saved = `${destination}.before-recovery-${suffix}`, temporary = `${destination}.recover-${suffix}`;
    for (const [file, bytes] of [[saved, before], [temporary, result.bytes]]) {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.fchownSync(fd, metadata.uid, metadata.gid);
        fs.fchmodSync(fd, metadata.mode & 0o660);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
    fs.renameSync(temporary, destination);
    const directory = fs.openSync(state, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  console.log(JSON.stringify({ applied: apply === 'apply', recovered: result.recovered }));
}

if (process.argv[1] === '-' || import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
