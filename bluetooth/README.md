# Run the source-built Bluetooth backend

Install CMake, Python 3.12 or later, and `aarch64-linux-gnu-gcc`. Then build an ARM64 bundle from
the BTstack checkout. The tool uses commit `431d58d5613fd8fae38afe50282b25302de84bf7` and excludes local checkout
changes.

```sh
tools/airmouse-bluetooth-build --arch arm64 --btstack /tmp/uc3-airmouse-reference/btstack
```

Use the archive path printed by the build command:

```sh
tools/airmouse-bluetooth --host root@10.0.10.51 install --archive dist/airmouse-bluetooth-arm64-RELEASE.tar.gz
tools/airmouse-bluetooth --host root@10.0.10.51 probe
```

Installation copies the daemon and licenses into a separate release directory
and records the installed paths. It backs up the previous custom units and
release link and leaves both custom units disabled.

The probe temporarily stops stock Bluetooth and initializes the controller
without advertising. It requires `PROBE_OK` and restores the previous service state,
including when the probe fails.

After a successful probe, start the owned backend:

```sh
tools/airmouse-bluetooth --host root@10.0.10.51 takeover
```

Open **Air mouse → All devices** and select **Pair another computer**. Pair the
new Air mouse identity from the computer's Bluetooth settings. The deployment
tools do not pair or send mouse input. Manually check OK and Right press and
release, movement with a held button, and release when the page closes.

To change names or order, open **All devices → Edit**. Tap a computer to rename
it, restore its Bluetooth name, or confirm Forget. Drag a handle to reorder the
list. The first three computers appear as home shortcuts. Up to four computers
can be saved. Home shortcuts preserve the pointing choice and resume after
connection. Pairing and the computer manager leave pointing off. Turning
pointing off or leaving the mouse screen cancels any pending resume. An
unavailable computer times out after three seconds with pointing off.

The remote shows a computer's GAP Device Name when it exposes one, and
**Computer N** otherwise, until you choose a custom name.

A takeover stops and runtime-masks `btstack.service` and its `btuart.service` UART helper. Stock Bluetooth
remotes stop working until rollback. The owned backend stores its bonds at `/mnt/data/airmouse/bluetooth/state`
and preserves the stock bond store and selected target. Keep SSH available for
rollback.

Restore stock Bluetooth with:

```sh
tools/airmouse-bluetooth --host root@10.0.10.51 rollback
tools/airmouse-bluetooth --host root@10.0.10.51 status
```

Rollback stops the owned daemon, powers the controller off, restores the previous runtime masks and Node drop-in, and restores previous service activity. It keeps the custom installation and its bond store for later use. Installation backups and the installed-file record are under `/mnt/data/airmouse/bluetooth/install-backup`.

The service applies `bluetooth.ownership` through `airmouse-bluetooth-request.path`, which is enabled at boot. With `always`, the
service takes ownership again after reboot. You can also run `takeover` and `rollback`
manually. Manual rollback prevents automatic takeover until you open the app
again. The daemon unit itself is never enabled at boot.

A daemon failure invokes rollback automatically, and a 45-second guard rolls back an interrupted takeover or probe. If another process holds `/dev/ttyS1`, the tool refuses to power the controller and keeps the transaction record until rollback can complete. Find and stop that UART owner before retrying.

To build and test on the development host:

```sh
tools/airmouse-bluetooth-build --arch host --btstack /tmp/uc3-airmouse-reference/btstack
python3 -m unittest discover -s bluetooth/test -p 'test_deploy.py'
```

The host build runs the state, registry persistence, Bluetooth lifecycle, and local IPC tests through CTest. The deployment tests use fake systemd commands and a temporary filesystem. They do not access a Bluetooth controller.

Compatible GATT updates preserve bonded notification subscriptions. The build
compares the released layouts in `schema/` with the current layout. Existing
attributes must match exactly, except for the database hash value. Added
attributes must follow the existing attributes. Startup migrates recognized
stored hashes before BTstack restores subscriptions. Unknown hashes retain
BTstack's normal invalidation behavior. Keep released layout files unchanged.
Changes to the dynamic HID report descriptor also require compatibility review;
the GATT layout comparison cannot check that descriptor.

For subscriptions already erased by the mouse-v1 to media-v2 update, use an
on-device backup. Recovery copies missing subscriptions only when the entire
saved bond matches. It preserves existing subscriptions, bond keys, file
ownership, and permissions. Stop the daemon before recovery. The tool holds the
daemon's ownership lock.

```sh
tools/airmouse-bluetooth rollback
tools/airmouse-bluetooth recover-subscriptions --backup /path/to/backup/state/bonds.tlv
tools/airmouse-bluetooth recover-subscriptions --backup /path/to/backup/state/bonds.tlv --apply
tools/airmouse-bluetooth takeover
```

The first recovery command is a dry run. Applying recovery saves the previous
file beside `bonds.tlv` before atomically replacing it. Recovery prints slot and
attribute identifiers, never bond keys.

To include the C daemon cases in the Node suite, build a host binary and pass
its path in `AIRMOUSE_HID_BINARY`. Without it, Node skips those cases.

```sh
cmake -S bluetooth -B /tmp/airmouse-bt-host -DBTSTACK_ROOT=/tmp/uc3-airmouse-reference/btstack
cmake --build /tmp/airmouse-bt-host --parallel 4
AIRMOUSE_HID_BINARY=/tmp/airmouse-bt-host/airmouse-hid npm test
```

Keep the licenses with the deployed bundle. The daemon source is MIT-licensed.
It links against BTstack, which permits redistribution and use only for
personal, noncommercial purposes. That restriction applies to the built daemon.
Commercial use requires a BTstack license from BlueKitchen GmbH.

The build copies no controller firmware. The daemon reads the remote's existing
`/opt/uc/bt/fw/init/BCM4373A0_001.001.025.0103.0155.FCC.CE.2BC.hcd`.

To measure switching without pointer input, close the Air mouse app and run
`tools/airmouse-switch-check`. It checks that pointing is off, switches among the
first three saved computers, and restores the original selection. The JSON result
reports command acknowledgement and ready times. Computer sleep and scanning
policy affect the result. The tool sends no mouse movement or button commands.
