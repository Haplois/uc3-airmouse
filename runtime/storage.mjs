import fs from 'node:fs';
import path from 'node:path';

export function saveJSON(file, value) {
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export const readText = file => fs.readFileSync(file, 'utf8').trim();
export const equalSetting = (a, b) => a === b || (a !== '' && b !== '' && Number.isFinite(Number(a)) && Number(a) === Number(b));
