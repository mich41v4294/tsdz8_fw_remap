from __future__ import annotations

import unittest
from pathlib import Path

from tools.jlink_flasher.hexio import (
    IMAGE_SIZE,
    HexError,
    dump_hex,
    idchip_field,
    load_image,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
STOCK_HEX = REPO_ROOT / "original firmware thonghsheng.hex"


class HexioTests(unittest.TestCase):
    def test_roundtrip_synthetic_64k(self) -> None:
        image = bytes((i * 17) & 0xFF for i in range(IMAGE_SIZE))
        text = dump_hex(image)
        self.assertTrue(text.startswith(":020000041000EA"))
        self.assertIn(":020000041001E9", text)
        self.assertTrue(text.strip().endswith(":00000001FF"))
        self.assertEqual(load_image(text), image)

    def test_rejects_hole(self) -> None:
        lines = dump_hex(bytes(IMAGE_SIZE)).splitlines()
        data_lines = [ln for ln in lines if ln.startswith(":20")]
        kept = [ln for ln in lines if ln not in data_lines[10:11]]
        with self.assertRaisesRegex(HexError, "holes"):
            load_image("\n".join(kept) + "\n")

    def test_rejects_data_outside_window(self) -> None:
        with self.assertRaisesRegex(HexError, "outside"):
            load_image(":020000041000EA\n:020000000000FE\n:00000001FF\n")

    def test_rejects_bad_checksum(self) -> None:
        with self.assertRaisesRegex(HexError, "Checksum"):
            load_image(":0000000100\n")

    def test_idchip_field(self) -> None:
        self.assertEqual(idchip_field(0x00F1C000), 0xF1C0)
        self.assertEqual(idchip_field(0x12F1C034), 0xF1C0)


@unittest.skipUnless(STOCK_HEX.is_file(), "stock HEX not present")
class StockHexTests(unittest.TestCase):
    def test_stock_is_contiguous_64k(self) -> None:
        text = STOCK_HEX.read_text(encoding="utf-8")
        image = load_image(text)
        self.assertEqual(len(image), IMAGE_SIZE)
        self.assertEqual(image[:4], bytes([0x10, 0x32, 0x00, 0x20]))
        dumped = dump_hex(image)
        self.assertEqual(load_image(dumped), image)


if __name__ == "__main__":
    unittest.main()
