import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeUI } from '../runtime/native-ui.mjs';
import { Controller } from '../runtime/controller.mjs';
import { samplingPolicy } from '../runtime/ui-policy.mjs';
import { fakeSensor, fakeOutput } from './helpers.mjs';

function setup(t) {
  const sensor = fakeSensor(t), output = fakeOutput();
  const controller = new Controller({ sensor: sensor.sensor, output, configFile: sensor.configFile });
  controller.target = 'host.a';
  t.after(() => controller.stop());
  return { ...sensor, controller, output };
}
function managedSetup(t) {
  const sensor = fakeSensor(t), output = fakeOutput();
  Object.assign(output, {
    backend: 'owned', buttonEdges: true, deviceManagement: true, hostLimit: 4, defaultTarget: null,
    selectedTarget: '00000001', paired: true, pairing: false, buttons: 0,
    targets: [
      { id: '00000001', name: 'Laptop', bluetooth_name: 'Laptop', custom_name: '', legacy: true, ready: true, connected: true },
      { id: '00000002', name: 'Desktop', bluetooth_name: 'Desktop', custom_name: '', legacy: false, ready: false, connected: false },
    ],
  });
  const controller = new Controller({ sensor: sensor.sensor, output, configFile: sensor.configFile });
  t.after(() => controller.stop());
  return { ...sensor, controller, output };
}
async function client(t, controller, dir, options) {
  const server = new NativeUI(controller, `${dir}/ui.sock`, options);
  t.after(() => server.close());
  await once(server.server, 'listening');
  const socket = net.connect(`${dir}/ui.sock`);
  t.after(() => socket.destroy());
  socket.setEncoding('utf8'); socket.on('error', () => {});
  const replies = []; let buffer = '';
  socket.on('data', data => { buffer += data; while (buffer.includes('\n')) { const end = buffer.indexOf('\n'); replies.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  await once(socket, 'connect');
  const send = message => socket.write(JSON.stringify(message) + '\n');
  const response = async id => {
    for (let i = 0; i < 200; i++) { const reply = replies.find(x => x.id === id); if (reply) return reply; await delay(5); }
    throw new Error('Missing reply');
  };
  return { socket, server, send, response };
}
test('native media routes to the selected computer without acquiring sensors', async t => {
  const {controller,output,dir,writes}=managedSetup(t);
  const sent=[]; output.media=async (id,key)=>sent.push({id,key});
  const ui=await client(t,controller,dir);
  ui.send({id:1,type:'media',key:'play_pause'});
  assert.equal((await ui.response(1)).ok,true);
  assert.deepEqual(sent,[{id:controller.target,key:'play_pause'}]);
  assert.equal(writes.length,0); assert.equal(controller.pointer,false);
  ui.send({id:2,type:'media',key:'mute',target:'00000002'});
  assert.equal((await ui.response(2)).ok,false); assert.equal(sent.length,1);
});
test('sampling policy distinguishes requested ODR from the installed ceiling', () => {
  assert.deepEqual(samplingPolicy(1000, [50,100,200,400,800]), { requested:3200, selected:800, satisfied:false });
  assert.deepEqual(samplingPolicy(500, [400,800,1600,3200]), { requested:1600, selected:1600, satisfied:true });
});
test('native settings persist, keep pointer off and do not touch sensors', async t => {
  const {controller,configFile,writes}=setup(t);
  await controller.apply({type:'theme',theme:'mint'});
  await controller.apply({type:'speed',speed:75});
  await controller.apply({type:'output_policy',rate:1000});
  assert.equal(controller.state().theme,'mint'); assert.equal(controller.state().speed,75);
  assert.equal(controller.rate,400); assert.equal(controller.outputRate,1000);
  assert.equal(controller.state().applied_sampling,null); assert.equal(controller.state().sampling_policy.satisfied,false);
  assert.equal(writes.length,0);
  const saved=JSON.parse(fs.readFileSync(configFile)); assert.equal(saved.ui.theme,'mint');
  assert.equal(saved.target_tuning['host.a'].sensitivity,2250);
  await assert.rejects(controller.apply({type:'theme',theme:'unknown'}));
});
test('native output policy persists atomically on write failure', async t => {
  const {controller}=setup(t), before=structuredClone(controller.config);
  controller.save=()=>{throw new Error('disk full');};
  await assert.rejects(controller.apply({type:'output_policy',rate:1000}), /disk full/);
  assert.deepEqual(controller.config,before);assert.equal(controller.outputRate,80);
});

test('native button order defaults normally and persists through a controller restart', async t => {
  const {controller,configFile,dir,sensor,output}=setup(t), c=await client(t,controller,dir);
  delete controller.config.ui.swap_click_buttons;
  assert.equal(controller.state().swap_click_buttons,false);
  c.send({id:1,type:'swap_click_buttons',swapped:true}); assert.equal((await c.response(1)).ok,true);
  assert.equal(controller.state().swap_click_buttons,true);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).ui.swap_click_buttons,true);
  const restarted=new Controller({sensor,output,configFile}); t.after(()=>restarted.stop());
  assert.equal(restarted.state().swap_click_buttons,true);
  c.send({id:2,type:'swap_click_buttons',swapped:false}); assert.equal((await c.response(2)).ok,true);
  assert.equal(controller.state().swap_click_buttons,false);
  for (const command of [{id:3,type:'swap_click_buttons',swapped:'yes'},{id:4,type:'swap_click_buttons',swapped:true,extra:1}]) {
    c.send(command); assert.equal((await c.response(command.id)).ok,false);
  }
  controller.pointer=true;
  await assert.rejects(controller.apply({type:'swap_click_buttons',swapped:true}),/Pause pointing/);
  controller.pointer=false; controller.save=()=>{throw new Error('disk full');};
  await assert.rejects(controller.apply({type:'swap_click_buttons',swapped:true}),/disk full/);
  assert.equal(controller.state().swap_click_buttons,false);
});
test('failed native calibration never reports completion', async t => {
  const {controller,sensor,dir}=setup(t), c=await client(t,controller,dir);
  sensor.begin=()=>{throw new Error('Sensor unavailable');};
  c.send({id:1,type:'calibrate'});assert.equal((await c.response(1)).ok,false);
  assert.equal(controller.reason,'Calibration failed');assert.equal(controller.pointer,false);
});
test('native target field remains separate from request identity', async t => {
  const {controller,dir}=setup(t), c=await client(t,controller,dir);
  c.send({id:1,type:'target',target:'host.b'});
  assert.equal((await c.response(1)).ok,true);assert.equal(controller.target,'host.b');assert.equal(controller.pointer,false);
});
test('closing UI while activation is pending never enables pointer', async t => {
  const {controller,dir,output,writes}=setup(t); let finish;
  output.prepare=()=>new Promise(resolve=>{finish=resolve;});
  const c=await client(t,controller,dir);c.send({id:1,type:'on'});
  for(let i=0;i<100&&!finish;i++)await delay(5);
  assert.ok(finish);const closed=once(c.socket,'close');c.socket.destroy();await closed;await delay(10);
  finish();await delay(20);assert.equal(controller.pointer,false);assert.equal(writes.length,0);
});
test('repeated native ON is idempotent while pointing', async t => {
  const {controller,dir,writes}=setup(t), c=await client(t,controller,dir);
  c.send({id:1,type:'on'});assert.equal((await c.response(1)).ok,true);
  const count=writes.length;
  c.send({id:2,type:'on'});assert.equal((await c.response(2)).ok,true);
  assert.equal(controller.pointer,true);assert.equal(writes.length,count);
});
test('OFF preempts native activation and UI heartbeat loss restores sensors', async t => {
  const {controller,dir,output,sensor}=setup(t), baseline=sensor.snapshot();let finish;
  output.prepare=()=>new Promise(resolve=>{finish=resolve;});
  const c=await client(t,controller,dir,{heartbeatMs:10,leaseMs:100});c.send({id:1,type:'on'});
  for(let i=0;i<100&&!finish;i++)await delay(2);
  assert.ok(finish);c.send({id:2,type:'off',reason:'Paused for Settings'});assert.equal((await c.response(2)).ok,true);
  finish();await c.response(1);assert.equal(controller.pointer,false);
  output.prepare=async()=>{};c.send({id:3,type:'on'});assert.equal((await c.response(3)).ok,true);assert.equal(controller.pointer,true);
  await once(c.socket,'close');await delay(10);assert.equal(controller.pointer,false);assert.deepEqual(sensor.snapshot(),baseline);
});

test('a second native client cannot take ownership or stop the active owner', async t => {
  const {controller,dir}=setup(t), c=await client(t,controller,dir);
  c.send({id:1,type:'on'});assert.equal((await c.response(1)).ok,true);
  const second=net.connect(`${dir}/ui.sock`);second.on('error',()=>{});
  await once(second,'close');
  assert.equal(controller.pointer,true);assert.equal(controller.nativeControl,true);
  c.send({id:2,type:'off'});assert.equal((await c.response(2)).ok,true);
});
test('replayed native command IDs close the owner and restore the sensor', async t => {
  const {controller,dir,sensor}=setup(t), baseline=sensor.snapshot(), c=await client(t,controller,dir);
  c.send({id:1,type:'on'});assert.equal((await c.response(1)).ok,true);
  const closed=once(c.socket,'close');c.send({id:1,type:'on'});await closed;await delay(10);
  assert.equal(controller.pointer,false);assert.deepEqual(sensor.snapshot(),baseline);
});
test('heartbeat loss still stops pointing after a backwards wall-clock jump', {timeout:2000}, async t => {
  let wallTime=1_000_000;t.mock.method(Date,'now',()=>wallTime);
  const {controller,dir}=setup(t), c=await client(t,controller,dir,{heartbeatMs:10,leaseMs:100});
  c.send({id:1,type:'on'});assert.equal((await c.response(1)).ok,true);
  wallTime-=60_000;await once(c.socket,'close');await delay(10);
  assert.equal(controller.pointer,false);
});

test('owned button edges bypass a pending control command and validate down exactly', async t => {
  const {controller,output,dir}=setup(t);output.backend='owned';output.buttonEdges=true;output.paired=true;
  const c=await client(t,controller,dir);c.send({id:1,type:'on'});assert.equal((await c.response(1)).ok,true);
  let finish;output.sendAction=()=>new Promise(resolve=>{finish=resolve;});
  c.send({id:2,type:'scroll',direction:1});
  for(let i=0;i<100&&!finish;i++)await delay(2);
  assert.ok(finish);
  c.send({id:3,type:'button',button:1,down:true});
  c.send({id:4,type:'button',button:1,down:false});
  assert.equal((await c.response(3)).ok,true);assert.equal((await c.response(4)).ok,true);
  assert.deepEqual(output.buttonCalls.map(({button,down})=>({button,down})),[{button:1,down:true},{button:1,down:false}]);
  c.send({id:5,type:'button',button:1,pressed:false});
  assert.equal((await c.response(5)).ok,false);
  finish();assert.equal((await c.response(2)).ok,true);
});

test('more than sixteen pending button edges closes the UI lease', async t => {
  const {controller,output,dir}=setup(t);output.backend='owned';output.buttonEdges=true;
  controller.pointer=true;controller.button=()=>new Promise(()=>{});
  const c=await client(t,controller,dir);
  const closed=once(c.socket,'close');
  for(let id=1;id<=17;id++)c.send({id,type:'button',button:1,down:id%2===1});
  await closed;
  assert.equal(controller.nativeControl,false);
});

test('pair is routed only to the owned backend and owned mode rejects legacy clicks', async t => {
  const {controller,output,dir}=setup(t),c=await client(t,controller,dir);
  c.send({id:1,type:'pair'});assert.equal((await c.response(1)).ok,false);
  output.backend='owned';output.buttonEdges=true;
  c.send({id:2,type:'pair'});assert.equal((await c.response(2)).ok,true);assert.equal(output.pairCalls,1);
  controller.pointer=true;c.send({id:3,type:'click',button:1});assert.equal((await c.response(3)).ok,false);
});

test('native v2 management routes semantic fields without exposing ASCII encoding', async t => {
  const { controller, output, dir } = managedSetup(t), c = await client(t, controller, dir);
  c.send({ id: 1, type: 'target', target: '00000002' });assert.equal((await c.response(1)).ok, true);
  c.send({ id: 2, type: 'rename', target: '00000001', name: 'Café 💻' });assert.equal((await c.response(2)).ok, true);
  c.send({ id: 3, type: 'reorder', targets: ['00000002', '00000001'] });assert.equal((await c.response(3)).ok, true);
  c.send({ id: 4, type: 'cancel_pairing' });assert.equal((await c.response(4)).ok, true);
  c.send({ id: 5, type: 'pair' });assert.equal((await c.response(5)).ok, true);
  c.send({ id: 6, type: 'forget', target: '00000002' });assert.equal((await c.response(6)).ok, true);
  assert.deepEqual(output.selectCalls, ['00000002']);
  assert.deepEqual(output.renameCalls, [{ id: '00000001', name: 'Café 💻' }]);
  assert.deepEqual(output.reorderCalls, [['00000002', '00000001']]);
  assert.equal(output.cancelPairingCalls, 1);assert.equal(output.pairCalls, 1);
  assert.deepEqual(output.forgetCalls, ['00000002']);
});

test('native v2 management rejects extra fields and malformed names, IDs, and orders', async t => {
  const { controller, output, dir } = managedSetup(t), c = await client(t, controller, dir);
  const invalid = [
    { id: 1, type: 'rename', target: '00000001', name: 'Laptop', extra: true },
    { id: 2, type: 'rename', target: '00000001', name: 'bad\nname' },
    { id: 3, type: 'rename', target: 'not-an-id', name: 'Laptop' },
    { id: 4, type: 'reorder', targets: ['00000001', '00000001'] },
    { id: 5, type: 'forget', target: 12345678 },
    { id: 6, type: 'rename', target: 12345678, name: 'Laptop' },
    { id: 7, type: 'cancel_pairing', target: '00000001' },
    { id: 8, type: 'pair', target: '00000001' },
  ];
  for (const command of invalid) { c.send(command);assert.equal((await c.response(command.id)).ok, false); }
  assert.deepEqual(output.renameCalls, []);assert.deepEqual(output.reorderCalls, []);
  assert.deepEqual(output.forgetCalls, []);assert.equal(output.cancelPairingCalls, 0);assert.equal(output.pairCalls, 0);
});

test('native metadata failures remain visible in the published controller state', async t => {
  const { controller, output, dir } = managedSetup(t), c = await client(t, controller, dir);
  output.rename = async () => { throw new Error('hosts.dat unavailable'); };
  c.send({ id: 1, type: 'rename', target: '00000001', name: 'Travel' });
  assert.deepEqual(await c.response(1), { id: 1, ok: false, error: 'hosts.dat unavailable' });
  assert.equal(controller.state().error, 'hosts.dat unavailable');
});

test('native home shortcut preserves intent, acknowledges before reconnect, and lets OFF cancel', async t => {
  const {controller,output,dir}=managedSetup(t), c=await client(t,controller,dir);
  c.send({id:1,type:'on'});assert.equal((await c.response(1)).ok,true);
  c.send({id:2,type:'target',target:'00000002',keep_pointer:true});
  assert.equal((await c.response(2)).ok,true);
  assert.equal(controller.state().pointer_enabled,true);assert.equal(controller.pointer,false);
  c.send({id:3,type:'off'});assert.equal((await c.response(3)).ok,true);
  output.targets[1].ready=true;controller.syncOutput();await delay(30);
  assert.equal(controller.pointer,false);assert.equal(controller.switching,null);
  c.send({id:4,type:'target',target:'00000001',keep_pointer:'yes'});
  assert.equal((await c.response(4)).ok,false);
});

test('native arrows work while paused and reject unsupported keys or fields', async t => {
  const {controller,output,dir}=managedSetup(t), calls=[], c=await client(t,controller,dir);
  output.key=async (target,key)=>calls.push({target,key});
  for (const [index,key] of ['up','down','left','right'].entries()) {
    c.send({id:index+1,type:'key',key}); assert.equal((await c.response(index+1)).ok,true);
  }
  assert.deepEqual(calls,['up','down','left','right'].map(key=>({target:'00000001',key})));
  assert.equal(controller.pointer,false);
  for (const command of [{id:5,type:'key',key:'enter'},{id:6,type:'key',key:'up',down:true},{id:7,type:'disconnect',target:'00000001'}]) {
    c.send(command); assert.equal((await c.response(command.id)).ok,false);
  }
  assert.equal(calls.length,4); assert.equal(controller.target,'00000001');
});

test('native disconnect stops input before clearing selection and preserves saved computers', async t => {
  const {controller,output,dir}=managedSetup(t), c=await client(t,controller,dir);
  let disconnected=false;
  output.disconnectTarget=async()=>{
    assert.equal(controller.pointer,false); assert.equal(output.buttons,0);
    disconnected=true; output.selectedTarget='';
  };
  c.send({id:1,type:'on'}); assert.equal((await c.response(1)).ok,true);
  c.send({id:2,type:'button',button:1,down:true}); assert.equal((await c.response(2)).ok,true);
  c.send({id:3,type:'disconnect'}); assert.equal((await c.response(3)).ok,true);
  assert.equal(disconnected,true); assert.equal(controller.target,'');
  assert.equal(controller.state().pointer_enabled,false); assert.equal(output.targets.length,2);
});

test('disconnect supersedes a pending mouse release without reporting a false failure', async t => {
  const {controller,output,dir}=managedSetup(t), c=await client(t,controller,dir);
  output.disconnectTarget=async()=>{output.selectedTarget='';};
  c.send({id:1,type:'on'}); assert.equal((await c.response(1)).ok,true);
  let cancel;
  output.button=()=>new Promise((resolve,reject)=>{cancel=reject;});
  c.send({id:2,type:'button',button:1,down:false});
  while (!cancel) await delay(1);
  c.send({id:3,type:'disconnect'}); assert.equal((await c.response(3)).ok,true);
  cancel(new Error('Bluetooth input invalidated by stop'));
  assert.equal((await c.response(2)).ok,true);
});
