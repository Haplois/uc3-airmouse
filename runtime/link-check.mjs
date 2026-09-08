import { BluetoothLink } from './bluetooth-link.mjs';
import { CoreOutput } from './output.mjs';
import { readJSON } from './storage.mjs';

const stateDir = process.env.AIRMOUSE_STATE ?? '/mnt/data/airmouse/state';
const output = new CoreOutput({ stateDir });
const link = new BluetoothLink();
try {
  const id = readJSON(`${stateDir}/airmouse.json`).selected_target;
  const pair = await output.api(`/remotes/${encodeURIComponent(id)}/bt/pairing`);
  if (!pair.paired || !pair.peer?.address) throw new Error('Selected host is not paired');
  await link.acquire({ id, peer: pair.peer.address });
  await link.check();
  console.log(JSON.stringify({ bluetooth: link.metrics(), hid_reports_sent: 0 }));
} finally { await link.release(); output.close(); }
