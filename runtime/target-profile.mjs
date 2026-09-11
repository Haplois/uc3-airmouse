export function targetProfile(target) {
  const name = target?.bluetooth_name || target?.name || '';
  return /(?:^|[^a-z])lg(?:[^a-z]|$)/i.test(name) && /(?:webos|\btv\b|\boled\d)/i.test(name) ? 'lg-tv' : 'computer';
}

export const arrowKeys = Object.freeze({
  up: 0x52,
  down: 0x51,
  left: 0x50,
  right: 0x4f
});

export const lgKeys = Object.freeze({
  power: 0x8008,
  input_next: 0x7f01,
  input_previous: 0x7f02,
  quick_settings: 0x7f03,
  all_settings: 0x7f04,
  input_picker: 0x7f05,
  hdmi1: 0x7f06,
  netflix: 0x7f07,
  youtube: 0x7f08,
  steam_machine: 0x7f09,
  up: 0x8040,
  down: 0x8041,
  left: 0x8007,
  right: 0x8006,
  ok: 0x8044,
  back: 0x8028,
  home: 0x807c,
  settings: 0x8043,
  channel_up: 0x8000,
  channel_down: 0x8001
});

export const lgMediaKeys = Object.freeze({
  play_pause: 0x7f0a,
  play: 0x80b0,
  pause: 0x80ba,
  stop: 0x7f0e,
  mute: 0x7f0d,
  volume_up: 0x7f0b,
  volume_down: 0x7f0c
});

export function lgMotion(sample, bias = [0, 0, 0]) {
  if (!sample || !Array.isArray(bias) || bias.length !== 3
      || !Array.isArray(sample.gyro) || sample.gyro.length !== 3
      || !Array.isArray(sample.accel) || sample.accel.length !== 3
      || ![sample.time, ...sample.gyro, ...sample.accel, ...bias].every(Number.isFinite)) return null;
  const clamp = value => Math.max(-32768, Math.min(32767, Math.round(value))) || 0;
  const rotate = ([x, y, z]) => [y, -x, z];
  const gyro = rotate(sample.gyro.map((value, i) => value - bias[i])).map(value => clamp(value * 180 / Math.PI / 0.07));
  const accel = rotate(sample.accel).map(value => clamp(value * 4096 / 9.80665));
  return { generation: sample.generation, time: sample.time, axes: [...gyro, ...accel] };
}
