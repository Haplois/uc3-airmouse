"""Validate explicitly supplied Bluetooth identities for device-scoped tools."""
import argparse
import re


def bluetooth_address(value):
    if not re.fullmatch(r'(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}', value):
        raise argparse.ArgumentTypeError('Expected a Bluetooth address as six hexadecimal octets')
    address = value.lower()
    if address in ('00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'):
        raise argparse.ArgumentTypeError('Expected an individual device address')
    return address
