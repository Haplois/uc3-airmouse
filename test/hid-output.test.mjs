import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { HidOutput } from '../runtime/hid-output.mjs';
import { Controller } from '../runtime/controller.mjs';
import { fakeSensor } from './helpers.mjs';
import { LgWakeDetector } from './support/lg-receiver.mjs';

const readyState = {
  ready: true, paired: true, pairing: false, active: false, buttons: 0,
  interval_ms: 7.5, reports_sent: 0, dropped_motion: 0, error: '',
};
const devices = [
  { id: '00000001', name: 'Work laptop', bluetooth_name: 'Laptop', custom_name: 'Work laptop', legacy: true },
  { id: '00000002', name: '桌面电脑', bluetooth_name: '桌面电脑', custom_name: '', legacy: false },
];
const readyV2State = {
  ...readyState, working: true, connected: true, selected: '00000001', connected_device: '00000001', host_limit: 4, devices,
};

async function waitFor(predicate, message = 'condition') {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  throw new Error(`Timed out waiting for ${message}`);
}

async function fakeDaemon(t, { initialState = readyState, version = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airmouse-hid-')), socketPath = path.join(dir, 'control.sock');
  const commands = [], clients = new Set(); let handler = () => true, connections=0;
  const server = net.createServer(socket => {
    connections++;
    clients.add(socket); socket.setEncoding('utf8'); let buffer = '';
    if (initialState) socket.write(`${JSON.stringify({ state: initialState, version })}\n`);
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        commands.push(line);
        const [command, rawID] = line.split(' '), id = Number(rawID);
        if (command === 'PING' || command === 'MOVE' || command === 'IMU') continue;
        const result = handler(command, line, socket);
        if (result === false) continue;
        const response = typeof result === 'object' ? { id, ...result } : { id, ok: true };
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
    socket.on('close', () => clients.delete(socket)); socket.on('error', () => {});
  });
  server.listen(socketPath); await once(server, 'listening');
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    server.close(); await once(server, 'close').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    socketPath, commands,
    get connections(){return connections;},
    handle(next) { handler = next; },
    drop() { for(const socket of clients)socket.destroy(); },
    state(value, nextVersion = version) {
      const base = nextVersion === 2 ? readyV2State : readyState;
      for (const socket of clients) socket.write(`${JSON.stringify({ state: { ...base, ...value }, version: nextVersion })}\n`);
    },
    message(value) { for (const socket of clients) socket.write(`${JSON.stringify(value)}\n`); },
    raw(value) { for (const socket of clients) socket.write(value); },
  };
}

async function connectedOutput(t, daemon, options = {}) {
  const output = new HidOutput({ socketPath: daemon.socketPath, heartbeatMs: 10_000, retryMs: 100_000, ...options });
  t.after(() => output.close()); output.start();
  await waitFor(() => output.ready('airmouse.host'), 'owned HID readiness');
  return output;
}

test('daemon socket connection waits for inventory before publishing Bluetooth availability', async t => {
  const daemon = await fakeDaemon(t, { initialState: null, version: 2 });
  const published = [];
  const output = new HidOutput({ socketPath: daemon.socketPath, onState: () => published.push({ connected: output.connected, targets: output.targets }) });
  t.after(() => output.close());
  output.start();
  await waitFor(() => daemon.commands.includes('PING 0'));
  assert.equal(output.connected, false);
  assert.equal(published.some(state => state.connected), false);
  daemon.state(readyV2State);
  await waitFor(() => output.connected);
  assert.equal(published.length, 1);
  assert.equal(published[0].targets[0].name, 'Work laptop');
});

test('media uses selected host while paused and stop revokes media delivery', async t => {
  const daemon=await fakeDaemon(t), output=await connectedOutput(t,daemon);
  await output.media('airmouse.host','play_pause');
  assert.ok(daemon.commands.some(line=>/^MEDIA \d+ 205$/.test(line)));
  await assert.rejects(output.media('other','mute'),/unavailable/);
  await assert.rejects(output.media('airmouse.host','unknown'),/Unknown/);
  await output.quiesce();
  assert.ok(daemon.commands.some(line=>/^STOP /.test(line)));
});

test('arrow keys encode keyboard usages and reject unavailable hosts', async t => {
  const daemon=await fakeDaemon(t), output=await connectedOutput(t,daemon);
  for (const key of ['up','down','left','right']) await output.key('airmouse.host',key);
  assert.deepEqual(daemon.commands.filter(line=>line.startsWith('KEY ')).map(line=>Number(line.split(' ')[2])),[82,81,80,79]);
  await assert.rejects(output.key('other','up'),/unavailable/);
  await assert.rejects(output.key('airmouse.host','enter'),/Unknown/);
  await output.quiesce();
  assert.ok(daemon.commands.some(line=>line.startsWith('STOP ')));
});

test('renamed LG TV uses native MR23 navigation and volume while paused', async t => {
  const tv = { ...devices[0], name: 'TV', custom_name: 'TV', bluetooth_name: '[LG] webOS TV OLED77G3PSA' };
  const daemon = await fakeDaemon(t, { version: 2, initialState: { ...readyV2State, devices: [tv, devices[1]] } });
  const output = new HidOutput({ socketPath: daemon.socketPath });
  t.after(() => output.close()); output.start();
  await waitFor(() => output.ready(tv.id));
  for (const key of ['power', 'input_next', 'input_previous', 'quick_settings', 'all_settings', 'input_picker', 'hdmi1', 'netflix', 'youtube', 'steam_machine', 'ok', 'back', 'home', 'channel_up', 'channel_down']) await output.key(tv.id, key);
  for (const key of ['mute', 'volume_up', 'volume_down', 'stop', 'play_pause']) await output.media(tv.id, key);
  assert.deepEqual(daemon.commands.filter(line => line.startsWith('LGKEY ')).map(line => Number(line.split(' ')[2])),
    [0x8008, 0x7f01, 0x7f02, 0x7f03, 0x7f04, 0x7f05, 0x7f06, 0x7f07, 0x7f08, 0x7f09, 0x8044, 0x8028, 0x807c, 0x8000, 0x8001, 0x7f0d, 0x7f0b, 0x7f0c, 0x7f0e, 0x7f0a]);
  assert.equal(daemon.commands.some(line => line.startsWith('MEDIA ')), false);
  await assert.rejects(output.key(devices[1].id, 'home'), /Unknown|unavailable/);
  await assert.rejects(output.media(tv.id, 'previous'), /not supported/);
});

test('STOP cancels pending keyboard requests and ignores their late replies', async t => {
  const daemon=await fakeDaemon(t), output=await connectedOutput(t,daemon);
  daemon.handle(command=>command!=='KEY');
  const key=output.key('airmouse.host','up');
  const canceled=assert.rejects(key,/invalidated by stop/);
  await waitFor(()=>daemon.commands.some(line=>line.startsWith('KEY ')));
  const id=Number(daemon.commands.find(line=>line.startsWith('KEY ')).split(' ')[1]);
  await output.quiesce(); await canceled;
  daemon.message({id,ok:false,error:'Input stopped'});
  daemon.handle(()=>true);
  await output.key('airmouse.host','left');
  assert.equal(output.connected,true);
});

test('owned output speaks the exact protocol and preserves absolute button masks', async t => {
  let now = 1000;
  const daemon = await fakeDaemon(t), output = await connectedOutput(t, daemon, { clock: () => now });
  assert.equal(output.defaultTarget, 'airmouse.host');assert.equal(output.buttonEdges,true);assert.equal(output.paired,true);
  await output.prepare('airmouse.host');await output.open('airmouse.host',7);
  const left=output.button(1,true,7),both=output.button(2,true,7),right=output.button(1,false,7);
  await Promise.all([left,both,right]);
  output.move({generation:7,time:1,dx:120,dy:-110});
  output.move({generation:7,time:1.001,dx:904.8,dy:-658.2});output.flush();
  await output.sendAction('MOUSE_WHEEL_-1',7);
  output.invalidate(8);await output.quiesce();
  assert.deepEqual(daemon.commands.filter(line=>!line.startsWith('PING ')),[
    'OPEN 1','BUTTON 2 1','BUTTON 3 3','BUTTON 4 2','MOVE 0 1024 -768','SCROLL 5 -1','STOP 6',
  ]);
  assert.equal(output.metrics().submitted_movement_updates,1);
});

test('stale and invalidated movement never crosses the daemon socket', async t => {
  let now = 1000;
  const daemon = await fakeDaemon(t), output = await connectedOutput(t, daemon, { clock: () => now });
  await output.open('airmouse.host',2);
  output.move({generation:2,time:0.9,dx:4,dy:5});output.flush();
  output.move({generation:2,time:1,dx:7,dy:8});output.invalidate(3);output.flush();
  assert.equal(daemon.commands.some(line=>line.startsWith('MOVE ')),false);
  assert.equal(output.metrics().dropped_movement,1);
  await output.quiesce();
});

test('a button edge flushes motion under the preceding button mask', async t => {
  let now=1000;
  const daemon=await fakeDaemon(t),output=await connectedOutput(t,daemon,{clock:()=>now});
  await output.open('airmouse.host',1);await output.button(1,true,1);
  output.lastMovement=now;output.nextMovement=now+1000;
  output.move({generation:1,time:1,dx:9,dy:7});
  await output.button(1,false,1);
  const input=daemon.commands.filter(line=>line.startsWith('BUTTON ')||line.startsWith('MOVE '));
  assert.deepEqual(input,['BUTTON 2 1','MOVE 0 9 7','BUTTON 3 0']);
  output.invalidate(2);await output.quiesce();
});

test('a timed-out button aborts the lease without replay', async t => {
  const daemon = await fakeDaemon(t);daemon.handle(command=>command==='BUTTON'?false:true);
  let stops=0;
  const output = await connectedOutput(t, daemon, { requestTimeoutMs: 30, onStop:()=>{stops++;} });
  await output.open('airmouse.host',1);
  await assert.rejects(output.button(1,true,1),/timed out/);
  await waitFor(()=>!output.connected,'adapter disconnect');
  assert.equal(daemon.commands.filter(line=>line.startsWith('BUTTON ')).length,1);
  assert.equal(stops,1);
});

test('a seventeenth unacknowledged edge closes the lease without writing that edge', async t => {
  const daemon = await fakeDaemon(t);daemon.handle(command=>command==='BUTTON'?false:true);
  const output = await connectedOutput(t, daemon);
  await output.open('airmouse.host',1);
  const pending=[];
  for(let i=0;i<16;i++)pending.push(output.button(1,i%2===0,1).catch(error=>error));
  await assert.rejects(output.button(1,true,1),/queue full/);
  await Promise.all(pending);await waitFor(()=>!output.connected,'bounded-request disconnect');
  const written=daemon.commands.filter(line=>line.startsWith('BUTTON '));
  assert.ok(written.length<=16);
  assert.ok(written.every(line=>Number(line.split(' ')[1])<=17));
});

test('STOP bypasses sixteen pending inputs and absorbs their late replies', async t => {
  const daemon=await fakeDaemon(t);
  daemon.handle((command,line,socket)=>{
    if(command==='BUTTON')return false;
    if(command==='STOP')socket.write(`${JSON.stringify({id:2,ok:false,error:'invalidated'})}\n`);
    return true;
  });
  const output=await connectedOutput(t,daemon);
  await output.open('airmouse.host',1);
  const pending=[];
  for(let i=0;i<16;i++)pending.push(output.button(1,i%2===0,1).catch(error=>error));
  output.invalidate(2);await output.quiesce();await Promise.all(pending);await delay(10);
  assert.ok(daemon.commands.some(line=>line.startsWith('STOP ')));
  assert.equal(output.connected,true);
});

test('daemon state updates pairing and connection metrics', async t => {
  const daemon = await fakeDaemon(t),output=await connectedOutput(t,daemon);
  await output.pair();assert.ok(daemon.commands.some(line=>line.startsWith('PAIR ')));
  daemon.state({working:true,connected:false,ready:false,paired:false,pairing:true,interval_ms:null,reports_sent:11,dropped_motion:4});
  await waitFor(()=>output.pairing,'pairing state');
  assert.equal(output.paired,false);assert.equal(output.targets[0].ready,false);
  assert.equal(output.daemon.working,true);assert.equal(output.daemon.connected,false);
  assert.deepEqual(output.metrics().bluetooth,{connection_interval_ms:null,reports_sent:11});
  assert.equal(output.metrics().dropped_movement,4);
  assert.equal(output.deviceManagement,false);assert.equal(output.selectedTarget,'airmouse.host');
});

test('v2 status derives the ordered roster and management commands use exact bounded ASCII', async t => {
  const daemon = await fakeDaemon(t, { initialState: readyV2State, version: 2 });
  const output = new HidOutput({ socketPath: daemon.socketPath, heartbeatMs: 10_000, retryMs: 100_000 });
  t.after(() => output.close()); output.start();
  await waitFor(() => output.ready('00000001'), 'v2 owned HID readiness');
  assert.equal(output.protocolVersion, 2);assert.equal(output.deviceManagement, true);assert.equal(output.hostLimit, 4);
  assert.equal(output.defaultTarget, null);assert.equal(output.selectedTarget, '00000001');
  assert.deepEqual(output.targets, [
    { ...devices[0], ready: true, connected: true },
    { ...devices[1], ready: false, connected: false },
  ]);
  await output.select('00000002');
  await output.rename('00000001', 'Café 💻');
  await output.rename('00000002', '');
  await output.reorder(['00000002', '00000001']);
  await output.forget('00000002');
  await output.cancelPairing();
  await output.pair();
  assert.deepEqual(daemon.commands.filter(line => !line.startsWith('PING ')), [
    'SELECT 1 00000002',
    `RENAME 2 00000001 ${Buffer.from('Café 💻').toString('hex')}`,
    'RENAME 3 00000002 -',
    'REORDER 4 00000002,00000001',
    'FORGET 5 00000002',
    'CANCEL_PAIR 6',
    'PAIR 7',
  ]);
  await output.reconnect();
  assert.equal(daemon.commands.filter(line => !line.startsWith('PING ')).at(-1), 'RECONNECT 8');
  daemon.state({ selected: '', connected_device: '', ready: false, active: false });
  await waitFor(() => output.selectedTarget === '', 'cleared selection');
  await assert.rejects(output.reconnect(), /No computer is selected/);
});

test('v2 management rejects invalid IDs, names, permutations, and capacity before writing', async t => {
  const fullState = { ...readyV2State, devices: [...devices,
    { id: '00000003', name: 'Computer 3', bluetooth_name: '', custom_name: '', legacy: false },
    { id: '00000004', name: 'Computer 4', bluetooth_name: '', custom_name: '', legacy: false }] };
  const daemon = await fakeDaemon(t, { initialState: fullState, version: 2 });
  const output = new HidOutput({ socketPath: daemon.socketPath, heartbeatMs: 10_000, retryMs: 100_000 });
  t.after(() => output.close());output.start();await waitFor(() => output.deviceManagement, 'v2 status');
  const before = daemon.commands.length;
  await assert.rejects(output.select('AIRmouse1'), /Invalid/);
  await assert.rejects(output.rename('00000001', 'bad\nname'), /Invalid/);
  await assert.rejects(output.rename('00000001', 'é'.repeat(25)), /Invalid/);
  await assert.rejects(output.reorder(['00000001', '00000001', '00000003', '00000004']), /Invalid/);
  await assert.rejects(output.forget('ffffffff'), /Unknown/);
  await assert.rejects(output.pair(), /limit/);
  assert.equal(daemon.commands.length, before);
});

test('malformed v2 roster and invalid UTF-8 fail the daemon lease closed', async t => {
  const malformed = [
    ['schema relationship', { ...readyV2State, selected: '00000003' }],
    ['extra field', { ...readyV2State, surprise: true }],
    ['resolved name', { ...readyV2State, devices: [{ ...devices[0], name: 'Stale alias' }, devices[1]] }],
    ['paired roster relationship', { ...readyV2State, paired: false }],
  ];
  for (const [name, state] of malformed) await t.test(name, async t => {
    const daemon = await fakeDaemon(t), output = await connectedOutput(t, daemon);
    daemon.message({ version: 2, state });
    await waitFor(() => !output.connected, 'invalid v2 disconnect');
  });
  await t.test('UTF-8', async t => {
    const daemon = await fakeDaemon(t), output = await connectedOutput(t, daemon);
    const prefix = Buffer.from('{"state":{"name":"');
    daemon.raw(Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), Buffer.from('"},"version":2}\n')]));
    await waitFor(() => !output.connected, 'invalid UTF-8 disconnect');
  });
});

test('metadata requests use their own bounded timeout while input keeps the short lease', async t => {
  const daemon = await fakeDaemon(t, { initialState: readyV2State, version: 2 });
  daemon.handle(command => command === 'SELECT' ? false : true);
  const output = new HidOutput({
    socketPath: daemon.socketPath, heartbeatMs: 10_000, retryMs: 100_000,
    requestTimeoutMs: 10, metadataRequestTimeoutMs: 60,
  });
  t.after(() => output.close());output.start();await waitFor(() => output.deviceManagement, 'v2 status');
  const pending = output.select('00000002');
  await delay(25);assert.equal(output.connected, true);
  await assert.rejects(pending, /select timed out/i);
  await waitFor(() => !output.connected, 'metadata timeout disconnect');
});

test('the daemon receive buffer is bounded to 8192 bytes', async t => {
  const daemon = await fakeDaemon(t), output = await connectedOutput(t, daemon);
  daemon.raw(Buffer.alloc(8193, 0x20));
  await waitFor(() => !output.connected, 'oversized response disconnect');
});

test('a v2 selection change revokes an open endpoint even when readiness remains true', async t => {
  let stops = 0;
  const daemon = await fakeDaemon(t, { initialState: readyV2State, version: 2 });
  const output = new HidOutput({ socketPath: daemon.socketPath, heartbeatMs: 10_000, retryMs: 100_000, onStop: () => { stops++; } });
  t.after(() => output.close());output.start();await waitFor(() => output.ready('00000001'), 'v2 readiness');
  await output.open('00000001', 1);
  daemon.state({ selected: '00000002', connected_device: '00000002' }, 2);
  await waitFor(() => stops === 1, 'selection revocation');
  assert.equal(output.selectedTarget, '00000002');assert.equal(output.ready('00000001'), false);
});

test('an unexpected daemon session revocation stops the controller while the host remains ready', async t => {
  const daemon=await fakeDaemon(t),fixture=fakeSensor(t);let controller;
  const output=new HidOutput({socketPath:daemon.socketPath,heartbeatMs:10_000,retryMs:100_000,onStop:reason=>controller?.stop(reason).catch(()=>{})});
  t.after(()=>output.close());output.start();await waitFor(()=>output.ready('airmouse.host'),'owned HID readiness');
  controller=new Controller({sensor:fixture.sensor,output,configFile:fixture.configFile});controller.nativeControl=true;
  t.after(()=>controller.stop().catch(()=>{}));
  await controller.apply({type:'on'});
  daemon.state({active:true});await waitFor(()=>output.active,'active daemon session');
  daemon.state({ready:true,active:false,error:'Button queue overflow; pointing stopped'});
  await waitFor(()=>!controller.pointer,'controller stop after daemon revocation');
  assert.equal(controller.reason,'Button queue overflow; pointing stopped');
  assert.equal(output.endpoint,null);
});

test('readiness loss while OPEN is pending restores the sensor and suppresses activation', async t => {
  const daemon=await fakeDaemon(t);daemon.handle(command=>command==='OPEN'?false:true);
  const fixture=fakeSensor(t);let controller;
  const output=new HidOutput({socketPath:daemon.socketPath,heartbeatMs:10_000,retryMs:100_000,onStop:reason=>controller?.stop(reason).catch(()=>{})});
  t.after(()=>output.close());output.start();await waitFor(()=>output.ready('airmouse.host'),'owned HID readiness');
  controller=new Controller({sensor:fixture.sensor,output,configFile:fixture.configFile});controller.nativeControl=true;
  t.after(()=>controller.stop().catch(()=>{}));
  const activation=controller.apply({type:'on'});
  await waitFor(()=>daemon.commands.some(line=>line.startsWith('OPEN ')),'pending OPEN');
  assert.ok(fixture.sensor.record);
  daemon.state({ready:false,connected:false,error:'Host disconnected'});
  await activation;await controller.cleanup;
  assert.equal(controller.pointer,false);assert.equal(fixture.sensor.record,null);
  assert.equal(controller.reason,'Host disconnected');
});

test('heartbeat and reconnect keep request IDs monotonic without replaying held state',async t=>{
  const daemon=await fakeDaemon(t),output=await connectedOutput(t,daemon,{heartbeatMs:20,retryMs:10});
  await output.open('airmouse.host',1);await output.button(1,true,1);
  await waitFor(()=>daemon.commands.filter(line=>line==='PING 0').length>=2,'heartbeat');
  daemon.drop();await waitFor(()=>daemon.connections>=2&&output.ready('airmouse.host'),'reconnect');
  assert.equal(output.desiredButtons,0);
  assert.equal(daemon.commands.filter(line=>line.startsWith('BUTTON ')).length,1);
  await output.open('airmouse.host',2);
  const opens=daemon.commands.filter(line=>line.startsWith('OPEN ')).map(line=>Number(line.split(' ')[1]));
  assert.deepEqual(opens,[1,3]);
  output.invalidate(3);await output.quiesce();
});

const simulator = process.env.AIRMOUSE_HID_BINARY;
test('owned adapter interoperates with the BTstack daemon simulator', { skip: !simulator || !fs.existsSync(simulator), timeout: 5000 }, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'airmouse-hid-integration-')),socketPath=path.join(dir,'control.sock');
  const daemon=spawn(simulator,['--simulate','--simulate-interval','10','--socket',socketPath,'--state-dir',dir],{stdio:['ignore','pipe','pipe']});
  let log='',output;
  daemon.stdout.setEncoding('utf8');daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data',chunk=>{log+=chunk;});daemon.stderr.on('data',chunk=>{log+=chunk;});
  t.after(async()=>{
    output?.close();
    if(daemon.exitCode===null&&daemon.signalCode===null){
      daemon.kill('SIGTERM');
      await Promise.race([once(daemon,'exit'),delay(2000)]);
      if(daemon.exitCode===null&&daemon.signalCode===null)daemon.kill('SIGKILL');
    }
    fs.rmSync(dir,{recursive:true,force:true});
  });
  await waitFor(()=>fs.existsSync(socketPath)||daemon.exitCode!==null,'simulator socket');
  assert.equal(daemon.exitCode,null,log);
  output=new HidOutput({socketPath,heartbeatMs:50,retryMs:100_000});output.start();
  await waitFor(()=>output.protocolVersion === 2 ? output.ready('00000001') : output.ready('airmouse.host'),'simulator readiness');
  assert.deepEqual({working:output.daemon.working,connected:output.daemon.connected},{working:true,connected:true});
  if (output.protocolVersion === 2) {
    assert.equal(output.deviceManagement, true);
    assert.deepEqual(output.targets.map(({ id, name, legacy }) => ({ id, name, legacy })), [{ id: '00000001', name: 'Simulated computer', legacy: true }]);
  }
  await output.open(output.selectedTarget,1);await output.button(1,true,1);
  const now=Number(process.hrtime.bigint())/1e9;
  output.move({generation:1,time:now,dx:1024,dy:-768});output.flush();
  await output.button(2,true,1);await output.button(1,false,1);
  output.invalidate(2);await output.quiesce();
  await waitFor(()=>log.split('\n').filter(line=>line.startsWith('TEST_REPORT ')).length>=5,'simulated reports');
  const reports=log.split('\n').filter(line=>line.startsWith('TEST_REPORT ')).map(line=>line.split(' ').slice(1).map(Number));
  assert.deepEqual(reports.slice(0,5),[[1,0,0,0],[1,1024,-768,0],[3,0,0,0],[2,0,0,0],[0,0,0,0]]);
});

test('owned adapter manages a v2 simulator roster end to end', { skip: !simulator || !fs.existsSync(simulator), timeout: 5000 }, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'airmouse-hid-management-')),socketPath=path.join(dir,'control.sock');
  const daemon=spawn(simulator,['--simulate','--simulate-hosts','2','--socket',socketPath,'--state-dir',dir],{stdio:['ignore','pipe','pipe']});
  let log='',output;
  daemon.stdout.setEncoding('utf8');daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data',chunk=>{log+=chunk;});daemon.stderr.on('data',chunk=>{log+=chunk;});
  t.after(async()=>{
    output?.close();
    if(daemon.exitCode===null&&daemon.signalCode===null){
      daemon.kill('SIGTERM');await Promise.race([once(daemon,'exit'),delay(2000)]);
      if(daemon.exitCode===null&&daemon.signalCode===null)daemon.kill('SIGKILL');
    }
    fs.rmSync(dir,{recursive:true,force:true});
  });
  await waitFor(()=>fs.existsSync(socketPath)||daemon.exitCode!==null,'v2 simulator socket');assert.equal(daemon.exitCode,null,log);
  output=new HidOutput({socketPath,heartbeatMs:50,retryMs:100_000});output.start();
  await waitFor(()=>output.deviceManagement&&output.targets.length===2,'v2 simulator roster');
  const [first,second]=output.targets.map(target=>target.id);
  await output.rename(second,'Desk 🌟');await waitFor(()=>output.targets.find(target=>target.id===second)?.custom_name==='Desk 🌟','simulator rename');
  await output.reorder([second,first]);await waitFor(()=>output.targets[0]?.id===second,'simulator reorder');
  await output.select(second);await waitFor(()=>output.selectedTarget===second&&output.ready(second),'simulator selection');
  await output.pair();await waitFor(()=>output.pairing,'simulator pair window');
  await output.cancelPairing();await waitFor(()=>!output.pairing&&output.ready(second),'simulator pair cancellation');
  await output.forget(first);await waitFor(()=>output.targets.length===1,'simulator forget');
  assert.deepEqual(output.targets.map(({id,name,custom_name})=>({id,name,custom_name})),[{id:second,name:'Desk 🌟',custom_name:'Desk 🌟'}]);
});

test('home quick switching releases a held button and reopens only the new simulator host', {skip:!simulator||!fs.existsSync(simulator),timeout:5000}, async t=>{
  const {Controller}=await import('../runtime/controller.mjs');
  const {fakeSensor}=await import('./helpers.mjs');
  const fixture=fakeSensor(t),socketPath=path.join(fixture.dir,'hid.sock');
  const daemon=spawn(simulator,['--simulate','--simulate-hosts','2','--socket',socketPath,'--state-dir',fixture.dir],{stdio:['ignore','pipe','pipe']});
  let output,controller,log='';
  daemon.stdout.on('data',chunk=>{log+=chunk;});daemon.stderr.on('data',chunk=>{log+=chunk;});
  t.after(async()=>{await controller?.stop();output?.close();if(daemon.exitCode===null&&daemon.signalCode===null){daemon.kill('SIGTERM');await Promise.race([once(daemon,'exit'),delay(1000)]);if(daemon.exitCode===null&&daemon.signalCode===null)daemon.kill('SIGKILL');}});
  await waitFor(()=>fs.existsSync(socketPath)||daemon.exitCode!==null,'simulator socket');assert.equal(daemon.exitCode,null,log);
  output=new HidOutput({socketPath,heartbeatMs:50,onState:()=>controller?.syncOutput(),onStop:reason=>{controller?.stop(reason);}});output.start();
  await waitFor(()=>output.ready('00000001'),'first computer ready');
  controller=new Controller({sensor:fixture.sensor,configFile:fixture.configFile,output});controller.nativeControl=true;
  await controller.apply({type:'on'});await controller.button(1,true);
  assert.equal(output.buttons,1);
  await controller.apply({type:'target',id:'00000002',keep_pointer:true});
  await waitFor(()=>controller.pointer&&controller.target==='00000002','pointing resumes');
  assert.equal(output.endpoint.id,'00000002');assert.equal(output.buttons,0);assert.equal(output.desiredButtons,0);
  assert.ok(log.indexOf('TEST_REPORT 0 0 0 0')<log.indexOf('SWITCH requested peer=00000002'),log);
  for (const key of ['up','down','left','right']) await controller.apply({type:'key',key});
  await controller.button(2,true);
  await controller.apply({type:'disconnect'});
  await waitFor(()=>controller.target==='' && !output.ready('00000002'),'disconnected computer');
  assert.equal(controller.pointer,false); assert.equal(output.buttons,0); assert.equal(output.targets.length,2);
  await assert.rejects(controller.apply({type:'key',key:'up'}),/unavailable/);
  await controller.apply({type:'target',id:'00000002',keep_pointer:true});
  await waitFor(()=>output.ready('00000002') && !controller.switching,'reconnected computer');
  assert.equal(controller.pointer,false);
  await controller.apply({type:'key',key:'up'});
  await waitFor(()=>log.split('\n').filter(line=>line.startsWith('TEST_KEY ')).length===10,'keyboard reports');
  assert.deepEqual(log.split('\n').filter(line=>line.startsWith('TEST_KEY ')),[
    'TEST_KEY 82','TEST_KEY 0','TEST_KEY 81','TEST_KEY 0','TEST_KEY 80','TEST_KEY 0','TEST_KEY 79','TEST_KEY 0','TEST_KEY 82','TEST_KEY 0',
  ]);
  await controller.stop();
});

test('LG motion retains the latest sample, caps pacing, and stops obsolete generations', async t => {
  const tv = { ...devices[0], bluetooth_name: '[LG] webOS TV OLED77G3PSA' };
  const daemon = await fakeDaemon(t, { version: 2, initialState: { ...readyV2State, devices: [tv, devices[1]] } });
  let now = 1000;
  const output = new HidOutput({ socketPath: daemon.socketPath, clock: () => now, movementRateHz: 1000 });
  t.after(() => output.close()); output.start(); await waitFor(() => output.ready(tv.id));
  await output.open(tv.id, 1);
  output.move({ generation: 1, time: 1, dx: 20, dy: 10 });
  assert.equal(output.pendingMovement, null);
  output.imu({ generation: 1, time: 1, axes: [1, 2, 3, 4, 5, 6] });
  output.imu({ generation: 1, time: 1, axes: [7, 8, 9, 10, 11, 12] }); output.flush();
  assert.equal(output.nextMovement, 1010);
  await waitFor(() => daemon.commands.includes('IMU 0 7 8 9 10 11 12'));
  assert.equal(daemon.commands.some(line => line.startsWith('MOVE ')), false);
  output.imu({ generation: 0, time: 1, axes: [1, 2, 3, 4, 5, 6] });
  output.imu({ generation: 1, time: 0.5, axes: [1, 2, 3, 4, 5, 6] });
  assert.equal(output.pendingMovement, null);
  output.imu({ generation: 1, time: 1, axes: [1, 2, 3, 4, 5, 6] });
  output.invalidate(2); await output.quiesce(); assert.equal(output.pendingMovement, null);
  await output.pair('lg-tv'); assert.ok(daemon.commands.some(line => line.startsWith('PAIR_LG ')));
});

test('LG profile sends MR23 reports through the real daemon IPC', { skip: !simulator || !fs.existsSync(simulator), timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airmouse-lg-integration-')), socketPath = path.join(dir, 'control.sock');
  const daemon = spawn(simulator, ['--simulate-lg', '--socket', socketPath, '--state-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', output;
  daemon.stdout.on('data', chunk => { log += chunk; }); daemon.stderr.on('data', chunk => { log += chunk; });
  t.after(async () => {
    output?.close();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM'); await Promise.race([once(daemon, 'exit'), delay(2000)]);
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(socketPath) || daemon.exitCode !== null);
  assert.equal(daemon.exitCode, null, log);
  output = new HidOutput({ socketPath, heartbeatMs: 50 }); output.start();
  await waitFor(() => output.ready('00000001'));
  await output.open('00000001', 1);
  output.imu({ generation: 1, time: Number(process.hrtime.bigint()) / 1e9, axes: [66, -182, -236, -91, 468, -4201] }); output.flush();
  await output.button(1, true, 1); await output.button(1, false, 1);
  await output.key('00000001', 'back');
  output.invalidate(2); await output.quiesce();
  await waitFor(() => log.split('\n').filter(line => line.startsWith('TEST_LG ')).length >= 8);
  const packets = log.split('\n').filter(line => line.startsWith('TEST_LG ')).map(line => Buffer.from(line.slice(8).replaceAll(' ', ''), 'hex'));
  assert.equal(packets[0].subarray(4, 16).toString('hex'), '000000000000ffa501d4ef97');
  assert.equal(packets[0].readUInt16BE(16), 0x803e);
  assert.equal(packets[0][1], 0);
  assert.equal(packets[0][2] & 3, 2);
  assert.equal(packets[1].subarray(4, 16).toString('hex'), '0042ff4aff14ffa501d4ef97');
  assert.equal(packets[1][1], 1);
  assert.equal(packets[1][2] & 3, 1);
  assert.equal(packets[2].readUInt16BE(16), 0x8044);
  assert.equal(packets[3].readUInt16BE(16), 0);
  assert.equal(packets[4].readUInt16BE(16), 0x8028);
  assert.equal(packets[5].readUInt16BE(16), 0);
  assert.equal(packets.at(-2).readUInt16BE(16), 0x803f);
  assert.equal(packets.at(-2)[1], packets[1][1]);
  assert.equal(packets.at(-1)[2] & 3, 2);
  assert.equal(packets.at(-1).readUInt16BE(16), 0);
  await output.open('00000001', 3);
  output.imu({ generation: 3, time: Number(process.hrtime.bigint()) / 1e9, axes: [66, -182, -236, -91, 468, -4201] }); output.flush();
  await waitFor(() => log.split('\n').filter(line => line.startsWith('TEST_LG ')).length >= packets.length + 2);
  const resumed = log.split('\n').filter(line => line.startsWith('TEST_LG ')).slice(packets.length).map(line => Buffer.from(line.slice(8).replaceAll(' ', ''), 'hex'));
  assert.equal(resumed[0].readUInt16BE(16), 0x803e);
  assert.equal(resumed[1].readUInt16BE(16), 0);
  assert.deepEqual(resumed.slice(0, 2).map(packet => [packet[1], packet[2] & 3]), [[0, 2], [1, 1]]);
});

test('LG preserves 100 Hz motion from batched sensor delivery', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000;
  const tv = { ...devices[0], bluetooth_name: '[LG] webOS TV OLED77G3PSA' };
  const output = new HidOutput({ clock: () => now, movementRateHz: 1000 });
  output.connected = true;
  output.acceptState({ ...readyV2State, devices: [tv, devices[1]] }, 2);
  output.endpoint = tv; output.generation = 1;
  const sent = [];
  const wake = new LgWakeDetector();
  let woke = false;
  output.socket = { writable: true, writableLength: 0, write(line) {
    sent.push({ at: now, line });
    const axes = line.trim().split(' ').slice(2).map(Number);
    if (wake.step(axes.slice(0, 3), now) === 1) woke = true;
  } };
  for (let elapsed = 0; elapsed < 10000; elapsed++) {
    now = 1000 + elapsed;
    if (elapsed % 20 === 0) {
      for (let index = 0; index < 16; index++) {
        output.imu({ generation: 1, time: (now - 18.75 + index * 1.25) / 1000,
          axes: [0, 0, elapsed < 120 || (elapsed >= 240 && elapsed < 360) ? 1800 : elapsed < 240 ? -1800 : 0, elapsed + index, 0, -4096] });
      }
    }
    t.mock.timers.tick(1);
  }
  assert.equal(woke, true, 'A three-stroke yaw gesture must satisfy the TV wake detector');
  assert.ok(sent.length >= 980 && sent.length <= 1001, `Only ${sent.length} LG reports in 10 seconds`);
  for (let i = 1; i < sent.length; i++) {
    assert.ok(sent[i].at - sent[i-1].at >= 9);
    assert.notEqual(sent[i].line, sent[i-1].line, 'Do not manufacture repeated sensor samples');
  }
  output.invalidate(2);
  const count = sent.length;
  now += 100; t.mock.timers.tick(100);
  assert.equal(sent.length, count, 'Pause discards buffered motion');
});


test('LG receiver wake contract distinguishes a preserved gesture from a 50 Hz stream', () => {
  for (const [rate, expected] of [[50, false], [100, true]]) {
    const detector = new LgWakeDetector();
    let woke = false;
    for (let i = 0; i < rate; i++) {
      const time = i * 1000 / rate;
      const z = time < 120 || (time >= 240 && time < 360) ? 1800 : time < 240 ? -1800 : 0;
      if (detector.step([0, 0, z], time) === 1) woke = true;
    }
    assert.equal(woke, expected);
  }
});

test('LG buffered samples expire during an output stall and ignore the computer rate', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000;
  const tv = { ...devices[0], bluetooth_name: '[LG] webOS TV OLED77G3PSA' };
  const output = new HidOutput({ clock: () => now, movementRateHz: 80 });
  output.connected = true;
  output.acceptState({ ...readyV2State, devices: [tv, devices[1]] }, 2);
  output.endpoint = tv; output.generation = 1;
  const sent = [];
  output.socket = { writable: true, writableLength: 0, write(line) { sent.push(line); } };
  for (let time = 0.94; time <= 1; time += 0.01) {
    output.imu({ generation: 1, time, axes: [500, 0, 0, 0, 0, -4096] });
  }
  now = 1100; t.mock.timers.tick(100);
  assert.equal(sent.length, 0);
  assert.equal(output.lgSamples.length, 0);
  assert.ok(output.dropped > 0);
  output.imu({ generation: 1, time: 1.1, axes: [500, 0, 0, 0, 0, -4096] });
  t.mock.timers.tick(1);
  assert.equal(sent.length, 1);
  assert.equal(output.nextMovement, 1110);
  output.setMovementRate(80);
  assert.equal(output.nextMovement, 1110);
  output.invalidate(2);
});
