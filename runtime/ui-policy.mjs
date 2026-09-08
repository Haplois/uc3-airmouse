import { validateOutputRate } from './output-rate.mjs';

export const themes = ['violet', 'glacier', 'mint', 'amber', 'graphite', 'black'];
export const sensorRates = [25, 50, 100, 200, 400, 800, 1600, 3200];
export function samplingPolicy(outputRate, available) {
  validateOutputRate(outputRate);
  const requested = sensorRates.find(rate => rate >= outputRate * 2);
  const supported = available.filter(rate => sensorRates.includes(rate)).sort((a, b) => a - b);
  const selected = supported.find(rate => rate >= requested) ?? supported.at(-1) ?? null;
  return { requested, selected, satisfied: selected !== null && selected >= outputRate * 2 };
}
