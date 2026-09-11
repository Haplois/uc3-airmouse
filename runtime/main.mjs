import { NativeUI } from './native-ui.mjs';
import { Sensor } from './sensor.mjs';
import { Controller } from './controller.mjs';
import { CoreOutput } from './output.mjs';
import { HidOutput } from './hid-output.mjs';
import { readJSON } from './storage.mjs';
import { StatusSnapshot } from './status.mjs';
import { BluetoothLink } from './bluetooth-link.mjs';
import { lockConfig } from './config-lock.mjs';
import { LauncherIntegration } from './launcher-integration.mjs';
import { OwnershipRequests } from './bluetooth-ownership.mjs';
import { LGIRPairing } from './lg-ir-pairing.mjs';
import { StandbyLease } from './power-saving.mjs';

const stateDir = process.env.AIRMOUSE_STATE ?? '/mnt/data/airmouse/state';
const sensor = new Sensor({ stateDir });
let recoveryError;
try { sensor.restore(); } catch (error) { recoveryError = error; }
if (process.argv[2] === 'recover') {
  if (recoveryError) { console.error(recoveryError.message); process.exitCode = 1; }
} else {
  const unlockConfig = lockConfig(stateDir);
  let controller, nativeUI, lastStatus, lastUIStatus, lastSession, lastStatusAt = -Infinity;
  const power = new StandbyLease({ stateDir });
  const snapshot = new StatusSnapshot(`${stateDir}/status.json`);
  const publish = () => {
    if (!controller) return;
    const state = controller.state();
    const content = JSON.stringify(state);
    const { output_metrics, ...uiState } = state;
    const uiContent = JSON.stringify(uiState);
    if (lastStatus !== content && (lastUIStatus !== uiContent || performance.now() - lastStatusAt >= 2000)) {
      snapshot.publish(state); lastStatus = content; lastStatusAt = performance.now();
    }
    // One journal line per pointing session change, so a stop can be explained after the fact.
    const session = `${state.pointer ? 'pointing' : 'stopped'} reason=${JSON.stringify(state.stop_reason)} control=${state.control_connected}${state.error ? ` error=${JSON.stringify(state.error)}` : ''}`;
    if (session !== lastSession) { console.log(`Pointer ${session}`); lastSession = session; }
    if (lastUIStatus !== uiContent) { lastUIStatus = uiContent; nativeUI?.publish(); }
  };
  const configFile = `${stateDir}/airmouse.json`;
  const backend = process.env.AIRMOUSE_OUTPUT ?? 'core';
  if (!['core', 'owned'].includes(backend)) throw new Error('Unsupported Bluetooth output backend');
  const outputOptions = { movementRateHz: readJSON(configFile).output?.movement_rate_hz ?? 80, onState: () => { controller?.syncOutput(); publish(); }, onStop: reason => {
    if (controller?.pointer || controller?.calibrating || sensor.record) controller.stop(reason);
  } };
  const output = backend === 'owned'
    ? new HidOutput(outputOptions)
    : new CoreOutput({ ...outputOptions, stateDir, link: new BluetoothLink({ stateDir }) });
  controller = new Controller({ sensor, output, configFile, publish, power, lgPairing: new LGIRPairing({ stateDir }), ownership: new OwnershipRequests({ dir: process.env.AIRMOUSE_RUN_DIR ?? '/run/airmouse' }) });
  if (recoveryError) controller.error = recoveryError.message;
  nativeUI = new NativeUI(controller, process.env.AIRMOUSE_UI_SOCKET ?? '/mnt/data/airmouse/ui/control.sock');
  const launcher = new LauncherIntegration();
  output.start(); publish();
  console.log('Air mouse native socket ready; pointer off');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    nativeUI?.close();
    launcher.close();
    clearTimeout(controller.releaseTimer); clearTimeout(controller.startupTimer); clearInterval(controller.reconnectTimer);
    try { await controller.stop('Service stopped'); }
    catch (error) { console.error(`Shutdown cleanup: ${error.message}`); process.exitCode = 1; }
    output.close();
    await power.close();
    await snapshot.flush();
    unlockConfig();
    process.exitCode = sensor.record ? 1 : process.exitCode ?? 0;
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);
  process.on('uncaughtException', error => { console.error(error.message); shutdown().finally(() => process.exit(1)); });
  process.on('unhandledRejection', error => { console.error(error?.message ?? 'Unhandled failure'); shutdown().finally(() => process.exit(1)); });
}
