from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from tools.jlink_flasher.hexio import FLASH_BASE, IDCHIP_ADDR, IMAGE_SIZE, dump_hex
from tools.jlink_flasher.probe import (
    ProbeError,
    check_idchip,
    check_vtref,
    flash_image,
    open_probe,
    read_flash,
)


class ChipIdTests(unittest.TestCase):
    def test_accepts_f1c0_field(self) -> None:
        check_idchip(0x00F1C000)

    def test_rejects_mismatch(self) -> None:
        with self.assertRaisesRegex(ProbeError, "IDCHIP"):
            check_idchip(0x00010000)


class VtrefTests(unittest.TestCase):
    def test_zero_is_warning(self) -> None:
        self.assertIn("0 mV", check_vtref(0, power=False) or "")

    def test_low_without_power_raises(self) -> None:
        with self.assertRaisesRegex(ProbeError, "VTref"):
            check_vtref(800, power=False)

    def test_low_with_power_ok(self) -> None:
        self.assertIsNone(check_vtref(800, power=True))

    def test_unknown_skipped(self) -> None:
        self.assertIsNone(check_vtref(None, power=False))


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
        jlink.halt.return_value = True
        jlink.halted.return_value = True
        jlink.target_voltage = 3300
        return jlink

    def test_open_reads_idchip(self) -> None:
        probe = self._probe()
        with open_probe(jlink=probe, skip_chip_id=False) as got:
            self.assertIs(got, probe)
        probe.open.assert_called_once()
        probe.memory_read32.assert_called_with(IDCHIP_ADDR, 1)
        probe.close.assert_called()
        probe.set_speed.assert_called()

    def test_flash_never_pulses_power_on(self) -> None:
        probe = self._probe()
        image = bytes((i * 3) & 0xFF for i in range(IMAGE_SIZE))
        flash_image(probe, image, power=True)
        probe.flash.assert_called_once()
        _args, kwargs = probe.flash.call_args
        self.assertEqual(_args[1], FLASH_BASE)
        self.assertFalse(kwargs["power_on"])
        probe.reset.assert_called_with(halt=False)

    def test_power_failure_raises(self) -> None:
        probe = self._probe()
        probe.exec_command.side_effect = RuntimeError("unsupported")
        probe.set_kickstart_power = None
        with self.assertRaisesRegex(ProbeError, "cannot switch target power"):
            with open_probe(jlink=probe, power=True):
                pass

    def test_low_vtref_without_power_raises(self) -> None:
        probe = self._probe()
        probe.target_voltage = 800
        with self.assertRaisesRegex(ProbeError, "VTref"):
            with open_probe(jlink=probe, power=False):
                pass

    def test_zero_vtref_does_not_block(self) -> None:
        probe = self._probe()
        probe.target_voltage = 0
        with open_probe(jlink=probe, power=False) as got:
            self.assertIs(got, probe)

    def test_halt_failure_raises(self) -> None:
        probe = self._probe()
        probe.halt.return_value = False
        probe.halted.return_value = False
        with self.assertRaisesRegex(ProbeError, "did not halt"):
            with open_probe(jlink=probe):
                pass

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
