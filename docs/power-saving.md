# Remote 3 power saving

The LG profile keeps pointing enabled while the display, sensor acquisition,
Bluetooth connection and system sleep time out independently.

| State | Sensor and pointer | Display and Bluetooth |
| --- | --- | --- |
| Moving or using controls | 200 Hz sensor sampling, 100 Hz LG reports | Display dims and turns off after its configured timeout; Bluetooth uses 10 ms and latency 0 |
| Still for 15 seconds | Acquisition stops and the original sensor settings return; pickup detection stays available | Display can remain off; Bluetooth relaxes to 30 ms and latency 2 |
| Pickup or a pointer button | Acquisition resumes automatically | The TV helper restores fast connection timing |
| Full suspend | The sleep service stops acquisition and then the owned Bluetooth service | The controller powers down; after wake both services restart and the TV reconnects the existing pairing |

Held mouse buttons defer rest. An explicit stop, target change, app closure or
sensor error cancels a pending pickup resume. Rest does not clear pointer intent,
so the LG automatic-start timer does not immediately undo it. Computer profiles
retain their configured sampling policy and inactivity timeout.

## Display wake events

The firmware BMI323 input device emits `KEY_WAKEUP` events during FIFO acquisition.
A read-only check measured 126 wake presses in 2.5 seconds. Core counts these as
user activity, preventing the normal display timer from expiring.

`runtime/native/sensor_io.c` uses the Linux evdev grab ioctl on the discovered
`bmi323` input device while acquisition runs. It consumes these false wake events
without forwarding them. Closing the reader releases the grab synchronously.
Rest, errors and process exit restore normal pickup wake handling. The installed
kernel drivers are unchanged. The service retains access only to the discovered
IIO and wake-input device nodes through its systemd device policy; the original
input-device ownership is unchanged.

Core's `IDLE` mode dims the display. `LOW_POWER` switches it off. Owned Bluetooth
pointing continues in both states. Full `SUSPEND` stops acquisition. Temporary
15-second standby inhibitors renew during acquisition, allowing the screen to
switch off while preventing suspend in the middle of pointing. They expire if
the process crashes and are removed when acquisition stops.

Sleep recovery runs through `ExecStopPost`, including when preparation fails or
times out. It attempts both saved service restarts independently. Failed restart
requests retain their markers for a later retry, including across another sleep
cycle. Bluetooth restarts only while Air mouse still owns the controller.

A wake does not always bring the TV link back. On 2026-09-09 the 22:27 wake
started the daemon with the app open and the TV never connected until a hand
switch three hours later, which then linked in 326 ms. The daemon was
advertising the whole time; whether the TV tried is unknown because the TV-side
helper only reconnects while the TV reports Active. The service now retries a
reconnect request every 30 seconds while the app is open and the target is
down, and any key press or shake requests one immediately. The daemon logs each
link, ready, and disconnect event so the next failure can be read from the
journal.

Screen-off hides the main Qt window and its popup. On wake, the UI reopens the
same Air mouse page, restores input ownership, and attempts a socket connection
immediately. Version .24 keeps the selected device and cards visible while the
service restarts. Device cards are marked offline until the connection recovers.

The status reads "Reconnecting…" for up to five seconds, then reports an
unavailable service. The Bluetooth backend waits for a valid device state before
publishing availability. That state replaces the retained view, including when
it reports an empty pairing list. Bluetooth still needs time to resume.

## Processing and radio activity

The sensor adapter waits for data-ready notifications instead of polling every
2 ms. Acquisition checks run separately every 250 ms. The adapter uses IIO's
[data-ready polling interface](https://github.com/torvalds/linux/blob/v6.6/drivers/iio/industrialio-buffer.c).

Diagnostics write `status.json` at most every two seconds; functional changes
publish immediately. UI heartbeats keep the existing watchdog timing and omit
diagnostic metrics. Identical snapshots do not trigger QML updates. The page
clock stops while hidden.

The TV link helper observes only the configured Remote 3's hidraw reports and
the receiver's slot-1 input events to recognize stream start, stop, activity,
and a missing receiver attachment. It does not save packets. Relaxed
timing may add up to roughly 90 ms of connection-event scheduling delay before
the fast timing is restored. While the TV is active, the helper retries the
normal HID connection API for this paired device after disconnects. It does not
wake the TV or reconnect other devices.

## Install and verify

Normal runtime deployment builds and packages the ARM64 Node adapter and installs
`airmouse-sleep.service`. Use native UI 0.74.5-airmouse.24 for the wake fixes.
Update the TV helper with `tools/airmouse-lg-install-link --host root@TV-address`.

`tools/airmouse-configure-power-saving` saves prior settings and applies display
brightness no higher than 60, button brightness no higher than 25, automatic
lighting, a display timeout no longer than 10 seconds, and a 60-second standby
timeout. Its `--restore` option restores saved settings, checking for later edits.

With the app open and the remote stationary:

```sh
python3 tools/airmouse-check-power-saving --seconds 45 --require-rest
```

To test full suspend with an automatic twenty-second RTC wake alarm:

```sh
python3 tools/airmouse-check-suspend
```

The suspend check refuses to replace an existing alarm. It verifies that both
services restarted and the selected Bluetooth target became ready. It leaves
the TV's power state alone. Physical testing should also cover pickup, arrows,
clicks and gentle-shake cursor recovery after a period of rest.

## Verification on 2026-09-09

The device reached `LOW_POWER` with backlight brightness zero while pointing at
200 Hz, and rested with pointer intent retained and acquisition off. The TV link
used 10 ms while active and 30 ms while resting. The user confirmed screen-off.

The timed RTC test on .23 confirmed orderly shutdown, kernel suspend, service
restarts, an LG connection, and automatic pointing. A post-wake screenshot showed
the Air mouse page. The .24 follow-up preserved the TV selection during recovery;
the user confirmed it after waking, and live status showed the TV ready and
pointing without an error. Installed UI and runtime hashes matched the packages.
The TV was already active and its power state was retained.

Local checks passed:

| Change | Node | QML | C++ bridge | Python |
| --- | --- | --- | --- | --- |
| Initial power saving | 194 passed, 4 skipped | 70 passed | Not rerun | 32 passed |
| .24 wake view | 195 passed, 4 skipped | 73 passed | 14 passed | Not rerun |
| Recovery review fixes | Not rerun | Not rerun | Not rerun | 40 passed |

The bridge test disconnects the local socket, sends an incomplete startup state,
and checks recovery and removal of a pairing. Recovery tests cover failed sleep
preparation, retry markers, inactive TV services, and recording permissions. A
one-second recording under the diagnostic service account captured 206 samples
at about 200 Hz and restored the sensor settings.

Battery life has not been measured. CPU percentages alone do not establish
energy savings across power modes.
