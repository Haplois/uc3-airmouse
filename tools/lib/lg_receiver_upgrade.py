#!/usr/bin/env python3
"""Upgrade the persistent receiver with a timer that restores the previous build."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path('/var/lib/webosbrew/airmouse-lg-receiver')
STAGE = ROOT / 'upgrade-v5'
TARGET = Path('/usr/sbin/lginput2')
OLD = '971bc4fce21529adcdf194f9226aa3bfa44ad0d4ad462ab4902112aeca360b70'
NEW = 'e0d7097ef21fe83af854633307f82f169d5b9e653887de40bdc8004ea88420e3'
TIMER = 'airmouse-lg-upgrade-rollback'
SERVICES = ('airmouse-lg-power.service', 'bthidmanager.service', 'lginput2.service')


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, timeout=45).decode().strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def calibration():
    root = Path('/mnt/lg/cmn_data/mrcu')
    files = [*root.glob('mrcu*.scd'), *root.glob('*.dcd')]
    return {p.name: digest(p) for p in files}


def replace(source, destination):
    temporary = destination.with_name(destination.name + '.upgrade')
    shutil.copy2(source, temporary)
    temporary.replace(destination)


def activate():
    if (digest(TARGET) != OLD or digest(ROOT / 'lginput2') != OLD
            or digest(STAGE / 'lginput2.new') != NEW or (ROOT / 'disabled').exists()):
        raise ValueError('Installed or candidate receiver checksum mismatch')
    if (STAGE / 'lginput2.old').exists():
        raise ValueError('Upgrade backup already exists')
    for name in ('lginput2', 'startup.py'):
        shutil.copy2(ROOT / name, STAGE / (name + '.old'))
    (STAGE / 'calibration-before.json').write_text(json.dumps(calibration()))
    run('sync')
    run('systemd-run', '--unit=' + TIMER, '--on-active=120s',
        '/usr/bin/python3', str(STAGE / 'upgrade.py'), 'rollback')
    run('systemctl', 'stop', *SERVICES)
    run('umount', str(TARGET))
    for name in ('lginput2', 'startup.py'):
        replace(STAGE / (name + '.new'), ROOT / name)
    run('/usr/bin/python3', str(ROOT / 'startup.py'), 'boot')
    print('Candidate active; rollback timer armed', flush=True)


def rollback():
    if (STAGE / 'committed').exists():
        return
    if digest(STAGE / 'lginput2.old') != OLD or digest(TARGET) not in (OLD, NEW):
        # A failed activation can leave the stock file exposed after unmounting.
        stock = 'c58d4f06179944944c475e47bd0b6d9f1be1a4e032d8dc6562642d2ffdbd870b'
        if digest(STAGE / 'lginput2.old') != OLD or digest(TARGET) != stock:
            raise ValueError('Unexpected firmware during rollback')
    run('systemctl', 'stop', *SERVICES)
    if digest(TARGET) in (OLD, NEW):
        run('umount', str(TARGET))
    for name in ('lginput2', 'startup.py'):
        replace(STAGE / (name + '.old'), ROOT / name)
    (ROOT / 'disabled').unlink(missing_ok=True)
    run('/usr/bin/python3', str(ROOT / 'startup.py'), 'boot')
    run('systemctl', 'stop', TIMER + '.timer')
    run('sync')
    print('Previous receiver and startup restored; pairing and calibration untouched', flush=True)


def commit():
    pid = run('systemctl', 'show', 'lginput2.service', '-p', 'MainPID', '--value')
    if digest(Path('/proc') / pid / 'exe') != NEW or digest(ROOT / 'lginput2') != NEW:
        raise ValueError('Running or saved receiver mismatch')
    if calibration() != json.loads((STAGE / 'calibration-before.json').read_text()):
        raise ValueError('Calibration changed during upgrade; refusing automatic acceptance')
    for service in SERVICES:
        run('systemctl', 'is-active', '--quiet', service)
    (STAGE / 'committed').touch()
    run('systemctl', 'stop', TIMER + '.timer')
    run('sync')
    print('Persistent receiver upgrade committed; calibration unchanged', flush=True)


if __name__ == '__main__':
    actions = {'activate': activate, 'rollback': rollback, 'commit': commit}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        raise SystemExit('Expected activate, rollback, or commit')
    actions[sys.argv[1]]()
