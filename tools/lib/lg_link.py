#!/usr/bin/env python3
"""Use fast timing while Remote 3 points and relaxed timing while it rests."""
import ctypes
import json
import os
from pathlib import Path
import re
import select
import socket
import struct
import time
from startup import api, ROOT, slots_valid


class LinkPolicy:
    def __init__(self, address):
        if not re.fullmatch(r'(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}', address):
            raise ValueError('Expected Remote 3 Bluetooth address')
        self.peer = bytes.fromhex(address.replace(':', ''))[::-1]
        self.clear()

    def clear(self):
        self.handle = None
        self.disconnecting = False
        self.interval = self.latency = None
        self.timeout = 300
        self.due = None
        self.attempts = 0
        self.desired = (8, 0)

    def activity(self, active, now):
        desired = (8, 0) if active else (24, 2)
        if self.desired != desired:
            self.desired = desired
            self.attempts = 0
            self.due = now

    def observe(self, packet, now):
        if len(packet) < 3 or packet[0] != 4 or packet[2] != len(packet) - 3:
            return None
        event, data = packet[1], packet[3:]
        if event == 0x0e and len(data) >= 4 and data[1:4] == b'\x03\x0c\x00':
            self.clear()
        elif event == 5 and len(data) == 4 and data[0] == 0:
            if struct.unpack_from('<H', data, 1)[0] == self.handle:
                self.clear()
        elif event == 0x3e and data:
            subevent, data = data[0], data[1:]
            if subevent in (1, 10) and len(data) == (18 if subevent == 1 else 30) and data[0] == 0:
                handle = struct.unpack_from('<H', data, 1)[0]
                if handle == self.handle:
                    self.clear()
                if data[3] != 0 or data[4] not in (0, 1) or data[5:11] != self.peer:
                    return None
                self.clear()
                self.handle = handle
                offset = 11 if subevent == 1 else 23
                self.interval, self.latency, self.timeout = struct.unpack_from('<3H', data, offset)
                self.due = now + 3
            elif subevent == 3 and len(data) == 9:
                if struct.unpack_from('<H', data, 1)[0] != self.handle:
                    return None
                if data[0] != 0:
                    return {'event': 'update_failed', 'status': data[0]}
                self.interval, self.latency, self.timeout = struct.unpack_from('<3H', data, 3)
                self.due = None if (self.interval, self.latency) == self.desired else now + 3
                return {'event': 'link', 'interval_ms': self.interval * 1.25, 'latency': self.latency}
        return None

    def request(self, now):
        if (self.handle is None or self.due is None or now < self.due or self.attempts >= 3
                or (self.interval, self.latency) == self.desired):
            return None
        self.attempts += 1
        self.due = now + 5
        interval, latency = self.desired
        parameters = struct.pack('<7H', self.handle, interval, interval, latency, self.timeout, 0, 0)
        return b'\x01\x13\x20\x0e' + parameters


class MotionActivity:
    def __init__(self):
        self.streaming = True
        self.last = time.monotonic()
        self.previous_report = float('-inf')
        self.burst = 0

    def observe(self, report, now):
        if len(report) != 20 or report[0] != 0xfd:
            return
        key = int.from_bytes(report[17:19], 'big')
        if key == 0x803f:
            self.streaming = False
            self.last = float('-inf')
            self.burst = 0
            self.previous_report = float('-inf')
        elif key == 0x803e:
            self.streaming = True
            self.last = now
        else:
            self.burst = self.burst + 1 if now - self.previous_report < .1 else 1
            self.previous_report = now
            if self.burst >= 3 or report[3] & 3 == 1:
                self.streaming = True
            if self.streaming or key:
                self.last = now

    def active(self, now):
        return now - self.last < 20


class MotionInputs:
    def __init__(self, address):
        self.address = address
        self.descriptors = {}
        self.next_scan = 0
        self.activity = MotionActivity()
        self.last_report = None

    def scan(self, now):
        if now < self.next_scan:
            return
        self.next_scan = now + 2
        present = set()
        for path in Path('/sys/class/hidraw').glob('hidraw*/device/uevent'):
            try:
                fields = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)
                if fields.get('HID_UNIQ', '').lower() != self.address:
                    continue
                device = '/dev/' + path.parts[4]
                present.add(device)
                if device not in self.descriptors:
                    self.descriptors[device] = os.open(device, os.O_RDONLY | os.O_NONBLOCK)
            except OSError:
                continue
        for device in list(self.descriptors):
            if device not in present:
                os.close(self.descriptors.pop(device))

    def receive(self, ready, now):
        for device, fd in list(self.descriptors.items()):
            if fd not in ready:
                continue
            try:
                for _ in range(64):
                    report = os.read(fd, 1024)
                    if not report:
                        raise OSError('HID input closed')
                    self.last_report = now
                    self.activity.observe(report, now)
            except BlockingIOError:
                pass
            except OSError:
                os.close(self.descriptors.pop(device))


class ReceiverInputs:
    NAME = 'LGE M-RCU - Builtin [1]'

    def __init__(self, sysfs_root=Path('/sys/class/input'), device_root=Path('/dev/input')):
        self.sysfs_root = sysfs_root
        self.device_root = device_root
        self.descriptors = {}
        self.next_scan = 0
        self.last_event = None

    def scan(self, now):
        if now < self.next_scan:
            return
        self.next_scan = now + 2
        present = set()
        for path in self.sysfs_root.glob('event*/device/name'):
            try:
                if path.read_text().strip() != self.NAME:
                    continue
                device = self.device_root / path.parts[-3]
                present.add(device)
                if device not in self.descriptors:
                    self.descriptors[device] = os.open(device, os.O_RDONLY | os.O_NONBLOCK)
            except OSError:
                continue
        for device in list(self.descriptors):
            if device not in present:
                os.close(self.descriptors.pop(device))

    def receive(self, ready, now):
        for device, fd in list(self.descriptors.items()):
            if fd not in ready:
                continue
            try:
                while True:
                    event = os.read(fd, 4096)
                    if not event:
                        raise OSError('Receiver input closed')
                    self.last_event = now
            except BlockingIOError:
                pass
            except OSError:
                os.close(self.descriptors.pop(device))

    def active(self, now):
        return self.last_event is not None and now - self.last_event < 3

class AttachmentPolicy:
    def __init__(self, grace=2, cooldown=60):
        self.grace = grace
        self.cooldown = cooldown
        self.next_repair = float('-inf')
        self.missing_since = None

    def update(self, reported, attached, now):
        if attached:
            self.missing_since = None
            return False
        if reported and self.missing_since is None:
            self.missing_since = now
        if (self.missing_since is None or now - self.missing_since < self.grace
                or now < self.next_repair):
            return False
        self.missing_since = None
        self.next_repair = now + self.cooldown
        return True


def receiver_has_hidraw(address, proc_root=Path('/proc'), hidraw_root=Path('/sys/class/hidraw')):
    for process in proc_root.glob('[0-9]*'):
        try:
            if (process / 'comm').read_text().strip() != 'lginput2':
                continue
            for descriptor in (process / 'fd').iterdir():
                device = os.readlink(descriptor)
                if not re.fullmatch(r'/dev/hidraw\d+', device):
                    continue
                fields = dict(line.split('=', 1) for line in
                              (hidraw_root / Path(device).name / 'device/uevent').read_text().splitlines()
                              if '=' in line)
                if fields.get('HID_UNIQ', '').lower() == address:
                    return True
        except OSError:
            continue
    return False


def receiver_attached(address, info=Path('/mnt/lg/cmn_data/mrcu/mrcu2.info'),
                      hidraw_root=Path('/sys/class/hidraw')):
    try:
        fields = dict(tuple(part.strip() for part in line.split('=', 1))
                      for line in info.read_text().splitlines() if '=' in line)
        device = fields.get('hidraw', '')
        if fields.get('BDAddr', '').lower() != address or not re.fullmatch(r'/dev/hidraw\d+', device):
            return False
        uevent = hidraw_root / Path(device).name / 'device/uevent'
        values = dict(tuple(part.strip() for part in line.split('=', 1))
                      for line in uevent.read_text().splitlines() if '=' in line)
        return values.get('HID_UNIQ', '').lower() == address
    except OSError:
        return False


def open_controller():
    class Address(ctypes.Structure):
        _fields_ = [('family', ctypes.c_ushort), ('device', ctypes.c_ushort), ('channel', ctypes.c_ushort)]
    controller = socket.socket(31, socket.SOCK_RAW, 1)
    try:
        # Event packets only: disconnect, command complete, LE meta. No ACL/HID capture.
        mask = struct.pack('<IIIH', 1 << 4, (1 << 5) | (1 << 14), 1 << 30, 0) + b'\0\0'
        controller.setsockopt(0, 2, mask)
        address = Address(31, 0, 0)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.bind(controller.fileno(), ctypes.byref(address), ctypes.sizeof(address)):
            raise OSError(ctypes.get_errno(), 'HCI socket bind')
        controller.setblocking(False)
        return controller
    except Exception:
        controller.close()
        raise


def receive(controller, policy):
    for _ in range(64):
        try:
            packet = controller.recv(260)
        except BlockingIOError:
            break
        result = policy.observe(packet, time.monotonic())
        if result:
            print('Remote 3 ' + json.dumps(result), flush=True)


def slot_identities_valid(address):
    try:
        config = json.loads((ROOT / 'slots.json').read_text())
        return config.get('secondary_address', '').lower() == address and slots_valid()
    except (OSError, AttributeError, ValueError):
        return False


def refresh_existing_link(controller, policy, address):
    if not slot_identities_valid(address):
        print('Remote 3 reconnect blocked: receiver slot identities are invalid', flush=True)
        return
    devices = api('device/getStatus', {}, service='com.webos.service.bluetooth2').get('devices', [])
    receive(controller, policy)
    existing = next((d for d in devices if d.get('address', '').lower() == address
                     and d.get('paired') is True and 'hid' in d.get('connectedProfiles', [])), None)
    if existing and policy.handle is None:
        print('Remote 3 existing link retained; timing discovery waits for the next connection', flush=True)


def reconnect_sleeping_remote(address, policy=None):
    if policy is not None and policy.disconnecting:
        return
    if not slot_identities_valid(address):
        return
    state = api('power/getPowerState', {}, service='com.webos.service.tvpower')
    if state.get('state') != 'Active' or state.get('processing'):
        return
    devices = api('device/getStatus', {}, service='com.webos.service.bluetooth2').get('devices', [])
    peer = next((device for device in devices if device.get('address', '').lower() == address), None)
    if (peer and peer.get('paired') is True and not peer.get('pairing') and not peer.get('blocked')
            and 'hid' not in peer.get('connectedProfiles', [])):
        if 'gatt' in peer.get('connectedProfiles', []):
            return
        if policy is not None:
            policy.clear()
        api('gatt/connect', {'address': address}, service='com.webos.service.bluetooth2')
        print('Remote 3 BLE reconnect requested', flush=True)


class ReconnectPolicy:
    def __init__(self):
        self.due = 0
        self.delay = 5

    def update(self, address, policy, now):
        if now < self.due:
            return
        try:
            reconnect_sleeping_remote(address, policy)
        except (OSError, ValueError, RuntimeError) as error:
            print('Remote 3 reconnect failed: ' + str(error), flush=True)
            self.due = now + self.delay
            self.delay = min(60, self.delay * 2)
        else:
            self.delay = 5
            self.due = now + 5


def repair_receiver_attachment(address, policy=None):
    if (not slot_identities_valid(address) or policy is None
            or policy.handle is None or policy.disconnecting):
        return False
    state = api('power/getPowerState', {}, service='com.webos.service.tvpower')
    if state.get('state') != 'Active' or state.get('processing'):
        return False
    devices = api('device/getStatus', {}, service='com.webos.service.bluetooth2').get('devices', [])
    peer = next((device for device in devices if device.get('address', '').lower() == address), None)
    if not (peer and peer.get('paired') is True and not peer.get('pairing') and not peer.get('blocked')
            and 'hid' in peer.get('connectedProfiles', [])):
        return False
    api('hid/disconnect', {'address': address}, service='com.webos.service.bluetooth2')
    policy.disconnecting = True
    print('Remote 3 attachment repair waiting for disconnect completion', flush=True)
    return True


def main():
    address = json.loads((ROOT / 'link.json').read_text())['bluetooth_address'].lower()
    policy = LinkPolicy(address)
    inputs = MotionInputs(address)
    receiver = ReceiverInputs()
    attachment = AttachmentPolicy()
    reconnect = ReconnectPolicy()
    next_attachment_check = time.monotonic() + 1
    with open_controller() as controller:
        try:
            refresh_existing_link(controller, policy, address)
        except (OSError, ValueError, RuntimeError) as error:
            print('Remote 3 link discovery failed: ' + str(error), flush=True)
        while True:
            inputs.scan(time.monotonic())
            receiver.scan(time.monotonic())
            ready, _, _ = select.select([controller] + list(inputs.descriptors.values())
                                        + list(receiver.descriptors.values()), [], [], .5)
            receive(controller, policy)
            inputs.receive(ready, time.monotonic())
            receiver.receive(ready, time.monotonic())
            policy.activity(inputs.activity.active(time.monotonic()), time.monotonic())
            command = policy.request(time.monotonic())
            if command:
                controller.send(command)
                print('Remote 3 requested {} ms link with latency {}'.format(
                    policy.desired[0] * 1.25, policy.desired[1]), flush=True)
            reconnect.update(address, policy, time.monotonic())
            now = time.monotonic()
            if policy.handle is not None and now >= next_attachment_check:
                reported = inputs.last_report is not None and now - inputs.last_report < 3
                attached = receiver_has_hidraw(address) or receiver.active(now)
                if attachment.update(reported, attached, now):
                    try:
                        repair_receiver_attachment(address, policy)
                    except (OSError, ValueError, RuntimeError) as error:
                        print('Remote 3 attachment repair failed: ' + str(error), flush=True)
                next_attachment_check = now + 1


if __name__ == '__main__':
    main()
