import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const stateDir = process.argv[2];
if (!stateDir) throw new Error('Usage: ready.mjs STATE_DIR');
const deadline = performance.now() + 10_000;
let ready = false;
while (performance.now() < deadline) {
  try {
    const state = JSON.parse(await fs.readFile(`${stateDir}/status.json`, 'utf8'));
    if (Number.isSafeInteger(state.generation) && typeof state.pointer === 'boolean' && typeof state.core_connected === 'boolean') { ready = true; break; }
  } catch { /* The installer removed the old snapshot before starting this release. */ }
  await delay(100);
}
if (!ready) throw new Error('New service did not publish a valid status snapshot');
console.log('New air mouse service published status');
