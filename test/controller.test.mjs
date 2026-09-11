import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import fs from 'node:fs';
import { Controller } from '../runtime/controller.mjs';
import { fakeSensor, fakeOutput } from './helpers.mjs';

function setup(t) {
  const fixture = fakeSensor(t), output = fakeOutput();
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  controller.nativeControl = true; controller.target = 'host.a';
  t.after(() => controller.stop());
  return { ...fixture, output, controller };
}

function ownedV2(output, selected = '00000001') {
  Object.assign(output, {
    backend: 'owned', buttonEdges: true, deviceManagement: true, hostLimit: 4,
    defaultTarget: null, selectedTarget: selected, paired: true, pairing: false, buttons: 0,
    targets: [
      { id: '00000001', name: 'Legacy laptop', bluetooth_name: 'Laptop', custom_name: 'Legacy laptop', legacy: true, ready: selected === '00000001', connected: selected === '00000001' },
      { id: '00000002', name: 'Desktop', bluetooth_name: 'Desktop', custom_name: '', legacy: false, ready: selected === '00000002', connected: selected === '00000002' },
    ],
  });
  return output;
}

test('LG rests after fifteen seconds while computer pointing retains its timeout', async t => {
  const { controller, output } = setup(t);
  output.backend = 'owned';
  output.targets.find(target => target.id === controller.target).bluetooth_name = '[LG] webOS TV OLED77G3PSA';
  controller.touch();
  assert.equal(controller.idle._idleTimeout, 15000);
  output.targets.find(target => target.id === controller.target).bluetooth_name = 'Desktop';
  controller.touch();
  assert.ok(controller.idle);
});

test('LG rest restores the sensor, preserves intent, and wakes without changing calibration', async t => {
  const { controller, sensor, output } = setup(t);
  output.backend = 'owned'; output.imu = () => {};
  output.targets[0].bluetooth_name = '[LG] webOS TV OLED77G3PSA';
  let wake;
  sensor.watchWake = callback => { wake = callback; };
  const config = JSON.stringify(controller.config);
  await controller.activate();
  assert.equal(sensor.rate, 200);
  await controller.rest();
  assert.equal(sensor.record, null);
  assert.equal(controller.state().pointer_enabled, true);
  assert.equal(controller.state().resting, true);
  assert.equal(output.endpoint, null);
  wake(); await tick(); await tick();
  assert.equal(controller.pointer, true);
  assert.equal(controller.resting, false);
  assert.equal(sensor.rate, 200);
  assert.equal(JSON.stringify(controller.config), config);
});

test('explicit stop cancels a stale pickup and resting mouse clicks resume before delivery', async t => {
  const { controller, sensor, output } = setup(t);
  output.backend = 'owned'; output.buttonEdges = true; output.imu = () => {};
  output.targets[0].bluetooth_name = '[LG] webOS TV OLED77G3PSA';
  let wake;
  sensor.watchWake = callback => { wake = callback; };
  await controller.activate(); await controller.rest();
  await controller.button(1, true);
  assert.equal(controller.pointer, true);
  assert.equal(output.buttonCalls.at(-1).down, true);
  await controller.button(1, false);
  await controller.rest(); await controller.stop();
  wake(); await tick();
  assert.equal(controller.pointer, false);
  assert.equal(controller.state().pointer_enabled, false);
});

test('held buttons defer rest and motion refreshes its deadline', async t => {
  const { controller, sensor, output } = setup(t);
  output.backend = 'owned'; output.imu = () => {};
  output.targets[0].bluetooth_name = '[LG] webOS TV OLED77G3PSA';
  await controller.activate();
  output.buttons = 1;
  await controller.rest();
  assert.equal(controller.pointer, true);
  const timer = controller.idle;
  sensor.callback([{ time: 1, gyro: [0.1, 0, 0], accel: [0, 0, 9.81] }]);
  assert.notEqual(controller.idle, timer);
});

test('LG power sends Bluetooth while connected and a wake packet while disconnected', async t => {
  const { controller, output } = setup(t);
  output.backend = 'owned';
  output.targets.find(target => target.id === controller.target).bluetooth_name = '[LG] webOS TV OLED77G3PSA';
  const calls = [];
  output.key = async (target, key) => calls.push({ target, key });
  controller.wakeTV = async config => calls.push(config);
  controller.config.lg_tv_power = { 'host.a': { mac: '02:11:22:33:44:55', broadcast: '192.168.1.255' } };
  await controller.apply({ type: 'power' });
  assert.deepEqual(calls, [{ target: 'host.a', key: 'power' }]);
  output.ready = () => false;
  await controller.apply({ type: 'power' });
  assert.deepEqual(calls[1], controller.config.lg_tv_power['host.a']);
  output.targets[0].bluetooth_name = 'Desktop';
  await assert.rejects(controller.apply({ type: 'power' }), /LG TV profile/);
});

test('explicit ON and OFF are idempotent and restore original settings', async t => {
  const { controller, sensor } = setup(t), baseline = sensor.snapshot();
  await controller.apply({ type: 'on' }); const generation = controller.generation;
  await controller.apply({ type: 'on' }); assert.equal(controller.generation, generation);
  await controller.apply({ type: 'off' }); await controller.apply({ type: 'off' });
  assert.deepEqual(sensor.snapshot(), baseline);
});
test('activation failure leaves pointer off and restores partial writes', async t => {
  const { controller, sensor, fail } = setup(t), baseline = sensor.snapshot();
  fail(2); await assert.rejects(controller.apply({ type: 'on' }), /Injected/);
  assert.equal(controller.pointer, false); assert.deepEqual(sensor.snapshot(), baseline);
});
test('off during activation prevents obsolete activation from resuming', async t => {
  const { controller, sensor } = setup(t), baseline = sensor.snapshot();
  const activation = controller.apply({ type: 'on' });
  await tick(); await controller.apply({ type: 'off' }); await activation;
  assert.equal(controller.pointer, false); assert.deepEqual(sensor.snapshot(), baseline);
});
test('off while Bluetooth timing is negotiated prevents sensor acquisition and output', async t => {
  const { controller, output, writes } = setup(t);
  let finish;
  output.prepare = () => new Promise(resolve => { finish = resolve; });
  const activation = controller.apply({ type: 'on' });
  await tick();
  assert.equal(writes.length, 0);
  await controller.apply({ type: 'off' });
  finish(); await activation;
  assert.equal(writes.length, 0); assert.equal(controller.pointer, false);
});
test('off while an owned session opens suppresses the obsolete open failure', async t => {
  const { controller, output } = setup(t);let rejectOpen;
  output.open=()=>new Promise((resolve,reject)=>{rejectOpen=reject;});
  const activation=controller.apply({type:'on'});
  for(let i=0;i<20&&!rejectOpen;i++)await tick();
  assert.ok(rejectOpen);await controller.apply({type:'off'});
  rejectOpen(new Error('Open invalidated by stop'));await activation;
  assert.equal(controller.pointer,false);assert.equal(controller.error,'');assert.equal(controller.reason,'Pointer off');
});
test('target change and disconnect stop pointing; reconnect does not reactivate', async t => {
  const { controller, sensor, output } = setup(t), baseline = sensor.snapshot();
  await controller.apply({ type: 'on' }); await controller.apply({ type: 'target', id: 'host.b' });
  assert.equal(controller.target, 'host.b'); assert.equal(controller.pointer, false);
  await controller.apply({ type: 'on' }); output.connected = false; await controller.stop('Core disconnect');
  output.connected = true; assert.equal(controller.pointer, false); assert.deepEqual(sensor.snapshot(), baseline);
});

test('repeated stops wait for old link restoration before a new session opens', async t => {
  const { CoreOutput } = await import('../runtime/output.mjs');
  const fixture = fakeSensor(t);
  let finish, releases = 0;
  const output = new CoreOutput({ stateDir: fixture.dir, link: {
    acquire: async () => {}, metrics: () => null,
    release: async () => { if (++releases === 1) await new Promise(resolve => { finish = resolve; }); },
  } });
  output.connected = true; output.awake = true;
  output.targets = [{ id: 'host.a', ready: true, peer: 'fixture' }];
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  controller.nativeControl = true; controller.target = 'host.a';
  t.after(async () => { await controller.stop(); output.close(); });
  await controller.apply({ type: 'on' });
  const first = controller.apply({ type: 'off' });
  const second = controller.apply({ type: 'off' });
  const next = controller.apply({ type: 'on' });
  await tick();
  try { assert.equal(controller.pointer, false); assert.equal(releases, 1); }
  finally { finish(); await Promise.all([first, second, next]); }
  assert.equal(controller.pointer, true); assert.ok(output.endpoint);
});

test('failed cleanup blocks activation until restoration retry succeeds', async t => {
  const { controller, output } = setup(t);
  await controller.apply({ type: 'on' });
  let fail = true;
  output.quiesce = async () => { if (fail) throw new Error('restoration unavailable'); output.endpoint = null; };
  await assert.rejects(controller.stop(), /restoration unavailable/);
  await assert.rejects(controller.apply({ type: 'on' }), /restoration unavailable/);
  assert.equal(controller.pointer, false);
  fail = false;
  await controller.apply({ type: 'on' });
  assert.equal(controller.pointer, true);
});

test('owned output uses its ephemeral target, original tuning, and isolated override', async t => {
  const fixture = fakeSensor(t), saved = JSON.parse(fs.readFileSync(fixture.configFile));
  saved.selected_target = 'host.a';saved.motion.filter.sensitivity=1800;saved.target_tuning={'host.a':{sensitivity:3000}};
  fs.writeFileSync(fixture.configFile, `${JSON.stringify(saved)}\n`);
  const output = fakeOutput();
  Object.assign(output, {
    backend: 'owned', buttonEdges: true, defaultTarget: 'airmouse.host', paired: true, pairing: false, buttons: 0,
    targets: [{ id: 'airmouse.host', name: 'Paired computer', ready: true }],
  });
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  t.after(() => controller.stop());
  assert.equal(controller.target, 'airmouse.host');
  assert.equal(JSON.parse(fs.readFileSync(fixture.configFile)).selected_target, 'host.a');
  const state=controller.state();
  assert.deepEqual({backend:state.bluetooth_backend,edges:state.button_edges,paired:state.paired,pairing:state.pairing,buttons:state.buttons},{backend:'owned',edges:true,paired:true,pairing:false,buttons:0});
  assert.equal(controller.currentTuning().sensitivity,3000);assert.equal(state.speed,100);
  await controller.apply({type:'speed',speed:70});
  const overridden=JSON.parse(fs.readFileSync(fixture.configFile));
  assert.equal(overridden.target_tuning['host.a'].sensitivity,3000);
  assert.equal(overridden.target_tuning['airmouse.host'].sensitivity,2100);
  assert.equal(controller.currentTuning().sensitivity,2100);assert.equal(controller.state().speed,70);
  await assert.rejects(controller.apply({type:'target',id:''}),/Unknown target/);
  assert.equal(JSON.parse(fs.readFileSync(fixture.configFile)).selected_target,'host.a');
});

test('owned button edges require pointing and release after stop is idempotent', async t => {
  const { controller, output } = setup(t);
  output.backend = 'owned'; output.buttonEdges = true; output.paired = true;
  await assert.rejects(controller.button(1, true), /Turn pointer on/);
  await controller.button(1, false);
  await controller.apply({ type: 'on' });
  const generation = controller.generation;
  await controller.button(1, true); await controller.button(1, false);
  assert.deepEqual(output.buttonCalls, [{ button: 1, down: true, generation }, { button: 1, down: false, generation }]);
  await controller.stop(); await controller.button(1, false);
  assert.equal(output.buttonCalls.length, 2);
});

test('owned pairing is unavailable through the Core backend', async t => {
  const { controller, output } = setup(t);
  await assert.rejects(controller.apply({ type: 'pair' }), /unavailable/);
  output.backend = 'owned';
  await controller.apply({ type: 'pair' });
  assert.equal(output.pairCalls, 1);
});

test('an owned button delivery error stops the pointer before returning the error', async t => {
  const {controller,output}=setup(t);output.backend='owned';output.buttonEdges=true;
  await controller.apply({type:'on'});
  output.button=async()=>{throw new Error('edge rejected');};
  await assert.rejects(controller.button(1,true),/edge rejected/);
  assert.equal(controller.pointer,false);assert.equal(controller.reason,'Button output failed');
});

test('v2 legacy migration copies complete tuning once without changing the Core target', async t => {
  const fixture = fakeSensor(t), saved = JSON.parse(fs.readFileSync(fixture.configFile));
  saved.selected_target = 'host.a';
  saved.target_tuning = {
    'airmouse.host': { sensitivity: 2700, deadzone: 0.12, nested: { retained: true } },
    'host.a': { sensitivity: 3000 },
  };
  fs.writeFileSync(fixture.configFile, `${JSON.stringify(saved)}\n`);
  const output = ownedV2(fakeOutput());
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  t.after(() => controller.stop());
  const migrated = JSON.parse(fs.readFileSync(fixture.configFile));
  assert.equal(controller.target, '00000001');
  assert.equal(migrated.selected_target, 'host.a');
  assert.deepEqual(migrated.target_tuning['00000001'], saved.target_tuning['airmouse.host']);
  assert.equal(migrated.owned_bluetooth.legacy_device, '00000001');
  migrated.target_tuning['00000001'].sensitivity = 2100;
  fs.writeFileSync(fixture.configFile, `${JSON.stringify(migrated)}\n`);
  const second = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  assert.equal(second.currentTuning().sensitivity, 2100);
  assert.equal(JSON.parse(fs.readFileSync(fixture.configFile)).target_tuning['00000001'].sensitivity, 2100);
});

test('v2 selection uses daemon IDs, quiesces pointing, and leaves Core selection untouched', async t => {
  const fixture = fakeSensor(t), output = ownedV2(fakeOutput());
  const original = JSON.parse(fs.readFileSync(fixture.configFile)).selected_target;
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  controller.nativeControl = true;t.after(() => controller.stop());
  await controller.apply({ type: 'on' });
  const beforeStops = output.quiesceCalls;
  await controller.apply({ type: 'target', id: '00000002' });
  assert.equal(controller.pointer, false);assert.equal(controller.target, '00000002');
  assert.deepEqual(output.selectCalls, ['00000002']);assert.ok(output.quiesceCalls > beforeStops);
  assert.equal(JSON.parse(fs.readFileSync(fixture.configFile)).selected_target, original);
  assert.equal(controller.currentTuning().sensitivity, undefined);
});

test('v2 management stops risky operations, serializes metadata, and exposes daemon failures', async t => {
  const fixture = fakeSensor(t), output = ownedV2(fakeOutput());
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  controller.nativeControl = true;t.after(() => controller.stop());
  await controller.apply({ type: 'on' });
  await controller.apply({ type: 'pair' });
  assert.equal(controller.pointer, false);assert.equal(controller.reason, 'Pairing');assert.equal(output.pairCalls, 1);
  await controller.apply({ type: 'rename', id: '00000001', name: 'Travel' });
  await controller.apply({ type: 'reorder', ids: ['00000002', '00000001'] });
  await controller.apply({ type: 'cancel_pairing' });
  assert.deepEqual(output.renameCalls, [{ id: '00000001', name: 'Travel' }]);
  assert.deepEqual(output.reorderCalls, [['00000002', '00000001']]);assert.equal(output.cancelPairingCalls, 1);
  output.rename = async () => { throw new Error('registry fsync failed'); };
  await assert.rejects(controller.apply({ type: 'rename', id: '00000001', name: 'Nope' }), /fsync/);
  assert.equal(controller.state().error, 'registry fsync failed');
  await controller.apply({ type: 'forget', id: '00000001' });
  assert.deepEqual(output.forgetCalls, ['00000001']);assert.equal(controller.target, '');
});

test('external v2 selection changes stop the old sensor session without automatic restart', async t => {
  const fixture = fakeSensor(t), output = ownedV2(fakeOutput());
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  controller.nativeControl = true;t.after(() => controller.stop());
  await controller.apply({ type: 'on' });
  output.selectedTarget = '00000002';output.endpoint = '00000001';
  output.targets[0].ready = false;output.targets[0].connected = false;
  output.targets[1].ready = true;output.targets[1].connected = true;
  controller.syncOutput();await controller.cleanup;
  assert.equal(controller.target, '00000002');assert.equal(controller.pointer, false);
  assert.equal(controller.reason, 'Bluetooth target changed');
});

test('a v2 selection change during OPEN invalidates activation and restores the sensor', async t => {
  const fixture = fakeSensor(t), output = ownedV2(fakeOutput());let finishOpen;
  output.open = async (id, generation) => {
    output.generation = generation;await new Promise(resolve => { finishOpen = resolve; });
    if (generation !== output.generation) return null;
    output.endpoint = id;return id;
  };
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  controller.nativeControl = true;t.after(() => controller.stop());
  const activation = controller.apply({ type: 'on' });
  for (let i = 0; i < 20 && !finishOpen; i++) await tick();
  assert.ok(finishOpen);assert.ok(fixture.sensor.record);
  output.selectedTarget = '00000002';output.targets[0].ready = false;output.targets[1].ready = true;
  controller.syncOutput();finishOpen();await activation;await controller.cleanup;
  assert.equal(controller.target, '00000002');assert.equal(controller.pointer, false);assert.equal(fixture.sensor.record, null);
});

test('home quick switch preserves pointing intent and resumes only when the new host is ready', async t => {
  const fixture = fakeSensor(t), output = ownedV2(fakeOutput());
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  controller.nativeControl = true; t.after(() => controller.releaseControl('Test cleanup'));
  let ready = true;
  output.ready = id => ready && id === output.selectedTarget;
  output.select = async id => { assert.equal(controller.pointer, false); assert.equal(output.endpoint, null); output.selectedTarget = id; ready = false; };
  await controller.apply({ type: 'on' });
  await controller.apply({ type: 'target', id: '00000002', keep_pointer: true });
  assert.equal(controller.pointer, false);
  assert.equal(controller.state().pointer_enabled, true);
  assert.equal(controller.state().switching, true);
  ready = true; controller.syncOutput();
  for (let i = 0; i < 50 && !controller.pointer; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(controller.pointer, true);
  assert.equal(output.endpoint, '00000002');
});

function quickSwitchFixture(t, options = {}) {
  const fixture = fakeSensor(t), output = ownedV2(fakeOutput());
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile, ...options });
  controller.nativeControl = true; t.after(() => controller.stop());
  const connected = new Set(['00000001']);
  output.ready = id => output.connected && connected.has(id) && id === output.selectedTarget;
  output.select = async id => { output.selectedTarget = id; controller.syncOutput(); };
  return { controller, output, connected };
}
const settleSwitch = async controller => {
  for (let i = 0; i < 100 && controller.switching; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.switching, null);
};

test('paused quick switching stays paused and clicking the selected shortcut is a no-op', async t => {
  const {controller, output, connected} = quickSwitchFixture(t);
  await controller.apply({type:'target',id:'00000002',keep_pointer:true});
  assert.equal(controller.state().pointer_enabled,false);
  connected.add('00000002'); await settleSwitch(controller);
  assert.equal(controller.pointer,false);
  await controller.apply({type:'on'});
  const generation=controller.generation;
  await controller.apply({type:'target',id:'00000002',keep_pointer:true});
  assert.equal(controller.pointer,true);assert.equal(controller.generation,generation);
  assert.equal(output.endpoint,'00000002');
});

test('OFF, page closure, and daemon loss cancel pending quick-switch activation', async t => {
  for (const reason of ['off','page','daemon']) {
    const {controller, output, connected} = quickSwitchFixture(t);
    await controller.apply({type:'on'});
    await controller.apply({type:'target',id:'00000002',keep_pointer:true});
    if(reason==='off') await controller.apply({type:'off'});
    if(reason==='page'){controller.nativeControl=false;await controller.stop('Air mouse screen closed');}
    if(reason==='daemon'){output.connected=false;controller.syncOutput();}
    connected.add('00000002'); output.connected=true; controller.syncOutput();
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(controller.switching,null);assert.equal(controller.pointer,false);assert.equal(output.endpoint,null);
  }
});

test('offline quick switch times out and a late reconnection cannot activate pointing', async t => {
  const {controller,connected} = quickSwitchFixture(t,{switchTimeoutMs:30});
  await controller.apply({type:'on'});
  await controller.apply({type:'target',id:'00000002',keep_pointer:true});
  await settleSwitch(controller);
  assert.match(controller.error,/did not reconnect/);assert.equal(controller.state().pointer_enabled,false);
  connected.add('00000002');controller.syncOutput();
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(controller.pointer,false);
});

test('quick switch deadline cancels stalled activation and ignores its late completion', async t => {
  const {controller,output,connected}=quickSwitchFixture(t,{switchTimeoutMs:30});
  await controller.apply({type:'on'});
  let finish;
  output.open=()=>new Promise(resolve=>{finish=resolve;});
  connected.add('00000002');
  await controller.apply({type:'target',id:'00000002',keep_pointer:true});
  await new Promise(resolve=>setTimeout(resolve,70));
  try {
    assert.equal(controller.state().pointer_enabled,false);
    assert.equal(controller.switching,null);
  } finally { finish?.(); }
  await tick(); assert.equal(controller.pointer,false);
});

test('another quick switch retains intent and only the latest computer can activate', async t => {
  const {controller,output,connected} = quickSwitchFixture(t);
  output.targets.push({id:'00000003',name:'Third',ready:false});
  await controller.apply({type:'on'});
  await controller.apply({type:'target',id:'00000002',keep_pointer:true});
  await controller.apply({type:'target',id:'00000003',keep_pointer:true});
  connected.add('00000002');controller.syncOutput();
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(controller.pointer,false);
  assert.equal(controller.state().pointer_enabled,true);
  connected.add('00000003');controller.syncOutput();await settleSwitch(controller);
  assert.equal(controller.pointer,true);assert.equal(output.endpoint,'00000003');
});

test('OFF during release prevents a delayed SELECT and OFF during SELECT prevents resume', async t => {
  for(const phase of ['release','select']) {
    const {controller,output,connected}=quickSwitchFixture(t);
    await controller.apply({type:'on'});
    let finish, selectCalls=0;
    const gate=new Promise(resolve=>{finish=resolve;});
    if(phase==='release')output.quiesce=()=>gate.then(()=>{output.endpoint=null;});
    output.select=async id=>{selectCalls++;if(phase==='select')await gate;output.selectedTarget=id;};
    const switching=controller.apply({type:'target',id:'00000002',keep_pointer:true});
    await tick(); const off=controller.stop(); finish(); await Promise.all([switching,off]);
    connected.add('00000002');controller.syncOutput();await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(controller.pointer,false);assert.equal(controller.switching,null);
    if(phase==='release')assert.equal(selectCalls,0);
  }
});

test('a full control queue rejects pair and forget before they can stop pointing', async t => {
  const fixture = fakeSensor(t), output = ownedV2(fakeOutput());
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile });
  controller.nativeControl = true; t.after(() => controller.stop());
  await controller.apply({ type: 'on' });
  let release, calls = 0;
  output.media = () => calls++ === 0 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const pending = [];
  for (let i = 0; i < 16; i++) pending.push(controller.apply({ type: 'media', key: 'mute' }));
  await assert.rejects(controller.apply({ type: 'pair' }), /Control queue full/);
  await assert.rejects(controller.apply({ type: 'forget', id: '00000002' }), /Control queue full/);
  assert.equal(controller.pointer, true); assert.equal(output.pairCalls, 0); assert.deepEqual(output.forgetCalls, []);
  release(); await Promise.all(pending);
});

test('control ownership is written only through the controller', async t => {
  const { controller } = setup(t);
  controller.nativeControl = false;
  await assert.rejects(controller.apply({ type: 'on' }), /Control or Bluetooth target unavailable/);
  controller.acquireControl(); await controller.apply({ type: 'on' }); assert.equal(controller.pointer, true);
  await controller.releaseControl('Air mouse screen closed');
  assert.equal(controller.pointer, false); assert.equal(controller.nativeControl, false); assert.equal(controller.reason, 'Air mouse screen closed');
});

function disconnectedOwned(t) {
  const fixture = fakeSensor(t), output = ownedV2(fakeOutput());
  output.targets[0].ready = false; output.targets[0].connected = false;
  output.reconnectCalls = 0; output.reconnect = async () => { output.reconnectCalls++; };
  const controller = new Controller({ sensor: fixture.sensor, output, configFile: fixture.configFile, reconnectHoldMs: 50, ownershipStartupMs: 0 });
  controller.nativeControl = true; t.after(() => controller.stop());
  return { ...fixture, output, controller };
}

test('physical input while the selected computer is disconnected requests one reconnect', async t => {
  const { controller, output } = disconnectedOwned(t);
  output.key = async () => { throw new Error('should not send while disconnected'); };
  output.media = output.key; output.button = output.key;
  assert.equal(controller.disconnected, true);
  await assert.rejects(controller.apply({ type: 'key', key: 'up' }), /Reconnecting/);
  await assert.rejects(controller.apply({ type: 'media', key: 'mute' }), /Reconnecting/);
  await assert.rejects(controller.button(1, true), /Reconnecting/);
  await assert.rejects(controller.apply({ type: 'on' }), /Reconnecting/);
  assert.equal(output.reconnectCalls, 1, 'rate limited to one request inside the hold window');
  assert.equal(controller.state().reconnecting, true);
  await new Promise(resolve => setTimeout(resolve, 60));
  await controller.apply({ type: 'reconnect' });
  assert.equal(output.reconnectCalls, 2);
  await assert.rejects(controller.apply({ type: 'reconnect' }), /already requested/);
  output.targets[0].ready = true; output.targets[0].connected = true;
  assert.equal(controller.disconnected, false);
  await assert.rejects(controller.apply({ type: 'reconnect' }), /not disconnected/);
  const sent = []; output.key = async (target, key) => sent.push(key);
  await controller.apply({ type: 'key', key: 'up' });
  assert.deepEqual(sent, ['up']);
});

test('a disconnected target with the app open retries on a timer until it connects', async t => {
  const { controller, output } = disconnectedOwned(t);
  controller.reconnectRetryMs = 20; controller.reconnectHoldMs = 5;
  controller.syncReconnectWatch();
  assert.equal(controller.reconnectTimer.hasRef?.(), false, 'retry timer does not own process lifetime');
  t.after(() => clearInterval(controller.reconnectTimer));
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.ok(output.reconnectCalls >= 2, `expected periodic retries, got ${output.reconnectCalls}`);
  output.targets[0].ready = true; output.targets[0].connected = true;
  controller.syncOutput(); await tick();
  const settled = output.reconnectCalls;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(output.reconnectCalls, settled, 'no retries once connected');
  assert.equal(controller.reconnectTimer, null);
});

test('a shake while disconnected requests a reconnect and the watcher stops once connected', async t => {
  const { controller, output, sensor } = disconnectedOwned(t);
  let wake = null, closed = 0;
  sensor.watchWake = callback => { wake = callback; };
  sensor.closeReader = () => { closed++; wake = null; };
  controller.syncReconnectWatch();
  assert.ok(wake, 'wake watcher armed while disconnected');
  wake(); await tick();
  assert.equal(output.reconnectCalls, 1);
  output.targets[0].ready = true; output.targets[0].connected = true;
  controller.syncOutput(); await tick();
  assert.equal(wake, null, 'watcher released once the target is ready');
  assert.ok(closed >= 1);
  controller.nativeControl = false; controller.syncReconnectWatch(); assert.equal(wake, null);
});

test('LG power while disconnected wakes the TV and also asks for a Bluetooth reconnect', async t => {
  const { controller, output } = disconnectedOwned(t);
  output.targets[0].bluetooth_name = '[LG] webOS TV OLED77G3PSA';
  const wakes = []; controller.wakeTV = async config => wakes.push(config);
  controller.config.lg_tv_power = { '00000001': { mac: '02:11:22:33:44:55', broadcast: '192.168.1.255' } };
  await controller.apply({ type: 'power' });
  assert.deepEqual(wakes, [controller.config.lg_tv_power['00000001']]);
  assert.equal(output.reconnectCalls, 1);
});
