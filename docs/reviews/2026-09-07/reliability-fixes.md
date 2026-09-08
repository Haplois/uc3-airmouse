# Reliability fixes installed on 7 September 2026

Release `e5af2cb79971533d` fixed all five items marked "Act on" in the independent review, plus
the direct-tuning race identified as Claude C5. All 86 tests passed, including
28 new regressions. The installed service passed native-control verification and
the connection-only Bluetooth check. See the archived [results and test
output](../archive.md).

| Reviewed problem | Implemented behavior | Regression coverage |
| --- | --- | --- |
| Stale accumulated movement and delayed Y output | A separate batch-start timestamp limits accumulation to 50 ms. The oldest sample sets a 75 ms deadline checked before each axis. | Slow Core acknowledgements with advancing sample timestamps. A 300 ms X acknowledgement suppresses the expired Y. |
| Overlapping stops and restoration ownership | Output cleanup is shared. New sessions wait. Bluetooth acquire and release operations run in order, and failed restoration retains its state for retry. The service checks all connection identity and timing fields. | Complete Controller stop/start sequence, failed restoration, reacquisition ordering, unavailable journal, missing timing, and host timeout changes. |
| Old Core owner retains commands | Control replacement stops the old session and invalidates accepted commands. Obsolete connection lifecycle events cannot stop a new owner's session. | Two simulated Core connections with a queued command and late disconnect events. |
| Shutdown creates a false delivery lockout | Resolved delivery markers clear before Bluetooth timing restoration. The service has a 30-second stop budget and closes its resources when cleanup reports an error. | Slow restoration shared by multiple stop callers, plus installed unit inspection. |
| Unsent commands incorrectly block later output | Pre-transmission Core socket failures use a distinct error type. They stop without persistent delivery uncertainty. Ambiguous commands remain blocked and are never replayed. | Zero socket sends followed by quiesce and restart. Existing ambiguous-click coverage remains passing. |
| Journal timestamp gaps | A versioned cache stores the consumed cursor and compacted metadata together. A raw anchor check detects removed cursors. Legacy caches rebuild from the current boot. | Backward realtime timestamps, restart, missing anchors, failed reads, legacy migration, and ordinary Bluetooth traffic. |
| Failed installation leaves the new release selected | The installer checks prerequisites before stopping the service. Failed setup or startup restores the prior release, unit, enabled state, and running state. Recovery refuses to discard an unresolved sensor baseline. | Ten installer tests run the real shell script against temporary files and a fake service manager. |
| Direct tuning races an idle service | The runtime holds a persistent configuration file lock. Tuning must acquire the same lock before reading or writing configuration. | A separate tuning process is rejected while the lock is held and succeeds after release. The installed service also holds the lock. |

The first installed cursor implementation saved the last matching metadata
cursor. Each later query rescanned ordinary Bluetooth traffic after that record.
Three reads took 7.3 to 7.6 seconds each.

The fix uses `journalctl`'s consumed cursor and checks that its raw anchor still exists.
Two complete incremental reads took 224 ms and 216 ms. Initial indexing took
about 28 seconds and runs during deployment with a separate 60-second timeout.
Runtime queries retain their deadlines. These measurements cover journal reads,
not pointer latency.

On the final installed release, verification confirmed five native entities, five home-page items, seven controls, repeated explicit OFF, WebSocket OFF acknowledgement, and inactive rate changes that restore the selected rate without changing sensor settings. The Bluetooth check confirmed a 7.5 ms interval and zero peripheral latency, then completed restoration. It sent zero HID reports. Final inspection found an active service with zero automatic restarts, no unresolved output, and no remaining sensor or output session journal.

The user selected 800 Hz before deployment. Configuration hashes before and after installation match. Sampling remains 800 Hz, sensitivity remains 1800, gyro range remains ±2000°/s, and the application movement limit remains 100 Hz. The original kernel drivers remain installed.

Target switching after output still requires manual verification of host
isolation. This release did not establish active-service performance beyond the
journal measurements, host report rate, or pointer feel.

Run `npm test` from the repository root to repeat the regression suite. The archived historical defect-confirmation scripts assert the old failures and are not the regression suite for the fixed implementation.
