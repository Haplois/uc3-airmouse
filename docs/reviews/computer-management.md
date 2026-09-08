# Computer management verification, 2026-09-08

This report records the first computer-manager release. See [home switching
verification](quick-switch.md) for the subsequent update.

The native computer manager was installed on the lab Remote 3. It saves up to
four computers, supports custom names, requires confirmation before Forget, and
saves the order set by dragging. The first three computers appear as home
shortcuts. A computer shows its GAP Device Name when it exposes one.

The existing computer reconnected without pairing again, and its Bluetooth name
was discovered. Hashes of the effective bond payloads and remote identity were
unchanged. The saved configuration exactly matches the previous configuration
plus the expected legacy target-tuning migration. Mint, speed 100, the 1000 Hz
output limit, and Core's selected target remain intact.

| Component | Verified result |
| --- | --- |
| Native UI | `0.74.5-airmouse.6`, installed and active |
| Node | Release `40f464163db9d876` |
| Bluetooth | Release `4490eac113699a50`, static ARM64 |
| Saved registry | One migrated computer, stable ID `00000001`, private mode 0600 |
| Live connection | Selected computer encrypted and ready; 7.5 ms connection interval |
| Input | Pointer off, zero held buttons, zero submitted movement updates |
| Initialization | One zero-button report before readiness |
| Sensor | Original modules, no pending recovery journal |
| Git | Staged entries unchanged; nothing staged or committed |

The Bluetooth binary SHA-256 is
`361e358a5c818c9572689937f9634d190b3c91de2a65694c7cf6abe155509505`.
Its BTstack source remains pinned to
`431d58d5613fd8fae38afe50282b25302de84bf7`.

## Checks and review fixes

| Check | Result |
| --- | --- |
| Node with `AIRMOUSE_HID_BINARY` | 132 passed, including two C simulator integrations |
| Native QML | 40 passed; six management screens rendered at 480 × 800 |
| C++ bridge | 12 passed |
| CTest | State and registry suites, 17 lifecycle cases, and 22 IPC cases passed |
| Address and undefined-behavior sanitizers | All four CTest suites passed; upstream process-lifetime leak detection disabled |
| Deployment fixtures | 16 passed |
| Device controller probe | `PROBE_OK`, no advertising or HID input, stock services restored |
| Migration | Existing bond and identity unchanged; Bluetooth name discovered on reconnect |

Review led to fixes for name queries that failed or arrived late and overwrote
stored names. Other fixes addressed UTF-8 truncation, embedded NUL characters,
stale pairing-event handles, and an unnecessary disconnect on an inactive
Cancel. A failed pairing now disconnects that attempt while preserving the
pairing window for retry. Node also revokes a pending activation if the selected
computer or readiness changes.

Persistence tests cover atomic-write failures, ID reuse prevention, exact order,
legacy trusted-slot migration, identity mismatch rejection, and interrupted
Forget cleanup. Native tests cover rename acknowledgement, keyboard dismissal,
resetting names, first-three ordering, drag completion and failure, membership
changes during drag, and confirmation tied to a computer ID.

Run CTest through `tools/airmouse-bluetooth-build --arch host`. Pass the host
binary to `AIRMOUSE_HID_BINARY` for the Node integrations. Native commands are
in [the build guide](../../native/README.md).

## Recovery and remaining manual checks

A private backup of the original bond store and settings remains on the device
at `/mnt/data/airmouse/bluetooth/devices-backup-20260908-0333`. Bond keys were never
copied into the workspace. Installation backups also retain the previous custom
release and units.

In this release, reboot or `tools/airmouse-bluetooth rollback` restored stock Bluetooth and preserved the custom
registry. Later releases added an ownership setting that can restore takeover
after reboot. See the current [operation and rollback
guide](../../bluetooth/README.md).

Pairing a second physical computer, switching between computers, touchscreen
renaming, and physical dragging remained unverified by this release's checks.
Multi-computer command behavior is covered by local simulation. No automated
host pointer, click, or scroll test was performed. Host report rate remains
unmeasured.

Design comparisons, rendered screens, builds, and verification logs are archived
outside the repository at
`/home/agent/.codex/archives/uc3-airmouse/computer-management-20260908/`.
