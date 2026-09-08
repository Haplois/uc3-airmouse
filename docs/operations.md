# Operate the Air mouse service

Tools that access the remote use your existing SSH authorization. The default
host is `root@10.0.10.51`; pass `--host user@address` for another device.

## Build and deploy

```sh
npm test
tools/airmouse-deploy --accept-warranty
```

`airmouse-deploy` builds and installs each component in order. It rolls back an active
Bluetooth takeover, installs the Bluetooth bundle, installs the Node service,
waits for the service to apply its Bluetooth ownership setting, activates the
native UI, places the launcher, and verifies the installation. Pass `--skip-build` to reuse
`dist/`, `--skip-ui` or `--skip-bluetooth` to leave a component alone, and `--probe` to re-run the controller
probe. Each step calls the corresponding component tool. Use that tool to roll
back the component.

```sh
tools/airmouse deploy
tools/airmouse status
```

`airmouse deploy` builds a self-contained Node release, installs it atomically, and starts
with pointing off. If installation fails, the installer restores the previous
release and service state. The persisted configuration and API key remain on the
device under `/mnt/data/airmouse/state`, accessible only to the service owner. No package manager runs
on the device.

For first provisioning, `tools/airmouse provision` reads the current Web Config PIN from a hidden
prompt and stores a Core API key on the remote. Never put the key in the
repository. The native UI uses a Unix socket and does not read it. See [native
installation](../native/README.md) to install the UI and launcher.

## Point and scroll

Open **Living room → Air mouse** and select a paired computer. Press Power to start
or pause, OK for a left click, and Right for a right click. Slide the bottom strip
right to scroll down or left to scroll up. Closing the app or entering settings
pauses pointing. Home shortcuts preserve whether pointing is enabled and resume
after the new computer is ready. Off cancels the pending resume. Switching from
the computer manager leaves pointing off.

Home cycles through the first three quick-switch computers and preserves pointing
state. Play, previous, next, volume, mute, and stop control the selected computer,
including while pointing is paused. Computers that cache the old mouse-only HID
descriptor may need to pair again before media controls become available.

Display sleep never closes the app and keeps an enabled pointer running. On
firmware 2.10.2, the remote does not sleep while pointing because the sensor's
wake events count as activity. Pointing pauses on its own after 60 seconds
without motion, set by `motion.idle_timeout_seconds`, and that pause lets the remote sleep. Low power and
suspend interrupt Bluetooth and the sensor. If pointing was enabled when sleep
began, the app stays open and shows "Paused for standby". Press Power to resume.
If pointing was already paused, the app closes.

**Bluetooth ownership** in Settings decides when the service owns the stack.
**Always** takes control at boot. **While open** takes control while the app is
open. **Never** keeps the stock Bluetooth service. With **Always**, the service
takes ownership within a few seconds of starting after a reboot. A failed
takeover shows its reason under the setting, and opening the app again retries
it.

To manage saved computers, open **All devices → Edit**. Tap a name to rename or
forget that computer. Drag a handle to reorder the list. The first three appear
on the main page. **Use Bluetooth name** removes a custom name.

For physical button down and up, install and activate the [owned Bluetooth
backend](../bluetooth/README.md). Open **All devices → Pair another computer**,
then pair **Remote 3 Air mouse** from the computer. Hold OK while moving to drag.
Right holds the right mouse button. Releasing either physical button releases
that mouse button.

With the firmware backend, pair in the firmware Bluetooth settings and list
targets with `tools/airmouse targets`. That backend sends complete clicks.
`tools/airmouse-bluetooth rollback` restores it after a Bluetooth takeover.

## Tune

Change speed and the output limit in the app's Settings. Speed is per target.
The output limit requests 10 to 1000 updates per second. The host report rate
has not been measured. The service selects the lowest supported sensor rate at
least twice the requested limit, capped by the installed driver's capabilities.
The lab device's original driver exposes at most 800 Hz.

The service uses the persisted motion configuration, including axis direction,
calibration, sensitivity, and the ±2000°/s gyro range. Firmware 2.10.2 rejects
gyro scale changes, so activation keeps the existing range. The service restores
every changed sensor setting when pointing stops.

For command-line tuning:

```sh
tools/airmouse tune --sensitivity 1800 --bluetooth-rate 500
```

The command stops the service, takes the configuration lock, saves the requested
values, and restarts with pointing off. It retains calibration and axis mapping.
Add `--bluetooth-ownership always|session|never` to change the ownership setting from the development machine.

## Diagnose without sending host input

```sh
tools/airmouse verify
tools/airmouse-power-watch
tools/airmouse benchmark
tools/airmouse link-check
tools/uc3-capabilities
tools/airmouse-screenshot --output /tmp/remote.png
```

`tools/airmouse-power-watch` prints one line per change in Core power mode, pointer state, pointing
intent, control connection, applied sampling, sensor journal presence, and stop
reason. Use it to observe manual power tests. It reads state without changing
it.

`verify` checks that the native UI is installed, that the launcher button is the
only Air mouse entity and sits on a page, that the control socket exists, and
that no old Air mouse page items remain. The installed unit takes its sensor
paths from the generated `airmouse.service.d/sensor.conf`; if that file does
not match the discovered sensor, the service refuses to start.

`benchmark` compares Core HTTP and WebSocket entity-read latency. `link-check` reads Bluetooth
connection metadata. During an owned takeover, use `tools/airmouse-bluetooth status` for daemon state. Core's
Bluetooth diagnostics describe only the firmware backend. `screenshot` reads the active
DRM display and refuses to overwrite its output. It presses no buttons and moves
no pointer.

Capture and replay sensor samples without Bluetooth output:

```sh
tools/airmouse record --rate 400 --seconds 3 --keep-range --output capture.jsonl
tools/airmouse-analyze-motion capture.jsonl
node runtime/replay.mjs < capture.jsonl
tools/airmouse crash-check
```

Recordings are limited to ten seconds. `--keep-range` preserves the current gyro range; `--gyro-range 2000`
selects the firmware-compatible diagnostic profile. The recorder runs under
systemd and restores the sensor even if SSH disconnects. `crash-check` kills a
time-limited recorder and verifies cleanup. These operations stop the service
temporarily and restart it with pointing off.

## Stop and recover

```sh
tools/airmouse stop
tools/airmouse rollback
```

`stop` stops the service. `rollback` also disables it, restores the original sensor
permissions, and removes the generated sensor drop-in. It locates the permission
helper in the current release, under `runtime/` or an older release's `deploy/`, before it
touches the service. Both keep releases, configuration, and credentials. To
restore the stock UI, use `tools/airmouse-ui rollback`.

Do not delete `sensor-journal.json`, `output-session.json`, or `output-used.json` to bypass a recovery check. Sensor recovery
verifies ownership and boot identity. Unresolved output delivery blocks
activation. A failed restoration retains its journal for diagnosis.

The firmware adapter allows one output command in flight, discards stale movement, and
never replays uncertain HID delivery. It verifies a 7.5 ms Bluetooth connection
interval before pointing and restores the prior timing on normal stop when it
still owns that setting. These checks bound application behavior; they do not
measure the host's display latency.

The owned daemon keeps button transitions in order, coalesces motion within
each held-button interval, and discards stale motion after 75 ms. A missing client
heartbeat releases buttons after one second. If a release cannot be handed to
BTstack within 250 ms, the daemon disconnects the host. These are application
safeguards; host receipt and display timing require manual validation.

Normal deployment excludes the [experimental kernel
drivers](../drivers/README.md). The remote keeps its original modules.
