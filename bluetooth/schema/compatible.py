"""Compile released layouts and authorize only unchanged attribute prefixes."""
import pathlib
import re
import subprocess
import sys
import tempfile


def attributes(header):
    body = header.split('profile_data[] =', 1)[1].split('};', 1)[0]
    body = re.sub(r'//[^\n]*', '', body)
    raw = bytes(int(x, 0) for x in re.findall(r'0x[0-9a-fA-F]+|\b[0-9]+\b', body))
    if raw[0] != 1:
        raise ValueError('Unsupported ATT format')
    result = []
    offset = 1
    while raw[offset:offset + 2] != b'\0\0':
        size = int.from_bytes(raw[offset:offset + 2], 'little')
        if size < 8 or offset + size > len(raw):
            raise ValueError('Malformed ATT record')
        result.append(raw[offset:offset + size])
        offset += size
    return result


def database_hash(records):
    matches = [r[8:] for r in records if r[6:8] == b'\x2a\x2b']
    if len(matches) != 1 or len(matches[0]) != 16:
        raise ValueError('Expected one database hash')
    return matches[0]


def compatible(old, new):
    if len(new) < len(old):
        return False
    for before, after in zip(old, new):
        if before[6:8] == b'\x2a\x2b':
            if before[:8] != after[:8]:
                return False
        elif before != after:
            return False
    return True


def main():
    compiler, current_header, output, lg_header = map(pathlib.Path, sys.argv[1:])
    current = attributes(current_header.read_text())
    hashes = []
    with tempfile.TemporaryDirectory() as work:
        for source in sorted(pathlib.Path(__file__).parent.glob('*.gatt')):
            header = pathlib.Path(work) / (source.stem + '.h')
            subprocess.run([sys.executable, str(compiler), str(source), str(header)], check=True)
            previous = attributes(header.read_text())
            if not compatible(previous, current):
                raise ValueError(f'{source.name}: incompatible layout; explicit migration required')
            hashes.append(database_hash(previous))
    def array(value):
        return '{' + ','.join(f'0x{x:02x}' for x in value) + '}'
    output.write_text('/* Generated from verified released ATT layouts. */\n'
                      'static const uint8_t compatible_hashes[][16] = {' +
                      ','.join(map(array, hashes)) + '};\n'
                      'static const uint8_t current_schema_hash[16] = ' +
                      array(database_hash(current)) + ';\n' +
                      'static const uint8_t lg_schema_hash[16] = ' +
                      array(database_hash(attributes(lg_header.read_text()))) + ';\n')


if __name__ == '__main__':
    main()
