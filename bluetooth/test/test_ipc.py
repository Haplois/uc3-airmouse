import json
import os
import pathlib
import select
import signal
import socket
import subprocess
import tempfile
import time
import unittest

BINARY = pathlib.Path(os.environ.get('AIRMOUSE_HID_BINARY', '/tmp/airmouse-owned-bluetooth/build-host/airmouse-hid'))

class Daemon(unittest.TestCase):
    def start(self, interval=0, hosts=None, ready=True):
        self.temp = tempfile.TemporaryDirectory(prefix='airmouse-hid-test-')
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name)
        self.log = (self.path / 'daemon.log').open('w+')
        self.addCleanup(self.log.close)
        self.notify=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
        self.notify.bind(str(self.path/'notify.sock')); self.notify.settimeout(1)
        self.addCleanup(self.notify.close)
        self.interval, self.host_count = interval, hosts
        self.launch(ready)

    def launch(self, ready=True):
        arguments = [str(BINARY), '--simulate', '--simulate-interval', str(self.interval), '--socket', str(self.path/'control.sock'), '--state-dir', str(self.path)]
        if self.host_count is not None: arguments += ['--simulate-hosts', str(self.host_count)]
        self.process = subprocess.Popen(arguments, stdout=self.log, stderr=self.log, env={**os.environ, "NOTIFY_SOCKET":str(self.path/"notify.sock")})
        process = self.process
        def stop():
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
        self.addCleanup(stop)
        until=time.monotonic()+2
        while not (self.path/'control.sock').exists() and self.process.poll() is None and time.monotonic()<until: time.sleep(.01)
        self.assertIsNone(self.process.poll(), self.contents())
        self.sock=socket.socket(socket.AF_UNIX)
        self.sock.settimeout(2)
        self.sock.connect(str(self.path/'control.sock'))
        self.addCleanup(self.sock.close)
        self.buffer=b''
        self.request=0
        self.ready_notice=self.notify.recv(128)
        self.initial_message=self.message()
        self.assertEqual(self.initial_message['state']['ready'], ready)

    def restart(self, ready=True):
        self.sock.close()
        self.process.terminate()
        self.assertEqual(self.process.wait(timeout=3), 0)
        while select.select([self.notify],[],[],0)[0]: self.notify.recv(128)
        self.launch(ready)

    def contents(self):
        self.log.flush(); self.log.seek(0); return self.log.read()

    def message(self):
        if hasattr(self,'notify'):
            while select.select([self.notify],[],[],0)[0]: self.notify.recv(128)
        while b'\n' not in self.buffer:
            chunk=self.sock.recv(8192)
            if not chunk: raise EOFError('Daemon disconnected')
            self.buffer+=chunk
        line,self.buffer=self.buffer.split(b'\n',1)
        return json.loads(line)

    def ack(self, request):
        while True:
            message=self.message()
            if message.get('id')==request: return message

    def send(self, text): self.sock.sendall(text.encode())
    def reports(self): return [tuple(map(int,line.split()[1:])) for line in self.contents().splitlines() if line.startswith('TEST_REPORT ')]

    def test_media_while_paused_is_press_then_release(self):
        self.start()
        for usage in [205,182,181,183,226,233,234]:
            self.assertTrue(self.command('MEDIA',str(usage))['ok'])
        media=[int(line.split()[1]) for line in self.contents().splitlines() if line.startswith('TEST_MEDIA ')]
        self.assertEqual(media,[205,0,182,0,181,0,183,0,226,0,233,0,234,0])
        self.assertFalse(self.command('MEDIA','999')['ok'])

    def command(self, command, arguments=''):
        self.request += 1
        self.send(f'{command} {self.request}' + (f' {arguments}' if arguments else '') + '\n')
        return self.ack(self.request)

    def state(self, predicate=lambda state: True):
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            message=self.message()
            if 'state' in message and predicate(message['state']): return message['state']
        self.fail('No matching state before deadline')

    def rename(self, target, name):
        return self.command('RENAME', f'{target} {name.encode().hex() if name else "-"}')

    def test_service_readiness_and_watchdog(self):
        self.start()
        self.assertEqual(self.ready_notice,b'READY=1')
        self.assertEqual(self.notify.recv(128),b'WATCHDOG=1')

    def test_hold_move_release_and_partial_frames(self):
        self.start()
        self.send('OP'); self.send('EN 1\nBUTTON 2 1\nMOVE 0 1024 -768\nSCROLL 3 -1\nBUTTON 4 0\n')
        self.assertTrue(self.ack(4)['ok'])
        self.assertEqual(self.reports(),[(1,0,0,0),(1,1024,-768,0),(1,0,0,-1),(0,0,0,0)])

    def test_busy_link_keeps_both_edges(self):
        self.start(interval=50)
        self.send('OPEN 1\nBUTTON 2 1\nMOVE 0 7 -4\nBUTTON 3 3\nBUTTON 4 2\nBUTTON 5 0\n')
        self.assertTrue(self.ack(5)['ok'])
        reports=self.reports()
        self.assertEqual([r[0] for r in reports if not r[1] and not r[2]],[1,3,2,0])
        self.assertTrue(all(r[0]==1 for r in reports if r[1] or r[2]))

    def test_client_loss_and_new_client_start_empty(self):
        self.start(); self.send('OPEN 1\nBUTTON 2 1\n'); self.assertTrue(self.ack(2)['ok'])
        self.sock.close(); time.sleep(.1)
        self.assertEqual(self.reports()[-1],(0,0,0,0))
        self.sock=socket.socket(socket.AF_UNIX); self.sock.settimeout(2); self.addCleanup(self.sock.close)
        self.sock.connect(str(self.path/'control.sock')); self.buffer=b''
        state=self.message()['state']; self.assertFalse(state['active']); self.assertEqual(state['buttons'],0)
        self.send('OPEN 1\n'); self.assertTrue(self.ack(1)['ok'])

    def test_lease_loss_releases_without_client_help(self):
        self.start(); self.send('OPEN 1\nBUTTON 2 1\n'); self.ack(2)
        time.sleep(1.15); self.assertEqual(self.reports()[-1],(0,0,0,0))
        with self.assertRaises(EOFError):
            while True: self.message()

    def test_second_client_cannot_steal_session(self):
        self.start(); self.send('OPEN 1\nBUTTON 2 1\n'); self.ack(2)
        with socket.socket(socket.AF_UNIX) as other:
            other.settimeout(1); other.connect(str(self.path/'control.sock')); self.assertEqual(other.recv(1),b'')
        self.send('BUTTON 3 0\n'); self.assertTrue(self.ack(3)['ok'])

    def test_replayed_id_revokes_and_releases(self):
        self.start(); self.send('OPEN 1\nBUTTON 2 1\n'); self.ack(2); self.send('BUTTON 2 1\n')
        with self.assertRaises(EOFError):
            while True: self.message()
        self.assertEqual(self.reports()[-1],(0,0,0,0))

    def test_bad_frame_revokes_and_releases(self):
        self.start(); self.send('OPEN 1\nBUTTON 2 1\n'); self.ack(2); self.send('BUTTON 3 1 extra\n')
        with self.assertRaises(EOFError):
            while True: self.message()
        self.assertEqual(self.reports()[-1],(0,0,0,0))

    def test_stop_preempts_pending_edges(self):
        self.start(interval=100)
        self.send('OPEN 1\nBUTTON 2 1\nBUTTON 3 3\nSTOP 4\n')
        self.assertTrue(self.ack(4)['ok']); self.assertEqual(self.reports()[-1],(0,0,0,0))
        self.send('OPEN 5\n'); self.assertTrue(self.ack(5)['ok'])

    def test_queue_overflow_revokes_pointing(self):
        self.start(interval=200)
        self.send('OPEN 1\n'+''.join(f'BUTTON {i+2} {i%2}\n' for i in range(30)))
        deadline=time.monotonic()+1; state={}
        while time.monotonic()<deadline:
            msg=self.message()
            if 'state' in msg: state=msg['state']
            if state.get('error') and not state.get('active') and self.reports(): break
        self.assertFalse(state['active']); self.assertEqual(self.reports()[-1],(0,0,0,0))

    def test_sigterm_releases_before_exit(self):
        self.start(); self.send('OPEN 1\nBUTTON 2 3\n'); self.ack(2)
        self.process.send_signal(signal.SIGTERM); self.assertEqual(self.process.wait(timeout=2),0)
        self.assertEqual(self.reports()[-1],(0,0,0,0))

    def test_v2_computer_roster_and_defaults(self):
        self.start(hosts=3)
        self.assertEqual(self.initial_message['version'], 2)
        state=self.initial_message['state']
        self.assertEqual(state['host_limit'], 4)
        self.assertEqual(state['selected'], '00000001')
        self.assertEqual(state['connected_device'], '00000001')
        self.assertTrue(state['paired'])
        self.assertEqual([device['id'] for device in state['devices']], ['00000001','00000002','00000003'])
        self.assertEqual([device['name'] for device in state['devices']], ['Simulated computer','Simulated computer 2','Simulated computer 3'])
        for device in state['devices']:
            self.assertEqual(device['name'], device['bluetooth_name'])
            self.assertEqual(device['custom_name'], '')
        self.assertTrue(state['devices'][0]['legacy'])

    def test_rename_unicode_quotes_and_reset_persist(self):
        self.start(hosts=2)
        name='Work "PC" \\ 桌 💻'
        self.assertTrue(self.rename('00000002', name)['ok'])
        state=self.state(lambda state: state['devices'][1]['custom_name']==name)
        self.assertEqual(state['devices'][1]['name'], name)
        self.assertEqual(state['devices'][1]['bluetooth_name'], 'Simulated computer 2')
        self.restart()
        self.assertEqual(self.initial_message['state']['devices'][1]['name'], name)
        self.assertTrue(self.rename('00000002', '')['ok'])
        state=self.state(lambda state: state['devices'][1]['custom_name']=='')
        self.assertEqual(state['devices'][1]['name'], 'Simulated computer 2')
        self.restart()
        self.assertEqual(self.initial_message['state']['devices'][1]['name'], 'Simulated computer 2')

    def test_rename_byte_limits_and_invalid_utf8(self):
        self.start(hosts=1)
        name='桌'*16
        self.assertEqual(len(name.encode()),48)
        self.assertTrue(self.rename('00000001', name)['ok'])
        for value in ['a'*49, '桌'*16+'a', 'line\nbreak', 'nul\x00byte', '\x7f', '\x85']:
            self.assertFalse(self.rename('00000001', value)['ok'])
        for value in ['c0af','eda080','f4908080','80','e2','0g','a']:
            self.assertFalse(self.command('RENAME', f'00000001 {value}')['ok'])
        state=self.state(lambda state: state['devices'][0]['custom_name']==name)
        self.assertEqual(state['devices'][0]['name'], name)
        self.assertIsNone(self.process.poll())

    def test_reorder_exact_permutation_persists(self):
        self.start(hosts=4)
        order=['00000004','00000002','00000001','00000003']
        self.assertTrue(self.command('REORDER', ','.join(order))['ok'])
        state=self.state(lambda state: [device['id'] for device in state['devices']]==order)
        self.assertEqual(state['selected'],'00000001')
        for invalid in ['00000004,00000002,00000001', '00000004,00000002,00000001,00000001',
                        '00000004,00000002,00000001,00000009', '-', '00000004,00000002,00000001,00000003,00000005']:
            self.assertFalse(self.command('REORDER', invalid)['ok'])
        self.restart()
        self.assertEqual([device['id'] for device in self.initial_message['state']['devices']], order)

    def test_selection_requires_stop_and_releases_before_switch(self):
        self.start(hosts=2)
        self.assertTrue(self.command('OPEN')['ok'])
        self.assertTrue(self.command('BUTTON','1')['ok'])
        self.assertFalse(self.command('SELECT','00000002')['ok'])
        state=self.state(lambda state: state['active'])
        self.assertEqual(state['selected'],'00000001')
        self.assertEqual(state['buttons'],1)
        self.assertTrue(self.command('STOP')['ok'])
        self.assertEqual(self.reports()[-1],(0,0,0,0))
        self.assertTrue(self.command('SELECT','00000002')['ok'])
        state=self.state(lambda state: state['selected']=='00000002')
        self.assertFalse(state['active'])
        self.assertEqual(state['buttons'],0)
        self.assertNotEqual(state['connected_device'],'00000001')
        self.restart()
        self.assertEqual(self.initial_message['state']['selected'],'00000002')
        self.assertFalse(self.initial_message['state']['active'])

    def test_forget_selected_preserves_remaining_order_and_empty_selection(self):
        self.start(hosts=3)
        self.assertTrue(self.command('FORGET','00000001')['ok'])
        state=self.state(lambda state: state['selected']=='')
        self.assertFalse(state['active'])
        self.assertFalse(state['ready'])
        self.assertEqual(state['connected_device'],'')
        self.assertEqual([device['id'] for device in state['devices']],['00000002','00000003'])
        self.assertTrue(state['paired'])
        self.restart(ready=False)
        state=self.initial_message['state']
        self.assertEqual(state['selected'],'')
        self.assertEqual([device['id'] for device in state['devices']],['00000002','00000003'])
        self.assertTrue(self.command('SELECT','00000003')['ok'])
        self.assertTrue(self.command('FORGET','00000002')['ok'])
        state=self.state(lambda state: len(state['devices'])==1)
        self.assertEqual(state['selected'],'00000003')

    def test_forget_all_stays_empty_after_restart(self):
        self.start(hosts=1)
        self.assertTrue(self.command('FORGET','00000001')['ok'])
        state=self.state(lambda state: not state['devices'])
        self.assertFalse(state['paired'])
        self.assertFalse(state['ready'])
        self.assertTrue(self.command('REORDER','-')['ok'])
        self.restart(ready=False)
        self.assertEqual(self.initial_message['state']['devices'],[])
        self.assertFalse(self.command('SELECT','00000001')['ok'])

    def test_pair_and_cancel_with_saved_computers(self):
        self.start(hosts=2)
        self.assertTrue(self.command('PAIR')['ok'])
        state=self.state(lambda state: state['pairing'])
        self.assertFalse(state['ready'])
        self.assertFalse(state['active'])
        self.assertEqual(len(state['devices']),2)
        self.assertEqual(state['selected'],'00000001')
        self.assertTrue(self.command('CANCEL_PAIR')['ok'])
        state=self.state(lambda state: not state['pairing'])
        self.assertEqual(state['selected'],'00000001')
        self.assertEqual(len(state['devices']),2)
        self.assertFalse(state['active'])

    def test_pair_capacity_and_empty_registry(self):
        self.start(hosts=4)
        self.assertFalse(self.command('PAIR')['ok'])
        self.assertTrue(self.command('FORGET','00000004')['ok'])
        self.assertTrue(self.command('PAIR')['ok'])
        self.assertTrue(self.command('CANCEL_PAIR')['ok'])
        for target in ['00000001','00000002','00000003']:
            self.assertTrue(self.command('FORGET',target)['ok'])
        self.assertTrue(self.command('PAIR')['ok'])
        state=self.state(lambda state: state['pairing'] and not state['devices'])
        self.assertFalse(state['paired'])
        self.assertEqual(state['selected'],'')
        self.assertTrue(self.command('CANCEL_PAIR')['ok'])

    def test_unknown_and_noncanonical_peer_ids_rejected_without_exit(self):
        self.start(hosts=2)
        for target in ['00000009','0000000A','0000000a','00000000','1','FFFFFFFF']:
            self.assertFalse(self.command('SELECT',target)['ok'])
            self.assertFalse(self.command('FORGET',target)['ok'])
            self.assertFalse(self.rename(target,'Alias')['ok'])
        self.assertTrue(self.command('SELECT','00000001')['ok'])
        self.assertIsNone(self.process.poll())

    def test_empty_simulation_can_enter_and_cancel_pairing(self):
        self.start(hosts=0,ready=False)
        state=self.initial_message['state']
        self.assertEqual(state['devices'],[])
        self.assertEqual(state['selected'],'')
        self.assertFalse(state['paired'])
        self.assertTrue(self.command('PAIR')['ok'])
        self.assertTrue(self.state(lambda state: state['pairing'])['pairing'])
        self.assertTrue(self.command('CANCEL_PAIR')['ok'])
        self.assertFalse(self.state(lambda state: not state['pairing'])['ready'])

if __name__=='__main__': unittest.main()
