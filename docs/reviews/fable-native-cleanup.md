# Fable 5 native UI and repository review

Claude Fable 5 reviewed the source and five native Qt screenshots on 7 September
2026. A follow-up reviewed a physical DRM capture of the Living room launcher.
The CLI reported `claude-fable-5` for both runs, with no permission denials. The reviewer
could read and search files but could not edit or execute code. The
implementation agent applied and checked the changes. The existing Git index was
preserved.

## Fixes

| Finding | Change |
| --- | --- |
| Calibration revisit stays on "All set." | Entering Calibrate always requests OFF with "Paused for calibration". The service publishes that state before acknowledging it. A Qt regression checks that another calibration can start. |
| Legacy integration starts by default with fresh state | Removed the integration server, registration mode, entity metadata, page helpers and legacy verification branch. Native IPC is the only control path. |
| Unreachable rate controls and timed tests remain deployed | Removed the legacy toggle/rate/stepping/test commands and their state machine. Kept output-limit validation and automatic sampling policy. |
| Commands rejected while the bridge is busy give no feedback | The C++ bridge now emits an explicit busy notice for rejected commands. OFF still preempts an in-flight action. This does not add command replay or a delayed click queue. |
| Driver check validates a deleted prototype | The check imports the production sampling policy and checks all 100 slider settings against the driver rate table. |
| Unused capture method in the production bridge | Removed the unused file-writing QML method. Physical capture now uses `tools/airmouse-screenshot`, outside the app. |
| Settings aligns labels with literal spaces | Replaced the color-setting text with a layout row. |
| Target picker marks selection differently | Selected rows retain the desktop icon and use the same accent treatment as quick-switch cards. |
| Launcher is inset from stock cards | Matched the stock 10 px margins and 8 px corner radius. Disabled Qt focus on this touch launcher because the firmware handles button navigation separately. |
| Stale product documentation | Rewrote README and operations around Living room → Air mouse, native settings, current diagnostics and automatic sampling. |

The implementation agent also changed the native heartbeat lease to a monotonic
clock. A test moves the wall clock backwards and confirms that heartbeat loss
still stops pointing. Native IPC tests now cover competing clients and replayed
request IDs. The sensor-restoration and target-isolation safeguards remain
unchanged.

## Findings left unchanged

- Empty Core Bluetooth responses: Fable could not establish that the documented
  endpoints return HTTP 204. Empty responses still cause an error.
- Brief socket permission window during startup: the bridge already retries;
  no persistent failure was found.
- The old sensor-journal format remains supported so recovery works after a
  release rollback.
- The launcher keeps the approved outlined style. Its margin and focus
  behavior were corrected.
- The user-added Desktop card was left unchanged. Its state is independent of
  the native launcher, and one screenshot was insufficient to diagnose it.

## Cleanup

Removed 43 historical and prototype files, plus four legacy integration files.
Removed unused controller branches and their feature-specific tests. Deleted
stale ignored release archives, driver build output and Python caches. Current
release artifacts were rebuilt for deployment.

Historical evidence and the latest HTML preview are preserved in an external
[archive](archive.md). The historical evidence files are now available only in
that archive. At cleanup time, the browser preview was served from the archive.
Cleanup created no archive branch or commit.

Kept experimental driver source and licenses, sensor recovery, output isolation,
diagnostics, direction fixtures, installation rollback tests, and dated hardware
verification records. These still support the product or the user's requested
sensor work.

## Validation

- 92 Node tests and 13 Qt checks pass. Tests for the retired integration
  and rate-test features were removed. Native-session and calibration
  regressions were added.
- All 100 output-slider settings pass the comparison of the production sampling policy with the driver rate table.
- ARM64 native build and service packaging pass. The service archive contains
  neither the legacy integration nor its driver metadata.
- Device verification confirms UI `0.74.5-airmouse.4` is active, both services
  are running, the native launcher is on Living room, no legacy Air mouse
  entities remain, and pointer output is off. The UI reports zero restarts.
- Native Qt renders and a physical launcher screenshot were reviewed. The
  in-app renders use desktop Qt and fixture data; they are not physical-device
  screenshots. No automated pointer, click or scroll test was sent to the host.

The post-install capture shows the device screensaver. Visual checks of the
app after these fixes are limited to the native Qt renders; the physical launcher review used the earlier device capture.

Raw reviewer responses, screenshot files, prompts and verification output are
retained with the [archive](archive.md).
