# Archived design and review evidence

`<private-archive>` denotes the maintainer's external archive directory.
The public notes retain artifact names but omit the workstation's absolute path.

The pre-cleanup repository files are preserved in:

`<private-archive>/before-fable-cleanup-20260907-154653.tar.gz`

The archive retains the complete `docs/reviews/2026-09-07/` tree, including `reliability-validation.json`, `reliability-tests.txt`, prompts, reviewer
responses, prototype screenshots, and historical defect checks. The evidence
files are now available only in the archive.

The original approved HTML design is also on branch
`prototype/airmouse-dock-approved-2026-09-07`, commit
`9d73b5421bbabe51bde4f62c98a2dee01a63520b`. Later visual adjustments are included
in the backup archive. At cleanup time the browser preview was served from
`<private-archive>/current-ui-prototype/`.

The Fable review, physical screenshot, native Qt renders, and validation logs
are stored at:

`<private-archive>/fable-native-cleanup-20260907/`

These are external archives on the shared workstation, not files distributed by
this repository. Copy them separately if moving the project. Cleanup created no
archive commit and left the Git index unchanged.

## September 11 cleanup

The generated-file archive is:

`<private-archive>/cleanup-20260911/`

It contains 42 superseded build bundles and 38 Python bytecode files,
totalling 12,416,720 bytes. Paths within the archive match their repository
paths. The two newest bundles by modification time remain in `dist/` for each
build type: Node service, ARM64 Bluetooth, and host Bluetooth. The native UI
bundle, binary, checksum, and sensor adapters also remain.

The archive includes `cleanup.py`, the dry-run-by-default cleanup script.
Running `python3 cleanup.py` lists eligible generated files. `--apply` moves
them to this archive without overwriting existing files. The script excludes
tracked files and symlink paths. After cleanup, its dry run listed zero files.

The only source removal was the unused `open_settings()` helper, its private
settings map, and its dedicated test. `APP_ACTIONS` and `control_action()`
still handle both settings buttons, covered by
`test_all_app_shortcuts_have_explicit_routes`. Copies of both files before
cleanup are in the archive.

LG protocol notes, recovery tools, historical slot fixtures, experimental
drivers, and regression tests remain in the repository. They document distinct
failure modes or preserve evidence needed for future TV and remote repairs.
No device was changed, and no Git index entries were modified.
