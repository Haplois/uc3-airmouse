import fs from 'node:fs';
import { readJSON, saveJSON } from './storage.mjs';
import { lockConfig } from './config-lock.mjs';
import { validateOutputRate } from './output-rate.mjs';

import { ownershipModes } from './bluetooth-ownership.mjs';

const [stateDir, sensitivityText = '-', rateText = '-', ownershipText = '-'] = process.argv.slice(2);
const sensitivity = sensitivityText === '-' ? undefined : Number(sensitivityText);
const rate = rateText === '-' ? undefined : Number(rateText);
const ownership = ownershipText === '-' ? undefined : ownershipText;
if (!stateDir || (sensitivity === undefined && rate === undefined && ownership === undefined)) throw new Error('Usage: tune.mjs STATE_DIR SENSITIVITY|- MOVEMENT_HZ|- OWNERSHIP|-');
if (ownership !== undefined && !ownershipModes.includes(ownership)) throw new Error(`Bluetooth ownership must be one of ${ownershipModes.join(', ')}`);
if (sensitivity !== undefined && (!Number.isFinite(sensitivity) || sensitivity < 1 || sensitivity > 10000)) throw new Error('Sensitivity must be within 1–10000 counts/radian');
if (rate !== undefined) validateOutputRate(rate);
const unlock = lockConfig(stateDir);
try {
  if (fs.existsSync(`${stateDir}/sensor-journal.json`)) throw new Error('Stop acquisition and restore the sensor before tuning');
  const file = `${stateDir}/airmouse.json`;
  const config = readJSON(file);
  if (sensitivity !== undefined) config.motion.filter = { ...config.motion.filter, sensitivity };
  if (rate !== undefined) config.output = { ...config.output, movement_rate_hz: rate };
  if (ownership !== undefined) config.bluetooth = { ...config.bluetooth, ownership };
  saveJSON(file, config);
  console.log(JSON.stringify({ sensitivity: config.motion.filter?.sensitivity ?? 900, movement_rate_hz: config.output?.movement_rate_hz ?? 80, sampling_hz: config.motion.active_profile.sampling_frequency_hz, bluetooth_ownership: config.bluetooth?.ownership ?? 'always' }));
} finally { unlock(); }
