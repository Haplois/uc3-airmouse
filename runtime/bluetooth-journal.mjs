import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const pattern = 'New connection:|\\] connected|\\] disconnected|conn params:';

export function compactJournal(text) {
  const addresses = new Map(), profiles = new Map();
  for (const line of text.split('\n')) {
    let match = /New connection: handle (\d+), ([0-9A-F:]{17})/i.exec(line);
    if (match) addresses.set(Number(match[1]), match[2]);
    match = /\[(\d+)\] (connected|disconnected) \(0x([\da-f]+)\)/i.exec(line);
    if (match) {
      if (match[2] === 'disconnected') profiles.delete(match[1]);
      else profiles.set(match[1], { handle: parseInt(match[3], 16), line: match[0] });
    }
    match = /\[(\d+)\] conn params: interval=\d+ latency=\d+ timeout=\d+/.exec(line);
    if (match && profiles.has(match[1])) profiles.get(match[1]).parameters = match[0];
  }
  return [...addresses.entries()].map(([handle, address]) => `New connection: handle ${handle}, ${address}`).concat([...profiles.values()].flatMap(p => [p.line, p.parameters ?? ''])).join('\n');
}

export class BluetoothJournal {
  constructor(stateDir = '/mnt/data/airmouse/state', { execute = run, initialTimeout = 3000, incrementalTimeout = 3000 } = {}) {
    this.file = `${stateDir}/bluetooth-journal.json`;
    this.temporary = `${this.file}.${randomUUID()}.tmp`;
    this.pending = null;
    this.execute = execute; this.initialTimeout = initialTimeout; this.incrementalTimeout = incrementalTimeout;
  }

  read() {
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => { this.pending = null; });
    return this.pending;
  }

  async refresh() {
    const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!this.cache) {
      try { this.cache = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { /* Missing cache requires an initial scan. */ }
    }
    let cursor = this.cache?.version === 2 && this.cache.boot === boot ? this.cache.cursor : undefined;
    // Validate the raw anchor even when its message is not connection metadata.
    if (cursor && (await this.scan(cursor, true)).entries[0]?.__CURSOR !== cursor) cursor = undefined;
    const { entries, cursor: consumed } = await this.scan(cursor);
    const text = compactJournal(`${cursor ? this.cache.text : ''}\n${entries.map(entry => entry.MESSAGE).join('\n')}`);
    if (entries.length && !consumed) throw new Error('Bluetooth journal did not report its consumed cursor');
    const next = { version: 2, boot, cursor: consumed ?? cursor ?? null, text };
    if (JSON.stringify(next) !== JSON.stringify(this.cache)) {
      await fs.writeFile(this.temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await fs.rename(this.temporary, this.file);
      this.cache = next;
    }
    return text;
  }

  async scan(cursor, anchor = false) {
    const args = ['-b', '-u', 'btstack.service', '--no-pager', '--quiet', '-o', 'json', `--output-fields=${anchor ? '__CURSOR' : '__CURSOR,MESSAGE'}`];
    if (anchor) args.push('--cursor', cursor, '--lines=1');
    else {
      args.push('-g', pattern, '--show-cursor');
      if (cursor) args.push('--after-cursor', cursor);
    }
    let stdout;
    const timeout = cursor ? anchor ? 3000 : this.incrementalTimeout : this.initialTimeout;
    try { ({ stdout } = await this.execute('journalctl', args, { timeout, maxBuffer: 1024 * 1024 })); }
    catch (error) { if (error.code === 1 && !error.stderr?.trim()) stdout = error.stdout ?? ''; else throw new Error('Bluetooth connection journal unavailable'); }
    let consumed = null;
    const entries = stdout.split('\n').filter(line => line.trim()).flatMap(line => {
      if (line.startsWith('-- cursor: ')) { consumed = line.slice(11).trim(); return []; }
      const entry = JSON.parse(line);
      if (typeof entry.__CURSOR !== 'string' || !entry.__CURSOR || !anchor && typeof entry.MESSAGE !== 'string') throw new Error('Invalid Bluetooth journal record');
      return [entry];
    });
    return { entries, cursor: consumed };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await fs.realpath(process.argv[1])).href) {
  await new BluetoothJournal(process.argv[2], { initialTimeout: 60_000, incrementalTimeout: 60_000 }).read();
  console.log('Bluetooth connection index refreshed; no HID input sent');
}
