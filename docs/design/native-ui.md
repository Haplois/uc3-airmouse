# Native Dock UI reference

The approved Dock layout, formerly Design B, has six dark themes and a
horizontal bottom touch strip. The approved HTML prototype is commit `9d73b5421bbabe51bde4f62c98a2dee01a63520b` on
branch `prototype/airmouse-dock-approved-2026-09-07`. That commit adds only prototype files to the original repository
HEAD. The later preview and review files are archived outside the repository.
See the [archive record](../reviews/archive.md).

`native/qml/AirMousePage.qml` owns the five pages: mouse, settings, color theme, computer selection and
calibration. `AirMouseHost.qml` connects the page to the firmware's input controller, battery
and touch-strip signals. `native/qml/Launcher.js`, patched into the stock `main.qml` by `tools/airmouse-ui-build`, opens the host
when the Living room launcher tile is pressed. The tile is a `button` entity served
by the local launcher integration in `runtime/launcher-integration.mjs`. Core discovers the entity, but
pressing it runs locally without a Core command. `deploy/native-home.mjs` supplies the entity ID
through `AIRMOUSE_LAUNCH_ENTITY_ID`. If the launcher port is unavailable, the service logs the error and
keeps any active pointing session running. Stock volume and brightness
touch-strip handlers are suspended while the custom page is open.

The main page shows the selected target and the first three paired computers.
The owned Bluetooth backend exposes up to four saved computers. **All devices**
opens the computer manager, where **Edit** reveals drag handles and name
controls. The first three computers in saved order appear on the home page.
Names use a custom alias, the discovered Bluetooth name, or **Computer N**, in
that order. **Forget** requires confirmation naming the specific computer.
**Pair another computer** opens a 60-second window; **Cancel pairing** returns
to the saved selection. Home shortcuts release input, keep the pointing choice,
and resume after the selected computer is ready. The computer manager leaves
pointing off. Off, navigation, closure, a service failure, or the three-second
switch deadline in `Controller.switchTimeoutMs` cancels a pending resume. The UI tracks the pointing
choice separately from active output and shows **Connecting** while reports are
paused.

Tapping the selected quick-switch computer stops input and disconnects Bluetooth.
The saved pairing remains available, and tapping the computer again reconnects it
with pointing paused. Disconnect requires the owned backend's device management.

Renaming uses a text field near the top of the screen and the existing native
keyboard. Save waits for a service acknowledgement. Names are plain text with a
48-byte UTF-8 limit, and **Use Bluetooth name** clears the custom alias.
The manager retains a version-1 selection view during rolling upgrades.

The monitor at the top and Power toggle pointing. Home cycles the first three quick-switch devices while
preserving pointing state. Media buttons send consumer-control press and release
pairs to the selected device, even while pointing is paused. When `button_edges` is true,
physical OK produces left mouse down and up. The **Left click** and **Right click**
buttons are 120 px tall, sit flush with the bottom of the screen, and support holding and dragging.
Settings provides **Click button order** with **Left · Right** and **Right · Left**
choices. The order persists across restarts and does not change physical OK.
Movement and scrolling preserve held buttons. Repeated mouse-button press events
are suppressed. The four direction keys send keyboard arrow presses and releases
to the selected computer, including repeat presses while held. Arrow keys work
while pointing is paused and require the owned Bluetooth backend.
The firmware backend advertises `button_edges: false` and retains complete
clicks. The [owned Bluetooth backend](owned-bluetooth.md) supports independent
edges. Bottom-strip movement to the right scrolls down; movement to the left
scrolls up. Releasing the strip discards residual scroll steps. Physical
direction and scroll scaling still need manual testing.

Settings pauses pointing. Returning to the mouse page does not resume it.
Pointer speed is stored per target. The output limit slider runs from 10 to
1000 Hz.
The service requests the first fixed sensor rate at least twice that limit,
then reports whether the installed driver can provide it. The lab device still
exposes at most 800 Hz; this UI does not install the experimental kernel driver.
The actual host report rate remains unmeasured.

Violet, Glacier, Mint, Amber, Graphite, and True black apply to every page. True
black uses `#000000` for backgrounds and cards. Theme and settings updates persist
through the service's atomic configuration writer.

`AirMouseBridge` uses a bounded newline-delimited JSON protocol over a Unix socket. The
bridge has no Web Config API calls or credentials. The socket has mode `0660`
inside a directory with mode `2750` and owner `airmouse:ucui`. The custom service binds that
directory at `/app/airmouse`. The service accepts one UI owner, monotonically increasing
request IDs, and a fixed command whitelist.

The UI sends a heartbeat every 500 ms. Losing it for 2.5 seconds, closing the
page, or losing input ownership stops pointing. OFF preempts activation, so a
stale completion cannot turn the pointer back on. The controller restores the
sensor state through its normal stop path. Scroll accumulation is bounded and
discarded on release or disconnect.

`AirMouseHost.qml` decides what each power mode does. Idle, which is display off, never closes
the app; it releases held buttons and keeps an enabled pointer running. Firmware
2.10.2 normally cannot reach this state while pointing. The sensor driver
reports a wake key on every FIFO interrupt and Core counts each one as activity,
so the remote does not reach Idle while pointing. See
[verification](../verification.md#power-transitions-on-2026-09-08). Low power
and Suspend send OFF with the reason "Paused for standby" and keep the app open
when the sleep began with pointing enabled; otherwise they close the paused app.
The service's 60-second idle timeout is a separate mechanism. It pauses pointing
when the remote is motionless. Pointing is usually paused by the time the
60-second display-off timer expires. Device tests on 2026-09-08 confirmed that
standby while paused closes the app and that display-off transitions are
reported.

## Verification on 2026-09-07

The full ARM64 UI and standalone preview build with Qt 5.15.8. The service and
Qt checks passed, including the native launcher button. The QML suite passed
navigation, theme bounds, pause behavior, slider input during status refresh,
and scroll release/disconnection. Service tests cover atomic settings, rate
policy, target request IDs, repeated activation, cancellation and heartbeat
loss. The complete Node suite is the regression check for the existing service.

The standalone page rendered on the lab Remote 3 through EGLFS, connected to the
live Unix socket as `ucui`, and showed the real Desktop target. It exited
successfully and the stock UI was restored. Pointer output stayed off. The
standalone preview uses a placeholder battery level; the integrated host reads
`Battery.level`. Physical pointer, click, and scroll input still needed manual testing.

The service and custom UI `0.74.5-airmouse.4` were installed on 2026-09-07. The 2026-09-08
button-edge update is `0.74.5-airmouse.5`; see the [owned Bluetooth
verification](../reviews/owned-bluetooth.md). The owner accepted the official
installer's warranty consent on 2026-09-07. The UI base is v0.74.5; stock is
v0.80.0. The cleanup removed all six Air mouse integration entities, the
dedicated Air mouse page, the rate-test commands, and dual control ownership.
The Living room page remains with one native launcher, and the paired Desktop
Bluetooth target is still configured. The launcher integration now only
publishes the single launch button; the service always uses native IPC for
control. The migration backup is `/mnt/data/airmouse/state/native-home-backup-1788795031393.json`. See [build and installation
commands](../../native/README.md).

The main page omits shortcut and touch-strip hints. The monitor, target name,
quick-switch cards, and primary button use the former footer space. Navigation
buttons are 56 px high and the primary button is 84 px high.
