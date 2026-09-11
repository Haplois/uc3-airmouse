import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'tools/lib/lg_power_key.py'
spec = importlib.util.spec_from_file_location('power_key', source)
module = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'startup': types.SimpleNamespace(api=None, ROOT=Path('/unused'))}):
    spec.loader.exec_module(module)


def report(key):
    packet = bytearray(20)
    packet[0] = 0xfd
    packet[17:19] = key.to_bytes(2, 'big')
    return packet


class PowerKeyTest(unittest.TestCase):
    def test_all_app_shortcuts_have_explicit_routes(self):
        expected = {0x7f03: 'com.webos.app.quicksettings', 0x7f04: 'com.palm.app.settings',
                    0x7f05: 'com.webos.app.quickinputpicker', 0x7f06: 'com.webos.app.hdmi1',
                    0x7f07: 'netflix', 0x7f08: 'youtube.leanback.v4'}
        self.assertEqual(module.APP_ACTIONS, expected)
        with patch.object(module, 'api') as api:
            for code, app in expected.items():
                api.reset_mock()
                module.control_action(code)
                api.assert_called_once_with('launch', {'id': app},
                                            service='com.webos.service.applicationmanager')

    def test_volume_stop_and_toggle_are_distinct_tv_commands(self):
        expected = [(0x7f0a, 'sendKeyCodes', {'keyCode1': 164}, 'com.webos.service.networkinput'),
                    (0x7f0e, 'controls/stop', {}, 'com.webos.service.networkinput'),
                    (0x7f0b, 'volumeUp', {}, 'com.webos.audio'),
                    (0x7f0c, 'volumeDown', {}, 'com.webos.audio')]
        with patch.object(module, 'api') as api:
            for code, method, body, service in expected:
                api.reset_mock()
                module.control_action(code)
                api.assert_called_once_with(method, body, service=service)

    def test_mute_toggles_actual_tv_state_and_rejects_unknown_state(self):
        for muted in (True, False):
            with patch.object(module, 'api', return_value={'muteStatus': muted}) as api:
                module.media_action(0x7f0d)
                self.assertEqual(api.call_args_list[1].args, ('setMuted', {'muted': not muted}))
        with patch.object(module, 'api', return_value={}):
            with self.assertRaises(RuntimeError):
                module.media_action(0x7f0d)

    def test_steam_selects_hdmi1_and_does_not_start_concurrent_cec_jobs(self):
        with patch.object(module, 'api') as api, patch.object(module.threading, 'Thread') as thread:
            try:
                module.control_action(0x7f09)
                module.control_action(0x7f09)
                thread.assert_called_once_with(target=module.steam_wake, daemon=True)
                thread.return_value.start.assert_called_once()
                self.assertEqual(api.call_args.args, ('launch', {'id': 'com.webos.app.hdmi1'}))
            finally:
                module.STEAM_LOCK.release()

    def test_input_command_does_not_trigger_power_or_repeat_while_held(self):
        power, next_key = module.PowerKey(), module.PowerKey(0x7f01, .2)
        self.assertFalse(power.press(report(0x7f01), 0))
        self.assertTrue(next_key.press(report(0x7f01), 0))
        self.assertFalse(next_key.press(report(0x7f01), 1))
        self.assertFalse(next_key.press(report(0), 1.1))
        self.assertTrue(next_key.press(report(0x7f01), 1.2))

    def test_input_cycle_wraps_in_port_order_and_skips_disconnected_ports(self):
        devices = [{'id': 'HDMI_' + str(port), 'port': port,
                    'appId': 'com.webos.app.hdmi' + str(port), 'connected': port != 2}
                   for port in (4, 2, 1, 3)]
        self.assertEqual(module.next_input(devices, 'HDMI_1', 1)['id'], 'HDMI_3')
        self.assertEqual(module.next_input(devices, 'HDMI_1', -1)['id'], 'HDMI_4')
        self.assertEqual(module.next_input(devices, 'HDMI_4', 1)['id'], 'HDMI_1')
        self.assertEqual(module.next_input(devices, 'UNKNOWN', -1)['id'], 'HDMI_4')
        self.assertEqual(module.next_input(devices, 'UNKNOWN', 1)['id'], 'HDMI_1')
        with self.assertRaisesRegex(ValueError, 'No connected'):
            module.next_input([], 'HDMI_1', 1)

    def test_input_switch_uses_current_tv_state_and_launches_selected_port(self):
        calls = []
        def api(method, body, *, service):
            calls.append((service, method, body))
            if method == 'getAllInputStatus':
                return {'devices': [{'id': 'HDMI_2', 'port': 2, 'appId': 'com.webos.app.hdmi2', 'connected': True}]}
            if method == 'getCurrentInput':
                return {'mainInputSourceId': 'HDMI_1'}
            return {'returnValue': True}
        with patch.object(module, 'api', api):
            module.switch_input(1)
        self.assertEqual(calls[-1], ('com.webos.service.applicationmanager', 'launch', {'id': 'com.webos.app.hdmi2'}))

    def test_one_action_per_press_despite_motion_and_repeated_reports(self):
        key = module.PowerKey()
        self.assertTrue(key.press(report(0x8008), 0))
        self.assertFalse(key.press(report(0x8008), 2))
        self.assertFalse(key.press(report(0), 2.1))
        self.assertTrue(key.press(report(0x8008), 3))

    def test_other_keys_and_malformed_reports_do_not_control_power(self):
        key = module.PowerKey()
        for packet in [b'', bytes(20), report(0x8040), report(0x803e), report(0x803f)]:
            self.assertFalse(key.press(packet, 0))

    def test_bounce_does_not_toggle_twice(self):
        key = module.PowerKey()
        self.assertTrue(key.press(report(0x8008), 0))
        self.assertFalse(key.press(report(0), .1))
        self.assertFalse(key.press(report(0x8008), .2))


if __name__ == '__main__':
    unittest.main()
