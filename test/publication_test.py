import argparse
from pathlib import Path
import runpy
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
check = runpy.run_path(str(ROOT / 'tools/check-public'))['findings']
address = runpy.run_path(str(ROOT / 'tools/lib/device_identity.py'))['bluetooth_address']


class PublicationTest(unittest.TestCase):
    def test_private_artifacts_are_rejected_without_printing_contents(self):
        for name in ('.env', '.env.local', 'credentials.json', 'captures/raw.bin',
                     'trace.pcapng', 'remote.tlv', 'core-api-key', 'dist/release.tar.gz'):
            result = list(check(name, b'confidential-value'))
            self.assertIn('private artifact', result)
            self.assertNotIn('confidential-value', str(result))

    def test_workstation_paths_and_private_hosts_are_flagged(self):
        self.assertTrue(list(check('docs/example.md', b'/home/' + b'person/project/')))
        self.assertTrue(list(check('tools/example', b'root@192.168.1.5')))
        self.assertFalse(list(check('tools/example', b'root@remote3.example')))
        self.assertFalse(list(check('test/network.test.mjs', b'192.168.1.5')))
        self.assertFalse(list(check('.env.example', b'AIRMOUSE_HOST=root@remote3.example')))

    def test_explicit_addresses_are_normalized_and_validated(self):
        self.assertEqual(address('02:AB:00:00:00:01'), '02:ab:00:00:00:01')
        for value in ('', 'not-an-address', '00:00:00:00:00:00',
                      'ff:ff:ff:ff:ff:ff', '02:00:00:00:00:01;echo unsafe'):
            with self.assertRaises(argparse.ArgumentTypeError):
                address(value)

    def test_device_mutations_reject_missing_or_duplicate_identities_before_ssh(self):
        cases = [
            ('airmouse-lg-clear-pairings', ['--host', 'root@lg-tv.example']),
            ('airmouse-lg-clear-pairings', ['--host', 'root@lg-tv.example',
                '--original-address', '02:00:00:00:00:01',
                '--remote3-address', '02:00:00:00:00:01']),
            ('airmouse-lg-deploy-receiver', ['--host', 'root@lg-tv.example', '--binary', '/unused']),
            ('airmouse-lg-check-key-route', ['--tv', 'root@lg-tv.example', '--remote', 'root@remote3.example']),
        ]
        for tool, args in cases:
            with self.subTest(tool=tool, args=args):
                result = subprocess.run([sys.executable, str(ROOT / 'tools' / tool), *args],
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn('error:', result.stderr)
