import importlib.util
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'tools/lib/lg_link.py'
spec = importlib.util.spec_from_file_location('lg_link', source)
module = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'startup': types.SimpleNamespace(
        api=None, ROOT=Path('/unused'), slots_valid=lambda: True)}):
    spec.loader.exec_module(module)

PEER = '02:00:00:00:00:02'


def event(code, data):
    return bytes((4, code, len(data))) + data


def connected(peer=PEER, handle=512, enhanced=False):
    data = struct.pack('<BHBB', 0, handle, 0, 1) + bytes.fromhex(peer.replace(':', ''))[::-1]
    if enhanced:
        data += bytes(12)
    data += struct.pack('<3HB', 8, 4, 300, 0)
    return event(0x3e, bytes((10 if enhanced else 1,)) + data)


def updated(handle=512, interval=16, latency=2, status=0):
    return event(0x3e, struct.pack('<BB4H', 3, status, handle, interval, latency, 300))


class LinkTest(unittest.TestCase):
    def setUp(self):
        self.policy = module.LinkPolicy(PEER)
        patcher = patch.object(module, 'slot_identities_valid', return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_rest_relaxes_link_and_new_motion_restores_fast_timing_immediately(self):
        self.policy.observe(connected(), 0)
        self.policy.activity(False, 20)
        self.assertEqual(struct.unpack('<7H', self.policy.request(20)[4:]), (512, 24, 24, 2, 300, 0, 0))
        self.policy.observe(updated(interval=24, latency=2), 21)
        self.assertIsNone(self.policy.request(25))
        self.policy.activity(True, 26)
        self.assertEqual(struct.unpack('<7H', self.policy.request(26)[4:]), (512, 8, 8, 0, 300, 0, 0))
        self.policy.observe(updated(interval=8, latency=0), 27)
        self.assertIsNone(self.policy.request(30))

    def test_motion_reports_handle_midstream_attach_stop_release_and_key_wake(self):
        activity = module.MotionActivity()
        def report(key=0, pointing=False):
            data = bytearray(20)
            data[0] = 0xfd
            data[3] = 1 if pointing else 2
            data[17:19] = key.to_bytes(2, 'big')
            return data
        activity.observe(report(pointing=True), 100)
        self.assertTrue(activity.active(110))
        activity.observe(report(0x803f), 111)
        activity.observe(report(), 112)
        self.assertFalse(activity.active(112))
        activity.observe(report(0x8000), 113)
        self.assertTrue(activity.active(113))
        self.assertFalse(activity.active(134))
        activity.observe(report(0x803e), 135)
        self.assertTrue(activity.active(135))
        activity.observe(report(), 150)
        self.assertTrue(activity.active(165))
        activity.observe(report(0x803f), 166)
        for now in (167, 167.02, 167.04):
            activity.observe(report(), now)
        self.assertTrue(activity.active(167.04))

    def test_reconnect_only_targets_paired_remote_while_tv_is_active(self):
        calls = []
        state = {'state': 'Active'}
        peer = {'address': PEER, 'paired': True, 'connectedProfiles': []}
        def api(method, body, **kwargs):
            calls.append((method, body))
            if method == 'power/getPowerState': return state
            if method == 'device/getStatus': return {'devices': [peer]}
            return {}
        with patch.object(module, 'api', api):
            module.reconnect_sleeping_remote(PEER)
            self.assertEqual(calls[-1], ('gatt/connect', {'address': PEER}))
            for change in ({'paired': False}, {'blocked': True}, {'pairing': True},
                           {'connectedProfiles': ['hid']}, {'connectedProfiles': ['gatt']}):
                before = dict(peer); peer.update(change); calls.clear()
                module.reconnect_sleeping_remote(PEER)
                self.assertNotIn('gatt/connect', [method for method, _ in calls])
                peer.clear(); peer.update(before)
            state['state'] = 'Active Standby'; calls.clear()
            module.reconnect_sleeping_remote(PEER)
            self.assertEqual(calls, [('power/getPowerState', {})])

    def test_observed_tv_default_changes_after_settle_and_acknowledgment_stops_requests(self):
        self.policy.observe(connected(), 0)
        self.policy.observe(updated(), .5)
        self.assertIsNone(self.policy.request(3))
        command = self.policy.request(3.5)
        self.assertEqual(command[:4], b'\x01\x13\x20\x0e')
        self.assertEqual(struct.unpack('<7H', command[4:]), (512, 8, 8, 0, 300, 0, 0))
        self.assertIsNone(self.policy.request(4))
        self.policy.observe(updated(interval=8, latency=0), 4)
        self.assertIsNone(self.policy.request(30))

    def test_other_peer_and_unknown_handle_updates_never_trigger_commands(self):
        self.policy.observe(connected('02:00:00:00:00:01'), 0)
        self.policy.observe(updated(), 1)
        self.assertIsNone(self.policy.request(20))

    def test_handle_reused_by_original_remote_clears_pending_update(self):
        self.policy.observe(connected(), 0)
        self.policy.observe(connected('02:00:00:00:00:01'), 1)
        self.assertIsNone(self.policy.request(4))

    def test_disconnect_and_controller_reset_clear_identity(self):
        for packet in (event(5, struct.pack('<BHB', 0, 512, 19)), event(0x0e, b'\x01\x03\x0c\x00')):
            self.policy.observe(connected(), 0)
            self.policy.observe(packet, 1)
            self.assertIsNone(self.policy.request(4))

    def test_retries_are_bounded_and_reset_only_on_a_fresh_connection(self):
        self.policy.observe(connected(), 0)
        for now in (3, 8, 13):
            self.assertIsNotNone(self.policy.request(now))
        self.assertIsNone(self.policy.request(100))
        self.policy.observe(updated(status=0x3b), 101)
        self.assertIsNone(self.policy.request(110))
        self.policy.observe(connected(handle=513, enhanced=True), 120)
        self.assertEqual(struct.unpack_from('<H', self.policy.request(123), 4)[0], 513)

    def test_malformed_events_do_not_create_a_connection(self):
        packet = connected()
        for length in range(len(packet)):
            self.policy.observe(packet[:length], 0)
        self.assertIsNone(self.policy.request(20))

    def test_existing_link_is_never_disconnected_at_helper_start(self):
        calls = []
        def api(method, body, **kwargs):
            calls.append((method, body))
            if method == 'power/getPowerState':
                return {'state': 'Active'}
            return {'devices': [{'address': PEER, 'paired': True, 'connectedProfiles': ['hid']}]}
        with patch.object(module, 'api', api), patch.object(module, 'receive'), patch.object(module.time, 'sleep'):
            module.refresh_existing_link(None, self.policy, PEER)
            self.assertEqual(calls, [('device/getStatus', {})])
            calls.clear()
            self.policy.observe(connected(), 0)
            module.refresh_existing_link(None, self.policy, PEER)
            self.assertEqual(len(calls), 1)

    def test_helper_start_during_standby_does_not_reconnect(self):
        calls = []
        def api(method, body, **kwargs):
            calls.append(method)
            if method == 'power/getPowerState':
                return {'state': 'Active Standby'}
            return {'devices': [{'address': PEER, 'paired': True, 'connectedProfiles': ['hid']}]}
        with patch.object(module, 'api', api), patch.object(module, 'receive'):
            module.refresh_existing_link(None, self.policy, PEER)
        self.assertEqual(calls, ['device/getStatus'])

    def test_raw_reports_without_a_receiver_binding_trigger_one_delayed_refresh(self):
        policy = module.AttachmentPolicy(grace=2)
        self.assertFalse(policy.update(True, False, 10))
        self.assertFalse(policy.update(False, False, 11.9))
        self.assertTrue(policy.update(False, False, 12))
        self.assertFalse(policy.update(False, False, 20))
        self.assertFalse(policy.update(True, True, 21))

    def test_receiver_output_activity_is_observed_by_slot_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sysfs, devices = root / 'sys', root / 'dev'
            (sysfs / 'event7/device').mkdir(parents=True)
            devices.mkdir()
            (sysfs / 'event7/device/name').write_text('LGE M-RCU - Builtin [1]\n')
            (devices / 'event7').write_bytes(b'input-event')
            receiver = module.ReceiverInputs(sysfs, devices)
            receiver.scan(10)
            self.assertEqual(len(receiver.descriptors), 1)
            receiver.receive(list(receiver.descriptors.values()), 11)
            self.assertTrue(receiver.active(13.9))
            self.assertFalse(receiver.active(14))

    def test_attachment_repairs_have_a_cooldown_even_after_new_reports(self):
        policy = module.AttachmentPolicy(grace=2, cooldown=60)
        self.assertFalse(policy.update(True, False, 0))
        self.assertTrue(policy.update(True, False, 2))
        for now in range(3, 62):
            self.assertFalse(policy.update(True, False, now))
        self.assertTrue(policy.update(True, False, 62))

    def test_live_receiver_descriptor_is_authoritative_without_saved_hidraw_field(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = root / 'proc/123'
            (process / 'fd').mkdir(parents=True)
            (process / 'comm').write_text('lginput2\n')
            (process / 'fd/19').symlink_to('/dev/hidraw0')
            device = root / 'hidraw/hidraw0/device'
            device.mkdir(parents=True)
            (device / 'uevent').write_text('HID_UNIQ=' + PEER + '\n')
            self.assertTrue(module.receiver_has_hidraw(PEER, root / 'proc', root / 'hidraw'))
            self.assertFalse(module.receiver_has_hidraw('02:00:00:00:00:01', root / 'proc', root / 'hidraw'))
            (process / 'comm').write_text('unrelated\n')
            self.assertFalse(module.receiver_has_hidraw(PEER, root / 'proc', root / 'hidraw'))

    def test_receiver_output_ignores_other_slots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sysfs, devices = root / 'sys', root / 'dev'
            (sysfs / 'event4/device').mkdir(parents=True)
            devices.mkdir()
            (sysfs / 'event4/device/name').write_text('LGE M-RCU - Builtin [0]\n')
            receiver = module.ReceiverInputs(sysfs, devices)
            receiver.scan(10)
            self.assertEqual(receiver.descriptors, {})

    def test_receiver_binding_requires_the_configured_address_and_live_hidraw(self):
        with tempfile.TemporaryDirectory() as directory:
            info = Path(directory) / 'mrcu2.info'
            contents = 'BDAddr = ' + PEER + '\nhidraw = /dev/hidraw1\n'
            info.write_text(contents)
            hidraw = Path(directory) / 'hidraw'
            (hidraw / 'hidraw1/device').mkdir(parents=True)
            (hidraw / 'hidraw1/device/uevent').write_text('HID_UNIQ=' + PEER + '\n')
            self.assertTrue(module.receiver_attached(PEER, info, hidraw))
            self.assertFalse(module.receiver_attached('02:00:00:00:00:01', info, hidraw))

    def test_attachment_repair_refreshes_only_the_connected_configured_remote(self):
        calls = []
        peer = {'address': PEER, 'paired': True, 'connectedProfiles': ['hid']}
        def api(method, body, **kwargs):
            calls.append((method, body))
            if method == 'power/getPowerState': return {'state': 'Active'}
            if method == 'device/getStatus': return {'devices': [peer]}
            return {}
        self.policy.observe(connected(), 0)
        with patch.object(module, 'api', api):
            self.assertTrue(module.repair_receiver_attachment(PEER, self.policy))
        self.assertEqual(calls[-1], ('hid/disconnect', {'address': PEER}))
        self.assertNotIn('gatt/connect', [method for method, _ in calls])
        self.assertTrue(self.policy.disconnecting)
        self.policy.observe(event(5, struct.pack('<BHB', 0, 512, 19)), 1.27)
        self.assertFalse(self.policy.disconnecting)

    def test_recovery_ignores_stale_handle_but_waits_for_requested_disconnect(self):
        self.policy.observe(connected(), 0)
        peer = {'address': PEER, 'paired': True, 'connectedProfiles': []}
        def api(method, body, **kwargs):
            return {'state': 'Active'} if method == 'power/getPowerState' else {'devices': [peer]}
        with patch.object(module, 'api', side_effect=api) as call:
            self.policy.disconnecting = True
            module.reconnect_sleeping_remote(PEER, self.policy)
            call.assert_not_called()
            self.policy.disconnecting = False
            module.reconnect_sleeping_remote(PEER, self.policy)
            self.assertIsNone(self.policy.handle)
            self.assertEqual(call.call_args.args[0], 'gatt/connect')

    def test_failed_reconnects_retry_with_capped_backoff_and_log_errors(self):
        recovery = module.ReconnectPolicy()
        with patch.object(module, 'reconnect_sleeping_remote', side_effect=RuntimeError('offline')) as connect, \
                patch('builtins.print') as log:
            for now, due in ((0, 5), (5, 15), (15, 35), (35, 75), (75, 135), (135, 195)):
                recovery.update(PEER, self.policy, now)
                self.assertEqual(recovery.due, due)
                count = connect.call_count
                recovery.update(PEER, self.policy, due - .1)
                self.assertEqual(connect.call_count, count)
            self.assertEqual(log.call_count, 6)
        with patch.object(module, 'reconnect_sleeping_remote') as connect:
            recovery.update(PEER, self.policy, 195)
            connect.assert_called_once_with(PEER, self.policy)
            self.assertEqual(recovery.delay, 5)

    def test_delayed_disconnect_completion_controls_reconnect_not_elapsed_sleep(self):
        self.policy.observe(connected(), 0)
        self.policy.disconnecting = True
        peer = {'address': PEER, 'paired': True, 'connectedProfiles': []}
        def api(method, body, **kwargs):
            return {'state': 'Active'} if method == 'power/getPowerState' else {'devices': [peer]}
        recovery = module.ReconnectPolicy()
        with patch.object(module, 'api', side_effect=api) as call:
            for now in (1, 6, 11):
                recovery.update(PEER, self.policy, now)
            call.assert_not_called()
            self.policy.observe(event(5, struct.pack('<BHB', 0, 512, 19)), 12)
            recovery.update(PEER, self.policy, 16)
            self.assertEqual(call.call_args.args[0], 'gatt/connect')

    def test_invalid_slot_identities_block_all_reconnect_operations(self):
        calls = []
        with patch.object(module, 'slot_identities_valid', return_value=False), \
                patch.object(module, 'api', side_effect=lambda *args, **kwargs: calls.append(args)):
            module.refresh_existing_link(None, self.policy, PEER)
            module.reconnect_sleeping_remote(PEER)
            self.assertFalse(module.repair_receiver_attachment(PEER))
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
