# Build and install the native Air mouse UI

The custom Qt Quick app opens from one **Air mouse** button entity on **Living
room**. The tile uses the stock entity layout and can be moved, renamed, or
removed in the normal page editor. The custom UI routes activation of its
configured entity ID to the native app. Other button entities keep their normal
behavior. Pressing the tile runs native UI code without sending a command to
Core. See the [native UI reference](../docs/design/native-ui.md) for behavior
and limits.

## Build

Install Python 3.12 or later, Git, and Docker. Clone the upstream UI once:

```sh
git clone https://github.com/unfoldedcircle/remote-ui.git /tmp/uc3-airmouse-reference/remote-ui
npm run build:native
python3 tools/airmouse-ui package
```

The build tool pins upstream revision `f3d34daea76239a92b5d43793f9eb849e5d0fc19` and applies the native page in a
separate build directory. It uses the `unfoldedcircle/r2-toolchain-qt-5.15.8-static:latest` image. The output is `dist/native-ui/airmouse-ui-0.1.0.tar.gz`, with a
separate SHA-256 checksum file. Use `tools/airmouse-ui-build --source PATH --work PATH` to change the checkout and build
locations. `--prepare` applies the source changes without compiling.

Run the service and QML checks:

```sh
npm test
npm run test:native
```

The QML tests require Qt 5.15 development tools, Qt Quick Controls 2, Qt Test,
Xvfb, and xauth. The test command allows QML to read local fixtures. The tests
save screenshots of all five pages in `/tmp/native-*.png`.

To test the C++ bridge's pending-action and button-edge handling:

```sh
mkdir -p /tmp/airmouse-native-bridge-tests
cd /tmp/airmouse-native-bridge-tests
qmake /path/to/uc3-airmouse/native/test/bridge.pro
make -j4
./tst_bridge
```

## Stage and activate

This build is based on Remote UI v0.74.5, while the lab device's stock UI is
v0.80.0 on firmware 2.10.2. The native page has rendered on the physical device.
The older UI has not been checked against every stock feature. The package
restricts installation to firmware 2.10.2.

Deploy the service, then stage the custom UI archive:

```sh
python3 tools/airmouse deploy
python3 tools/airmouse-home prepare
python3 tools/airmouse-ui stage
python3 tools/airmouse-ui status
```

`airmouse-home prepare` backs up the current pages, entities, and service configuration. It
registers the single `airmouse.main.launch` button through the local launcher integration and
configures `AIRMOUSE_LAUNCH_ENTITY_ID`. Staging verifies the archive checksum and leaves the active UI
alone. All remote commands use existing SSH authorization. Supply `--host user@address` to use
another device.

The official Core installer requires `void_warranty=yes`. Its API specification says the consent
is written once and cannot be reverted. Activate the package only if you accept
this permanent consent record:

```sh
python3 tools/airmouse-ui install --accept-warranty
python3 tools/airmouse-home apply
python3 tools/airmouse-home verify
```

The installer adds the Unix-socket bind mount for `remote-ui-custom.service`,
then uploads the package through the supported Core API. The device screen
restarts. The deployment process reads the existing Core key on the remote;
the UI does not receive it.

`airmouse-home apply` adds the launcher to Living room if it is not already on a
page. Rerunning the command preserves any existing placement and custom name.
Other entities and paired Bluetooth computers remain intact. The build no longer
adds a page footer or overrides navigation on an empty page.

The integration exposes only the launcher and does not control pointing. Launch
is local to the custom UI; executing `button.push` through Core automations is
unsupported and returns an error. The app's sensor and Bluetooth controls continue
to use the existing Unix socket.

After activation, open **Living room → Air mouse**. Check the selected computer,
press **Power** to start pointing, and test **OK**, **Right**, and the bottom
strip manually. Open Settings to change speed, output limit, calibration, or
color.

If upload returns a connection error, run `status` before retrying. The Core
installer can restart the UI while completing an installation.

## Restore the stock UI

```sh
python3 tools/airmouse-ui rollback
python3 tools/airmouse-ui status
```

Rollback uses the Core API to disable the custom UI. The native launch button is
unavailable in the stock UI. Page and entity backups are retained under `/mnt/data/airmouse/state/native-home-backup-*.json`.
Rollback retains the custom UI package and Air mouse settings. It cannot undo
the installer's warranty record. The firmware also has its own crash recovery
for custom UI applications.

## Preview without replacing the UI

Build the standalone preview with:

```sh
python3 tools/airmouse-ui-build --preview --work /tmp/airmouse-preview-build
```

`AIRMOUSE_UI_SOCKET` selects its local service socket. The default is
`/app/airmouse/control.sock`. If `AIRMOUSE_CAPTURE_DIR` is set, the preview saves
`native-live.png` and exits after four seconds. This binary shares the page and
bridge with the integrated build; it does not test the stock UI launcher or
hardware-button adapter. The Remote 3 toolchain includes only the `eglfs`
platform plugin, so its ARM64 preview requires the physical display.

`AirMouseHost.qml`, `Launcher.js`, and the patches in `tools/airmouse-ui-build`
extend the upstream UI and follow its GPL-3.0-or-later license; see
[LICENSE](LICENSE). The page, computer manager, controls, palette, and the C++
bridge depend only on Qt and are MIT-licensed like the rest of this repository.
The patched upstream source remains in the build directory;
`tools/airmouse-ui-build` reproduces it from the pinned revision and this repo.

## Capture the physical screen

```sh
tools/airmouse-screenshot --output /tmp/remote-native.png
```

This captures the active DRM display without sending input. It uses the device
path from the firmware EGLFS configuration and refuses to overwrite a file. For
screenshots of each QML page without hardware, run `npm run test:native`. Those renders use test
data and desktop Qt.
