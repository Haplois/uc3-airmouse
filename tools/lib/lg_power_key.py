#!/usr/bin/env python3
"""Handle Remote 3's power and input-cycle Bluetooth commands on the TV."""
import json
import os
from pathlib import Path
import select
import threading
import time
from startup import api, ROOT


class PowerKey:
    def __init__(self, code=0x8008, debounce=.75):
        self.code = code
        self.debounce = debounce
        self.down = False
        self.last_press = float('-inf')

    def press(self, report, now):
        if len(report) != 20 or report[0] != 0xfd:
            return False
        down = int.from_bytes(report[17:19], 'big') == self.code
        pressed = down and not self.down and now - self.last_press >= self.debounce
        self.down = down
        if pressed:
            self.last_press = now
        return pressed


def next_input(devices, current, direction):
    if direction not in (-1, 1):
        raise ValueError('Expected an input direction')
    connected = sorted((device for device in devices
                        if device.get('connected') is True
                        and device.get('id', '').startswith('HDMI_')
                        and isinstance(device.get('port'), int)
                        and device.get('appId', '').startswith('com.webos.app.hdmi')),
                       key=lambda device: device['port'])
    if not connected:
        raise ValueError('No connected HDMI inputs')
    index = next((i for i, device in enumerate(connected) if device['id'] == current), None)
    if index is None:
        return connected[0 if direction == 1 else -1]
    return connected[(index + direction) % len(connected)]


def switch_input(direction):
    devices = api('getAllInputStatus', {}, service='com.webos.service.eim')['devices']
    current = api('getCurrentInput', {}, service='com.webos.service.eim')['mainInputSourceId']
    target = next_input(devices, current, direction)
    api('launch', {'id': target['appId']}, service='com.webos.service.applicationmanager')
    print('Remote 3 selected ' + target['id'], flush=True)


APP_ACTIONS = {0x7f03: 'com.webos.app.quicksettings', 0x7f04: 'com.palm.app.settings',
               0x7f05: 'com.webos.app.quickinputpicker',
               0x7f06: 'com.webos.app.hdmi1', 0x7f07: 'netflix',
               0x7f08: 'youtube.leanback.v4'}
MEDIA_ACTIONS = {0x7f0a, 0x7f0b, 0x7f0c, 0x7f0d, 0x7f0e}
STEAM_LOCK = threading.Lock()
KEY_CODES = (0x8008, 0x7f01, 0x7f02, *APP_ACTIONS, 0x7f09, *MEDIA_ACTIONS)


def media_action(code):
    if code == 0x7f0a:
        api('sendKeyCodes', {'keyCode1': 164}, service='com.webos.service.networkinput')
    elif code == 0x7f0e:
        api('controls/stop', {}, service='com.webos.service.networkinput')
    elif code in (0x7f0b, 0x7f0c):
        api('volumeUp' if code == 0x7f0b else 'volumeDown', {}, service='com.webos.audio')
    elif code == 0x7f0d:
        muted = api('getVolume', {}, service='com.webos.audio').get('muteStatus')
        if not isinstance(muted, bool):
            raise RuntimeError('TV did not report its mute state')
        api('setMuted', {'muted': not muted}, service='com.webos.audio')
    else:
        raise ValueError('Unsupported media action')


def steam_wake():
    try:
        from cec import CecAdapter, wake_hdmi1
        with CecAdapter() as adapter:
            result = wake_hdmi1(adapter)
        print('Steam Machine CEC: ' + json.dumps(result), flush=True)
        if not result['power_on_confirmed']:
            message = ('HDMI 1 selected. No CEC device replied; power-on is unconfirmed.'
                       if result['logical_address'] is None else
                       'HDMI 1 selected. CEC power-on requested; power state is not confirmed.')
            api('createToast', {'message': message}, service='com.webos.notification')
    except (OSError, RuntimeError, ValueError) as error:
        print('Steam Machine CEC failed: ' + str(error), flush=True)
        try:
            api('createToast', {'message': 'HDMI 1 selected, but the CEC wake command failed.'},
                service='com.webos.notification')
        except (OSError, RuntimeError, ValueError):
            pass
    finally:
        STEAM_LOCK.release()


def control_action(code):
    if code in APP_ACTIONS:
        api('launch', {'id': APP_ACTIONS[code]}, service='com.webos.service.applicationmanager')
    elif code in MEDIA_ACTIONS:
        media_action(code)
    elif code == 0x7f09:
        api('launch', {'id': 'com.webos.app.hdmi1'}, service='com.webos.service.applicationmanager')
        if STEAM_LOCK.acquire(blocking=False):
            try:
                threading.Thread(target=steam_wake, daemon=True).start()
            except RuntimeError:
                STEAM_LOCK.release()
                raise
    else:
        raise ValueError('Unsupported control action')


def main():
    address = json.loads((ROOT / 'power.json').read_text())['bluetooth_address'].lower()
    descriptors = {}
    while True:
        present = set()
        for path in Path('/sys/class/hidraw').glob('hidraw*/device/uevent'):
            try:
                fields = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)
                if fields.get('HID_UNIQ', '').lower() != address:
                    continue
                device = '/dev/' + path.parts[4]
                present.add(device)
                if device not in descriptors:
                    descriptors[device] = (os.open(device, os.O_RDONLY | os.O_NONBLOCK),
                                           {code: PowerKey(code, .75 if code == 0x8008 else
                                                           .05 if code in (0x7f0b, 0x7f0c) else .2)
                                            for code in KEY_CODES})
            except OSError:
                continue
        for device in list(descriptors):
            if device not in present:
                os.close(descriptors.pop(device)[0])
        ready, _, _ = select.select([entry[0] for entry in descriptors.values()], [], [], 1)
        for device, (fd, keys) in list(descriptors.items()):
            if fd not in ready:
                continue
            try:
                report = os.read(fd, 1024)
                if not report:
                    os.close(descriptors.pop(device)[0])
                    continue
            except OSError:
                os.close(descriptors.pop(device)[0])
                continue
            pressed = [code for code, key in keys.items() if key.press(report, time.monotonic())]
            for code in pressed:
                try:
                    if code in APP_ACTIONS or code in MEDIA_ACTIONS or code == 0x7f09:
                        control_action(code)
                        continue
                    if code in (0x7f01, 0x7f02):
                        switch_input(1 if code == 0x7f01 else -1)
                        continue
                    state = api('power/getPowerState', {}, service='com.webos.service.tvpower')['state']
                    method = 'powerOff' if state == 'Active' else 'powerOn'
                    api('power/' + method, {'reason': 'remoteKey'}, service='com.webos.service.tvpower')
                    print('Remote 3 requested ' + method, flush=True)
                except (OSError, ValueError, RuntimeError) as error:
                    print('Remote 3 key handler failed: ' + str(error), flush=True)


if __name__ == '__main__':
    main()
