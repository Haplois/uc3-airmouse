import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('compatible', pathlib.Path(__file__).parents[1] / 'schema/compatible.py')
schema = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schema)


class SchemaTest(unittest.TestCase):
    def test_only_hash_value_and_append_are_compatible(self):
        attribute = b'\x09\x00\x02\x00\x01\x00\x00\x28\x12'
        hash_record = b'\x18\x00\x02\x00\x02\x00\x2a\x2b' + bytes(16)
        old = [attribute, hash_record]
        updated = [attribute, hash_record[:8] + bytes([1]) * 16, attribute]
        self.assertTrue(schema.compatible(old, updated))
        self.assertFalse(schema.compatible(old, updated[:1]))
        for byte in range(len(attribute)):
            changed = bytearray(attribute)
            changed[byte] ^= 1
            self.assertFalse(schema.compatible(old, [bytes(changed), hash_record]))
        changed_hash_handle = bytearray(hash_record)
        changed_hash_handle[4] += 1
        self.assertFalse(schema.compatible(old, [attribute, bytes(changed_hash_handle)]))


if __name__ == '__main__':
    unittest.main()
