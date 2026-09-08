# Bluetooth ownership for physical mouse buttons

The firmware output adapter turns each command into a complete click. Dragging
requires the Bluetooth service to preserve the button bitmap while the remote
moves and to clear it when the physical button is released.

`airmouse-hid` owns that bitmap and the Bluetooth controller. It builds BTstack
commit `431d58d5613fd8fae38afe50282b25302de84bf7` from source. Node keeps the
existing sensor reader, calibration, motion filter, and sensor recovery.
The native Qt UI forwards physical press and release events.

The hardware transport is H4 over `/dev/ttyS1`, with RTS/CTS, 115200 baud during
initialization, and 921600 baud afterward. GPIO 28 controls Bluetooth power.
The daemon uses the remote's installed BCM4373A0 initialization file and checks
manufacturer 15 and LMP subversion `0x2119`. It does not alter the firmware binary
or sensor modules.

## Saved computers and Bluetooth ownership

The backend saves up to four bonded computers and connects to one at a time.
An explicit **Pair another computer** action opens a 60-second pairing window.
Pairing stops pointer input and leaves existing bonds intact. Cancel or expiry
restores advertising for the previously selected computer. The daemon uses LE Secure Connections
and stores its own random static identity and bond database under
`/mnt/data/airmouse/bluetooth/state`. It never opens the stock bond database.
A reconnect starts with a zero-button report before pointing becomes available.

Runtime masks stop Core from restarting stock Bluetooth or its `btuart.service` UART helper
during the takeover. A runtime Node drop-in selects `AIRMOUSE_OUTPUT=owned`; the saved Core target
stays in the configuration. Each owned target has a stable eight-digit
hexadecimal ID. The version-1 adapter retains `airmouse.host` during rolling upgrades. The
`bluetooth.ownership` setting decides when the service takes the stack. With `always`, it owns the
stack whenever it runs. With `session`, it owns the stack while the app is open and
releases it ten seconds after close. With `never`, it keeps stock Bluetooth running.
The setting lives in the app's Settings page and in `tools/airmouse tune --bluetooth-ownership`.

The service is unprivileged, so it writes a one-word request into its runtime
directory and the boot-enabled `airmouse-bluetooth-request.path` unit runs the helper's `request` command as root.
That command accepts only `takeover` and `rollback`. A failed takeover leaves its reason in a
marker file, which the app shows, and the service retries once per app session.
An explicit rollback sets the same marker to prevent an immediate automatic
takeover with `always`.

Reboot removes the runtime masks and drop-in. The request path unit can then
restore ownership according to `bluetooth.ownership`. The daemon and rollback units are not
enabled at boot. Explicit rollback restores previous service activity and
runtime files. See [installation and rollback](../../bluetooth/README.md).

Independent reviews by Fable and Sol agreed on the process boundary. The design
uses Sol's ordered button intervals and retains the existing Node interface.
Both processes enforce button release on lost control. The local protocol has
fixed message limits, and a runtime setting selects the backend.

## Names, order, and bond identity

The C daemon owns `hosts.dat` beside its private bond database. Each record binds
an ID to a bond slot and identity address, a Bluetooth name, and an optional
custom name. IDs increase and are never reused after Forget. The file also stores
selection and display order, which determines the first three home shortcuts.

Metadata updates write a private temporary file, sync it, rename it, and sync
the directory before acknowledging success. Storage failures stop the daemon and
invoke rollback. Forget removes the registry record before deleting the bond.
Startup removes unregistered bond entries left by an interrupted Forget. A
registry record whose identity no longer matches its bond slot fails closed.

Migration imports the original trusted bond without changing its keys or identity.
Node copies that target's complete tuning to its new ID once, preserving the
saved Core target. Later computers receive independent tuning.

After an encrypted connection becomes ready, the daemon reads the remote GAP
Device Name through GATT. Mouse input can start before this lookup finishes. A
failed read keeps the existing name. A valid name is limited to 48 UTF-8 bytes
at a character boundary. Computers that do not expose this characteristic use
**Computer N**. A custom name takes precedence and can be reset with **Use
Bluetooth name**.

Only the selected encrypted identity can receive input. Advertising uses the
controller's resolving list and Filter Accept List when privacy is supported. An
application identity check also guards every report. Selection changes release
buttons before disconnecting. Unrequested reconnection leaves pointing off. A
home shortcut can remember that pointing was enabled for up to three seconds.
Node resumes only the selected ready computer and discards motion during the
transition. Off, page closure, navigation, failure, or a newer switch
invalidates the old resume request.

Reconnect advertising uses a fixed 20 ms interval for the first 30 seconds, then
restores the previous 30 to 60 ms interval if still disconnected. This follows
[Apple's discovery
guidance](https://developer.apple.com/library/archive/qa/qa1931/_index.html).
The daemon announces readiness immediately after the zero-button report. Node
sends UI state changes immediately and retains periodic heartbeats. Report
counters do not trigger UI updates. `SWITCH` journal lines record selection, link
establishment, and readiness times. The daemon maintains one Bluetooth link.
Host scanning and encryption contribute to switch time.

## Input order and release behavior

The GATT database includes Device Information with a lab PnP ID, Battery
Service, and HID Service. HOGP requires host discovery of the PnP ID and battery
characteristics. See the [Bluetooth SIG implementation conformance
statement](https://files.bluetooth.com/wp-content/uploads/2024/10/HOGP.ICS.p8.pdf).
The lab uses vendor ID `0xffff`; this build makes no product qualification claim.
Battery level comes from the existing `rk817-battery` power-supply interface.

The six-byte report contains a button bitmap, signed 16-bit X and Y movement,
and signed 8-bit wheel movement. Every movement and wheel report includes the
current bitmap. Boot mouse mode uses the standard three-byte report and clamps
movement to its 8-bit range; wheel movement is unavailable in that mode.

The queue contains at most 16 reports. Motion can coalesce only with the last
motion report in the same button interval. Button edges retain order, including
rapid press and release before a send opportunity. Motion older than 75 ms is
discarded. Overflow policy differs by input type. A full queue drops the new
motion and counts it in `dropped_motion`, which Node folds into `dropped_movement`. Pointing continues after
motion overflow. Button, scroll, and media overflow stop pointing and request a
zero-button report to recover from the lost input. `MOVE` never emits a status
line; status follows state changes and a 250 ms timer.

The local client sends a heartbeat every 250 ms. Client disconnect, a one-second
lease expiry, STOP, suspend, and shutdown all stop input. A release has a 250 ms
handoff deadline that repeated STOP commands cannot extend. If notifications or
encryption disappear while a button may be held, the daemon disconnects.
Systemd uses a three-second process watchdog and powers Bluetooth off after exit.

These acknowledgements confirm BTstack accepted a report. They do not confirm
that a computer received or displayed it. The requested 7.5 ms connection interval
also does not imply 1000 reports per second. Host timing and drag behavior need
manual validation on each supported host.

## Local command protocol

`/run/airmouse-bt/control.sock` accepts one local client with the `airmouse` UID
or UID 0. The socket is mode 0660 in a directory owned by `uccore:airmouse`.
Each ASCII command ends with a newline and occupies at most 128 bytes.

| Command | Behavior |
| --- | --- |
| `OPEN id` | Start pointing when the encrypted, subscribed host is ready |
| `BUTTON id mask` | Set absolute button mask 0 to 3 |
| `MOVE 0 dx dy` | Queue signed movement, bounded to ±32767 per axis |
| `SCROLL id wheel` | Queue wheel movement, bounded to ±127 |
| `STOP id` | Cancel pending input and release buttons |
| `PAIR id` | Open pairing when fewer than four computers are saved |
| `CANCEL_PAIR id` | Close pairing and restore selected-host advertising |
| `SELECT id peer` | Select a saved computer and disconnect the previous link |
| `RENAME id peer hex` | Save UTF-8 name encoded as hex; `-` resets the custom name |
| `REORDER id peers` | Save an exact comma-separated permutation of all peer IDs |
| `FORGET id peer` | Remove a saved computer and its bond |
| `PING 0` | Renew the local client lease |

Request IDs increase and fit an unsigned 32-bit integer. MOVE and PING use zero
and receive no acknowledgement. Other replies are JSON lines with `id`, `ok`,
and an optional `error`. BUTTON, SCROLL, and STOP succeed after BTstack handoff.
Unsent commands cancelled by STOP receive errors.

Management commands require pointing off and no pending release. Peer IDs are
nonzero, eight-digit lowercase hexadecimal strings. Names contain at most 48
UTF-8 bytes and no control characters. SELECT acknowledges accepted selection,
not a completed Bluetooth connection.

Periodic version-2 state messages include the ordered `devices` array,
`selected`, `connected_device`, and `host_limit`. They distinguish controller initialization,
connection, encrypted readiness, pairing, active input, and the button bitmap.
They include the connection interval, report count, discarded motion count,
and the current error. Node validates the protocol and stops on malformed data,
request timeout, congestion, or disconnect. It never replays uncertain input.

## Repeatable checks

The C state tests verify ordering, coalescing, stale motion, overflow, and
report encoding. The lifecycle tests call the production Bluetooth event handler
with simulated controller operations. The IPC tests launch the daemon with `--simulate`;
they never access a radio. Node tests exercise its adapter against local socket
servers. Qt tests cover physical edges through pending actions and page closure.
Deployment tests replace systemd and device files with fixtures.

The device `--probe` initializes and powers down the controller without
advertising or generating HID reports. Pairing and host mouse tests remain manual.
