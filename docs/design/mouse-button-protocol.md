# Mouse button protocol findings

Firmware 2.10.2's Bluetooth daemon cannot provide a held mouse button through
the reviewed hold or native-report handlers. The firmware adapter therefore
sends complete clicks. The [owned Bluetooth backend](owned-bluetooth.md) now
implements independent mouse down and mouse up in source-built BTstack.

The reviewed executable is `/opt/uc/bt/hog_keyboard`. Its SHA-256 is
`8cc84d484e1fd30514d276d234c5e339c28ea92f4fda14fe75092d3263913930`.
The local copy matched the installed binary on 2026-09-07.

## Hold commands exclude the mouse

The daemon contains `UCR_KBD_HOLD_START` and `UCR_KBD_HOLD_STOP` handlers.
The start handler calls the hold validator at virtual address `0x59a30`.
The checks at `0x59ab4` and `0x59d6c` accept these report lengths:

| Report ID | Required bytes |
| --- | --- |
| 1 | 8 |
| 2 | 2 |
| 3 | 2 |

Other IDs branch to the rejection at `0x59d80`, which logs that the report is not
holdable. The mouse wrapper at `0x58980` supplies report ID 4 and four bytes. Mouse
reports therefore cannot use the hold lease, keepalive, or release mechanism.

## Native mouse reports release automatically

`UCR_MOUSE_SEND_REPORT` reaches the mouse wrapper at `0x58980`, then the native
report queue at `0x585b0`. The wrapper passes its release flag in `w2`, but the queue
function overwrites that register without consuming the flag.

After sending a nonzero native report, the completion path at `0x576dc` compares
the report with a zero buffer. A nonzero report sets the pending-release state
to 2 and requests another send opportunity. The release path at `0x57aa0`
sends the zero buffer for report IDs 1 through 4. Mouse reports follow this path.

Sending native mouse reports directly would therefore retain the automatic
release. Repeating those reports would produce repeated clicks. The button would
not stay held for a drag.

## UI events are a separate prerequisite

The inspected Remote UI source handles physical release with `remote.stop_send`
when a button has a repeatable simple-command mapping. Its current short and
long click mappings suppress repeats and do not expose independent button edges.
Changing the mapping alone cannot overcome the daemon's mouse-report behavior.
The Core-to-integration translation of this release path has not been validated.

A complete implementation needs mouse support in the Bluetooth daemon's hold
state, movement that preserves the held button mask, and release on physical up,
standby, lost control, and process failure. Allowing report ID 4 in the hold
validator would still leave the native queue rejecting reports owned by a hold.

## Reproduce the static evidence

Run against the copied executable with AArch64 binutils installed:

```sh
python3 tools/airmouse-firmware-inspect /path/to/hog_keyboard
```

The tool refuses other firmware hashes and prints the disassembly sections used
for these findings. It does not connect to a device or modify the executable.
