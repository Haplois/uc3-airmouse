# LG MR23 receiver protocol reference

This reference describes the OLED77G3PSA receiver on webOS 11.2.0, using static
inspection and MR23 recordings. Coverage stops at what those sources establish;
command names alone do not specify payloads or support on other remote generations.

The [LG TV profile](lg-tv.md) documents implemented controls, the FD motion
layout, sensor units, registration IR, GATT reports, and hardware tests.
The [extracted receiver map](../test/fixtures/lg-receiver-protocol.json) retains
table entries, function addresses, and instruction checks without distributing
LG executables, Bluetooth keys, or factory calibration data.

Command examples use placeholder hostnames. Set `REMOTE3_ADDRESS` and
`ORIGINAL_REMOTE_ADDRESS` to your paired devices' Bluetooth addresses before
using the identity-scoped tools. Literal example addresses are synthetic.

## Evidence and reproduction

The inspected `lginput2` SHA-256 is
`c58d4f06179944944c475e47bd0b6d9f1be1a4e032d8dc6562642d2ffdbd870b`.
Addresses below are ELF virtual addresses before relocation. Function addresses
omit the ARM Thumb bit.

[`tools/airmouse-lg-firmware-map`](../tools/airmouse-lg-firmware-map) extracts all
31 entries of the command-name table, all 27 response-handler entries, and all
nine UEI command-name entries. Duplicate entries are retained. There are 27
distinct named command IDs and 26 distinct response IDs. The tool also checks
reviewed instructions for framing and both the selection and failure of the
second remote slot. It reads a local binary and sends no device commands.

Use a Python environment with `pyelftools` and `capstone` installed:

```sh
python tools/airmouse-lg-firmware-map /private/path/lginput2 \
    --check test/fixtures/lg-receiver-protocol.json
```

An unknown executable hash or a changed saved map fails the check. Extracting
the map requires no new remote recording. The saved map is evidence about this
receiver, not an assertion that Air mouse implements every listed command.

## Transport boundaries

The MR23 uses Bluetooth LE HID. GATT Report References identify reports, so
the ATT characteristic value does **not** start with the HID report ID. The
TV's hidraw representation **does** include that byte. For example, the TV
writer produces `f9 01`, while the characteristic write contains only `01`.
Motion appears as `fd` plus 19 bytes in hidraw, and as 19 bytes over ATT.

`lginput_uhid_sendData` constructs F9 output reports. With no payload it writes
two hidraw bytes, report ID and command. `lginput_uhid_parser_respond` dispatches
using hidraw offset 1, which is characteristic-value offset 0. The response ID
can differ from the request, as with `13` requesting a `14` reply.

The receiver contains separate parsers for FD BLE motion, FE BLE voice, FA
older motion, F7 older voice, and FC simple-remote input. The MR23 descriptor
declares additional reports, but its captured GATT service exposes only the
five report characteristics listed in the profile. Descriptor presence alone
does not establish an available transport or a supported feature.

TV device-manager commands and Luna service calls are another layer. Their
numeric IDs are not Bluetooth command IDs. In particular, the internal
`cursor/setWakeUpCondition` command `0x6a` is unrelated to F9 `0x6a`, whose
receiver-table name is `stopRepeatingIR`. Sending that Bluetooth command cannot
select the TV's wake policy.

## F9 command families

The names in this table come from `_lginput2_cmd_nameTable`, except where an
entry explicitly cites observed behavior or only a response handler. Request
and response roles need separate confirmation for commands not yet exercised.

| ID | Receiver name or evidence | Air mouse coverage |
| --- | --- | --- |
| `01` | `activeMotion` | Starts a motion session |
| `02` | Sleep observed in captures and receiver state transitions | Stops the motion session |
| `11`, `12` | `readFWVer`; response handler accepts `12` | Older version format, unimplemented |
| `13`, `14` | `readFWVer`; response handler accepts `14` | Captured `13` request and `14` response implemented |
| `17` | `getScdInfo` | Transfer framing decoded below; response unimplemented |
| `19` | `getMRCUInfo` | Captured response implemented; field coverage incomplete |
| `40`, `41` | `unplugMRCU`, `unplugPMCU` | Unimplemented |
| `50`, `51` | Response handlers for UEI set-data and extracted-data operations | Older variants, unimplemented |
| `61` | `transferZipIr` | Unimplemented |
| `62` | `saveCodeSet` | Unimplemented |
| `64` | `eraseCodeSet` | Unimplemented |
| `65` | `sendIrCode` | Unimplemented |
| `66` | `getCodeSet` | Unimplemented |
| `67`, `68` | `setStbPwrIr`, `getStbPwrIr` | Unimplemented |
| `69` | `resetPrimaryCodeset` | Unimplemented |
| `6a` | `stopRepeatingIR` | Unimplemented |
| `6b` | `resetIRTimer` | Unimplemented |
| `6c`, `6d` | `setSTBPwrEmergencyIR`, `getSTBPwrEmergencyIR` | Unimplemented |
| `6e` | `checkBlasgerBatteryLevel`, spelling as stored | Unimplemented |
| `6f` | QRP read-back response handler | Stub receiver handler; unimplemented |
| `71` | `sendWritingNFC` | Unimplemented |
| `73`, `74` | `setStbPwrControl`, `getStbPwrControl` | `74` observed, no response implemented |
| `90` | `getLiquidDetect` | Captured three-byte response implemented |
| `93` | `otaStandby` | Unimplemented |

`_uhid_packetizeData` adds a fragment flag for commands `50`, `61`, and `62`.
Other commands use the report ID and command followed by their payload. Those
UEI transfer formats and their completion semantics remain unimplemented.
The command-name table includes both request and response entries and omits
some observed commands, including `02`. It is not an exhaustive wire opcode
registry.

The current fixed version reply is
`14 16 68 04 08 26 30 01 40 03 60 11`. The information reply starts
`19 34 23` and pads the remaining nine bytes with `ff`. Liquid status is
`90 00 00`. These are compatibility responses from the original recording,
not descriptions of Remote 3's actual firmware or hardware. Unknown commands
receive no invented success response.

## Calibration transfer

`lginput_uhid_parser_getSCDdata` at `0x6159c` dispatches received calibration
fragments to `lginput_motion_set_scd` at `0x57d64`. Offsets here refer to the
F9 characteristic value, excluding the report ID:

| Offset | Meaning established by receiver and existing registration capture |
| --- | --- |
| 0 | Response ID `17` |
| 1 | Continuation indicator; nonzero accumulates, zero completes |
| 2 | Number of data bytes in this fragment |
| 3 | Skipped byte; meaning unconfirmed |
| 4 onward | Calibration fragment data, limited by byte 2 |

The original registration has two 154-byte characteristic values. Their first
four bytes are `17 01 96 00` and `17 00 6e 00`. The meaningful data lengths are
150 and 110 bytes, giving a 260-byte assembled calibration block. Remaining
bytes in a characteristic value are not additional calibration data. On the
terminal fragment, the receiver creates the motion device using the assembled
calibration.

This establishes transport framing, not the meaning of all 260 calibration
bytes. The TV passes sensor configuration into its MotionEngine libraries.
Remote 3 needs calibration and sensor characteristics that describe its own
hardware. Replaying the MR23's factory values would not establish correct sensor
fusion. The lab TV already had a valid 260-byte, address-specific DCD cache for
Remote 3. The v5 receiver uses that local cache for the secondary slot instead
of requesting a transfer that Remote 3 does not implement. Current success does
not prove registration on a TV with no cached calibration. Fresh-TV calibration
remains the largest compatibility gap in the implemented motion profile.

## Voice

`interpret_ble_voice_packet` at `0x4e8a4` handles FE and expects a 120-byte
audio portion. `lginput_devmngr_process` separates a four-byte report header
before calling it. The parser reads a sequence byte and a big-endian key field,
initializes `RS_init_sbc`, and sends the audio portion through
`RS_deal_voice_stream_data`. It adds `aa bb` to the decoded internal audio
buffer. Those bytes are a TV-side marker, not a remote-transmitted prefix.

The exact relationship between this internal header and the GATT-declared
124-byte FE value needs a voice sample or a complete upstream framing trace.
Voice session negotiation, SBC parameters, microphone behavior, and error
recovery are not established. Air mouse sends no FE audio reports.

## Motion state and wake

The complete implemented FD value layout and axis transform are in
[the profile](lg-tv.md#motion-and-reports). Key points confirmed from the
receiver are a separate eight-bit motion sequence, big-endian signed sensor
axes, the two mode bits, and a signed wheel byte. Header bytes 0 and 3 still
lack confirmed semantic names.

Native key events `803e` and `803f` mark motion start and stop. Starting motion
arms the receiver's gesture detector. It does not force cursor visibility.
After navigation, the TV's shake policy requires alternating strokes above
its thresholds. Home takes a separate UI transition that can activate motion.
These are TV state transitions, not evidence of a missing Bluetooth pairing
handshake.

The signal warning counts report arrivals over ten seconds. The deployed
100 Hz stream resolved the warning in the September 8 hardware test. No Bluetooth
command that changes the wake policy has been identified.

### Gentle shake after navigation

The stock `event_wake_on_shake` detector requires yaw above 1500 gyro counts,
about 105 degrees per second. It counts three alternating strokes, or four when
the gesture includes large off-axis movement. At least eight samples separate
counted strokes. The first stroke must arrive within one second; the subsequent
gesture window is 800 ms. Remote 3 already starts its real motion stream above
300 gyro counts, so starting that stream does not satisfy the TV's higher threshold.

The normal `cursor/setWakeUpCondition` API accepts `{"condition":"motion"}` or
`{"condition":"shake"}`, but rejected both with `Magic Remote is not Ready` while
the primary remote was asleep. Those calls left the global activity flags unchanged.
The commercial cursor-visibility API also selects the primary device explicitly.

The v5 receiver changes only the threshold loaded by the shake detector for slot 1
with dual pairing enabled. It uses 375 counts, about 26 degrees per second. All
other slots and single-remote mode retain the original threshold. Stroke counting,
timeouts, motion reports, and cursor gain remain unchanged. The v5 calibration
route change is described in [Second-slot report dispatch failure](#second-slot-report-dispatch-failure).
The detector context's `+0x54` field carries the slot ID; this was checked on the
running receiver. A branch at `0x59876` loads the conditional threshold through
the stub at `0xb9640`, then returns to the original comparison at `0x5987a`.

[`airmouse-lg-check-shake`](../tools/airmouse-lg-check-shake) executes the actual
ARM detector, initializer, stroke counter, and timeout instructions offline.
Only the clock helper is simulated. At 100 Hz, alternating 400-count strokes fail
on stock firmware and wake after 240 ms on v5. Eight gestures across five slots
and both dual-mode settings cover 80 cases. Quiet input, the exact threshold,
one-way movement, one reversal, and roll-only motion do not wake the cursor.
The 510 slot, dispatcher, and calibration-initialization cases also pass.
These checks send no synthetic sensor data to the TV. The user confirmed that
the gentle-shake fix works after deployment.

To upgrade an existing persistent v4 installation while the TV is already on:

```sh
python tools/airmouse-lg-build-receiver /private/path/lginput2 /private/path/lginput2-v5
python tools/airmouse-lg-upgrade-receiver --host root@lg-tv.example \
    --remote-host root@remote3.example --binary /private/path/lginput2-v5
```

The upgrader saves the prior receiver and startup helper, arms a two-minute
rollback timer, and disconnects Remote 3 during the receiver restart. It restores
dual mode before allowing Remote 3 to reconnect. Acceptance requires a stable
receiver, active dependent services, and unchanged calibration hashes. The
upgrade preserves the TV's power state and persists through the existing startup
hook. Backups remain private on the TV under `airmouse-lg-receiver/upgrade-v5`.

The September 11 v5 deployment passed these checks with dual mode enabled.
Remote 3 reconnected with the LG profile ready. The SCD and DCD hashes matched
their pre-upgrade values. Seven upgrade tests cover checksum refusal, rollback
ordering, recovery after failed startup, calibration verification, and protection
against a late rollback timer after acceptance.

### Motion rate

The loaded calibration on the lab TV declares a period of 9.615385 ms, about
104 Hz. The current Remote 3 stream sends 100 Hz. In MotionEngine core 3.7.1,
`fme_scdGetPeriod` reads the float period at offset 8 of the validated calibration
record and converts seconds to integer microseconds. The receiver copies motion
sequence numbers into the engine input, but does not pass Remote 3's sensor
timestamps. A higher arrival rate therefore cannot be assumed to change the
engine's configured sample period correctly.

[`airmouse-lg-check-motion-rate`](../tools/airmouse-lg-check-motion-rate) checks
the receiver checksum and reads only the 12-byte calibration header and period
from the running process. It reports the last loaded calibration, not measured
Bluetooth delivery. It does not wake the TV or modify process memory.

```sh
python3 tools/airmouse-lg-check-motion-rate --host root@lg-tv.example
```

Before the connection timing fix, Remote 3 reported a 20 ms Bluetooth connection
interval despite requesting 7.5 ms. Multiple motion reports can arrive in one
connection event. Increasing the report rate alone does not shorten that interval.
Rates such as 125 or 200 Hz have not been validated with this calibration or
receiver. The working 100 Hz setting remains deployed.

### Bluetooth connection timing

The September 9 connection trace showed the TV initially connecting at 10 ms with
peripheral latency 4, then selecting 20 ms with latency 2 and a 3-second supervision
timeout. It rejected Remote 3's 7.5 ms L2CAP request. A delayed 10 ms L2CAP request
and a Remote 3 controller-level request also failed to reduce the interval.
A TV-side standard LE Connection Update succeeded at 10 ms with latency 0.

[`lg_link.py`](../tools/lib/lg_link.py) applies that update to the configured
Remote 3 connection. It observes successful connection events, matches the peer's
Bluetooth address, waits three seconds for the TV's default policy to settle,
and requests 10 ms with latency 0. It preserves the supervision timeout and stops
after acknowledgment or three attempts. Disconnect, controller reset, and handle
reuse clear the tracked identity. The original LG remote is not selected.
The HCI command and socket formats follow the
[BlueZ HCI definitions](https://github.com/bluez/bluez/blob/master/lib/bluetooth/hci.h).

The helper reads HCI event packets and Remote 3's hidraw reports. It uses the
reports only to detect activity and does not log or save their payloads or keys.
If it starts after Remote 3 has already connected, it retains that connection
and waits for the next connection event to discover timing. It does not refresh
the connection during standby or a power transition. If raw reports arrive while the receiver has no
matching slot-1 hidraw attachment, it waits two seconds and refreshes only Remote
3. This repairs the connection order where Remote 3 attaches first and the
original remote attaches later. It never guesses or persists connection handles. It runs as
`airmouse-lg-link.service` through the existing receiver startup hook.

Attachment repair waits for the matching disconnect-complete event before
reconnection. Recovery uses `gatt/connect`, which restores HID on the paired
Remote 3. Failed requests retry with a delay that increases from 5 to at most
60 seconds and print an error. Periodic checks consult the TV's profile state
even when the helper holds an old connection handle.

On September 13, the previous startup refresh removed the background connection
registration. Its fixed one-second delay requested reconnection before the TV
finished disconnecting. The TV rejected that request, and subsequent HID-only
requests failed. A GATT request restored the connection without re-pairing.
The updated helper passed TV and Remote 3 reboot checks, recovering in 56 and
49 seconds respectively, with both pairings and the installed helper intact.
These checks verify connectivity, not physical key presses or cursor motion.

Use [`airmouse-lg-check-reconnect`](../tools/airmouse-lg-check-reconnect) to
repeat either reboot check without sending a manual reconnect command:

```sh
python3 tools/airmouse-lg-check-reconnect --tv root@lg-tv.example --remote root@remote3.example --reboot tv
python3 tools/airmouse-lg-check-reconnect --tv root@lg-tv.example --remote root@remote3.example --reboot remote
```

The checker accepts a reset uptime because this TV retains its boot ID after
restart. It checks the selected Bluetooth target independently of the app's
UI-control connection, since the app is closed after a Remote 3 reboot.

```sh
python3 tools/airmouse-lg-install-link --host root@lg-tv.example
python3 tools/airmouse-lg-check-link --tv root@lg-tv.example \
    --remote root@remote3.example --address 02:00:00:00:00:02 --reconnect
```

The installation retained the receiver process. The fresh-connection hardware
check observed `10 ms / latency 4 → 20 ms / latency 2 → 10 ms / latency 0` and
confirmed that the final setting remained at the end of the 30-second observation.
Remote 3 independently reported 10 ms. Motion report rate, calibration, and the
receiver executable are unchanged. This measures connection timing, not total
motion-to-display latency. Fourteen policy tests cover the observed sequence,
other remotes, handle reuse, disconnect/reset, bounded retries, malformed events,
discovery of an already connected peer, startup during standby, and a missing
receiver attachment. Two startup
tests check helper activation without a receiver restart and isolation of helper
startup failure. The TV was returned to `Active Standby` after testing.

Disable the helper and restore default timing on the next connection with:

```sh
python3 tools/airmouse-lg-install-link --host root@lg-tv.example --disable
```

## Dual pairing verification and failed hardware test

The running TV advertises `enableDualPairing` through Luna introspection.
An ordinary root SSH call with `{"enable":true}` returned
`{"returnValue":true}`. No service permissions were changed. The static
permission file omitted this method, so that file alone was not an accurate
list of available methods.

The implementation has two conflicting paths:

1. The method handler at `0x21230` calls
   `interface_mrcu_enableDualPairing`, which dispatches internal command 8.
   The device manager stores the mode. The interface returns success without
   proving that two input devices can operate.
2. `xpa_wbs_isSupportedRemocon` selects slot 1 when dual mode is enabled.
   `xpa_wbs_pairMotionRemocon` looks up that selected slot during registration.
3. For the BLE remote family exercised by MR23,
   `_uhid_check_mrcu_dev_index` requires slot 0. A nonzero slot enters its
   `DB Error Case` branch at `0x63074`, writes the device into slot 0, and
   continues using the primary slot.

During the test, the user reported that Remote 3 worked while the successfully
paired original MR23 did not respond to arrows or other physical keys. TV logs
at `17:14:52.856258Z` show the original MR23 entering `DB Error Case`, followed
by lookups finding it in slots 0 and 1. At `17:15:27.145026Z`, Remote 3 enters
the same repair path and then appears in slot 0. Bluetooth status retained
both bonds, and the original had GATT and HID connections. That did not make
both remotes usable.

The dual-pairing flag was restored to false through the same API, which
returned success. This does not erase either Bluetooth bond or automatically
repair input ownership left by the test. No firmware or pairing database was
patched. Reliable MR23 coexistence is not supported by the tested path.
Copying the original remote's Bluetooth identity would not fix this receiver
slot conflict.

### Newer remotes and a TV-side repair candidate

LG's [MR25GA compatibility list](https://www.lg.com/es/accesorios/tvs/mandos-a-distancia/mr25ga/)
includes G3-series TVs. This is a regional product compatibility statement,
not evidence that two Magic Remotes work simultaneously. LG also sells the
[MR26GA](https://www.lg.com/us/tv-home-theater-accessories/lg-mr26ga-magic-remote),
whose US compatibility list names 2026 TVs. It does not establish G3 support.

The inspected receiver's BLE family table explicitly includes MR24, MR24N,
MR25GA, MR25GB, MR25JP, and MR25LA. MR26GA is not an explicit table entry.
The firmware map now extracts all names in that table so this distinction
can be checked again after a firmware update.

[`tools/airmouse-lg-check-slots`](../tools/airmouse-lg-check-slots) executes the
unmodified ARM slot handler and its two remote-family classifiers in Unicorn.
Database operations, string helpers, calibration restoration, and logging use
local substitutes. All peer addresses are synthetic. It sends no packets and
does not run or modify a process on the TV.

The test starts with a known device in slot 0 and a different paired device
in slot 1. Its failure condition is a write over the original device or loss
of the second slot. Each candidate also runs in slot 0 as a control.

| Candidate Bluetooth name | Stock second-slot result | Interpretation |
| --- | --- | --- |
| `LGE MR23` | Rewrites slot 0 | Reproduces the observed receiver conflict |
| `LGE MR24`, `LGE MR24N` | Rewrites slot 0 | A newer profile does not avoid it |
| `LGE MR25GA`, `LGE MR25GB`, `LGE MR25JP`, `LGE MR25LA` | Rewrites slot 0 | All tested 2025 profiles take the same path |
| `LGE MR26GA` | Rewrites slot 0 | Even this name reaches the same family path; discovery and hardware compatibility remain unverified |
| `LGE SP16` | Keeps slot 1 | Older accessory-family control; this does not prove compatibility with MR23 reports or full TV controls |

The [stock results](../test/fixtures/lg-receiver-slots.json) contain all 18
cases. With `pyelftools` and `unicorn` installed, this command deliberately
exits with status 1 because the newer remotes lose their second slot:

```sh
python tools/airmouse-lg-check-slots /private/path/lginput2 \
    --check test/fixtures/lg-receiver-slots.json --require-dual
```

A local policy experiment retains a known paired slot 1 when dual mode is
enabled and continues through the receiver's existing common device lookup.
The experiment changes emulator control flow at that decision only. It does
not generate a patched executable. All nine candidates retain their second
slot and preserve the primary device. The nine primary-slot controls pass,
and disabling dual mode produces the stock result for every candidate.

```sh
python tools/airmouse-lg-check-slots /private/path/lginput2 \
    --policy preserve-secondary --require-dual \
    --check test/fixtures/lg-receiver-slots-prototype.json
```

The [prototype results](../test/fixtures/lg-receiver-slots-prototype.json)
validate this one decision, not a complete TV-side fix. The harness does not
model persistent database reloads, discovery, calibration, key dispatch,
Bluetooth connections, or motion processing. The policy applies only to a
known paired device in the existing second slot. Handling an unknown device
must retain the original validation and registration flow.

There is useful receiver infrastructure beyond that decision. `mrcu_add`
allocates state per device, creates button and receiver state, and stores the
input handle selected by slot. The live TV lists both `LGE M-RCU - Builtin [0]`
and `LGE M-RCU - Builtin [1]`. The button and motion callbacks look up their
device context using a supplied device ID. These observations support a
focused TV-side repair, although shared cursor and activity state still need
testing.

There is also shared cleanup to account for. `mrcu_remove` clears
`_gSensorEventData`, `_gEventDataCount`, and sensor parameter fields in
`_gstSensorParamSetting`. A second remote disconnecting must not invalidate
subscriptions or state still used by the first. The experimental build below
does not change this cleanup. Disconnect behavior remains unverified.

A complete repair must preserve the two database entries and parser handles
through either connection order and a service restart. The v5 checks cover the
modified slot paths, and the hardware check covers Remote 3 after a reconnect.
Longer independent use while either remote sleeps or disconnects still needs a
physical test.

### Temporary receiver deployment

[`airmouse-lg-build-receiver`](../tools/airmouse-lg-build-receiver) builds an
experimental executable from the exact reviewed firmware. Conditional Thumb
stubs use unused executable-segment alignment padding. They retain slot 1, route
its FD reports, initialize its motion state, lower its shake threshold, and select
its local calibration cache only when dual mode is enabled. Other cases follow
the original handlers. No Bluetooth address, key, authentication, or service
permission changes are involved.

The builder executes the actual patched slot instructions against 120 cases covering
ten device names, six database indices, and both switch states. The stock
dual-slot check fails, while the patched build preserves the second slot. The
other cases match stock behavior. The dispatcher repair described below adds
180 cases across five slots, nine report IDs, both dual-switch states, and both
primary report-block states. Database helpers remain simulated, so these
checks do not establish working keys, motion, or reconnection on hardware. The
motion initialization check covers 210 cases, the shake check covers 80, and the
calibration-route check covers 20. The full build covers 610 cases.

```sh
python tools/airmouse-lg-build-receiver /private/path/lginput2 \
    /private/path/lginput2-v5
python tools/airmouse-lg-deploy-receiver --host root@lg-tv.example \
    --binary /private/path/lginput2-v5 --remote3-address "$REMOTE3_ADDRESS"
```

The build requires `pyelftools`, `keystone-engine`, and `unicorn`. Neither the
original nor patched proprietary executable belongs in the repository.

The deployed SHA-256 is
`e0d7097ef21fe83af854633307f82f169d5b9e653887de40bdc8004ea88420e3`.
Deployment bind-mounts the temporary file over `/usr/sbin/lginput2` for the current
boot and restarts the existing service. A two-minute rollback timer protects
startup. It is cancelled only after the running executable hash, service API,
and stable process ID pass the health checks. The original firmware remains
under the mount. Upgrades stop the receiver before unmounting the previous
build, because a running executable can keep the mount busy. A full reboot
removes the mount. Pairing changes made during
testing are persistent and are not undone by removing the mount.

On September 8, the patched service started and passed these checks. The first
attempt to execute it directly from `/tmp` failed webOS service registration and
was rolled back. The corrected deployment retains the normal executable path
and existing service permissions.

The initial pre-deployment pairing state had only `mrcu2.info`, containing the original
remote, and no primary `mrcu1.info`. The service reported its primary remote as
unpaired. The setup required a pairing reset and registration of the original
remote in the primary slot. After that registration, enable the second slot:

```sh
python tools/airmouse-lg-deploy-receiver --host root@lg-tv.example --enable-dual
```

Then use **Pair LG TV** on Remote 3 and test keys and pointer on each remote.
Check that each still works after the other pauses, sleeps, and reconnects.
On September 8, the user confirmed that both remotes worked correctly with v3.

Roll back without rebooting:

```sh
python tools/airmouse-lg-deploy-receiver --host root@lg-tv.example --rollback
```

The deployment keeps a private copy of the pre-deployment receiver state under
`/tmp/airmouse-lg-receiver-v5/paired-state-before`. Rollback does not replace the
live pairing database with that copy. The deployer refuses to overwrite an
existing trial directory or mount. A service restart also resets the in-memory
dual switch. The optional startup installation below restores it automatically.

Keep Remote 3 disconnected while restarting this receiver. The dual switch is
off during startup, before the deployment tool can restore it. An early
secondary reconnect can enter the stock database repair path. The deployer
rejects an active Remote 3 connection for this reason. After an unsuccessful
upgrade, the original slot records were restored from the private backup. The
TV subsequently had no Remote 3 Bluetooth bond, so another **Pair LG TV** attempt
was required. The original LG remote's bond remained saved.

### Persistent receiver startup

The optional TV key handler also implements Remote 3 input cycling. Its custom
FD key values are `0x7f01` for the next input and `0x7f02` for the previous input;
these are project extensions, not LG remote commands. The handler matches only
the configured Remote 3 Bluetooth address. It queries `com.webos.service.eim`
for connected inputs and the current input, then launches the selected HDMI app
through `com.webos.service.applicationmanager`. Each physical press selects one
connected HDMI port in numerical order and wraps at the end. No IR is sent.

[`airmouse-lg-persist-receiver`](../tools/airmouse-lg-persist-receiver) saves the
working v5 executable under `/var/lib/webosbrew/airmouse-lg-receiver` and adds
`/var/lib/webosbrew/init.d/10-airmouse-lg-receiver`. It requires the TV's existing
webOSbrew startup installation and a healthy v5 receiver. It does not modify
system firmware, pairing records, or calibration files.

```sh
python3 tools/airmouse-lg-persist-receiver --host root@lg-tv.example
```

The hook recreates two runtime systemd drop-ins. The receiver's pre-start step
checks the exact stock firmware checksum before mounting the saved executable.
Its post-start step enables dual pairing through the existing service API.
Bluetooth input handling starts after that step and follows receiver restarts.
At boot, the hook stops both services before activating the replacement. If
activation fails, it removes its drop-ins and mount, disables itself, and starts
the original services. An unknown firmware checksum leaves the existing
receiver untouched.

The September 8 installation retained receiver PID 5711 and Bluetooth input
manager PID 4016. The saved executable matched the running v3 checksum, both
calibration file hashes were unchanged, and systemd loaded the intended ordering.
Five local tests cover startup ordering, installation without a restart,
changed firmware, failure recovery, and a disabled hook.

A full reboot remains untested. The hook runs when webOSbrew reaches its user
startup hooks; it cannot control Bluetooth connections made before then. Verify
both remotes after the first full reboot. Startup output is saved in
`/var/lib/webosbrew/airmouse-lg-receiver/startup.log`.

Disable restoration on future boots without interrupting the current receiver:

```sh
python3 tools/airmouse-lg-persist-receiver --host root@lg-tv.example --disable
```

For an immediate rollback, run `/usr/bin/python3
/var/lib/webosbrew/airmouse-lg-receiver/startup.py rollback` on the TV. This stops
both input services, removes the runtime changes, starts the original receiver,
and disables the hook. It leaves pairing records and calibration files intact.

### Second-slot report dispatch failure

After the slot repair and clean pairing, the original LG remote worked while
Remote 3's keys and pointer both failed. Both Bluetooth links were connected.
The live receiver had distinct device records with IDs and handles 0 and 1.
Remote 3's FD reports reached its `hidraw` device, but an automated Up/Down
sequence produced no corresponding Linux key events.

The report dispatcher at `0x65aa4` accepts motion/key reports for slots 0, 2,
and 3. At `0x65b0c`, it excludes slot 1 before calling
`lginput_uhid_parser_processMotion`. Saving two pairing slots alone cannot
change that decision.

The second build conditionally routes slot 1 FD reports through the primary
report-block checks and then the existing motion/key handler. It requires dual
mode, preserves the slot ID, and leaves other report types and slots unchanged.
The actual-instruction check failed on the first build and passes on the second:

```sh
python tools/airmouse-lg-check-dispatcher /private/path/lginput2-dual-v2 \
    --require-secondary
```

[`airmouse-lg-check-key-route`](../tools/airmouse-lg-check-key-route) provides the
hardware check. It briefly stops the Remote 3 runtime, sends four Bluetooth
Up/Down commands through the deployed `HidOutput`, and watches the TV's input
devices and Remote 3's raw HID reports. It restarts the runtime afterward.
The test changes the TV's focused selection if the keys work. Concurrent use of
the original remote can add extra events, so keep it idle during the check.

```sh
python tools/airmouse-lg-check-key-route --tv root@lg-tv.example \
    --remote root@remote3.example --remote3-address "$REMOTE3_ADDRESS"
```

After pairing again, the second build produced all four key presses and releases
from slot 1. Motion still failed because secondary-slot initialization skipped
the SCD version parser. The third build allows the secondary MR23 through that
parser when dual mode is enabled. Its initialization check covers 210 cases,
bringing the three instruction checks to 510 cases.

On hardware, the third build initialized the secondary motion engine with SCD
version 21.2 and emitted motion events. The user subsequently confirmed that
both remotes worked correctly. Artificial motion used during diagnosis does
not establish calibration quality; that result comes from the user's test.

The fifth build fixes a later regression where keys reached slot 1 but the
MotionEngine handle stayed disabled. `fme_scdIsDataValid` rejected the advertised
remote-transfer descriptor before any motion device was created. The TV already
held a valid address-specific DCD cache for Remote 3, so v5 routes only slot 1 in
dual mode through the receiver's existing local-cache path. The
[`airmouse-lg-check-scd-route`](../tools/airmouse-lg-check-scd-route) test proves
that the other slots and single-remote mode retain their stock routes.

After deployment and a full Remote 3 reboot, the hardware check received every
Up/Down press and release on `LGE M-RCU - Builtin [1]`. It also received 96
motion events with changing X and Y coordinates. The receiver's position-send
counter increased from 172 to 343. A later TV reboot reproduced a lost slot-1
attachment when the original remote connected after Remote 3. Refreshing only
Remote 3 restored 92 changing motion events and every key edge. The link helper
now correlates Remote 3's raw reports with events from `LGE M-RCU - Builtin [1]`
and performs that bounded refresh only when the receiver produces no input. The
TV can leave the `hidraw` field blank while input is healthy, so that database
field is not used as the sole attachment signal.

A subsequent cold-TV test exposed an earlier startup race: Remote 3 could attach
to the stock receiver before the webOSbrew hook mounted v5, causing the stock
repair path to copy Remote 3 into both persisted slots. The startup helper now
keeps checksum-verified copies of both slot records and SCD files under
`/var/lib/webosbrew/airmouse-lg-receiver/slots`. On cold startup it stops the
receiver and Bluetooth input manager, restores those records when their embedded
addresses do not match, then starts v5 and enables dual mode before Bluetooth
input handling. The runtime link helper also refuses reconnect and refresh calls
while those identities are invalid.

[`tools/airmouse-lg-check-reboot-recovery`](../tools/airmouse-lg-check-reboot-recovery)
reboots the TV, validates the protected records and running receiver, waits for
Remote 3's HID profile, and runs the key-and-motion hardware check. On September
11 it observed the expected first-activity attachment refresh, then received all
four Up/Down edges and changing slot-1 cursor coordinates without restarting
Remote 3. The original remote remains paired in slot 0, whose receiver paths are
unchanged by v5. The user previously confirmed that both remotes' navigation,
pointer, and OK input worked. A separate Netflix and YouTube launch failure was
traced to pending webOS app updates, not remote input; both apps worked after the
TV's supported installer completed those updates.

### Clear the lab remote pairings

[`airmouse-lg-clear-pairings`](../tools/airmouse-lg-clear-pairings) removes the
original MR23 and Remote 3 Bluetooth bonds from the reviewed TV. It stops the
receiver, moves both `mrcu1` and `mrcu2` registration and SCD files into a private
temporary backup, then restarts the receiver with dual mode off. Other Bluetooth
bonds and the shared calibration archive remain intact.

```sh
python tools/airmouse-lg-clear-pairings --host root@lg-tv.example \
    --original-address "$ORIGINAL_REMOTE_ADDRESS" --remote3-address "$REMOTE3_ADDRESS"
```

During diagnosis, this reset cleared both registration slots and their TV-side
Bluetooth bonds while preserving other paired devices. Remote 3 had no TV entry
at that point. Both remotes were subsequently paired and confirmed working.
After running the reset again, register the original remote before enabling the
second slot. The physical LG remote can retain its own bond until reset using
its buttons.

## Remaining coverage

| Area | Evidence available | Still needed |
| --- | --- | --- |
| Registration | IR trigger, advertisement, five GATT reports, successful lab registration | Fresh-TV behavior without cached SCD |
| Motion and keys | Wire layout, physical units, native events, 100 Hz delivery, 80 actual-instruction shake cases | Meanings of two header bytes |
| Calibration | Fragment framing and completion | Full calibration schema and valid Remote 3 calibration |
| Information | Version, remote-info and liquid-status handler families | Complete field semantics and truthful Remote 3 capability replies |
| Universal IR and NFC | All entries in the inspected dispatch tables | Payload layouts, device support and completion behavior |
| Voice | FE receiver path and SBC decoding entry points | Negotiation, complete header layout and codec parameters |
| Firmware update | Receiver contains update-related functionality | Remote firmware behavior and update specification; no update implementation |
| Two remotes | User confirmed both working on v5; 610 instruction cases pass; a cold-TV test restored protected slot identities, automatically refreshed a missing attachment, and passed keys and cursor motion | Longer sleep/reconnect coverage |

The offline checks cover the inspected receiver. They do not establish remote
firmware behavior or implement the remaining command families.
