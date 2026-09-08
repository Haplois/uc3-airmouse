"""Exercise deployment transactions without systemd or Bluetooth hardware."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
root = pathlib.Path(os.environ['AIRMOUSE_DEPLOY_ROOT'])
statefile = root/'services.json'
state = json.loads(statefile.read_text())
args = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
with (root/'calls').open('a') as out: out.write(name+' '+' '.join(args)+'\n')
def save(): statefile.write_text(json.dumps(state))
def power(action):
    subprocess.run(['sh',str(root/'mnt/data/airmouse/bluetooth/owned-bluetooth.sh'),action],check=True)
if name == 'systemctl':
    action=args[0]
    if action == 'daemon-reload' and os.environ.get('FAIL_RELOAD'): sys.exit(1)
    unit=next((a for a in args[1:] if a.endswith(('.service','.timer'))),'')
    if action == 'is-active': sys.exit(0 if state.get(unit,False) else 3)
    if action == 'show': print('active' if state.get(unit,False) else 'inactive')
    if action == 'is-enabled': print('disabled')
    if action == 'enable': pass
    if action == 'mask':
        if os.environ.get('FAIL_MASK'): sys.exit(1)
        if unit == 'btuart.service' and os.environ.get('FAIL_HELPER_MASK'): sys.exit(1)
        dest=root/'run/systemd/system'/unit
        if not dest.is_symlink(): dest.symlink_to('/dev/null')
    if action == 'stop':
        state[unit]=False; save()
        if unit=='btuart.service': (root/'proc/999/fd/4').unlink(missing_ok=True)
        if unit in ('airmouse-bluetooth.service','btstack.service'): power('power-off')
    if action == 'start':
        if unit=='airmouse-bluetooth.service':
            power('power-on')
            if os.environ.get('FAIL_START'): sys.exit(1)
        if unit=='btstack.service': (root/'sys/class/gpio/gpio28/value').write_text('1\n')
        if unit=='btuart.service' and not (root/'proc/999/fd/4').is_symlink(): (root/'proc/999/fd/4').symlink_to('/dev/ttyS1')
        state[unit]=True; save()
elif name == 'systemd-run':
    if '--unit=airmouse-bluetooth-probe' in args:
        power('power-on'); power('power-off')
        if os.environ.get('FAIL_PROBE'): sys.exit(1)
        print('PROBE_OK' if not os.environ.get('BAD_PROBE') else 'controller incomplete')
elif name == 'getent': print('present')
elif name == 'install':
    clean=[]; i=0
    while i<len(args):
        if args[i] in ('-o','-g'): i+=2
        else: clean.append(args[i]); i+=1
    sys.exit(subprocess.run(['/usr/bin/install',*clean]).returncode)
'''

class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.root=pathlib.Path(self.directory.name)
        self.base=self.root/'mnt/data/airmouse/bluetooth'
        self.wrapper=self.base/'owned-bluetooth.sh'
        for path in ['mnt/data/airmouse/bluetooth/releases/previous/bin','sys/class/gpio/gpio28',
                     'opt/uc/bt/fw/init','dev','proc/999/fd','run/systemd/system','mockbin']:
            (self.root/path).mkdir(parents=True,exist_ok=True)
        (self.base/'current').symlink_to('releases/previous')
        shutil.copy(ROOT/'deploy/owned-bluetooth.sh',self.wrapper)
        (self.root/'sys/class/gpio/gpio28/value').write_text('1\n')
        (self.root/'sys/class/gpio/gpio28/direction').write_text('out\n')
        (self.root/'dev/ttyS1').touch()
        (self.root/'proc/999/fd/4').symlink_to('/dev/ttyS1')
        (self.root/'opt/uc/bt/fw/init/BCM4373A0_001.001.025.0103.0155.FCC.CE.2BC.hcd').touch()
        binary=self.base/'current/bin/airmouse-hid'; binary.touch(); binary.chmod(0o755)
        (self.root/'services.json').write_text(json.dumps({'btstack.service':True,'btuart.service':True,'airmouse.service':True}))
        (self.root/'calls').touch()
        for name in ['systemctl','systemd-run','getent','install']:
            path=self.root/'mockbin'/name; path.write_text(MOCK); path.chmod(0o755)
        self.env={**os.environ,'AIRMOUSE_DEPLOY_ROOT':str(self.root),'PATH':str(self.root/'mockbin')+':'+os.environ['PATH']}
    def tearDown(self): self.directory.cleanup()
    def run_tool(self, command, *arguments, success=True, **env):
        result=subprocess.run(['sh',str(self.wrapper),command,*arguments],env={**self.env,**env},capture_output=True,text=True)
        if success: self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        else: self.assertNotEqual(result.returncode,0)
        return result
    def state(self): return json.loads((self.root/'services.json').read_text())
    def assert_restored(self):
        self.assertTrue(self.state()['btstack.service'])
        self.assertTrue(self.state()['btuart.service'])
        self.assertFalse((self.root/'run/systemd/system/btuart.service').is_symlink())
        self.assertTrue(self.state()['airmouse.service'])
        self.assertFalse((self.root/'run/systemd/system/btstack.service').is_symlink())
        self.assertFalse((self.root/'run/airmouse-bluetooth-takeover').exists())
        self.assertFalse((self.root/'run/systemd/system/airmouse.service.d/80-owned-bluetooth.conf').exists())
    def test_takeover_then_rollback(self):
        self.run_tool('takeover')
        self.assertFalse(self.state()['btstack.service'])
        self.assertFalse(self.state()['btuart.service'])
        self.assertTrue(self.state()['airmouse-bluetooth.service'])
        dropin=self.root/'run/systemd/system/airmouse.service.d/80-owned-bluetooth.conf'
        self.assertEqual(dropin.read_text(),'[Service]\nEnvironment=AIRMOUSE_OUTPUT=owned\n')
        calls=(self.root/'calls').read_text()
        self.assertLess(calls.index('--on-active=45s'),calls.index('mask --runtime'))
        self.assertLess(calls.index('mask --runtime'),calls.index('stop btstack.service'))
        self.run_tool('rollback'); self.assert_restored()
        calls=(self.root/'calls').read_text()
        self.assertLess(calls.index('mask --runtime btuart.service'),calls.index('stop btuart.service'))
        self.assertLess(calls.index('stop btuart.service'),calls.index('start airmouse-bluetooth.service'))
        self.assertLess(calls.index('start btuart.service'),calls.index('start btstack.service'))
        self.run_tool('rollback'); self.assert_restored()
    def test_mask_failure_restores_node_while_stock_is_still_running(self):
        self.run_tool('takeover',success=False,FAIL_MASK='1'); self.assert_restored()
    def test_helper_mask_failure_restores_stock_mask(self):
        self.run_tool('takeover',success=False,FAIL_HELPER_MASK='1'); self.assert_restored()
    def test_existing_helper_mask_and_inactive_state_are_preserved(self):
        state=self.state(); state['btuart.service']=False
        (self.root/'services.json').write_text(json.dumps(state))
        (self.root/'proc/999/fd/4').unlink()
        mask=self.root/'run/systemd/system/btuart.service'; mask.symlink_to('/dev/null')
        self.run_tool('probe')
        self.assertFalse(self.state()['btuart.service'])
        self.assertEqual(os.readlink(mask),'/dev/null')
    def test_old_transaction_does_not_change_helper(self):
        self.run_tool('takeover')
        transaction=self.root/'run/airmouse-bluetooth-takeover'
        for path in transaction.glob('helper-*'): path.unlink()
        mask=self.root/'run/systemd/system/btuart.service'; mask.unlink()
        (self.root/'calls').write_text('')
        self.run_tool('rollback')
        self.assertFalse(self.state()['btuart.service'])
        self.assertFalse(mask.is_symlink())
        self.assertNotIn('btuart.service',(self.root/'calls').read_text())
        self.assertTrue(self.state()['btstack.service'])
        self.assertFalse(transaction.exists())
    def test_power_requires_helper_mask_and_stopped_helper(self):
        transaction=self.root/'run/airmouse-bluetooth-takeover'; transaction.mkdir()
        (transaction/'prepared').touch()
        (self.root/'run/systemd/system/btstack.service').symlink_to('/dev/null')
        state=self.state(); state['btstack.service']=False
        (self.root/'services.json').write_text(json.dumps(state))
        self.run_tool('power-on',success=False)
        (self.root/'run/systemd/system/btuart.service').symlink_to('/dev/null')
        self.run_tool('power-on',success=False)
    def test_failed_daemon_start_restores_stock(self):
        self.run_tool('takeover',success=False,FAIL_START='1'); self.assert_restored()
    def test_probe_restores_stock(self):
        result=self.run_tool('probe'); self.assertIn('PROBE_OK',result.stdout); self.assert_restored()
    def test_failed_and_incomplete_probe_restore_stock(self):
        self.run_tool('probe',success=False,FAIL_PROBE='1'); self.assert_restored()
        self.run_tool('probe',success=False,BAD_PROBE='1'); self.assert_restored()
    def test_uart_conflict_does_not_power_controller(self):
        fd=self.root/'proc/123/fd/4'; fd.parent.mkdir(parents=True); fd.symlink_to('/dev/ttyS1')
        self.run_tool('takeover',success=False)
        self.assertEqual((self.root/'sys/class/gpio/gpio28/value').read_text(),'0\n')
        self.assertNotIn('start airmouse-bluetooth.service',(self.root/'calls').read_text())
        self.assertTrue((self.root/'run/airmouse-bluetooth-takeover/prepared').exists())
        fd.unlink(); self.run_tool('rollback'); self.assert_restored()
    def test_existing_dropin_and_inactive_services_are_preserved(self):
        (self.root/'services.json').write_text(json.dumps({'btstack.service':False,'airmouse.service':False}))
        dropin=self.root/'run/systemd/system/airmouse.service.d/80-owned-bluetooth.conf'
        dropin.parent.mkdir(); dropin.write_text('[Service]\nEnvironment=PREVIOUS=1\n')
        mask=self.root/'run/systemd/system/btstack.service'; mask.symlink_to('/dev/null')
        self.run_tool('takeover'); self.run_tool('rollback')
        self.assertFalse(self.state()['btstack.service']); self.assertFalse(self.state()['airmouse.service'])
        self.assertEqual(dropin.read_text(),'[Service]\nEnvironment=PREVIOUS=1\n')
        self.assertEqual(os.readlink(mask),'/dev/null')
    def test_fuser_result_avoids_proc_scan(self):
        script=(ROOT/'deploy/owned-bluetooth.sh').read_text()
        function=script[script.index('uart_idle() {'):script.index('\npower_off()')]
        fuser=self.root/'mockbin/fuser'; fuser.write_text('#!/bin/sh\nexit "$FUSER_RESULT"\n'); fuser.chmod(0o755)
        readlink=self.root/'mockbin/readlink'
        readlink.write_text('#!/bin/sh\necho unexpected >> "$TEST_READLINK_LOG"\nexit 1\n'); readlink.chmod(0o755)
        log=self.root/'readlink-calls'
        for status,expected in [('0',1),('1',0),('2',1)]:
            result=subprocess.run(['sh','-c','root=; uart=/dev/ttyS1\n'+function+'\nuart_idle'],env={**self.env,'FUSER_RESULT':status,'TEST_READLINK_LOG':str(log)},capture_output=True,text=True)
            self.assertEqual(result.returncode,expected,result.stderr)
            self.assertFalse(log.exists())
    def test_power_requires_transaction_and_mask(self):
        self.run_tool('power-on',success=False)
        (self.root/'run/airmouse-bluetooth-takeover').mkdir()
        (self.root/'run/airmouse-bluetooth-takeover/prepared').touch()
        self.run_tool('power-on',success=False)
    def install_fixture(self):
        release='1234567890abcdef'
        destination=self.base/'releases'/release
        shutil.copytree(ROOT/'deploy',destination/'deploy')
        (destination/'bin').mkdir()
        binary=destination/'bin/airmouse-hid'; binary.touch(); binary.chmod(0o755)
        unit=self.root/'etc/systemd/system/airmouse-bluetooth.service'
        unit.parent.mkdir(parents=True); unit.write_text('previous unit\n')
        return release,unit
    def test_install_preserves_backup_without_starting_services(self):
        release,unit=self.install_fixture()
        self.run_tool('install',release)
        self.assertEqual(os.readlink(self.base/'current'),'releases/'+release)
        backup=next((self.base/'install-backup').iterdir())
        self.assertEqual((backup/'daemon-unit').read_text(),'previous unit\n')
        self.assertEqual(os.readlink(backup/'current'),'releases/previous')
        self.assertIn(str(unit),(backup/'installed-files').read_text())
        calls=(self.root/'calls').read_text()
        self.assertNotIn('systemctl start',calls); self.assertEqual(calls.count('systemctl enable'),1)
        self.assertIn('systemctl enable --now airmouse-bluetooth-request.path',calls)
    def test_failed_install_restores_previous_files(self):
        release,unit=self.install_fixture()
        self.run_tool('install',release,success=False,FAIL_RELOAD='1')
        self.assertEqual(os.readlink(self.base/'current'),'releases/previous')
        self.assertEqual(unit.read_text(),'previous unit\n')
    def request(self, kind):
        run=self.root/'run/airmouse'; run.mkdir(exist_ok=True)
        (run/'bluetooth-request').write_text(kind+'\n')
        return run
    def test_request_takeover_and_rollback_consume_the_file(self):
        run=self.request('takeover'); self.run_tool('request')
        self.assertFalse((run/'bluetooth-request').exists()); self.assertFalse((run/'bluetooth-request.failed').exists())
        self.assertTrue(self.state()['airmouse-bluetooth.service']); self.assertFalse(self.state()['btstack.service'])
        self.request('takeover'); self.run_tool('request'); self.assertTrue(self.state()['airmouse-bluetooth.service'])
        self.request('rollback'); self.run_tool('request'); self.assert_restored()
        self.assertFalse((run/'bluetooth-request.failed').exists())
        self.request('rollback'); self.run_tool('request'); self.assert_restored()
    def test_failed_request_records_the_reason_and_restores_stock(self):
        run=self.request('takeover'); self.run_tool('request',success=False,FAIL_START='1')
        self.assert_restored(); self.assertIn('did not start',(run/'bluetooth-request.failed').read_text())
        self.request('takeover'); self.run_tool('request'); self.assertFalse((run/'bluetooth-request.failed').exists())
    def test_explicit_rollback_holds_automatic_takeovers_and_bad_requests_are_rejected(self):
        self.run_tool('takeover'); self.run_tool('rollback')
        self.assertTrue((self.root/'run/airmouse/bluetooth-request.failed').exists())
        run=self.request('reboot'); self.run_tool('request',success=False); self.assertFalse((run/'bluetooth-request').exists())
    def test_install_enables_the_request_watcher(self):
        release,unit=self.install_fixture(); self.run_tool('install',release)
        self.assertTrue((self.root/'etc/systemd/system/airmouse-bluetooth-request.path').exists())
        self.assertIn('systemctl enable --now airmouse-bluetooth-request.path',(self.root/'calls').read_text())
    def test_destination_validation_precedes_ssh(self):
        result=subprocess.run(['python3',str(ROOT/'tools/airmouse-bluetooth'),'--host','root@host;id','status'],capture_output=True,text=True)
        self.assertEqual(result.returncode,2)
        self.assertIn('Expected root@host',result.stderr)

if __name__=='__main__': unittest.main()
