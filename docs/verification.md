# Verification on firmware 2.10.2

This history records successive firmware-adapter releases on 2026-09-07 and
power tests on 2026-09-08. Settings, controls, and test counts belong to the
release in each section. For the source-built Bluetooth backend, see the
[initial verification](reviews/owned-bluetooth.md), [computer
management](reviews/computer-management.md), and [home
switching](reviews/quick-switch.md) reports. Current commands are in the
[operations guide](operations.md).

Observed on the lab Remote 3 on 2026-09-07. The hardware service, Core
registration, and native entities were deployed. The user approved and enabled
±2000°/s because the original ±500°/s setting fails. Desktop is paired and
selected. After manual use the user reported poor pointer feel and requested
faster sampling; the saved rate was changed to 400 Hz after latency measurements
showed large batches at 800 Hz. Host behavior has not been measured
independently.

Initial release: `fa913ff02979e1b2`. Repeated builds produced identical archives.
SHA-256: `dbdcf001f85e3db1ba2ad71d775931485400537d5bf77c64e75b6cdeaa086f1a`.

The later release `682cc4609322864d` was installed. It adds verified 7.5 ms Bluetooth
connection timing to the WebSocket, asynchronous acquisition, FIFO and native
button changes. Persisted tuning is sensitivity 1800 and a 10 ms movement
interval, with the diagnostic 400 Hz sensor profile and ±2000°/s range.

After restarting, the user reported: "Its much better, doesn't skip" and asked
for more resolution and speed. No new Bluetooth buffer-full errors appeared in
the inspected post-restart session. Sensitivity was then raised from 1350 to
1800 counts/radian, and the movement limit from 80 to 100 Hz. Feedback on that
final tuning and host report-rate measurements are still pending.

## Results

| Check | Result |
| --- | --- |
| Buildroot runtime | Node.js 22.22.2, arm64; installed systemd service runs as `airmouse` |
| Dependency check | Pinned `ws` 8.21.3; npm audit reports zero vulnerabilities |
| Provisioning | Active persistent API key created through normal authenticated Core API; key stored only on remote |
| Integration | Core registered `airmouse.main` and accepted all five native entities, including the remote grid page; added an Air mouse page to the existing single profile |
| Inactive native commands | Repeated OFF succeeded; 200 Hz selection persisted and published; returned to 400 Hz; no sensor changes |
| Local automated suite | 58 tests passed, including connection identity, timing negotiation, reconnect metadata, activation cancellation, WebSocket acknowledgements, disconnect and timeout handling, nonblocking sensor checks, output pacing, suppression of duplicate status events, bounded asynchronous diagnostic writes, FIFO restoration, native mappings, click delivery, cancellation, and direction replay |
| On-device abnormal termination | SIGKILL of active bounded recorder; systemd stop hook restored baseline and removed journal |
| Wake settings | Event attributes unchanged during and after the killed recording |
| Requested gyro range | `in_anglvel_scale=0.000266` returns `EINVAL`; writing the existing `0.001065` also returns `EINVAL`, with and without newline |
| Activation failure | Recorder failed visibly, remained off, and restored the original settings |
| Bluetooth output | User reports no skips after the connection-timing fix; no agent-driven host input test performed |
| Page registration | Verified five home-page entries and seven controls buttons; restarted the display application after the user reported both screens empty. Visual confirmation remains with the user |
| Configuration at verification | Native 400 Hz selection acknowledged by Core and published in runtime status; ±2000°/s retained, Desktop selected |
| Hardware button mappings | Core readback matches short and long actions for Up toggle, OK left click, and Right right click on the Air mouse controls screen |
| FIFO capture at 800 Hz | 2,403 scans in a three-second recording; timestamp-derived cadence 800.76 Hz; baseline restored |
| Requested roughly 1 kHz Bluetooth output | Not achieved; current output still uses separate Core X/Y commands with one in flight |

## Confirmed Bluetooth report loss

Further manual testing still produced skipped motion and occasional motion for
about half a second after the hand stopped. At 11:06 UTC on 2026-09-07,
`btstack.service` repeatedly logged `Keyboard send buffer full, can't enqueue
native report 4` and `UCR_MOUSE_SEND_REPORT error: 7` for profile 1. Meanwhile the
application reported zero rejected stale samples, and its latest 256 Core
acknowledgements were 5.14 ms median, 6.91 ms p95, and 16.10 ms maximum.

Core acknowledgement therefore does not establish that Bluetooth accepted the
report. The installed firmware has a 20-entry native report queue and applies
a press/release cycle to nonzero mouse motion. The connection log shows the
selected host changed its interval from 12 to 48 units of 1.25 ms, or 15 to
60 ms. Together these explain queue pressure and delayed motion. The root cause
of the user's reported loss is downstream of the sample freshness checks.

The user rejected 400 Hz as the final performance target and requested roughly 1
kHz, including custom drivers if needed. The installed 400 Hz profile served as
the diagnostic baseline. Connection timing is now corrected; higher-rate sensor
support and roughly 1 kHz host delivery remain unachieved.

## Investigation of movement lag

Sensor timestamps concealed delayed delivery to the application. The recorder
now measures sample age at callback, batch size, callback gaps, device-read
duration, event-loop delay, and synchronous and asynchronous attribute read
duration.

The old health check synchronously read driver attributes every 250 ms. Three
reads could take about 20 ms each. The initial diagnostic measured sample ages
near 34 ms median and 76 ms p95. Health checks now run asynchronously, with one
check at a time, a 500 ms watchdog, and reader identity checks so a stopped
reader cannot affect its replacement. A regression holds an attribute read
pending and verifies that available scans still reach the callback.

After that fix, isolated three-second captures produced:

| Sensor setting | Delivered scans/sec | Sample age median / p95 | Callback gap median / p95 | Median batch |
| --- | ---: | --- | --- | ---: |
| 800 Hz | 801.76 | 30.01 / 39.98 ms | 19.27 / 21.43 ms | 16 scans |
| 400 Hz | 400.98 | 5.46 / 8.01 ms | 4.09 / 6.06 ms | 2 scans |

Both captures restored the baseline. Device reads at 800 Hz took 0.24 ms median
and 0.51 ms p95, so the 19 ms delivery gaps are not explained by the read call.
The observed batching precedes the application callback. Its exact cause within
the vendor driver and hardware was not established. The installed rate was set
to 400 Hz to reduce measured delivery delay. Sensitivity 1350, filtering at 18
ms, and the accepted ±2000°/s range are retained. FIFO timestamps are
reconstructed by the driver; these measurements are not motion-to-screen
latency.

A separate idle, read-only Core benchmark measured HTTP at 11.57 ms median and
27.43 ms p95, versus WebSocket at 4.96 ms median and 8.78 ms p95. This
comparison uses entity queries, not HID delivery. Movement and clicks now use
Core's `execute_entity_command` on the existing authenticated WebSocket. Each command still waits for
its matching response, with one request in flight, a 500 ms response deadline,
and no replay or HTTP fallback after an ambiguous result. The device verifier
exercises that command envelope using native Pointer OFF, which sends no host
input. Tests also cover stop between X and Y commands and socket loss while a
click is pending.

Repeat the measurements with `tools/airmouse record --rate 800 --seconds 3
--gyro-range 2000`, the same command at `--rate 400`, and
`tools/airmouse benchmark`. Run sensor captures and the Core benchmark separately
to avoid load from one measurement affecting the other.

The filter's 18 ms smoothing and separate X/Y reports still contribute delay.
The user subsequently confirmed improved feel. The requested higher Bluetooth
report rate remains unverified. No automated host input was sent during this investigation.

## Stutter after FIFO deployment

The user reported jumpy movement with release `509b9a7f4763b773`. Its latest
256 Core responses measured 11.13 ms median, 30.13 ms p95, and 67.78 ms maximum.
The runtime recorded 528 rejected stale or future-dated movement samples or
batches. These counters do not identify host latency or prove one cause of the
reported feel.

Two deterministic regressions reproduced avoidable work in the output path:

- Replaying 80 unchanged Bluetooth-ready events triggered 80 status publications.
  These now trigger none. Readiness changes still publish and disconnects stop
  pointing. Metrics-only changes no longer republish native entities.
- After a 30 ms command delay, fresh movement waited for another fixed polling
  tick. The scheduler now dispatches within the next simulated millisecond once
  Core is free. A separate test checks the 13 ms rate limit and stop cancellation.

The diagnostic `status.json` writer now uses asynchronous atomic replacement
without a durability sync. If storage is slow, it retains one in-flight write
and the latest pending state. The regression submits 800 updates while a write
is held and verifies that only the first and final states are written. Sensor,
configuration, and output recovery journals still use durable writes.

Run `node --test test/output.test.mjs test/status.test.mjs` to repeat these checks. Sensor rate, sensitivity, direction mapping, and
physical buttons were retained. The changes remove these application stalls.
Physical smoothness and updated Core timings still required a manual test.
Separate X/Y delivery and the Core transport's throughput remain limitations.

## FIFO acquisition and physical buttons

The previous triggered acquisition plateaued near 388 scans/second. Clearing
`trigger/current_trigger` before enabling the buffer selects the driver's hardware
FIFO path. The runtime verifies `buffer/hwfifo_enabled=1` and journals the original
trigger for normal stop and crash recovery. An older journal without a trigger
entry remains recoverable without writing that attribute.

At 800 Hz, a three-second capture delivered 2,403 complete scans. Timestamp gaps
were 1.243 ms median, 1.306 ms p95, 1.325 ms p99, and 3.801 ms maximum. The driver
can reconstruct FIFO frame timestamps, so this measures scan cadence rather than
individual interrupt or application callback timing. These results supersede the
triggered acquisition measurements retained below.

Up, OK, and Right are registered on the native controls entity and verified by
Core readback. Each has matching short and long actions. The native UI's
`ButtonNavigation.qml` suppresses automatic repeats when a long action exists:
a short press acts on release and a hold acts once at the long-press threshold.
Physical behavior still requires manual confirmation. These mappings are scoped
to the controls screen.

At this stage, 400 Hz Bluetooth delivery was still unverified. Prior live Core
command responses were about 10.6 ms median and 15.2 ms p95. A read-only probe
of 50 profile-status requests to the existing Bluetooth daemon measured 43.0 ms
median and 46.4 ms p95. Status-query latency does not establish its HID
capacity. Its internal mouse command path provides no per-report success
response. It had not replaced the Core transport or been tested with host input.
Raising the application timer alone would not establish 400 delivered
reports/second.

After the user selected a target, the runtime reported activation failure at
`in_anglvel_scale`. A one-second default-profile recorder reproduced the same
`EINVAL` without Bluetooth output. Node file writes, Node descriptor writes, and
shell writes of the existing scale all failed with the sensor inactive. This
rules out the application's writer and acquisition ordering as the cause of
these rejected writes. An explicit ±2000°/s compatibility profile is implemented;
the user subsequently approved and enabled it in the installed configuration.

`tools/airmouse record --rate 400 --seconds 3 --gyro-range 2000` passed on the device. It delivered 1,176 samples at 389.02 Hz, with gaps of
2.535 ms median, 2.838 ms p95, 3.303 ms p99, and 3.738 ms maximum. All original
settings were restored. This exercises the compatibility sensor profile without
enabling Bluetooth output or changing the persisted runtime profile.

The coherent acquisition path uses all six channels plus an aligned IIO timestamp
with `current_timestamp_clock=monotonic`. The captured records contained complete
24-byte scans. The upstream BMI323 driver reads all six channels together when
the full scan mask is enabled. The vendor's exact kernel source was not inspected.

Three-second diagnostic captures retained the original gyro range:

| Requested rate | Samples | Delivered rate | Median gap | p95 gap | p99 gap | Maximum gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 Hz | 152 | 50.11 Hz | 19.954 ms | 20.090 ms | 20.297 ms | 20.428 ms |
| 400 Hz | 1160 | 383.17 Hz | 2.586 ms | 2.915 ms | 3.349 ms | 3.524 ms |

Both captures restored all recorded settings exactly. The 400 Hz profile's
delivered cadence is lower than its configured rate. These are short runs, not
sustained throughput or power measurements. Observed mean gyro bias was about
`[0.0018, -0.0015, 0.0001]` rad/s. This is not a calibrated user profile.

## Direction, lifecycle, and output controls

### Direction correction from manual feedback

The user reported mirrored horizontal movement and poor vertical response. A
ten-second labeled sensor capture contained 3,883 samples, delivered at 387.99 Hz
despite both sensors being configured for 800 Hz. Original sensor settings were
restored afterward. This is measured acquisition cadence, not Bluetooth report
timing.

92.1% of rotational energy lay along sensor Y while tipping the remote up and
down. The previous forward vector `[0, 1, 0]` treated that pitch rotation as rotation
around the remote's long axis. The corrected forward vector is `[1, 0, 0]`. Replaying
the full capture produced 4,867 absolute vertical counts instead of 798, with
512 absolute horizontal counts. The first major upward stroke produces negative
screen Y and the following downward stroke produces positive Y. Horizontal
output sign was reversed independently in response to the user's observation.

A decimated capture is retained in `test/fixtures/pitch-motion.json` for a
regression test. The test failed with the old mapping and passed after correction.
Synthetic tests also check pitch direction through wrist roll and tilted holds.
Use `tools/airmouse-analyze-motion CAPTURE.jsonl` to compare candidate forward
axes on another labeled capture. Hand confirmation of the installed correction
remains pending.

### Lifecycle and output

- The installer checks for existing acquisition descriptors, records original
  permissions, and grants the dedicated group only the changed acquisition
  attributes and the IIO device. Core retains its separate event attributes.
  A process lock prevents this service and its recorder from running concurrently.
- The sensor journal records the original values and each intended write before
  mutation. Active rate changes retain the original baseline. Unexpected
  external changes block restoration and new activation.
- The software buffer holds 64 scans. Output retains one bounded fresh movement
  batch and permits one in-flight command. X and Y are separate Core commands.
- Stop invalidates sample and output generations before restoring the sensor.
  Restoration does not wait for a Core response. A pending old Y command is
  suppressed if stop occurs while X is in flight.
- Ambiguous clicks and movement are never retried. An output-session marker
  survives a crash and blocks activation pending inspection. Target changes
  after output remain blocked until host isolation has been demonstrated.
- Core reports connected Bluetooth entities as `UNKNOWN`, which the adapter
  accepts only for a paired mouse-capable target. That state is a firmware
  report, not proof that the host consumed a HID report.

## Manual work remaining at the firmware-adapter stage

The user chose to perform physical and host tests manually. Unverified items are
physical axis signs, roll behavior, sensitivity, physical-button repeat, screen
interaction, move-to-wake, standby and wake, whole-remote power, sustained
cadence, Windows, Linux, and Steam compatibility, host report timing, diagonal
smoothness, click release, scroll direction, and target isolation.

No host-observed latency was measured. The output adapter records a bounded
window of Core response times when commands are sent. Those timings measure Core
acknowledgements, not host latency. Operation with the development computer
disconnected remained unverified. The adapter limits new movement batches to one
per 13 ms after the user requested faster output, compared with the original 25
ms. The configured movement limit is 80 Hz, rounded down to about 77
batches/second by timer resolution. One in-flight command and separate X/Y
acknowledgements can lower actual throughput. 800 Hz sensor sampling does not
imply 800 Hz Bluetooth output. Sensitivity at this stage was 1350 counts/radian,
50% above the original 900. These configuration changes still needed host timing
measurements and manual feedback on pointer feel.

The original ±500°/s gyro write failure still needs a firmware-supported fix.
The accepted ±2000°/s profile avoids the write. The installed service retains the
original kernel drivers and firmware `btstack.service`. Experimental driver
source and its build tool are separate from the release.

## Interface references

- [Core authentication](https://github.com/unfoldedcircle/core-api/blob/main/core-api/README.md#authentication)
- [Integration registration](https://unfoldedcircle.github.io/core-api/integration-driver/driver-registration.html)
- [Bluetooth commands](https://unfoldedcircle.github.io/core-api/bt/index.html)
- [Bluetooth state and hold restrictions](https://unfoldedcircle.github.io/core-api/bt/TODO.html)
- [Native select entity](https://unfoldedcircle.github.io/core-api/entities/entity_select.html)
- [Upstream BMI323 acquisition](https://github.com/torvalds/linux/blob/v6.8/drivers/iio/imu/bmi323/bmi323_core.c)
- [Native physical-button repeat handling](https://github.com/unfoldedcircle/remote-ui/blob/main/src/qml/components/ButtonNavigation.qml)

- [Core WebSocket command schema](https://github.com/unfoldedcircle/core-api/blob/main/core-api/websocket/UCR-core-asyncapi.yaml)

## Experimental driver trial

The repository contains a BMI323 driver prototype with a 1600 Hz option and
a controller driver restricted to the sensor's I2C bus at 400 kHz. Both build
against captured firmware headers with module version checking enabled. The
build compared 24 generated symbol CRCs with those in installed firmware
modules; all matched. No 1600 Hz cadence result was obtained.

The first replacement trial failed to restore an event threshold exactly.
Investigation also found that the firmware driver's input-device lifetime
makes live replacement unsafe. Core subsequently failed while enumerating an
obsolete input device. The user restarted the remote; its original drivers
and services are running again. The hot-reload trial tool was removed from
both the repository and device, and no further replacement was attempted.

The prototype now includes a managed `bmi323` input interface with `KEY_WAKEUP`, with wake
events for motion and taps. That revision is compiled but has not been loaded or
physically tested. A verified boot-time transition and wake validation are
prerequisites for deployment. See [driver status](../drivers/README.md).

## Reliability fixes after independent review

Release `e5af2cb79971533d` implements the accepted reliability fixes and the direct
tuning lock. All 86 local tests pass. Installer failure tests use temporary files
and a fake service manager; failures were not injected into the live remote.

Installed verification passed for native controls, repeated OFF, inactive sensor
preservation, and restoration of the selected 800 Hz sampling rate. A separate
Bluetooth check confirmed 7.5 ms timing with no HID reports. The saved
configuration hash was unchanged, including sensitivity 1800, ±2000°/s range,
and the 100 Hz application movement limit. The service is active, holds its
configuration lock, and uses the 30-second shutdown budget.

The updated journal reader advances past ordinary traffic as well as metadata.
Two measured incremental reads took 224 ms and 216 ms after initial indexing.
The original drivers remain installed. These checks do not measure host report
rate or motion-to-screen latency.

See the [fix report](reviews/2026-09-07/reliability-fixes.md) for regression mapping,
device evidence, and the remaining validation limits.

## Output rate controls and mouse hold investigation

Release `dbabe11177fff6bc` adds the output selector, faster and slower buttons,
and a 10-second manual-motion test. All 96 local tests pass. Tests cover
fractional 400 Hz pacing, live rate changes, persistence failure, completed-batch
counting, automatic test stop, and cancellation without affecting later sessions.

Device verification found six entities, six home-page entries, and ten controls.
The 1,000 Hz option and both step buttons passed through Core. Verification restored
the previous 100 Hz limit and 800 Hz sensor setting. The sensor baseline was unchanged,
pointing remained off, and the service reported zero restarts. These checks sent no
host input. The timed motion test was tested locally; host testing remains manual.

Static analysis of the installed Bluetooth daemon found that its hold validator
rejects mouse report ID 4. Its native mouse path ignores the release flag and
schedules an automatic zero report. No button mapping change or firmware patch
was installed. Independent mouse press and release were still unimplemented in
this release. See the [protocol report](design/mouse-button-protocol.md); its
findings can be reproduced locally with `tools/airmouse-firmware-inspect` against the firmware executable,
which is not distributed here.

## Power transitions on 2026-09-08

Manual tests used `tools/airmouse-power-watch`, UI release 0.74.5-airmouse.10, the owned Bluetooth
backend, and mains power. Core timeouts were 60 s for display-off and 180 s for
standby. Pointing paused by the service idle timeout 73 s after activation while
the remote lay still; display-off then closed the app because pointing was
already paused. Standby while paused closed the app as designed. Release
0.74.5-airmouse.11 removed app closure on display-off. Idle now leaves the app
open.

A retest used 0.74.5-airmouse.11 under the same conditions. Pointing paused by
the idle timeout 64 s after activation; display-off followed 31 s later. The
control connection stayed intact, the app stayed open, and Power resumed
pointing without a relaunch. This confirmed display-off behavior while paused.

Standby while pointing cannot occur naturally on firmware 2.10.2. With the idle
timeout raised to 600 s, pointing ran 3 min 48 s with the remote still and Core
never left NORMAL. The cause is the firmware `bmi323` input device. At the 800 Hz
FIFO rate its interrupt handler emits `KEY_WAKEUP` press and release pairs at about 49
per second, measured on `/dev/input/event4` as 1372 events in 14 s while pointing against 4 in
12 s at rest. Core's evdev actor counts each as user activity, so display-off
and standby timers never expire while pointing. Display-off therefore cannot
occur naturally while pointing. An explicit Core `STANDBY` command can interrupt
pointing. Otherwise, the service must pause pointing through its idle timeout
before Core's sleep timers can expire. The idle timeout is the only automatic
limit on battery use while pointing.

A reboot on 2026-09-08 confirmed the Node service, generated sensor drop-in,
custom UI, launcher entity and configuration survive. Bluetooth takeover did not
survive that reboot. Running `tools/airmouse-bluetooth takeover` restored it and the pairing controls. Later
releases added the [ownership setting](design/owned-bluetooth.md), which can
restore takeover automatically after reboot.
