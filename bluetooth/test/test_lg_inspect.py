import pathlib
import random
import runpy
import struct
import unittest

inspect = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[2] / 'tools/airmouse-lg-inspect'))
motion = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[2] / 'tools/airmouse-lg-align-motion'))
header = b'btsnoop\0' + struct.pack('>II', 1, 1002)


def record(packet):
    return struct.pack('>IIIIQ', len(packet), len(packet), 0, 0, 0) + packet


class InspectTest(unittest.TestCase):
    def test_alignment_recovers_rotation_and_clock_offset(self):
        rng = random.Random(23)
        sensor, lg = [], []
        for index in range(120):
            gyro = [rng.uniform(-1, 1) for _ in range(3)]
            accel = [rng.uniform(-9, 9) for _ in range(3)]
            time = 1000 + index * 0.05
            sensor.append({'wall_time': time, 'gyro': gyro, 'accel': accel})
            lg.append({'wall_time': time - 0.85, 'gyro': [800 * gyro[1], -800 * gyro[0], 800 * gyro[2]],
                       'accel': [400 * accel[1], -400 * accel[0], 400 * accel[2]]})
        result = motion['align'](sensor, lg)
        self.assertTrue(result['all_axes_supported'])
        self.assertEqual(result['source_axes'], [1, 0, 2])
        self.assertEqual(result['signs'], [1, -1, 1])
        self.assertAlmostEqual(result['lg_time_minus_remote3_seconds'], -0.85)
        self.assertGreater(result['score'], 0.999)
        with self.assertRaises(ValueError):
            motion['align']([], lg)

    def test_motion_sessions_separate_reused_handles_and_sleep_phases(self):
        def monitor(opcode, payload):
            packet = struct.pack('<HHH', opcode, 0, len(payload)) + payload
            return struct.pack('>QI', 100, len(packet)) + packet

        def connect(address):
            return monitor(3, b'\x3e\x13\x01\x00\x01\x02\x00\x00' + bytes.fromhex(address)[::-1] + bytes(7))

        def att(opcode, value):
            return monitor(opcode, struct.pack('<HHHH', 0x2201, len(value) + 4, len(value), 4) + value)

        motion = b'\x1b\x25\x00' + bytes([0xc4, 0, 0xfe, 0xff]) + struct.pack('>hhhhhh', 500, 0, 0, 0, 0, -4096) + bytes(3)
        capture = b'AMHCI1\0\0' + connect('123456789abc')
        capture += att(4, b'\x52\x2d\x00\x02') + att(5, motion)
        capture += att(5, b'\x1b\x1e\x00PRIVATE-PAYLOAD')
        capture += monitor(3, b'\x05\x04\x00\x01\x02\x13')
        capture += connect('abcdef123456') + att(5, motion)
        capture += connect('123456789abc') + att(4, b'\x52\x2d\x00\x01')
        result = inspect['summarize_motion_sessions'](capture, '12:34:56:78:9a:bc', 0x25, 0x2d)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]['disconnect_reason'], 0x13)
        self.assertEqual(result[0]['phases'][0]['tv_command'], 2)
        self.assertEqual(result[0]['phases'][0]['mode_counts'], {'2': 1})
        self.assertEqual(result[0]['phases'][0]['moving_navigation_reports'], 1)
        self.assertEqual(result[1]['phases'][0]['tv_command'], 1)
        self.assertEqual(result[1]['phases'][0]['motion_reports'], 0)
        self.assertNotIn('PRIVATE', str(result))

    def test_motion_events_and_sequence_loss_exclude_keys_and_reset_on_start(self):
        def monitor(opcode, payload):
            packet = struct.pack('<HHH', opcode, 0, len(payload)) + payload
            return struct.pack('>QI', 100, len(packet)) + packet
        capture = b'AMHCI1\0\0' + monitor(3, b'\x3e\x13\x01\x00\x01\x02\x00\x00' + bytes.fromhex('bc9a78563412') + bytes(7))
        for sequence, mode, key in [(0, 2, 0x803e), (1, 1, 0), (1, 1, 0x8006),
                                    (3, 1, 0), (3, 2, 0x803f), (0, 2, 0x803e), (1, 1, 0)]:
            value = b'\x1b\x22\x00' + bytes([0xc4, sequence, 0xfc | mode, 0xff]) + bytes(12) + struct.pack('>HB', key, 0)
            capture += monitor(5, struct.pack('<HHHH', 0x2201, len(value)+4, len(value), 4) + value)
        phase = inspect['summarize_motion_sessions'](capture, '12:34:56:78:9a:bc', 0x22, 0x2c)[0]['phases'][0]
        self.assertEqual(phase['sequence_gaps'], 1)
        self.assertEqual(phase['repeated_motion_sequences'], 0)
        self.assertEqual([(event['event'], event['sequence']) for event in phase['motion_events']],
                         [('start', 0), ('stop', 3), ('start', 0)])

    def test_monitor_capture_is_complete_and_omits_payload(self):
        att = b'\x1b\x22\x00PRIVATE-PAYLOAD'
        acl = struct.pack('<HHHH', 0x2201, len(att) + 4, len(att), 4) + att
        packet = struct.pack('<HHH', 5, 0, len(acl)) + acl
        capture = b'AMHCI1\0\0' + struct.pack('>QI', 100, len(packet)) + packet
        result = inspect['summarize_monitor'](capture)
        self.assertEqual(result['records'], 1)
        self.assertFalse(result['incomplete_tail'])
        self.assertEqual(result['att_adapter_direction_connection_attribute_payload_length_counts'], {'0:5:513:34:15': 1})
        self.assertNotIn('PRIVATE', str(result))
        self.assertTrue(inspect['summarize_monitor'](capture[:-1])['incomplete_tail'])
        with self.assertRaises(ValueError):
            inspect['summarize_monitor'](b'invalid')

    def test_summarizes_without_exposing_payloads(self):
        att = b'\x1b\x18\x00PRIVATE-PAYLOAD'
        packet = b'\x02' + struct.pack('<HHHH', 0x2200, len(att) + 4, len(att), 4) + att
        summary = inspect['summarize_snoop'](header + record(packet))
        self.assertEqual(summary['att_handle_attribute_payload_length_counts'], {'512:24:15': 1})
        self.assertNotIn('PRIVATE', str(summary))

    def test_handles_live_capture_truncation(self):
        self.assertTrue(inspect['summarize_snoop'](header + b'\0')['incomplete_tail'])
        with self.assertRaises(ValueError):
            inspect['summarize_snoop'](b'not a capture')

    def test_stack_only_emits_allowlisted_metadata(self):
        result = inspect['summarize_stack']('vendor_id = 0x f product_id = 0x3412\n'
            '<--- Register Report ID: 1\n<--- Register Report ID: 2\ndscp_len = 91\nLinkKey=SECRET')
        self.assertEqual(result, {'hid_identities': ['000f:3412'], 'registered_input_report_ids': [1, 2], 'descriptor_lengths': [91]})


if __name__ == '__main__':
    unittest.main()
