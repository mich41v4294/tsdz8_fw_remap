"""Intel HEX constrained to the TSDZ8 64 KB window at 0x10001000."""

from __future__ import annotations

FLASH_BASE = 0x10001000
IMAGE_SIZE = 65536
RECORD_DATA_LEN = 32
IDCHIP_ADDR = 0x40010004
IDCHIP_FIELD_SHIFT = 8
IDCHIP_FIELD_MASK = 0xFFFF
IDCHIP_EXPECTED = 0xF1C0


class HexError(ValueError):
    pass


def _checksum(payload: bytes) -> int:
    return (~sum(payload) + 1) & 0xFF


def _parse_line(line: str) -> tuple[int, int, int, bytes]:
    trimmed = line.strip()
    if not trimmed.startswith(":"):
        raise HexError(f"Line does not start with ':': {trimmed[:20]}")
    hexpart = trimmed[1:]
    if len(hexpart) < 10 or len(hexpart) % 2:
        raise HexError(f"Invalid record length: {trimmed}")
    raw = bytes.fromhex(hexpart)
    count = raw[0]
    addr = (raw[1] << 8) | raw[2]
    rtype = raw[3]
    if len(raw) != count + 5:
        raise HexError(f"Count mismatch on record at {addr:04x}")
    data = raw[4 : 4 + count]
    recorded = raw[4 + count]
    expected = _checksum(raw[: 4 + count])
    if recorded != expected:
        raise HexError(f"Checksum {recorded:02x} != {expected:02x} at {addr:04x}")
    return count, addr, rtype, data


def load_image(text: str, base: int = FLASH_BASE, size: int = IMAGE_SIZE) -> bytes:
    """Parse Intel HEX into a contiguous `size`-byte image starting at `base`."""
    image = bytearray(size)
    seen = bytearray(size)
    ela = 0
    saw_eof = False
    for raw_line in text.splitlines():
        if not raw_line.strip():
            continue
        _count, addr, rtype, data = _parse_line(raw_line)
        if rtype == 1:
            saw_eof = True
            break
        if rtype == 4:
            if len(data) != 2:
                raise HexError("Type-04 record must be 2 bytes")
            ela = ((data[0] << 8) | data[1]) << 16
            continue
        if rtype == 2:
            if len(data) != 2:
                raise HexError("Type-02 record must be 2 bytes")
            ela = ((data[0] << 8) | data[1]) << 4
            continue
        if rtype in (3, 5):
            continue
        if rtype != 0:
            raise HexError(f"Unsupported HEX record type {rtype}")
        start = ela + addr
        for i, byte in enumerate(data):
            abs_addr = start + i
            if abs_addr < base or abs_addr >= base + size:
                raise HexError(f"HEX data at 0x{abs_addr:08X} is outside 0x{base:08X}+{size}")
            off = abs_addr - base
            image[off] = byte
            seen[off] = 1
    if not saw_eof:
        raise HexError("HEX file does not end with an EOF record")
    missing = [i for i, flag in enumerate(seen) if flag == 0]
    if missing:
        raise HexError(
            f"HEX has holes in the flash window (first missing 0x{base + missing[0]:08X})"
        )
    return bytes(image)


def dump_hex(image: bytes, base: int = FLASH_BASE, rec_len: int = RECORD_DATA_LEN) -> str:
    """Serialize a flat image as type-04 extended linear address plus data records."""
    lines: list[str] = []
    current_ela: int | None = None
    i = 0
    while i < len(image):
        abs_addr = base + i
        ela = (abs_addr >> 16) & 0xFFFF
        rec_addr = abs_addr & 0xFFFF
        if ela != current_ela:
            ela_payload = bytes([2, 0, 0, 4, (ela >> 8) & 0xFF, ela & 0xFF])
            lines.append(":" + ela_payload.hex().upper() + f"{_checksum(ela_payload):02X}")
            current_ela = ela
        take = min(rec_len, len(image) - i, 0x10000 - rec_addr)
        chunk = image[i : i + take]
        payload = bytes([len(chunk), (rec_addr >> 8) & 0xFF, rec_addr & 0xFF, 0]) + chunk
        lines.append(":" + payload.hex().upper() + f"{_checksum(payload):02X}")
        i += take
    eof = bytes([0, 0, 0, 1])
    lines.append(":" + eof.hex().upper() + f"{_checksum(eof):02X}")
    return "\n".join(lines) + "\n"


def idchip_field(word: int) -> int:
    return (word >> IDCHIP_FIELD_SHIFT) & IDCHIP_FIELD_MASK
