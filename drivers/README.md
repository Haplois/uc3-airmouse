# Experimental sensor drivers

These modules are buildable prototypes. Normal air mouse deployment excludes
them. The lab remote currently runs its original kernel drivers.

The BMI323 module adds 1600 Hz and 3200 Hz sampling options with corresponding FIFO
timestamp periods and high-performance sensor mode. It also provides the
firmware's `bmi323` input-device name and `KEY_WAKEUP` capability for motion and
tap events. Input-device allocation uses managed cleanup. The I2C controller
module accepts only `fe5d0000.i2c` and sets its bus clock to 400 kHz.

Acquisition above 800 Hz has not been measured. A replacement trial exposed
unsafe input-device cleanup in the firmware driver, so live replacement was
stopped and its trial tool removed. The owner restarted the remote, and its
original drivers are active. Deployment needs a verified boot-time transition
and physical wake testing. A successful build does not establish that the
modules work on the device.

## Build

Check the rate encodings and FIFO timestamp periods before building:

```sh
python3 tools/airmouse-driver-check
```

The native service selects the lowest supported sensor rate that is at least
twice the output limit. For example, 400 Hz output selects 800 Hz sampling,
500 Hz selects 1600 Hz, and 1000 Hz selects 3200 Hz. The sensor has no 1000 Hz
or 2000 Hz ODR setting, so an exact 2:1 ratio is not available for every limit.
The running app applies this policy, capped at the rates its installed driver exposes.

This policy sets the nominal sampling rate. FIFO delivery, scheduling, and
Bluetooth timing can still prevent two new samples from arriving before a
report. Device validation must measure sample age and loss as well as average
cadence. At 3200 Hz, six 16-bit axes require at least 345.6 kbit/s on I2C
including byte acknowledgements, before transaction overhead. That is 86.4% of
the prototype's 400 kHz bus, so sustained acquisition remains unproven.

Use a disposable Linux 6.6.23 source tree, the remote's `kheaders.tar.xz`, and a
tar containing the installed kernel modules. The build needs an ARM64 cross
compiler, make, flex, bison, and libelf development headers.

```sh
tools/airmouse-driver-build \
  --source /path/to/linux-6.6.23 \
  --headers /path/to/kheaders-6.6.23.tar.xz \
  --modules /path/to/all-modules.tar \
  --work /path/to/kernel-build
```

The tool updates the disposable source and build trees. It compares generated
symbol CRCs with captured firmware modules, then builds with module version
checking enabled. The tested GCC 15.2 cross-build matched 24 available firmware
CRCs. The running firmware itself was compiled with GCC 13.2.1. Output goes to
`dist/drivers-6.6.23`. The tool does not install or load modules.

## Source references

- `bmi323/` is a modified copy of the Linux BMI323 IIO driver by Jagath Jog J,
  taken from [Linux v6.8](https://github.com/torvalds/linux/tree/v6.8/drivers/iio/imu/bmi323).
  The changes add 1600 and 3200 Hz rates, FIFO timestamp periods,
  high-performance mode, and a wake input device.
- `i2c/` is a modified copy of the Rockchip RK3xxx I2C driver by Max Schwarz,
  taken from [Linux 6.6.23](https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.6.23.tar.xz).
  The changes restrict it to `fe5d0000.i2c` and set a 400 kHz bus clock.
- Sensor rates, power modes, and bus timing follow the [Bosch BMI323 datasheet](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi323-ds000.pdf).

The files keep their original copyright notices and SPDX identifiers. This
repository distributes the modifications listed above. Everything in this
directory is GPL-2.0. The repository's MIT license does not apply here. The
license text is in [LICENSES/GPL-2.0](LICENSES/GPL-2.0).
