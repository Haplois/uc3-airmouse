# LG TV profile

The LG TV profile implements the observed Bluetooth LE reports of the **LGE
MR23 Magic Remote**. It was developed from a recording on the lab TV,
`[LG] webOS TV OLED77G3PSA`, running webOS 11.2.0. The TV name selects the
profile even when its display name is changed to `TV`. LG TVs have their own
icon in the device list and quick switcher.

Lab tests confirmed registration, corrected motion axes, about 100 Hz delivery,
and cursor recovery after a small side-to-side shake. The original LG remote and
Remote 3 work together with the TV receiver fix. The profile is experimental and
specific to the inspected firmware. A TV reboot exposed a connection-order
failure when Remote 3 reached the stock receiver before the startup hook. The
hook now restores checksum-protected slot records before patched Bluetooth input
starts. The link helper checks the receiver's live hidraw descriptor, not the
saved `hidraw` field, which can be empty while input works. Attachment repairs
have a 60-second cooldown.

The deployed v5 receiver reduces Remote 3's shake threshold from about 105 to
26 degrees per second. It also uses the TV's saved local calibration cache for
Remote 3's secondary slot. It retains the alternating-stroke requirement, cursor
sensitivity, and original remote behavior. The TV connection helper
uses a 10 ms interval and zero peripheral latency during pointing. It can briefly
reconnect Remote 3 when first installed or after a lost receiver attachment,
preserving the pairing. During rest it
relaxes to 30 ms and latency 2; see [power saving](power-saving.md).

The [receiver protocol reference](lg-protocol.md) contains the firmware evidence,
command families, calibration framing, voice coverage, and dual-pairing fixes.
Use its [persistent startup procedure](lg-protocol.md#persistent-receiver-startup)
for installation and recovery, and its
[connection timing procedure](lg-protocol.md#bluetooth-connection-timing) for the
link helper. The offline checks use saved firmware evidence without a new recording.

## Power and automatic pointing

Channel up opens the LG input switcher. Channel down selects HDMI 1. The bottom
Next and Previous buttons cycle connected HDMI inputs in port order. Unplugged
ports are skipped. The original LG remote keeps its normal channel controls.
Remote 3 sends these commands over Bluetooth to the TV-side key handler.

With an LG TV selected, the physical Power key sends the TV's Bluetooth power
command while connected. When Bluetooth is unavailable, it sends a Wake-on-LAN
packet to that TV's configured network MAC address and asks Remote 3 to
advertise again, so it works whether the TV is off or only out of range. Power
uses no IR. Any other key or a shake while disconnected only asks to reconnect;
the TV-side link helper retries the HID connection when it sees the remote.
The lab TV drops native Bluetooth power reports, so its persistent startup
installation includes a handler for Remote 3's power key. The handler accepts
reports only from the configured Remote 3 Bluetooth address and calls the TV's
normal power API. It does not change motion reports or receiver calibration.
The TV needs **Turn on via Wi-Fi** enabled under **TV On With Mobile**, as described
in [LG's network wake guide](https://www.lg.com/us/support/help-library/how-to-set-up-the-lg-thinq-app-on-your-lg-smart-tv--20152745625356).

Configure a saved TV after checking its network MAC and subnet broadcast address:

```sh
python3 tools/airmouse-lg-configure-power --host root@REMOTE_IP \
    --target DEVICE_ID --mac TV_NETWORK_MAC --broadcast SUBNET_BROADCAST
```

The tool changes only that target's wake destination in the service configuration.
It briefly restarts the runtime and preserves sensor calibration. Bluetooth
re-pairing creates a new device ID, which requires configuring the new target.

Install the TV handler after the [persistent receiver setup](lg-protocol.md#persistent-receiver-startup):

```sh
python3 tools/airmouse-lg-install-power --host root@TV_IP \
    --remote-bluetooth-address REMOTE_BLUETOOTH_MAC
```

The September 8 hardware check observed **Active → Active Standby → Active**:
Remote 3 sent the Bluetooth power press, waited 12 seconds, then sent the wake
packet. Afterward, pointing resumed automatically, all services were active,
and both TV calibration file hashes were unchanged. This check exercises one
standby cycle; it does not establish wake after an extended power outage.

Pointing starts automatically on the main Air mouse screen when the TV connects
or the app returns from Settings or standby. The pointer button cannot pause an
LG session. After 15 seconds of stillness, acquisition rests while pointing stays
enabled; pickup resumes it. Closing the app, losing input ownership, calibration,
and full suspend release the sensor. The TV controls cursor visibility, including
menus that hide it. Computer profiles retain Power-to-pause and their configured
inactivity timeout. See [power saving](power-saving.md) for screen-off and wake behavior.

## IR pairing

1. Remove the earlier keyboard/mouse pairing from the TV and Air mouse if it
   remains saved. The corrected GATT report layout needs a fresh Bluetooth bond.
2. Turn the TV on and point Remote 3's IR transmitter at it.
3. In Air mouse's device manager, choose **Pair LG TV** and keep pointing at the TV.
4. Wait for the TV's Magic Remote registration message, then select the TV in
   Air mouse.

The service checks Remote 3's internal IR emitter, starts the 60-second Bluetooth
pairing window as **LGE MR23**, waits for the previous Bluetooth connection to
close, and sends the registration IR command once. A failure to send IR cancels
that pairing window and reports an error. Closing Air mouse during setup cancels
pending IR work. An IR command already sent cannot be recalled.

Regular controls use Bluetooth. Only the registration trigger uses IR. The Core
API call is local to Remote 3; no TV network remote API is involved.

The stock receiver cannot use two MR23-style remotes together: its BLE handler
moves the second device into the primary slot despite accepting dual-pairing mode.
The deployed receiver fix preserves both slots, dispatches second-slot input, and
initializes its motion engine. Both remotes were confirmed working with v3. V5 adds
the gentler shake threshold and the secondary-slot local calibration route. For a fresh setup, register the original LG remote
first, enable the second slot, then use **Pair LG TV** on Remote 3. See
[persistent receiver startup](lg-protocol.md#persistent-receiver-startup).

### Captured registration signal

[`config/ir/lg-mr23-pairing.json`](../config/ir/lg-mr23-pairing.json) contains the
signal, source, and capture timestamps. During the original MR23 registration on
September 8, the TV's MICOM log recorded input command `0x83` translated to Linux
key `0x405`. Magic Remote registration started immediately afterward and the TV
logged success 2.35 seconds later.

The NEC encoding is `20DFC13E`, sent through Core as `3;0x20DFC13E;32;0` in HEX
format. The [IR key mapping](https://gist.github.com/ledoge/ab78723efdaa00e6815e30d1792790fd)
identifies it as `IR_KEY_PAIRING_SP`. This is reconstructed from the captured
command using standard NEC encoding, not a measurement of the original pulse
widths. Remote 3's Core encoder also confirms NEC address `0x04`, command `0x83`,
and a 38 kHz carrier. Its returned timing vector is retained in
`test/fixtures/lg-mr23-pairing-core.json`. The original OK command `0x44` was a
separate following IR event.

The initial implementation exposed eleven GATT reports and listened on F8.
The corrected profile exposes the original remote's five reports and listens
on F9. An IR-triggered hardware attempt reached the registration screen, but
the TV rejected discovery with `There in no scd packet info` before connecting.
The profile now includes the captured LG manufacturer field, company ID
`0x00c4` and ASCII payload `SCD 21.2,BA 35,webOS`. It uses the original
advertising flags `0x05` and puts `LGE MR23` in the scan response. The lifecycle
test retains both captured byte sequences and checks that cancelling LG pairing
restores generic advertising. Remote 3 keeps its own Bluetooth address and keys.

The TV logged Remote 3's `PAIR_OK` at `2026-09-08T13:10:55.474812Z`.
The registration recording also includes larger F9 `17`
responses that have not yet been implemented.

Choosing **Pair another computer** keeps the generic mouse, keyboard, and media
profile. Selecting an existing LG TV switches the advertised identity and GATT
reports after the current connection closes. Saved subscriptions are preserved
across known profile schemas; an unknown schema still uses BTstack's normal
cache invalidation.

## Controls

| Remote 3 control | LG TV action |
| --- | --- |
| Power | TV power toggle over Bluetooth, or Wake-on-LAN plus a reconnect request while disconnected |
| Circle (firmware `RECORD`) | TV Quick Settings |
| Hamburger (firmware `MENU`) | TV All Settings |
| Arrows | Native remote navigation |
| OK | Native OK, with press/release while pointing |
| Home | TV Home |
| Back | TV Back |
| Channel up | LG input switcher |
| Channel down | HDMI 1 |
| Next / Previous | Next / previous connected HDMI input |
| Volume up / down | TV audio volume up / down |
| Mute | Toggle the TV's reported mute state |
| Play/Pause | Linux `KEY_PLAYPAUSE` press and release |
| Stop | TV Stop press and release |
| Touchscreen Netflix | Launch Netflix |
| Touchscreen YouTube | Launch YouTube |
| Touchscreen Steam Machine | Select HDMI 1 and request HDMI-CEC power-on |
| Touch strip while pointing | Wheel scrolling |

Use the touchscreen back arrow to exit Air mouse. Inside settings and the
device manager, Home and Back keep their app functions. Computer controls keep
their existing behavior.

Circle and hamburger use distinct Bluetooth commands handled only for the
paired Remote 3 address. The TV helper launches `com.webos.app.quicksettings`
and `com.palm.app.settings`, respectively. Verify these routes with
`python3 tools/airmouse-lg-check-settings --tv root@10.0.240.2 --remote root@10.0.10.51`.
The check briefly stops and restores the pointer runtime, returns Home before
each command, and checks TV lifecycle events. It leaves All Settings open.
It does not check rendered pixels or physical button switches.

The logo-only touchscreen shortcuts replace TV Back and OK. Their SVG assets
are bundled locally, and the buttons have no focus outline. The physical Back and center
OK buttons retain their TV functions. The firmware identifies the channel rocker
as `CHANNEL_UP` and `CHANNEL_DOWN`, the circle as `RECORD`, the hamburger as
`MENU`, and the combined play button as `PLAY` in `src/ui/inputController.h`.

Volume, mute, media, app shortcuts, and settings use reserved Bluetooth commands
handled only for Remote 3's paired address. No native volume code is sent alongside
the helper command, so one press does not change volume twice. Play/Pause sends
key 164, not Pause. Each app controls its response to the toggle key.
Volume and mute use [LG's documented Audio API](https://webostv.developer.lge.com/develop/references/audio).
`tools/airmouse-lg-check-controls` verifies volume, both mute transitions, HDMI 1,
app shortcuts, and media key edges. It restores volume, mute, and the runtime.

Steam Machine uses the TV's existing `/dev/cec0` in non-exclusive initiator mode.
It broadcasts Set Stream Path for physical address `1.0.0.0`, discovers that
device's logical address, and sends discrete Power On followed by key release.
It never sends a power toggle or powers a device on another input. A power-state
reply of On is required before the helper reports confirmed wake. If no device
acknowledges, HDMI 1 remains selected and a toast reports the unconfirmed wake.
The September 11 check confirmed the routing transmission but received no device
acknowledgment. SIMPLINK and automatic CEC power-on were enabled.

The protocol also supports separate Play, Pause, and Settings actions. Some key
assignments use the [MR20 driver's key table](https://github.com/brainrom/lg-magic/blob/master/kernel/lg_magic_main.c).
Voice audio, firmware updates,
and general IR controls are not implemented. TV power-on uses Wake-on-LAN;
regular remote commands use Bluetooth.

## Netflix and YouTube metadata repair

Old compatibility overrides exposed Netflix 4.0.0 and YouTube 26.1.0 after the
installed packages had updated to 4.0.2 and 26.1.1. Home selected a mandatory
update prompt instead of launching the app. Netflix also referenced removed
artwork. Direct app launch alone did not detect this regression.

`tools/airmouse-lg-repair-app-metadata --tv root@TV_IP` audits the overlay metadata
against the underlying installed packages. `--apply` quarantines only recognized
stale metadata overrides and the old icon-repair boot hook. It preserves account
data and app packages. A TV reboot is required after applying the repair.
The tool prints the recoverable backup directory under `/var/lib/webosbrew`.

`tools/airmouse-lg-check-home-apps --tv root@TV_IP` tests Home, arrow selection,
and OK using the lab TV's saved tile order. Both apps passed after the September
11 repair and reboot. Future checks must test this route as well as shortcuts.

## Motion and reports

The profile advertises `LGE MR23` and vendor/product `000f:3412`. Its 202-byte HID
map has the original report IDs and declared lengths, including separate F9
input, feature, and output reports. The GATT service exposes only five of the
descriptor's eleven report declarations, in this captured order:

| Report ID | Type | Properties |
| --- | --- | --- |
| F9 | Input | Read, notify |
| F9 | Feature | Read, write, write without response |
| FD | Input | Read, write, notify |
| FE | Input | Read, notify |
| F9 | Output | Read, write, write without response |

The report references were cross-checked against the TV's cached GATT metadata
for the original MR23. Its PnP product version is zero. Input FD carries the observed 19-byte value;
the Bluetooth report ID is supplied by its GATT Report Reference.

| FD value offset | Encoding |
| --- | --- |
| 0 | Header field, sent as the observed value `c4`; its meaning remains unknown |
| 1 | Wrapping 8-bit counter, incremented for each motion report |
| 2 | Six battery/status bits and two mode bits: 1 pointing, 2 navigation |
| 3 | Header field, sent as the observed value `ff`; its meaning remains unverified |
| 4–9 | Three signed, big-endian gyroscope values |
| 10–15 | Three signed, big-endian accelerometer values |
| 16–17 | Big-endian LG key code, zero for release |
| 18 | Signed wheel movement |

Starting pointing activates motion mode. The TV can enable or disable that mode
with F9 output commands `01` and `02`. While the user has pointing enabled,
pitch or yaw above 300 LG gyro counts starts a motion stream after TV sleep. This
threshold follows the [MR20 driver's gesture detector](https://github.com/brainrom/lg-magic/blob/master/kernel/lg_magic_airmouse.c)
and only arms the TV's separate wake detector. Small sensor noise and roll alone
do not start the stream. Closing the input session prevents motion from waking it.
The original MR23 starts with a navigation report at sequence zero carrying
internal event `0x803e`, followed by motion at sequence one. Stop uses a
navigation report with event `0x803f` and the last motion sequence. Each new
pointing session and motion wake follows these events. A TV sleep command sends
one stop event even when no sensor sample is queued. User pause also sends the
stop event before completing queued key/button releases. Internal motion events
do not become held user keys.

Motion counters advance by one per transmitted motion report and wrap at 256.
Navigation and stop reports retain the last number. The counter regression
checks that a 20 ms delivery gap advances the next report by one, not two.
Receiver analysis corrected the earlier attribution of the signal warning to
sequence gaps: that warning counts arrivals over time, independently of these
sequence numbers.

[Sanitized original motion events](../test/fixtures/lg-mr23-motion-events.json)
retain event names, timestamps and sequence numbers from three MR23 recordings.
The inspection tool extracts these events only from connections it observed for
the requested peer. It also counts sequence gaps and repeated motion numbers;
these counts describe the capture and are not a measurement of RF signal strength.

Commands
`13`, `19`, and `90` receive the recorded F9 responses through a bounded queue;
`74` has no response in the recording. Other commands receive no fabricated
response. F9 responses can be delivered before the TV subscribes to FD.

The service keeps the newest real sample in each 10 ms sensor-time bucket and
paces those samples at 100 Hz, independently of the computer output-rate setting.
A bounded queue holds at most eight buckets; samples older than 75 ms expire.
Pause, disconnect, and generation changes clear the queue. It does not repeat
samples to fill a gap. Computer movement continues through its existing pointer
filter. LG conversion currently assumes 0.07 degrees/second per gyro count and
4096 acceleration counts per g. The measured mount rotation is
`LG [x, y, z] = Remote 3 [y, -x, z]` for both gyro and acceleration. Gyro bias
is removed in Remote 3's frame before rotation and signed saturation happens
after rotation. Pointer speed is adjusted in the TV settings. Air mouse's
computer speed setting does not scale LG gyro values: gyro and acceleration
must describe the same physical rotation for sensor fusion. Calibration removes
gyro bias. Generic smoothing
and deadband do not process the LG wire samples because the TV processes its
own motion reports.

### TV receiver timing and wake requirements

Static analysis used the TV's ARM `lginput2` executable, SHA-256
`c58d4f06179944944c475e47bd0b6d9f1be1a4e032d8dc6562642d2ffdbd870b`.
The executable remains outside the repository. These findings describe the stock
webOS 11.2.0 receiver; the v5 fix lowers its secondary-remote shake threshold
and selects the saved local calibration for that slot.

| Receiver function | Observed behavior |
| --- | --- |
| `_mrcu_state_isLowSignal` | Counts arrivals into ten one-second buckets. The branch exercised by this TV logs low counts at 800 or fewer and reports an unstable signal below 500. It does not use the FD sequence number for this check. |
| `mrcu_process` | Event `0x803e` initializes motion-event detection and marks motion start. It does not immediately force cursor visibility. |
| `event_wake_on_shake_init` | Starts with a 1,500-count gyro threshold and a 1,000 ms deadline. |
| `event_wake_on_shake` | Requires more than seven samples between qualifying yaw strokes and three alternating strokes for a flat gesture. Strong movement on other axes requires four strokes. |
| `event_wake_on_shake_count` | Counts alternating yaw signs above the threshold and changes the deadline to 800 ms from the detector's start. |
| `event_wake_on_shake_time_check` | Marks an unsuccessful wake when its deadline expires. The TV can then request sleep again. |

The 14:33 test logged motion-start and motion-stop events, repeated wake
failures, and `THRESHOLD_LOW_STRENGTH` values of 489–490. Sequence correction
alone did not address the arrival rate. The sensor's FIFO delivers several
samples together. Keeping only the latest sample in each arrival batch reduced
the LG stream to about 50 Hz and discarded samples needed by the wake detector.

A ten-second, 800 Hz sensor recording contained 8,021 samples in 530 arrival
batches. Replaying its arrival timestamps through the corrected runtime emitted
1,001 reports at 100 Hz, with 10 ms gaps and no stale or overflow drops. This is
a deterministic runtime replay, not a measurement of delivery over Bluetooth.
The regression also sends the same three-stroke gesture through the inspected
wake contract: it succeeds at 100 Hz and fails at 50 Hz. The contract is
implemented independently in [the receiver test helper](../test/support/lg-receiver.mjs).

Record arrivals and repeat the scheduler check with:

```sh
python3 tools/airmouse-lg-record-sensor --rate 800 --seconds 10 --output SENSOR.jsonl
node tools/airmouse-lg-replay-motion SENSOR.jsonl
```

The recorder temporarily stops the pointer service, preserves sensor settings,
and restarts the service afterward. The replay uses a simulated local output;
it sends no Bluetooth traffic. A TV retest must check gentle left-right wake,
pause/resume, keys, and a sustained pointer session longer than ten seconds.

### Hardware retest at 16:51–16:53 UTC

The September 8 retest recorded 10,191 FD reports across two Remote 3
connections. Sustained motion intervals averaged 98.97–100.64 Hz. Arrival timing
still varied: the longest measured gap within those intervals was 60.28 ms.
The TV logs contained no `THRESHOLD_LOW_STRENGTH` warning during the test,
and the user confirmed the signal warning did not appear.

Wake after an arrow still required a strong shake. Applying the inspected wake
detector to the recorded gyro reports predicted all four successful shake wakes
within approximately 20 ms of the TV's logged successes. Of the other 41 motion
starts, 25 never exceeded the initial 1,500-count yaw threshold. This validates
the receiver model against actual Bluetooth delivery; it does not establish a
way to lower the TV's gesture requirement over Bluetooth.

Home produced a different transition: the TV sent F9 `01` immediately after
Home and enabled the cursor. The TV also exposes an internal choice between
`motion` and `shake` wake policies, but no Bluetooth operation for selecting that
policy was identified. No TV setting was changed and no Home key is synthesized
by the pointer controls. The signal-rate fix was confirmed in this test. The later v5 update reduced the
shake threshold, and the user confirmed cursor recovery with a small shake.

### Simultaneous motion recording

On September 8, the user held Remote 3 and the original MR23 together for a
five-minute recording. The aligned movement interval at sensor seconds 80–100
gave gyro correlations `0.946, -0.869, 0.914` for source axes `y, x, z` and
acceleration correlations `0.937, -0.888, 0.965`. The fitted timestamp offset
was -0.85 seconds. The full recording includes intervals where the remotes were
not moving together, so it must not be fitted as one rigid motion interval.

`tools/airmouse-lg-record-sensor --seconds 300 --output SENSOR.jsonl` temporarily
stops the pointer service, records buffered sensor samples with wall timestamps,
restores sensor settings, and restarts the service if it was running. Run
`tools/airmouse-lg-record --seconds 300 --output TV.hci-monitor` alongside it.
Analyze an interval where both remotes moved together with:

```sh
python3 tools/airmouse-lg-align-motion --sensor SENSOR.jsonl --monitor TV.hci-monitor \
  --start-seconds 80 --duration-seconds 20
```

The alignment tool checks all signed axis rotations and clock offsets within
three seconds. It reports correlation and excitation checks, rather than
accepting weakly correlated movements as calibration.

The TV logs contain no process-crash report during the earlier pause test.
During the later key test, the TV entered sleep after Right and kept sending
sleep commands. Our reports lacked the motion-start and motion-stop events
visible in the original remote's recordings. The lifecycle regression now checks
Right, TV sleep, stop event, key release, and motion wake. The runtime-to-daemon
test checks the explicit events across user pause and resume.

`tools/airmouse-lg-inspect --monitor TV.hci-monitor --peer BLUETOOTH_ADDRESS
--motion-attribute 0x25 --command-attribute 0x2d` separates Remote 3 connections
and motion modes around the TV's sleep/wake commands without printing packet
payloads. Original MR23 attributes use the defaults `0x22` and `0x2c`.

Stale motion expires after 75 ms. Stop, disconnect, lease expiry, and queue
failure preserve the existing release-or-disconnect behavior. Pausing sends a
navigation-mode stop event and release with zero angular velocity.

## Validation

Run:

```sh
python3 tools/airmouse-bluetooth-build --arch host
AIRMOUSE_HID_BINARY=/path/to/built/airmouse-hid npm test
npm run test:native
```

The C tests compare an encoded Back report against captured MR23 bytes, check
control responses, parse all five GATT report references with BTstack, and exercise
subscription migration and profile switching. IPC tests send native motion,
clicks, Back, and Stop through the runtime into the daemon simulator. UI tests
cover the LG icon, native navigation, and LG pairing selection.

On the TV, check fresh registration, arrows, OK, Home, Back, volume, and wheel.
Then check pointer direction, drift, speed, rest/pickup, app closure/reopening,
and a switch to a computer and back. Repeat in both system menus and an app
after changing the profile or TV firmware.

## Record or inspect a session

`tools/airmouse-lg-record` passively records the TV's Linux HCI monitor over
SSH. It does not modify Bluetooth settings or inject input:

```sh
python3 tools/airmouse-lg-record --seconds 120 --output /tmp/magic.hci-monitor
python3 tools/airmouse-lg-inspect --monitor /tmp/magic.hci-monitor
python3 tools/airmouse-lg-inspect --host root@10.0.240.2
```

For a registration capture, run `tools/airmouse-lg-record-input --seconds 120
--output /tmp/magic-input.jsonl` at the same time. It passively reads only the
TV's `LGE RCU` input device without grabbing it. The JSONL contains decoded input
events and observation timestamps for comparison with Bluetooth traffic. It does
not record IR carrier frequency or pulse timings; those require an IR receiver.

The September 8, 2026 recording contains 7,444 monitor records over 120 seconds,
including 7,256 incoming FD notifications from the original MR23. The saved
HID map and the TV's motion parser establish the packet layout above. The
older driver treats the first two bytes as a counter; the TV parser and this
recording establish that the sequence is only the second byte.

Keep raw recordings outside the repository. They can include Bluetooth pairing
material and unrelated traffic. The inspection tool emits aggregate counts and
metadata rather than keys or raw payloads. Connection handles can be reused;
do not attribute a whole log to a device using only its numeric handle.
