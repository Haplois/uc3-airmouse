import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / 'tools/lib/lg_receiver_upgrade.py'
        spec = importlib.util.spec_from_file_location('upgrade', source)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.m.ROOT = Path(directory.name)
        self.m.STAGE = self.m.ROOT / 'upgrade-v4'
        self.m.STAGE.mkdir()
        self.m.TARGET = self.m.ROOT / 'target'
        self.m.OLD = hashlib.sha256(b'old').hexdigest()
        self.m.NEW = hashlib.sha256(b'new').hexdigest()
        for name, content in {'lginput2': b'old', 'startup.py': b'old startup',
                              'upgrade-v4/lginput2.new': b'new',
                              'upgrade-v4/startup.py.new': b'new startup'}.items():
            (self.m.ROOT / name).write_bytes(content)
        self.current = self.m.OLD
        self.commands = []
        self.scd = {'mrcu1.scd': 'original', 'mrcu2.scd': 'secondary'}
        original_digest = self.m.digest
        def digest(path):
            if path == self.m.TARGET or str(path).startswith('/proc/'):
                return self.current
            return original_digest(path)
        for name, replacement in [('digest', digest), ('run', self.run_command),
                                  ('calibration', lambda: self.scd.copy())]:
            patcher = patch.object(self.m, name, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_command(self, *args):
        self.commands.append(args)
        if args[0] == 'umount':
            self.current = 'c58d4f06179944944c475e47bd0b6d9f1be1a4e032d8dc6562642d2ffdbd870b'
        if args[0] == '/usr/bin/python3':
            self.current = self.m.digest(self.m.ROOT / 'lginput2')
        return '123' if args[:2] == ('systemctl', 'show') else ''

    def test_upgrade_arms_recovery_before_stopping_and_preserves_old_pair(self):
        self.m.activate()
        armed = next(i for i, command in enumerate(self.commands) if command[0] == 'systemd-run')
        stopped = self.commands.index(('systemctl', 'stop', *self.m.SERVICES))
        self.assertLess(armed, stopped)
        self.assertEqual((self.m.STAGE / 'lginput2.old').read_bytes(), b'old')
        self.assertEqual((self.m.STAGE / 'startup.py.old').read_bytes(), b'old startup')
        self.assertEqual(self.current, self.m.NEW)
        self.assertFalse((self.m.STAGE / 'committed').exists())

    def test_unknown_firmware_never_stops_receiver(self):
        self.current = 'unknown'
        with self.assertRaises(ValueError):
            self.m.activate()
        self.assertEqual(self.commands, [])

    def test_rollback_restores_previous_binary_and_startup_together(self):
        self.m.activate()
        self.m.rollback()
        self.assertEqual(self.current, self.m.OLD)
        self.assertEqual((self.m.ROOT / 'startup.py').read_bytes(), b'old startup')
        self.assertEqual(json.loads((self.m.STAGE / 'calibration-before.json').read_text()), self.scd)

    def test_rollback_after_failed_boot_recovers_from_stock(self):
        self.m.activate()
        self.current = 'c58d4f06179944944c475e47bd0b6d9f1be1a4e032d8dc6562642d2ffdbd870b'
        (self.m.ROOT / 'disabled').touch()
        self.m.rollback()
        self.assertEqual(self.current, self.m.OLD)
        self.assertFalse((self.m.ROOT / 'disabled').exists())

    def test_calibration_change_keeps_rollback_armed(self):
        self.m.activate()
        self.scd['mrcu2.scd'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'Calibration changed'):
            self.m.commit()
        self.assertFalse((self.m.STAGE / 'committed').exists())

    def test_committed_upgrade_cannot_be_rolled_back_by_late_timer(self):
        self.m.activate()
        self.m.commit()
        commands = self.commands.copy()
        self.m.rollback()
        self.assertEqual(self.commands, commands)
        self.assertEqual(self.current, self.m.NEW)

    def test_failed_dependent_service_keeps_rollback_armed(self):
        self.m.activate()
        for failed in self.m.SERVICES[:-1]:
            with self.subTest(service=failed):
                self.commands.clear()
                def run(*args):
                    if args[:2] == ('systemctl', 'is-active'):
                        units = [arg for arg in args[2:] if not arg.startswith('-')]
                        # systemctl succeeds if ANY supplied unit is active.
                        if all(unit == failed for unit in units):
                            raise subprocess.CalledProcessError(3, args, output=b'failed\n')
                        return '\n'.join('failed' if unit == failed else 'active' for unit in units)
                    return self.run_command(*args)
                with patch.object(self.m, 'run', run):
                    with self.assertRaises(subprocess.CalledProcessError):
                        self.m.commit()
                self.assertFalse((self.m.STAGE / 'committed').exists())
                self.assertNotIn(('systemctl', 'stop', self.m.TIMER + '.timer'), self.commands)


if __name__ == '__main__':
    unittest.main()
