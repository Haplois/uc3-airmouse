# Initial owned Bluetooth verification, 2026-09-08

This report records the initial single-computer release. The user subsequently
paired a computer and confirmed that it works well. See
[computer management verification](computer-management.md) for the newer release.

The source-built BTstack backend was installed and active on the lab Remote 3.
It implements physical OK and Right down and up, held-button movement, and
release on stop or lost control. Host pairing and dragging had not been manually
validated when these checks ran. No automated host pointer, click, or scroll
test was performed.

| Component | Installed result |
| --- | --- |
| Native UI | `0.74.5-airmouse.5`, active; Living room launcher present; zero legacy Air mouse entities |
| Node service | Release `84394406baa652e6`, `AIRMOUSE_OUTPUT=owned` |
| Bluetooth daemon | Release `e5b1f00a1042e842`, static ARM64, systemd readiness and watchdog active |
| BTstack source | `431d58d5613fd8fae38afe50282b25302de84bf7` |
| Controller probe | BCM4373A0 initialized through H4; exact `PROBE_OK`; stock services restored |
| Crash recovery | SIGKILL automatically restored `btstack`, `btuart`, and Node; new backend then reactivated |
| Input at verification | Pointer off, unpaired, zero held buttons, zero submitted reports |
| Preferences | Amber theme, speed 100, sensitivity 3000, and output limit 1000 Hz preserved |
| Sensor | Original modules; idle 50 Hz; no recovery journal left behind |
| Stock bonds | SHA-256 unchanged across takeover and crash recovery |
| Git index | Exact staged-entry snapshot unchanged; no staging or commit |

## Review decisions and fixes

Fable 5 and Sol independently reviewed the process boundary. Both placed the
complete HID report and release lease in a C BTstack daemon while keeping
sensor handling in Node. The selected design uses ordered button intervals,
a bounded local protocol, one bonded computer, and runtime-only takeover.
See [the design](../design/owned-bluetooth.md).

Implementation review found six Bluetooth lifecycle faults, all fixed: missing
systemd readiness, a mismatched probe marker, lost release state after
unsubscribe, conflated boot and report subscriptions, retained boot mode after
reconnect, and STOP commands extending the release deadline. Mutation testing
checked that the lifecycle regressions detect the faults. IPC tests verify
readiness and watchdog notifications.

On-device checks also found that the firmware UART helper survives stock
Bluetooth shutdown. Takeover now stops and masks both services, and rollback
restores their previous activity. The installer decompresses archives locally
because this device's BusyBox `tar` has no gzip option.

The Node installer exceeded the existing three-second timeout for incremental
journal reads. A read-only reproduction measured 11.636 seconds for that scan.
Standalone installation now allows 60 seconds. Runtime scans and cursor
validation retain their three-second limits. The virtual owned target also
inherits the existing selected target's sensitivity until an owned-target
override is saved.

## Repeatable local checks

| Check | Result |
| --- | --- |
| `npm test` with `AIRMOUSE_HID_BINARY` set | 111 passed, including the real C daemon in local simulation |
| QML suite | 24 passed |
| C++ bridge suite | 9 passed |
| CTest | State suite, six lifecycle cases, and 11 IPC cases passed |
| Address and undefined-behavior sanitizers | All three CTest suites passed; leak detection disabled for upstream process-lifetime allocations |
| Deployment fixtures | 16 passed, including previous masks, helper ownership, old transaction records, and failed startup |
| ARM64 builds | Static Bluetooth daemon and full native UI built successfully |

Build the host Bluetooth target with `tools/airmouse-bluetooth-build --arch host`
to run CTest. Run deployment fixtures with
`python3 -m unittest discover -s bluetooth/test -p 'test_deploy.py'`.
Native test commands are in [the build guide](../../native/README.md).

The daemon binary SHA-256 is
`9996bdc256390eb73515fff1b612da9218a1431e38b9cc6d16934f61120acb58`.
Design responses, hardware evidence, build logs, and device verification are
archived outside the repo at
`/home/agent/.codex/archives/uc3-airmouse/owned-bluetooth-20260908/`.

## Manual checks remaining at this release

Open **Living room → Air mouse → Pair computer**, then pair **Remote 3 Air mouse**
from the computer. Press Up to enable pointing. Hold OK while moving to drag;
release OK to end the drag. Check Right down and up, scrolling while held,
and release when leaving the app.

This version supports one computer. The 1000 Hz slider sets the application
output limit. Host report rate and latency were unmeasured. The original sensor
driver still exposes at most 800 Hz. In this release, reboot or `tools/airmouse-bluetooth rollback` restored the
firmware Bluetooth backend. Later releases added an [ownership
setting](../../bluetooth/README.md) that can restore takeover after reboot.
