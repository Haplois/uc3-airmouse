export function validateOutputRate(rate) {
  if (!Number.isFinite(rate) || rate < 10 || rate > 1000) throw new Error('Movement rate must be within 10–1000 Hz');
  return rate;
}
