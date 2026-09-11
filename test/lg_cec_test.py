import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('lg_cec', Path(__file__).resolve().parents[1] / 'tools/lib/lg_cec.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Adapter:
    def __init__(self, devices=None, power=0, fail_press=False):
        self.devices = devices or {}
        self.power = power
        self.fail_press = fail_press
        self.calls = []

    def transmit(self, address, payload, reply=0):
        self.calls.append((address, payload, reply))
        data = b''
        if payload == [0x83] and address in self.devices:
            data = bytes([address << 4 | 15, 0x84, *self.devices[address].to_bytes(2, 'big'), 4])
        elif payload == [0x8f]:
            data = bytes([address << 4, 0x90, self.power])
        elif payload == [0x44, 0x6d] and self.fail_press:
            raise OSError('transmit failed')
        return {'tx_ok': address == 15 or address in self.devices, 'rx_ok': bool(data), 'bytes': data}


class CecTest(unittest.TestCase):
    def test_only_hdmi1_receives_discrete_power_on_and_release(self):
        adapter = Adapter({4: 0x2000, 8: 0x1000})
        result = module.wake_hdmi1(adapter, sleep=lambda _: None)
        self.assertTrue(result['power_on_confirmed'])
        self.assertEqual(result['logical_address'], 8)
        self.assertEqual(adapter.calls[0], (15, [0x86, 0x10, 0], 0))
        power = [(address, payload) for address, payload, _ in adapter.calls if payload[0] in (0x44, 0x45)]
        self.assertEqual(power, [(8, [0x44, 0x6d]), (8, [0x45])])

    def test_no_acknowledgement_never_claims_power_on_or_targets_another_input(self):
        adapter = Adapter({4: 0x2000})
        result = module.wake_hdmi1(adapter)
        self.assertTrue(result['routing_sent'])
        self.assertIsNone(result['logical_address'])
        self.assertFalse(result['power_on_sent'])
        self.assertFalse(result['power_on_confirmed'])
        self.assertFalse(any(payload[0] == 0x44 for _, payload, _ in adapter.calls))

    def test_acknowledged_command_is_not_proof_of_wake(self):
        result = module.wake_hdmi1(Adapter({4: 0x1000}, power=1), sleep=lambda _: None)
        self.assertTrue(result['power_on_sent'])
        self.assertFalse(result['power_on_confirmed'])

    def test_failed_press_still_releases_key(self):
        adapter = Adapter({4: 0x1000}, fail_press=True)
        with self.assertRaises(OSError):
            module.wake_hdmi1(adapter)
        self.assertEqual(adapter.calls[-1], (4, [0x45], 0))


if __name__ == '__main__':
    unittest.main()
