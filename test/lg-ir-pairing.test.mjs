import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { LGIRPairing } from '../runtime/lg-ir-pairing.mjs';
import { HidOutput } from '../runtime/hid-output.mjs';
import { fakeSensor } from './helpers.mjs';

const signalCode = JSON.parse(fs.readFileSync(new URL('../config/ir/lg-mr23-pairing.json', import.meta.url)));
const coreEncoding = JSON.parse(fs.readFileSync(new URL('./fixtures/lg-mr23-pairing-core.json', import.meta.url))).encoded;
const internal = { device_id: 'internal', type: 'INTERNAL', active: true };
function setup(t, { emitters = [internal], sendStatus = 200 } = {}) {
  const { dir } = fakeSensor(t), calls = [];
  fs.writeFileSync(`${dir}/core-api-key`, 'test-key\n', { mode: 0o600 });
  const pairing = new LGIRPairing({ stateDir: dir, request: async (url, options) => {
    calls.push([options.method, new URL(url).pathname, options.body ? JSON.parse(options.body) : null]);
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal(options.redirect, 'error');
    return options.method === 'GET' ? new Response(JSON.stringify(emitters)) : new Response('', { status: sendStatus });
  } });
  const output = {
    async pair(profile) { calls.push(['bluetooth', profile]); },
    async waitForPairing({ signal }) { signal.throwIfAborted(); calls.push(['advertising_ready']); },
    async cancelPairing() { calls.push(['cancel']); },
  };
  return { pairing, output, calls };
}

test('stored LG pairing code encodes captured MICOM command 83 as NEC, not Linux key 405', () => {
  const reverse = byte => parseInt(byte.toString(2).padStart(8, '0').split('').reverse().join(''), 2);
  const address = Number(signalCode.address), command = Number(signalCode.command);
  const wire = [address, address ^ 255, command, command ^ 255].map(reverse).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  assert.equal(signalCode.provenance.micom_input_keycode, '0x83');
  assert.equal(signalCode.provenance.linux_input_keycode, '0x405');
  assert.equal(signalCode.code, `3;0x${wire};32;0`);
  assert.equal(wire, '20DFC13E');
  assert.equal(signalCode.provenance.raw_pulse_timings_measured, false);
});

test('Remote 3 Core encodes the stored signal as the captured NEC command', () => {
  assert.equal(coreEncoding.protocol, 'NEC');
  assert.equal(coreEncoding.frequency, 38000);
  assert.equal(coreEncoding.command, signalCode.command);
  assert.equal(Number(coreEncoding.address), Number(signalCode.address));
  assert.equal(coreEncoding.raw.length, 67);
  const bits = Array.from({ length: 32 }, (_, bit) => coreEncoding.raw[3 + bit * 2] > 1000 ? '1' : '0').join('');
  const decoded = parseInt(bits, 2).toString(16).toUpperCase();
  assert.equal(signalCode.code, `3;0x${decoded};32;0`);
});

test('LG IR trigger follows Bluetooth advertising and uses only the internal emitter', async t => {
  const { pairing, output, calls } = setup(t, { emitters: [{ device_id: 'dock', type: 'DOCK', active: true }, internal] });
  await pairing.pair(output, new AbortController().signal);
  assert.deepEqual(calls, [
    ['GET', '/api/ir/emitters', null], ['bluetooth', 'lg-tv'], ['advertising_ready'],
    ['PUT', '/api/ir/emitters/internal/send', { format: 'HEX', code: '3;0x20DFC13E;32;0', repeat: 0 }],
  ]);
});

test('missing internal IR fails before opening Bluetooth pairing', async t => {
  const { pairing, output, calls } = setup(t, { emitters: [] });
  await assert.rejects(pairing.pair(output, new AbortController().signal), /infrared output is unavailable/);
  assert.equal(calls.length, 1);
});

test('an IR send failure cancels the Bluetooth window and remains an error', async t => {
  const { pairing, output, calls } = setup(t, { sendStatus: 503 });
  await assert.rejects(pairing.pair(output, new AbortController().signal), /HTTP 503/);
  assert.deepEqual(calls.at(-1), ['cancel']);
});

test('stop during Bluetooth setup prevents the IR trigger and cancels pairing', async t => {
  const { pairing, output, calls } = setup(t), abort = new AbortController();
  output.waitForPairing = async () => { abort.abort(); };
  await assert.rejects(pairing.pair(output, abort.signal), { name: 'AbortError' });
  assert.equal(calls.some(call => call[0] === 'PUT'), false);
  assert.deepEqual(calls.at(-1), ['cancel']);
});

test('Bluetooth setup failure never sends IR and reports cleanup failure', async t => {
  const { pairing, output, calls } = setup(t);
  output.pair = async () => { throw new Error('Bluetooth failed'); };
  output.cancelPairing = async () => { throw new Error('offline'); };
  await assert.rejects(pairing.pair(output, new AbortController().signal), /Bluetooth failed; Bluetooth pairing could not be cancelled/);
  assert.equal(calls.some(call => call[0] === 'PUT'), false);
});

test('pairing readiness waits for the old Bluetooth connection to close', async () => {
  const state = { connected: true, daemon: { working: true, pairing: true, connected: true, error: '' } };
  let ready = false;
  const waiting = HidOutput.prototype.waitForPairing.call(state, { signal: new AbortController().signal, timeoutMs: 500 }).then(() => { ready = true; });
  await delay(30);
  assert.equal(ready, false);
  state.daemon.connected = false;
  await waiting;
  assert.equal(ready, true);
  state.daemon.pairing = false;
  await assert.rejects(HidOutput.prototype.waitForPairing.call(state, { signal: new AbortController().signal, timeoutMs: 1 }), /did not become ready/);
});
