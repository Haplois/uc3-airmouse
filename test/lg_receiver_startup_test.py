import importlib.util
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'tools/lib/lg_receiver_startup.py'


class StartupTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('startup', SOURCE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.module.ROOT = Path(self.directory.name)
        self.module.TARGET = self.module.ROOT / 'target'
        self.module.MRCU = self.module.ROOT / 'mrcu'
        self.module.MRCU.mkdir()
        self.current = self.module.STOCK
        self.commands = []
        self.api_calls = []
        self.fail_start = False
        self.active_state = 'active'
        self.dropin = self.module.ROOT / 'unit.conf'
        self.real_digest = self.module.digest
        for name, replacement in [('run', self.run_command), ('digest', self.digest),
                                  ('api', self.api), ('dropins', lambda: {self.dropin: 'unit'})]:
            patcher = patch.object(self.module, name, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def digest(self, path):
        if path == self.module.TARGET:
            return self.current
        if path == self.module.ROOT / 'lginput2' or str(path).startswith('/proc/'):
            return self.module.PATCHED
        return self.real_digest(path)

    def slots(self, primary='02:00:00:00:00:01', secondary='02:00:00:00:00:02'):
        for number, address in ((1, primary), (2, secondary)):
            (self.module.MRCU / f'mrcu{number}.info').write_text(
                f'Name = LGE MR23\nBDAddr = {address}\nhidraw = /dev/hidraw{number}\n')
            (self.module.MRCU / f'mrcu{number}.scd').write_bytes(
                b'\x01SCD 21.2,BA 35,webOS\0' + address.encode() + b'\0')

    def api(self, method, body):
        self.api_calls.append((method, body))
        return {'returnValue': True}

    def run_command(self, *args):
        self.commands.append(args)
        if args[:2] == ('mount', '--bind'):
            self.current = self.module.PATCHED
        if args[0] == 'umount':
            self.current = self.module.STOCK
        if args == ('systemctl', 'start', self.module.RECEIVER):
            self.module.mount()
            if self.fail_start:
                raise RuntimeError('startup failure')
            self.module.enable()
        if args[:2] == ('systemctl', 'is-active'):
            if self.active_state != 'active':
                raise subprocess.CalledProcessError(3, args, output=self.active_state.encode())
            return 'active'
        if args[:2] == ('systemctl', 'show'):
            if 'ActiveState' in args:
                return self.active_state
            return '123'
        return ''

    def test_stock_boot_enables_dual_before_bluetooth(self):
        self.module.boot()
        self.assertEqual(self.current, self.module.PATCHED)
        self.assertIn(('enableDualPairing', {'enable': True}), self.api_calls)
        stop = ('systemctl', 'stop', self.module.BLUETOOTH, self.module.RECEIVER)
        receiver = ('systemctl', 'start', self.module.RECEIVER)
        bluetooth = ('systemctl', 'start', self.module.BLUETOOTH)
        self.assertLess(self.commands.index(stop), self.commands.index(receiver))
        self.assertLess(self.commands.index(receiver), self.commands.index(bluetooth))

    def test_live_install_preserves_process(self):
        self.current = self.module.PATCHED
        self.module.boot()
        self.assertFalse(any(command[1] in ('start', 'stop') for command in self.commands))

    def test_mounted_inactive_receiver_is_restarted(self):
        self.current = self.module.PATCHED
        for state in ('inactive', 'failed'):
            with self.subTest(state=state):
                self.active_state = state
                self.commands.clear()
                self.module.boot()
                self.assertIn(('systemctl', 'start', self.module.RECEIVER), self.commands)
                self.assertIn(('systemctl', 'start', self.module.BLUETOOTH), self.commands)
                self.assertFalse((self.module.ROOT / 'disabled').exists())

    def test_inactive_receiver_start_failure_rolls_back(self):
        self.current = self.module.PATCHED
        self.active_state = 'failed'
        self.fail_start = True
        with self.assertRaisesRegex(RuntimeError, 'startup failure'):
            self.module.boot()
        self.assertEqual(self.current, self.module.STOCK)
        self.assertTrue((self.module.ROOT / 'disabled').exists())

    def test_changed_firmware_is_untouched(self):
        self.current = 'new-firmware'
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            self.module.boot()
        self.assertEqual(self.commands, [])
        self.assertFalse(self.dropin.exists())

    def test_startup_failure_restores_stock_and_disables_hook(self):
        self.fail_start = True
        with self.assertRaisesRegex(RuntimeError, 'startup failure'):
            self.module.boot()
        self.assertEqual(self.current, self.module.STOCK)
        self.assertTrue((self.module.ROOT / 'disabled').exists())
        self.assertFalse(self.dropin.exists())
        self.assertEqual(self.commands[-1], ('systemctl', 'start', self.module.RECEIVER,
                                             self.module.BLUETOOTH))

    def test_disabled_hook_does_nothing(self):
        (self.module.ROOT / 'disabled').touch()
        self.module.boot()
        self.assertEqual(self.commands, [])

    def test_optional_link_helper_starts_without_restarting_receiver(self):
        self.current = self.module.PATCHED
        (self.module.ROOT / 'link.json').write_text('{}')
        self.module.boot()
        self.assertIn(('systemctl', 'start', 'airmouse-lg-link.service'), self.commands)
        self.assertNotIn(('systemctl', 'stop', self.module.BLUETOOTH, self.module.RECEIVER), self.commands)

    def test_link_start_failure_does_not_remove_receiver_startup(self):
        self.current = self.module.PATCHED
        (self.module.ROOT / 'link.json').write_text('{}')
        def run(*args):
            if args == ('systemctl', 'start', 'airmouse-lg-link.service'):
                raise subprocess.CalledProcessError(1, args)
            return self.run_command(*args)
        with patch.object(self.module, 'run', run):
            self.module.boot()
        self.assertTrue(self.dropin.exists())
        self.assertEqual(self.current, self.module.PATCHED)

    def test_protected_slots_restore_primary_identity_and_calibration_on_cold_boot(self):
        primary, secondary = '02:00:00:00:00:01', '02:00:00:00:00:02'
        self.slots(primary, secondary)
        self.module.protect(secondary)
        saved = self.module.ROOT / 'slots'
        self.assertIn(b'hidraw = \n', (saved / 'mrcu1.info').read_bytes())
        self.slots(secondary, secondary)
        self.module.boot()
        self.assertEqual(self.module.info_address(self.module.MRCU / 'mrcu1.info'), primary)
        self.assertEqual(self.module.scd_address(self.module.MRCU / 'mrcu1.scd'), primary)
        self.assertTrue(self.module.slots_valid())

    def test_slot_protection_rejects_a_duplicate_primary(self):
        secondary = '02:00:00:00:00:02'
        self.slots(secondary, secondary)
        with self.assertRaisesRegex(RuntimeError, 'original remote'):
            self.module.protect(secondary)

    def test_protected_slot_checksum_tampering_is_rejected(self):
        secondary = '02:00:00:00:00:02'
        self.slots(secondary=secondary)
        self.module.protect(secondary)
        (self.module.ROOT / 'slots/mrcu1.info').write_text('tampered\n')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            self.module.protected_slots()


if __name__ == '__main__':
    unittest.main()
