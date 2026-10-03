from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from tools.jlink_flasher.cli import build_parser
from tools.jlink_flasher.hexio import FLASH_BASE, IDCHIP_ADDR, IMAGE_SIZE, dump_hex
from tools.jlink_flasher.probe import ProbeError, check_idchip, flash_image, open_probe, read_flash


class CliTests(unittest.TestCase):
    def test_flash_defaults(self) -> None:
        args = build_parser().parse_args(["flash", "a.hex"])
        self.assertFalse(args.power)
        self.assertEqual(args.device, "XMC1302-T038x0064")
        self.assertEqual(args.speed, 4000)


class ChipIdTests(unittest.TestCase):
    def test_accepts_f1c0_field(self) -> None:
        check_idchip(0x00F1C000)

    def test_rejects_mismatch(self) -> None:
        with self.assertRaisesRegex(ProbeError, "IDCHIP"):
            check_idchip(0x00010000)


class FakeProbeTests(unittest.TestCase):
    def _probe(self) -> MagicMock:
        jlink = MagicMock()
        image = bytes((i * 3) & 0xFF for i in range(IMAGE_SIZE))
        jlink.memory_read32.return_value = [0x00F1C000]

        def read8(addr: int, count: int) -> list[int]:
            off = addr - FLASH_BASE
            return list(image[off : off + count])

        jlink.memory_read8.side_effect = read8
        jlink.flash.return_value = IMAGE_SIZE
        jlink.product_name = "J-Link"
        jlink.core_id.return_value = 0x0BB11477
        return jlink

    def test_open_reads_idchip(self) -> None:
        probe = self._probe()
        with open_probe(jlink=probe, skip_chip_id=False) as got:
            self.assertIs(got, probe)
        probe.open.assert_called_once()
        probe.memory_read32.assert_called_with(IDCHIP_ADDR, 1)
        probe.close.assert_called()

    def test_flash_verifies(self) -> None:
        probe = self._probe()
        image = bytes((i * 3) & 0xFF for i in range(IMAGE_SIZE))
        flash_image(probe, image, power=False)
        probe.flash.assert_called_once()
        args, kwargs = probe.flash.call_args
        self.assertEqual(args[1], FLASH_BASE)
        self.assertFalse(kwargs["power_on"])
        probe.reset.assert_called_with(halt=False)

    def test_read_flash_length(self) -> None:
        probe = self._probe()
        data = read_flash(probe)
        self.assertEqual(len(data), IMAGE_SIZE)

    def test_dump_hex_roundtrip_matches_fake(self) -> None:
        probe = self._probe()
        image = read_flash(probe)
        self.assertEqual(image, load_via_dump(image))


def load_via_dump(image: bytes) -> bytes:
    from tools.jlink_flasher.hexio import load_image

    return load_image(dump_hex(image))


if __name__ == "__main__":
    unittest.main()
