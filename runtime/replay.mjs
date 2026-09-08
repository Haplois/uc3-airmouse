import readline from 'node:readline';
import { MotionFilter } from './motion.mjs';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let filter, samples = 0, dx = 0, dy = 0;
for await (const line of input) {
  if (!line.trim()) continue;
  if (++samples > 100000 || line.length > 4096) throw new Error('Replay limit exceeded');
  const sample = JSON.parse(line);
  if (!filter || filter.generation !== sample.generation) filter = new MotionFilter({ generation: sample.generation });
  const delta = filter.step(sample);
  if (delta) { dx += delta.dx; dy += delta.dy; }
}
console.log(JSON.stringify({ samples, dx, dy, output: 'Replay only; no Bluetooth commands sent' }));
