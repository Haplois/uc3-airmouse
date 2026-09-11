#!/usr/bin/env python3
"""Restore the reviewed receiver through the TV's existing startup hooks."""
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import subprocess
import sys
import time

ROOT = Path('/var/lib/webosbrew/airmouse-lg-receiver')
TARGET = Path('/usr/sbin/lginput2')
STOCK = 'c58d4f06179944944c475e47bd0b6d9f1be1a4e032d8dc6562642d2ffdbd870b'
PATCHED = 'e0d7097ef21fe83af854633307f82f169d5b9e653887de40bdc8004ea88420e3'
RECEIVER = 'lginput2.service'
BLUETOOTH = 'bthidmanager.service'
MRCU = Path('/mnt/lg/cmn_data/mrcu')
SLOT_FILES = ('mrcu1.info', 'mrcu1.scd', 'mrcu2.info', 'mrcu2.scd')


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, timeout=30).decode().strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def info_address(path):
    fields = dict(tuple(part.strip() for part in line.split('=', 1))
                  for line in path.read_text().splitlines() if '=' in line)
    return fields.get('BDAddr', '').lower()


def scd_address(path):
    match = re.search(rb'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', path.read_bytes().lower())
    return match.group().decode() if match else ''


def protected_slots():
    config = json.loads((ROOT / 'slots.json').read_text())
    primary = config['primary_address'].lower()
    secondary = config['secondary_address'].lower()
    expected = config['sha256']
    if (primary == secondary
            or not re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', primary)
            or not re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', secondary)
            or set(expected) != set(SLOT_FILES)):
        raise RuntimeError('Invalid protected receiver slots')
    saved = ROOT / 'slots'
    for name in SLOT_FILES:
        if digest(saved / name) != expected[name]:
            raise RuntimeError('Protected receiver slot checksum mismatch')
    if (info_address(saved / 'mrcu1.info') != primary
            or info_address(saved / 'mrcu2.info') != secondary
            or scd_address(saved / 'mrcu1.scd') != primary
            or scd_address(saved / 'mrcu2.scd') != secondary):
        raise RuntimeError('Protected receiver slot identity mismatch')
    return primary, secondary, saved


def slots_valid():
    try:
        primary, secondary, _ = protected_slots()
        return (info_address(MRCU / 'mrcu1.info') == primary
                and info_address(MRCU / 'mrcu2.info') == secondary
                and scd_address(MRCU / 'mrcu1.scd') == primary
                and scd_address(MRCU / 'mrcu2.scd') == secondary)
    except (OSError, KeyError, ValueError, RuntimeError):
        return False


def sanitize_info(data):
    lines = data.decode().splitlines()
    return ('\n'.join('hidraw = ' if line.startswith('hidraw =') else line for line in lines)
            + '\n').encode()


def protect(secondary):
    secondary = secondary.lower()
    if not re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', secondary):
        raise RuntimeError('Invalid secondary remote address')
    if (ROOT / 'slots.json').exists() or (ROOT / 'slots').exists():
        primary, saved_secondary, _ = protected_slots()
        if saved_secondary != secondary:
            raise RuntimeError('Protected secondary remote changed')
        if not slots_valid():
            raise RuntimeError('Live receiver slots do not match protected identities')
        print('Receiver slot protection already installed for ' + primary + ' and ' + secondary)
        return
    primary = info_address(MRCU / 'mrcu1.info')
    if not primary or primary == secondary or info_address(MRCU / 'mrcu2.info') != secondary:
        raise RuntimeError('Put the original remote in slot 0 and Remote 3 in slot 1 first')
    staging = ROOT / 'slots.new'
    saved = ROOT / 'slots'
    temporary = ROOT / 'slots.json.new'
    staging.mkdir(mode=0o700)
    promoted = False
    try:
        for name in SLOT_FILES:
            data = (MRCU / name).read_bytes()
            if name.endswith('.info'):
                data = sanitize_info(data)
            path = staging / name
            path.write_bytes(data)
            path.chmod(0o600)
        checksums = {name: digest(staging / name) for name in SLOT_FILES}
        config = {'primary_address': primary, 'secondary_address': secondary,
                  'sha256': checksums}
        temporary.write_text(json.dumps(config, sort_keys=True) + '\n')
        temporary.chmod(0o600)
        staging.rename(saved)
        promoted = True
        os.replace(temporary, ROOT / 'slots.json')
    except Exception:
        temporary.unlink(missing_ok=True)
        incomplete = saved if promoted else staging
        for path in incomplete.glob('*'):
            path.unlink()
        if incomplete.exists():
            incomplete.rmdir()
        raise
    protected_slots()
    print('Receiver slots protected for ' + primary + ' and ' + secondary)


def restore_slots():
    if not (ROOT / 'slots.json').exists():
        return False
    _, _, saved = protected_slots()
    if slots_valid():
        return False
    for name in SLOT_FILES:
        target = MRCU / name
        temporary = MRCU / (name + '.airmouse-new')
        temporary.write_bytes((saved / name).read_bytes())
        temporary.chmod(0o644)
        os.replace(temporary, target)
    if not slots_valid():
        raise RuntimeError('Receiver slot restoration did not validate')
    print('Restored protected receiver slots')
    return True


def api(method, body, *, service='com.webos.service.mrcu'):
    master, slave = pty.openpty()
    process = None
    output = bytearray()
    try:
        process = subprocess.Popen(
            ['/usr/bin/luna-send', '-n', '1', '-w', '3000', '-f',
             'luna://' + service + '/' + method, json.dumps(body)],
            stdin=slave, stdout=slave, stderr=slave)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                output.extend(os.read(master, 4096))
            if process.poll() is not None:
                while select.select([master], [], [], 0)[0]:
                    output.extend(os.read(master, 4096))
                break
        else:
            raise RuntimeError('Receiver API timed out')
        response = json.loads(output.decode())
        if process.returncode or response.get('returnValue') is not True:
            raise RuntimeError('Receiver API failed: ' + method)
        return response
    finally:
        if process and process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def enable():
    if digest(TARGET) == STOCK:
        return
    if digest(TARGET) != PATCHED:
        raise RuntimeError('Unexpected receiver executable')
    for attempt in range(5):
        try:
            api('getAPIVersion', {})
            api('enableDualPairing', {'enable': True})
            return
        except (OSError, ValueError, RuntimeError):
            if attempt == 4:
                raise
            time.sleep(.5)


def mount():
    if (ROOT / 'disabled').exists():
        return
    if digest(ROOT / 'lginput2') != PATCHED:
        raise RuntimeError('Saved receiver checksum mismatch')
    current = digest(TARGET)
    if current == PATCHED:
        return
    if current != STOCK:
        raise RuntimeError('Firmware changed; refusing receiver replacement')
    run('mount', '--bind', str(ROOT / 'lginput2'), str(TARGET))


def dropins():
    units = {
        Path('/run/systemd/system/lginput2.service.d/90-airmouse.conf'):
            '[Service]\nExecStartPre=/usr/bin/python3 ' + str(ROOT / 'startup.py') + ' mount\n'
            'ExecStartPost=/usr/bin/python3 ' + str(ROOT / 'startup.py') + ' enable\n',
        Path('/run/systemd/system/bthidmanager.service.d/90-airmouse.conf'):
            '[Unit]\nRequires=lginput2.service\nAfter=lginput2.service\nPartOf=lginput2.service\n',
    }
    if (ROOT / 'power.json').exists():
        units[Path('/run/systemd/system/airmouse-lg-power.service')] = (
            '[Unit]\nDescription=Remote 3 LG TV power key\n'
            'Requires=lginput2.service\nAfter=lginput2.service\nPartOf=lginput2.service\n'
            '[Service]\nType=simple\nExecStart=/usr/bin/python3 ' + str(ROOT / 'power-key.py') + '\n'
            'Restart=on-failure\nRestartSec=2\n')
    if (ROOT / 'link.json').exists():
        units[Path('/run/systemd/system/airmouse-lg-link.service')] = (
            '[Unit]\nDescription=Remote 3 LG Bluetooth connection timing\n'
            'Requires=lginput2.service\nAfter=lginput2.service\nPartOf=lginput2.service\n'
            '[Service]\nType=simple\nExecStart=/usr/bin/python3 ' + str(ROOT / 'link.py') + '\n'
            'Restart=on-failure\nRestartSec=5\n')
    return units


def remove_dropins():
    for path in dropins():
        if path.exists():
            path.unlink()
    run('systemctl', 'daemon-reload')


def rollback():
    (ROOT / 'disabled').touch()
    if (ROOT / 'link.json').exists():
        run('systemctl', 'stop', 'airmouse-lg-link.service')
    if (ROOT / 'power.json').exists():
        run('systemctl', 'stop', 'airmouse-lg-power.service')
    run('systemctl', 'stop', BLUETOOTH, RECEIVER)
    remove_dropins()
    if digest(TARGET) == PATCHED:
        run('umount', str(TARGET))
    run('systemctl', 'start', RECEIVER, BLUETOOTH)


def boot():
    if (ROOT / 'disabled').exists():
        print('LG receiver startup disabled')
        return
    if digest(ROOT / 'lginput2') != PATCHED or digest(TARGET) not in (STOCK, PATCHED):
        raise RuntimeError('Firmware checksum mismatch; existing receiver left in place')
    already_running = (digest(TARGET) == PATCHED and
                       run('systemctl', 'show', RECEIVER, '-p', 'ActiveState', '--value') == 'active')
    try:
        for path, contents in dropins().items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)
        run('systemctl', 'daemon-reload')
        if already_running:
            enable()
        else:
            run('systemctl', 'stop', BLUETOOTH, RECEIVER)
            restore_slots()
            run('systemctl', 'start', RECEIVER)
            run('systemctl', 'start', BLUETOOTH)
        pid = run('systemctl', 'show', RECEIVER, '-p', 'MainPID', '--value')
        if digest(Path('/proc') / pid / 'exe') != PATCHED:
            raise RuntimeError('Running receiver checksum mismatch')
        if (ROOT / 'power.json').exists():
            run('systemctl', 'start', 'airmouse-lg-power.service')
        if (ROOT / 'link.json').exists():
            try:
                run('systemctl', 'start', 'airmouse-lg-link.service')
            except (OSError, subprocess.SubprocessError):
                print('LG connection timing helper could not start; receiver remains active')
        print('LG receiver active; dual mode enabled; startup configuration installed')
    except Exception:
        if already_running:
            remove_dropins()
        else:
            rollback()
        raise


if __name__ == '__main__':
    actions = {'boot': boot, 'mount': mount, 'enable': enable, 'rollback': rollback}
    if len(sys.argv) == 3 and sys.argv[1] == 'protect':
        protect(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] in actions:
        actions[sys.argv[1]]()
    else:
        raise SystemExit('Expected boot, mount, enable, rollback, or protect ADDRESS')
