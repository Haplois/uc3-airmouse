from pathlib import Path
import configparser
import os
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/sleep.sh'
UNIT = SCRIPT.with_name('airmouse-sleep.service')


class SleepTest(unittest.TestCase):
    def test_owned_services_stop_before_sleep_and_only_those_services_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'bin').mkdir()
            command = root/'bin/systemctl'
            command.write_text('#!/bin/sh\necho "$*" >> "$AIRMOUSE_SLEEP_ROOT/calls"\n'
                               'if test "$1" = is-active; then test -f "$AIRMOUSE_SLEEP_ROOT/$3"; fi\n')
            command.chmod(0o755)
            env = dict(os.environ, AIRMOUSE_SLEEP_ROOT=directory, PATH=str(root/'bin')+':'+os.environ['PATH'])
            for name in ('airmouse.service', 'airmouse-bluetooth.service'):
                (root/name).touch()
            prepared = root/'run/airmouse-bluetooth-takeover/prepared'
            prepared.parent.mkdir(parents=True)
            prepared.touch()
            subprocess.run(['sh',str(SCRIPT),'pre'],env=env,check=True)
            subprocess.run(['sh',str(SCRIPT),'post'],env=env,check=True)
            calls=(root/'calls').read_text().splitlines()
            self.assertLess(calls.index('stop airmouse.service'),calls.index('stop airmouse-bluetooth.service'))
            self.assertEqual(calls[-2:],['--no-block start airmouse-bluetooth.service','--no-block start airmouse.service'])
            self.assertFalse((root/'run/airmouse-sleep').exists())
            subprocess.run(['sh',str(SCRIPT),'post'],env=env,check=True)
            self.assertEqual((root/'calls').read_text().splitlines(),calls)
            subprocess.run(['sh',str(SCRIPT),'pre'],env=env,check=True)
            prepared.unlink()
            (root/'calls').write_text('')
            subprocess.run(['sh',str(SCRIPT),'post'],env=env,check=True)
            self.assertEqual((root/'calls').read_text().splitlines(),['--no-block start airmouse.service'])

    def test_inactive_services_are_not_started(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'bin').mkdir()
            command=root/'bin/systemctl'
            command.write_text('#!/bin/sh\nif test "$1" = is-active; then exit 1; fi\nexit 97\n')
            command.chmod(0o755)
            env=dict(os.environ,AIRMOUSE_SLEEP_ROOT=directory,PATH=str(root/'bin')+':'+os.environ['PATH'])
            subprocess.run(['sh',str(SCRIPT),'pre'],env=env,check=True)
            subprocess.run(['sh',str(SCRIPT),'post'],env=env,check=True)


class SleepFailureTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root/'bin').mkdir()
        command = self.root/'bin/systemctl'
        command.write_text('''#!/bin/sh
echo "$*" >> "$AIRMOUSE_SLEEP_ROOT/calls"
if test "$1" = --no-block; then shift; fi
case "$1" in
    is-active) test -f "$AIRMOUSE_SLEEP_ROOT/$3" ;;
    stop|start)
        if test -f "$AIRMOUSE_SLEEP_ROOT/fail-$1-$2"; then exit 1; fi
        if test "$1" = stop; then rm -f "$AIRMOUSE_SLEEP_ROOT/$2";
        else touch "$AIRMOUSE_SLEEP_ROOT/$2"; fi ;;
    *) exit 97 ;;
esac
''')
        command.chmod(0o755)
        self.env = dict(os.environ, AIRMOUSE_SLEEP_ROOT=directory.name,
                        PATH=str(self.root/'bin')+':'+os.environ['PATH'])
        self.state = self.root/'run/airmouse-sleep'
        self.prepared = self.root/'run/airmouse-bluetooth-takeover/prepared'
        self.prepared.parent.mkdir(parents=True)
        self.prepared.touch()
        for name in ('airmouse.service', 'airmouse-bluetooth.service'):
            (self.root/name).touch()

    def run_script(self, action):
        return subprocess.run(['sh', str(SCRIPT), action], env=self.env, capture_output=True)

    def test_failed_preparation_has_systemd_failure_cleanup(self):
        (self.root/'fail-stop-airmouse-bluetooth.service').touch()
        self.assertNotEqual(self.run_script('pre').returncode, 0)
        self.assertFalse((self.root/'airmouse.service').exists())
        config = configparser.ConfigParser()
        config.read(UNIT)
        # systemd skips ExecStop after failed ExecStart; only ExecStopPost runs.
        self.assertEqual(config['Service'].get('ExecStopPost'),
                         '/bin/sh /mnt/data/airmouse/sleep.sh post')
        self.assertEqual(self.run_script('post').returncode, 0)
        self.assertTrue((self.root/'airmouse.service').exists())
        self.assertFalse(self.state.exists())

    def test_failed_restart_preserves_marker_and_restores_other_service(self):
        self.assertEqual(self.run_script('pre').returncode, 0)
        failure = self.root/'fail-start-airmouse-bluetooth.service'
        failure.touch()
        self.assertNotEqual(self.run_script('post').returncode, 0)
        self.assertTrue((self.state/'bluetooth').exists())
        self.assertFalse((self.state/'node').exists())
        self.assertTrue((self.root/'airmouse.service').exists())
        failure.unlink()
        self.assertEqual(self.run_script('post').returncode, 0)
        self.assertTrue((self.root/'airmouse-bluetooth.service').exists())
        self.assertFalse(self.state.exists())

    def test_next_sleep_does_not_erase_an_unrestored_service(self):
        self.assertEqual(self.run_script('pre').returncode, 0)
        failure = self.root/'fail-start-airmouse.service'
        failure.touch()
        self.assertNotEqual(self.run_script('post').returncode, 0)
        self.assertTrue((self.state/'node').exists())
        self.assertEqual(self.run_script('pre').returncode, 0)
        self.assertTrue((self.state/'node').exists())
        failure.unlink()
        self.assertEqual(self.run_script('post').returncode, 0)
        self.assertTrue((self.root/'airmouse.service').exists())
