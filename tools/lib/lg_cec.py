"""Send HDMI 1 wake commands through the TV's existing Linux CEC adapter.

Uses non-exclusive initiator mode. Never claims addresses or changes TV CEC
configuration. A discrete Power On is sent only to a device reporting 1.0.0.0.
"""
import fcntl
import os
import struct
import time

HDMI1 = 0x1000
PLAYBACK_FIRST = (4, 8, 11, 1, 2, 3, 5, 6, 7, 9, 10, 12, 13, 14)


class CecAdapter:
    def __enter__(self):
        self.fd = os.open('/dev/cec0', os.O_RDWR | os.O_CLOEXEC)
        try:
            physical, logical = bytearray(2), bytearray(92)
            fcntl.ioctl(self.fd, 0x80026101, physical, True)
            fcntl.ioctl(self.fd, 0x805c6103, logical, True)
            if struct.unpack('<H', physical)[0] != 0 or not struct.unpack_from('<H', logical, 4)[0] & 1:
                raise RuntimeError('CEC adapter is not configured as the TV')
        except BaseException:
            os.close(self.fd)
            raise
        return self

    def __exit__(self, *_):
        os.close(self.fd)

    def transmit(self, destination, payload, reply=0):
        if not 0 <= destination <= 15 or not 1 <= len(payload) <= 15:
            raise ValueError('Invalid CEC message')
        packet = bytes([destination, *payload])
        message = bytearray(56)
        struct.pack_into('<II', message, 16, len(packet), 500 if reply else 0)
        message[32:32 + len(packet)] = packet
        message[48] = reply
        fcntl.ioctl(self.fd, 0xc0386105, message, True)
        length = struct.unpack_from('<I', message, 16)[0]
        if not 1 <= length <= 16:
            raise RuntimeError('Invalid CEC response length')
        return {'tx_ok': bool(message[50] & 1), 'rx_ok': bool(message[49] & 1),
                'bytes': bytes(message[32:32 + length]), 'tx_status': message[50]}


def hdmi1_device(adapter):
    for address in PLAYBACK_FIRST:
        result = adapter.transmit(address, [0x83], reply=0x84)
        data = result['bytes']
        if (result['tx_ok'] and result['rx_ok'] and len(data) == 5
                and data[0] >> 4 == address and data[1] == 0x84
                and int.from_bytes(data[2:4], 'big') == HDMI1):
            return address
    return None


def wake_hdmi1(adapter, sleep=time.sleep):
    route = adapter.transmit(15, [0x86, 0x10, 0x00])
    if not route['tx_ok']:
        raise RuntimeError('HDMI-CEC routing transmission failed')
    address = hdmi1_device(adapter)
    result = {'routing_sent': True, 'logical_address': address,
              'power_on_sent': False, 'power_on_confirmed': False}
    if address is None:
        return result
    try:
        pressed = adapter.transmit(address, [0x44, 0x6d])
    finally:
        released = adapter.transmit(address, [0x45])
    result['power_on_sent'] = pressed['tx_ok'] and released['tx_ok']
    if not result['power_on_sent']:
        return result
    for _ in range(3):
        status = adapter.transmit(address, [0x8f], reply=0x90)
        data = status['bytes']
        if (status['rx_ok'] and len(data) == 3 and data[0] >> 4 == address
                and data[1] == 0x90 and data[2] == 0):
            result['power_on_confirmed'] = True
            break
        sleep(.25)
    return result
