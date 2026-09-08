# Design progress on 2026-09-07

This record covers the original design and the first firmware-backed
implementation. It describes controls and features later replaced by the [native
app](../../README.md). See the [verification history](../verification.md) for
measurements and the [operations guide](../operations.md) for current commands.

## First implementation

The Node.js service and six native entities were installed after the design
phase. Native rate changes, timestamped diagnostic capture, and systemd crash
restoration passed. Firmware 2.10.2 rejected the proposed ±500°/s gyro range, so
the user approved ±2000°/s.

The installed sensor profile used the FIFO at the user-selected 800 Hz. Earlier
400 Hz diagnostics measured about 401 scans/second with lower sample age than
800 Hz. Up toggled pointing, OK clicked left, and Right clicked right on the
controls screen. The Bluetooth interval was confirmed at 7.5 ms, and the user
reported no skips. Tuning was 1800 counts/radian with a 100 Hz movement limit.

The UI supported output limits up to 1,000 Hz and a timed measurement of
completed Core movement batches. The Core adapter did not achieve the requested
roughly 1 kHz Bluetooth output or independent mouse press and release. See the
[firmware protocol findings](mouse-button-protocol.md). Host input testing
remained manual.

## Completed design work

- [x] Inspect the hardware, Bluetooth service, and native UI interfaces.
- [x] Sketch two designs and compare them through an independent review.
- [x] Record proposed behavior and user preferences. The user accepted a hardware service and deferred LG investigation.
- [x] Add and run a repeatable capability probe.
- [x] Review the proposal against device evidence and revise unsupported assumptions.

The capability probe passed on firmware 2.10.2. Python syntax and SSH
destination validation checks passed. During this design phase, no runtime was
deployed, Web Config UI accessed, Bluetooth commands sent, or remote
configuration changed.

## Original sensor and UI proposals

The original configuration and design requested 400 Hz for both sensors and a
±500°/s gyro range while active. Inactive mode would restore the pre-activation
settings. Runtime application, rollback, crash recovery, and power measurements
were still pending.

The proposed Pointer sampling rate selector used one persisted rate for both
sensors, defaulting to 400 Hz. Choices were 50, 100, 200, 400, and 800 Hz,
filtered by device support. Inactive changes would save configuration without
sensor writes. Active changes would pause and reset motion while preserving the
restoration baseline. The UI and runtime had not yet been implemented.
