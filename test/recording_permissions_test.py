from pathlib import Path
import runpy
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class RecordingPermissionsTest(unittest.TestCase):
    def test_recording_launchers_grant_wake_input_access(self):
        with tempfile.TemporaryDirectory() as directory:
            for tool, args in [
                ('airmouse', ['record', '--seconds', '1']),
                ('airmouse-lg-record-sensor', ['--seconds', '1', '--output', str(Path(directory)/'record.jsonl')]),
            ]:
                with self.subTest(tool=tool):
                    launched = []
                    def run(command, **kwargs):
                        self.assertEqual(command[0], 'ssh')
                        remote = shlex.split(command[-1])
                        if remote[0] == 'systemd-run':
                            launched.append(remote)
                            self.assertIn('User=airmouse', remote)
                            self.assertIn('SupplementaryGroups=input', remote,
                                          'Sensor.start needs input-group access to BMI323 evdev')
                        return subprocess.CompletedProcess(command, 0)
                    with patch.object(sys, 'argv', [tool, *args]), patch('subprocess.run', run):
                        runpy.run_path(str(ROOT/'tools'/tool), run_name='__main__')
                    self.assertEqual(len(launched), 1)

    def test_crash_recorder_grants_wake_input_access(self):
        # Execute the diagnostic with fake device/systemd boundaries, never the host devices.
        script = r'''
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const launches=[];
const fakeFs={readdirSync:()=>[],existsSync:()=>false};
class Sensor {
  constructor(){this.root='/fake';this.io={read:()=> '1'};}
  snapshot(){return {};}
  restore(){}
}
const dependencies={
  'node:fs':{default:fakeFs},
  'node:child_process':{execFileSync:(command,args)=>{
    if(command==='systemd-run'){
      launches.push(args);
      assert.ok(args.includes('User=airmouse'));
      assert.ok(args.includes('SupplementaryGroups=input'),'Crash recorder needs BMI323 input access');
    }
    return '';
  }},
  'node:assert/strict':{default:assert},
  'node:timers/promises':{setTimeout:async()=>{}},
  './sensor.mjs':{Sensor},
};
const module=new vm.SourceTextModule(fs.readFileSync(0,'utf8'));
await module.link(name=>{
  assert.ok(dependencies[name],'Unexpected dependency '+name);
  const values=dependencies[name];
  return new vm.SyntheticModule(Object.keys(values),function(){
    for(const [key,value] of Object.entries(values))this.setExport(key,value);
  });
});
await module.evaluate();
assert.equal(launches.length,1);
'''
        result = subprocess.run(['node', '--experimental-vm-modules', '--input-type=module', '-e', script],
                                input=(ROOT/'runtime/crash-check.mjs').read_text(), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
