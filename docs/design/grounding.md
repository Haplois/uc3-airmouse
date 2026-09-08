# Remote 3 design evidence

These observations were collected over SSH on 2026-09-07 without changing the
remote configuration.

## Requirements

The app must run and store its state on Remote 3, use native UI controls, and
act as a Bluetooth mouse for Windows and Linux. LG webOS remote and pointer
support is deferred. The proposal allows multiple saved targets with one active
at a time. The owner chose toggle activation. Operation must not depend on
deployment tools.

The owner accepted an on-device hardware service installed with existing root access, and deferred model-specific LG work.

The owner reports that the multiple-Bluetooth-connection preview setting is
enabled. Multi-host operation was not measured.

## Device

- Firmware 2.10.2, Linux 6.6.23, Buildroot 2024.02.6, aarch64.
- `bmi323-imu` at `/sys/bus/iio/devices/iio:device1` exposes three accelerometer and three angular-velocity channels.
- Both sample rates read 50 Hz. Buffer enable reads 0.
- Accelerometer scale reads 0.002394. Angular velocity scale reads 0.001065. Read scales at runtime, never assume constants.
- Raw readings succeeded for all six channels. This establishes root access. Simultaneous sampling, sustained rate, physical axis direction, noise, and access inside an integration sandbox were not tested.
- `/dev/iio:device1` is root-only. The accelerometer mount matrix reads identity.
- `btstack.service` runs `/opt/uc/bt/hog_keyboard` as `uccore`. No BlueZ service appeared in the running system services or system D-Bus list.
- The bundled Android TV integration service uses `PrivateDevices=yes`, `DevicePolicy=closed`, and hides `/sys`. Its unit says it uses a similar sandbox to custom integrations. This sandbox prevents IIO access through normal packaging. Other custom units may use different policies.
- The native UI also hides `/sys/bus/iio`.

## Documented interfaces

- [Bluetooth HID support](https://unfoldedcircle.github.io/core-api/bt/index.html) documents existing Bluetooth remote entities with mouse buttons, relative X/Y movement and wheel commands. Movement values are signed 8-bit. Hold, delay and repeat parameters are ignored. High-rate simultaneous X/Y reports and button-down/up behavior need validation.
- [Driver installation](https://unfoldedcircle.github.io/core-api/integration-driver/driver-installation.html) defines custom archives with driver.json and bin/config/data directories and a statically linked aarch64 executable or Node.js entry point.
- [Entities](https://unfoldedcircle.github.io/core-api/entities/) describes native UI controls that send commands through Core to an integration, then receive attribute updates.
- [Authentication](https://github.com/unfoldedcircle/core-api/blob/main/core-api/README.md#authentication) supports a provisioned API key. It is independent of a rotating deployment PIN. Activation may require approval on the remote and must be checked.

## Unknowns to resolve

The following still need testing or a design decision:

- Core command rate, latency, diagonal motion, and held buttons.
- Multi-host routing and reconnection.
- Sensor ownership, physical axes, and service permissions.
- Suspend signals, wake behavior, and activity exit behavior.
- LG model compatibility.
- Persistent Core credential provisioning.

## Native UI trace

In remote-ui revision `f3d34daea76239a92b5d43793f9eb849e5d0fc19`, native button commands pass through `Remote.qml`, `EntityController.onEntityCommand`, `EntityController::retrySendAttempt`,
and `core::Api::entityCommand` to the Core WebSocket command. Core routes `entity_command` to the integration.
Integration `entity_change` events return through Core to `Api::processEntityChange` and `EntityController::onEntityChanged`, which update native
entity attributes.

The remote entity provides initial simple commands, physical button mappings,
and grid pages. User-edited layouts are not overwritten by reloading available
entities. Public button mappings have short-press and long-press commands but no
general button-release callback. Current `ButtonNavigation.qml` suppresses short-press repeats when
a long-press mapping is present. Verify this behavior on installed firmware
before using a physical toggle.

Activity on/off sequences can issue explicit commands. Integration standby
messages are available, but leaving an activity screen does not guarantee an
activity-off event. Runtime disconnect detection must distinguish loss of the
Core control connection from loss of the target Bluetooth connection.

Sources: [remote entity](https://unfoldedcircle.github.io/core-api/entities/entity_remote.html), [Remote.qml](https://github.com/unfoldedcircle/remote-ui/blob/f3d34daea76239a92b5d43793f9eb849e5d0fc19/src/qml/components/entities/remote/deviceclass/Remote.qml), [button handling](https://github.com/unfoldedcircle/remote-ui/blob/f3d34daea76239a92b5d43793f9eb849e5d0fc19/src/qml/components/ButtonNavigation.qml), [Integration schema](https://github.com/unfoldedcircle/core-api/blob/main/integration-api/UCR-integration-asyncapi.yaml).

## Design comparison criteria

Each proposal must describe usage, types and signatures, module ownership,
rationale, and a first implementation step. Compare them against these criteria:

- All runtime work stays on the remote.
- Controls fit the native UI.
- Bluetooth and sensor assumptions match the evidence.
- Switching prevents input from reaching the wrong host and discards stale motion.
- LG support can be added, with generic HID and Magic Remote capabilities distinguished.
- Interfaces remain small and maintainable.
