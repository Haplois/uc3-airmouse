import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function lockConfig(stateDir) {
  const fd = fs.openSync(`${stateDir}/config.lock`, 'a', 0o600);
  try {
    // flock locks the shared open-file description, which this process keeps alive.
    execFileSync('flock', ['-n', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
  } catch (error) {
    fs.closeSync(fd);
    throw new Error('Configuration is in use; stop the air mouse service before tuning', { cause: error });
  }
  return () => fs.closeSync(fd);
}
