"""Parameter-map encode/decode and firmware compare (mirrors the webapp)."""

from __future__ import annotations

import json
import struct
from pathlib import Path

from tools.jlink_flasher.hexio import FLASH_BASE, IMAGE_SIZE, HexError, dump_hex, load_image

MAP_PATH = Path(__file__).resolve().parents[1] / "webapp" / "src" / "parameter_map.json"
LOCALE_DIR = Path(__file__).resolve().parents[1] / "webapp" / "src" / "locales"

with MAP_PATH.open(encoding="utf-8") as fh:
    PARAMETER_MAP = json.load(fh)


def parse_addr(hex_str: str) -> int:
    return int(hex_str, 16)


def parse_bytes(hex_bytes: list[str]) -> list[int]:
    return [int(b, 16) for b in hex_bytes]


def _shift_of(spec: dict) -> int:
    return int(spec.get("shift") or 0)


def _pack_le32(value: int) -> list[int]:
    v = value & 0xFFFFFFFF
    return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]


def _unpack_le32(data: list[int]) -> int:
    return data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)


def _unpack_i32(data: list[int]) -> int:
    v = _unpack_le32(data)
    if v >= 0x80000000:
        v -= 0x100000000
    return v


def _encode_thumb_u16_movs_lsl8_adds(spec: dict, value: int) -> list[int]:
    label = spec["label"]
    if value == 0:
        return parse_bytes(spec["originalBytes"])
    if value < 450 or value > 32767:
        raise HexError(f"{label} 0 keeps the stock derived limit; overrides must be 450–32767")
    return [(value >> 8) & 0xFF, 0x20, 0x00, 0x02, value & 0xFF, 0x30]


def _decode_thumb_u16_movs_lsl8_adds(spec: dict, data: list[int]) -> int:
    original = parse_bytes(spec["originalBytes"])
    if data == original:
        return 0
    if len(data) == 6 and data[1] == 0x20 and data[2] == 0x00 and data[3] == 0x02 and data[5] == 0x30:
        return (data[0] << 8) | data[4]
    raise HexError(f"{spec['label']} 0 keeps the stock derived limit; overrides must be 450–32767")


def _mantissa_low(spec: dict) -> int:
    raw = spec.get("mantissaLowBytes") or []
    if len(raw) == 4:
        b = parse_bytes(raw)
        return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)
    return 0x9999999A


def _encode_f64_hi32(spec: dict, value: int) -> list[int]:
    packed = struct.pack("<d", value / 100.0)
    low = int.from_bytes(packed[:4], "little")
    if low != _mantissa_low(spec):
        raise HexError(
            f"{spec['label']} must keep the shared IEEE mantissa "
            "(valid percents are 10/20/40/80/160)"
        )
    return list(packed[4:8])


def _decode_f64_hi32(spec: dict, data: list[int]) -> int:
    low = _mantissa_low(spec).to_bytes(4, "little")
    return int(round(struct.unpack("<d", low + bytes(data))[0] * 100.0))


def _encode_f32_le(value: int | float) -> list[int]:
    return list(struct.pack("<f", float(value)))


def _decode_f32_le(data: list[int]) -> int:
    value = struct.unpack("<f", bytes(data))[0]
    rounded = round(value)
    if abs(value - rounded) < 1e-5:
        return int(rounded)
    return value  # type: ignore[return-value]


def _parse_asrs(halfword: int) -> tuple[int, int, int]:
    if (halfword >> 11) != 0b00010:
        raise HexError("Not a Thumb asrs imm5 instruction")
    return (halfword >> 6) & 0x1F, (halfword >> 3) & 7, halfword & 7


def _pack_asrs(imm5: int, rm: int, rd: int) -> int:
    return 0x1000 | ((imm5 & 0x1F) << 6) | ((rm & 7) << 3) | (rd & 7)


def _asrs_shifts_for_value(value: int, base: int, label: str) -> tuple[int, int]:
    if value < 2:
        raise HexError(f"{label} must be a sum of two shift contributions (min 2)")
    bits = [i for i in range(value.bit_length()) if value & (1 << i)]
    if len(bits) == 1:
        k = bits[0]
        if k < 1:
            raise HexError(f"{label} cannot be encoded as two asrs immediates")
        a = b = k - 1
    elif len(bits) == 2:
        a, b = bits[0], bits[1]
    else:
        raise HexError(f"{label} must be a sum of at most two powers of two")
    s1 = base - a
    s2 = base - b
    if s1 > s2:
        s1, s2 = s2, s1
    if s1 < 0 or s2 < 0 or s1 > 31 or s2 > 31:
        raise HexError(f"{label} does not fit in two Thumb asrs imm5 fields")
    return s1, s2


def _encode_movs_mvns_neg_exp(spec: dict, value: int) -> list[int]:
    label = spec["label"]
    if value < 1 or value > 4:
        raise HexError(f"{label} must be an exponent 1–4 (max_current / 2^n)")
    imm = value - 1
    return [imm & 0xFF, 0x22, 0xD2, 0x43]


def _decode_movs_mvns_neg_exp(spec: dict, data: list[int]) -> int:
    label = spec["label"]
    if len(data) != 4 or data[1] != 0x22 or data[2] != 0xD2 or data[3] != 0x43:
        raise HexError(f"{label} is not a Thumb movs r2 / mvns r2 pair")
    imm = data[0]
    if imm > 3:
        raise HexError(f"{label} movs immediate must be 0–3")
    return imm + 1



def _parse_lsrs(halfword: int) -> tuple[int, int, int]:
    if (halfword >> 11) != 0b00001:
        raise HexError("not a Thumb lsrs imm5")
    return (halfword >> 6) & 0x1F, (halfword >> 3) & 7, halfword & 7


def _pack_lsrs(imm5: int, rm: int, rd: int) -> int:
    return 0x0800 | ((imm5 & 0x1F) << 6) | ((rm & 7) << 3) | (rd & 7)


def _encode_cmp_shift_n(spec: dict, value: int) -> list[int]:
    label = spec["label"]
    n = int(value)
    lo = int(spec.get("min") or 1)
    hi = int(spec.get("max") or 7)
    if n < lo or n > hi:
        raise HexError(f"{label} shift N must be {lo}–{hi}")
    return [(1 << n) - 1]


def _decode_cmp_shift_n(spec: dict, data: list[int]) -> int:
    label = spec["label"]
    if not data:
        raise HexError(f"{label} cmp/shift decode needs the cmp imm byte")
    imm = data[0]
    for n in range(1, 8):
        if (1 << n) - 1 == imm:
            return n
    raise HexError(f"{label} cmp imm must be 2^N-1 (got {imm})")


def _encode_asrs_shift_n(spec: dict, value: int, original: list[int] | None = None) -> list[int]:
    label = spec["label"]
    n = int(value)
    lo = int(spec.get("min") or 1)
    hi = int(spec.get("max") or 7)
    if n < lo or n > hi:
        raise HexError(f"{label} shift N must be {lo}–{hi}")
    data = original if original is not None else parse_bytes(spec["originalBytes"])
    if len(data) != 2:
        raise HexError(f"{label} asrs shift site must be 2 bytes")
    _imm, rm, rd = _parse_asrs(data[0] | (data[1] << 8))
    w = _pack_asrs(n, rm, rd)
    return [w & 0xFF, (w >> 8) & 0xFF]


def _decode_asrs_shift_n(spec: dict, data: list[int]) -> int:
    label = spec["label"]
    if len(data) != 2:
        raise HexError(f"{label} asrs shift site must be 2 bytes")
    imm, _rm, _rd = _parse_asrs(data[0] | (data[1] << 8))
    lo = int(spec.get("min") or 1)
    hi = int(spec.get("max") or 7)
    if imm < lo or imm > hi:
        raise HexError(f"{label} asrs imm5 must be {lo}–{hi} (got {imm})")
    return imm


def encode_site_bytes(spec: dict, value: int, site: dict) -> list[int]:
    """Per-site bytes for encodings that patch heterogeneous sites."""
    encoding = spec["encoding"]
    if encoding == "thumb_asrs_shift_n":
        return _encode_asrs_shift_n(spec, value, parse_bytes(site["originalBytes"]))
    if encoding != "thumb_cmp_shift_n":
        return encode_value(spec, value)
    role = site.get("role") or "cmp_imm"
    n = int(value)
    if role == "cmp_imm":
        return [(1 << n) - 1]
    original = parse_bytes(site["originalBytes"])
    if len(original) != 2:
        raise HexError(f"{spec['label']} shift site must be 2 bytes")
    hw = original[0] | (original[1] << 8)
    if role == "lsrs":
        _imm, rm, rd = _parse_lsrs(hw)
        w = _pack_lsrs(n, rm, rd)
    elif role == "asrs":
        _imm, rm, rd = _parse_asrs(hw)
        w = _pack_asrs(n, rm, rd)
    else:
        raise HexError(f"{spec['label']} unknown site role {role}")
    return [w & 0xFF, (w >> 8) & 0xFF]


def _encode_subs_from_literal(spec: dict, value: int) -> list[int]:
    label = spec["label"]
    base = int(spec.get("literalBase") or 0)
    imm = base - int(value)
    if imm < 0 or imm > 255:
        raise HexError(f"{label} must keep {base}-value in 0–255")
    return [imm & 0xFF]


def _decode_subs_from_literal(spec: dict, data: list[int]) -> int:
    base = int(spec.get("literalBase") or 0)
    return base - data[0]


def _encode_lsl_lsr16_pow2_sixteenths(spec: dict, value: int) -> list[int]:
    label = spec["label"]
    if value not in (1, 2, 4, 8):
        raise HexError(f"{label} must be a power of two in 1/2/4/8 sixteenths")
    lsl_imm = 12 + (value.bit_length() - 1)
    w0 = (lsl_imm & 0x1F) << 6  # lsls r0, r0, #imm
    w1 = 0x0C00  # lsrs r0, r0, #16
    return [w0 & 0xFF, (w0 >> 8) & 0xFF, w1 & 0xFF, (w1 >> 8) & 0xFF]


def _decode_lsl_lsr16_pow2_sixteenths(spec: dict, data: list[int]) -> int:
    label = spec["label"]
    if len(data) != 4:
        raise HexError(f"{label} lsl/lsr pair must be 4 bytes")
    w0 = data[0] | (data[1] << 8)
    w1 = data[2] | (data[3] << 8)
    if w1 != 0x0C00 or (w0 & 0xF83F) != 0:
        raise HexError(f"{label} is not a Thumb lsls r0 / lsrs r0,#16 pair")
    lsl_imm = (w0 >> 6) & 0x1F
    if lsl_imm < 12 or lsl_imm > 15:
        raise HexError(f"{label} lsl immediate must be 12–15")
    return 1 << (lsl_imm - 12)


def _encode_asrs_pair_sum(spec: dict, value: int) -> list[int]:
    label = spec["label"]
    base = int(spec.get("baseShift") or 0)
    original = parse_bytes(spec["originalBytes"])
    if len(original) != 4:
        raise HexError(f"{label} asrs pair must be 4 bytes")
    _imm0, rm0, rd0 = _parse_asrs(original[0] | (original[1] << 8))
    _imm1, rm1, rd1 = _parse_asrs(original[2] | (original[3] << 8))
    s1, s2 = _asrs_shifts_for_value(value, base, label)
    w0 = _pack_asrs(s1, rm0, rd0)
    w1 = _pack_asrs(s2, rm1, rd1)
    return [w0 & 0xFF, (w0 >> 8) & 0xFF, w1 & 0xFF, (w1 >> 8) & 0xFF]


def _decode_asrs_pair_sum(spec: dict, data: list[int]) -> int:
    label = spec["label"]
    base = int(spec.get("baseShift") or 0)
    if len(data) != 4:
        raise HexError(f"{label} asrs pair must be 4 bytes")
    s1, _rm0, _rd0 = _parse_asrs(data[0] | (data[1] << 8))
    s2, _rm1, _rd1 = _parse_asrs(data[2] | (data[3] << 8))
    if s1 > base or s2 > base:
        raise HexError(f"{label} asrs shifts must be at most {base}")
    return (1 << (base - s1)) + (1 << (base - s2))


def encode_value(spec: dict, value: int) -> list[int]:
    encoding = spec["encoding"]
    label = spec["label"]
    if encoding in (
        "uint8_kmh",
        "uint8_percent",
        "uint8_pas_level",
        "uint8_wheel_code",
        "thumb_cmp_imm8",
        "thumb_movs_imm8",
        "thumb_adds_imm8",
        "thumb_subs_imm8",
    ):
        return [value & 0xFF]
    if encoding == "uint8_plus_255":
        return [(value - 255) & 0xFF]
    if encoding == "thumb_movs_lsl":
        shift = _shift_of(spec)
        denom = 1 << shift
        if value % denom != 0:
            raise HexError(f"{label} must be a multiple of {denom}")
        imm = value // denom
        if imm < 0 or imm > 255:
            raise HexError(f"{label} does not fit in a Thumb movs imm8<<{shift}")
        return [imm & 0xFF]
    if encoding == "literal_le32":
        return _pack_le32(value & 0xFFFFFFFF)
    if encoding == "literal_i32":
        return _pack_le32(value)
    if encoding == "checkbox_sites":
        sites = spec.get("sites") or []
        if not sites:
            raise ValueError(f"{spec['id']} is missing sites")
        site = sites[0]
        return parse_bytes(site["patchedBytes"] if value else site["originalBytes"])
    if encoding == "thumb_u16_movs_lsl8_adds":
        return _encode_thumb_u16_movs_lsl8_adds(spec, value)
    if encoding == "ieee_f64_le":
        return list(struct.pack("<d", value / 100.0))
    if encoding == "ieee_f64_hi32":
        return _encode_f64_hi32(spec, value)
    if encoding == "ieee_f32_le":
        return _encode_f32_le(value)
    if encoding == "thumb_asrs_pair_sum":
        return _encode_asrs_pair_sum(spec, value)
    if encoding == "thumb_lsl_lsr16_pow2_sixteenths":
        return _encode_lsl_lsr16_pow2_sixteenths(spec, value)
    if encoding == "thumb_movs_mvns_neg_exp":
        return _encode_movs_mvns_neg_exp(spec, value)
    if encoding == "thumb_subs_from_literal":
        return _encode_subs_from_literal(spec, value)
    if encoding == "thumb_cmp_shift_n":
        return _encode_cmp_shift_n(spec, value)
    if encoding == "thumb_asrs_shift_n":
        return _encode_asrs_shift_n(spec, value)
    raise ValueError(f"Unknown encoding {encoding}")


def decode_value(spec: dict, data: list[int]) -> int:
    encoding = spec["encoding"]
    if encoding in (
        "uint8_kmh",
        "uint8_percent",
        "uint8_pas_level",
        "uint8_wheel_code",
        "thumb_cmp_imm8",
        "thumb_movs_imm8",
        "thumb_adds_imm8",
        "thumb_subs_imm8",
    ):
        return data[0]
    if encoding == "uint8_plus_255":
        return data[0] + 255
    if encoding == "thumb_movs_lsl":
        return data[0] << _shift_of(spec)
    if encoding == "literal_le32":
        return _unpack_le32(data)
    if encoding == "literal_i32":
        return _unpack_i32(data)
    if encoding == "checkbox_sites":
        sites = spec.get("sites") or []
        if not sites:
            raise ValueError(f"{spec['id']} is missing sites")
        patched = parse_bytes(sites[0]["patchedBytes"])
        return 1 if data == patched else 0
    if encoding == "thumb_u16_movs_lsl8_adds":
        return _decode_thumb_u16_movs_lsl8_adds(spec, data)
    if encoding == "ieee_f64_le":
        return int(round(struct.unpack("<d", bytes(data))[0] * 100.0))
    if encoding == "ieee_f64_hi32":
        return _decode_f64_hi32(spec, data)
    if encoding == "ieee_f32_le":
        return _decode_f32_le(data)
    if encoding == "thumb_asrs_pair_sum":
        return _decode_asrs_pair_sum(spec, data)
    if encoding == "thumb_lsl_lsr16_pow2_sixteenths":
        return _decode_lsl_lsr16_pow2_sixteenths(spec, data)
    if encoding == "thumb_movs_mvns_neg_exp":
        return _decode_movs_mvns_neg_exp(spec, data)
    if encoding == "thumb_subs_from_literal":
        return _decode_subs_from_literal(spec, data)
    if encoding == "thumb_cmp_shift_n":
        return _decode_cmp_shift_n(spec, data)
    if encoding == "thumb_asrs_shift_n":
        return _decode_asrs_shift_n(spec, data)
    raise ValueError(f"Unknown encoding {encoding}")


def fingerprint_items(spec: dict) -> list[dict]:
    sites = spec.get("sites") or []
    if sites:
        return [
            {
                "id": f"{spec['id']}#{i}",
                "address": parse_addr(site["address"]),
                "expected": parse_bytes(site["originalBytes"]),
            }
            for i, site in enumerate(sites)
        ]
    return [
        {
            "id": spec["id"],
            "address": parse_addr(spec["address"]),
            "expected": parse_bytes(spec["originalBytes"]),
        }
    ]


def _is_checkbox(spec: dict) -> bool:
    return spec.get("encoding") == "checkbox_sites"


def parameter_sites(spec: dict) -> list[dict]:
    sites = spec.get("sites") or []
    if sites:
        return [
            {
                "address": parse_addr(site["address"]),
                "originalBytes": parse_bytes(site["originalBytes"]),
                "patchedBytes": parse_bytes(site["patchedBytes"]) if site.get("patchedBytes") else None,
            }
            for site in sites
        ]
    return [
        {
            "address": parse_addr(spec["address"]),
            "originalBytes": parse_bytes(spec["originalBytes"]),
            "patchedBytes": None,
        }
    ]


def _read(image: bytes, address: int, size: int) -> list[int]:
    off = address - FLASH_BASE
    if off < 0 or off + size > len(image):
        raise HexError(f"Address 0x{address:x} is missing")
    return list(image[off : off + size])


def _write(image: bytearray, address: int, data: list[int]) -> None:
    off = address - FLASH_BASE
    image[off : off + len(data)] = bytes(data)


def check_original_bytes(image: bytes) -> list[dict]:
    failures: list[dict] = []
    items = [item for p in PARAMETER_MAP["parameters"] for item in fingerprint_items(p)]
    items.extend(
        {
            "id": p["id"],
            "address": parse_addr(p["address"]),
            "expected": parse_bytes(p["originalBytes"]),
        }
        for p in PARAMETER_MAP["preserve"]
    )
    for item in items:
        actual = _read(image, item["address"], len(item["expected"]))
        if actual != item["expected"]:
            failures.append({**item, "actual": actual})
    return failures


def default_values() -> dict[str, int]:
    return {spec["id"]: spec["defaultValue"] for spec in PARAMETER_MAP["parameters"]}


def apply_preset(preset_id: str, values: dict[str, int]) -> dict[str, int]:
    preset = next((p for p in PARAMETER_MAP.get("presets", []) if p["id"] == preset_id), None)
    if preset is None:
        raise KeyError(preset_id)
    ids = {spec["id"] for spec in PARAMETER_MAP["parameters"]}
    out = dict(values)
    if preset.get("reset"):
        out = default_values()
    for key, value in (preset.get("values") or {}).items():
        if key not in ids:
            raise KeyError(key)
        out[key] = int(value)
    return out


def build_diff(values: dict[str, int]) -> list[dict]:
    diffs: list[dict] = []
    for spec in PARAMETER_MAP["parameters"]:
        if spec["id"] not in values:
            continue
        value = values[spec["id"]]
        sites = spec.get("sites") or []
        if _is_checkbox(spec):
            if not value:
                continue
            for site in sites:
                diffs.append(
                    {
                        "id": spec["id"],
                        "label": spec["label"],
                        "audience": spec["audience"],
                        "address": parse_addr(site["address"]),
                        "oldBytes": parse_bytes(site["originalBytes"]),
                        "newBytes": parse_bytes(site["patchedBytes"]),
                    }
                )
            continue
        if sites:
            for site in sites:
                old_bytes = parse_bytes(site["originalBytes"])
                new_bytes = encode_site_bytes(spec, value, site)
                if old_bytes != new_bytes:
                    diffs.append(
                        {
                            "id": spec["id"],
                            "label": spec["label"],
                            "audience": spec["audience"],
                            "address": parse_addr(site["address"]),
                            "oldBytes": old_bytes,
                            "newBytes": new_bytes,
                        }
                    )
            continue
        old_bytes = parse_bytes(spec["originalBytes"])
        new_bytes = encode_value(spec, value)
        if old_bytes != new_bytes:
            diffs.append(
                {
                    "id": spec["id"],
                    "label": spec["label"],
                    "audience": spec["audience"],
                    "address": parse_addr(spec["address"]),
                    "oldBytes": old_bytes,
                    "newBytes": new_bytes,
                }
            )
    return diffs


def apply_patches(image: bytes, values: dict[str, int]) -> bytearray:
    failures = check_original_bytes(image)
    if failures:
        first = failures[0]
        raise HexError(
            f"This HEX does not match the mapped stock firmware at 0x{first['address']:x} "
            f"({first['id']}). Refusing to patch."
        )
    out = bytearray(image)
    for spec in PARAMETER_MAP["parameters"]:
        if spec["id"] not in values:
            continue
        value = values[spec["id"]]
        if value < spec["min"] or value > spec["max"]:
            raise HexError(f"{spec['label']} must be between {spec['min']} and {spec['max']}")
        if spec["step"] > 1 and value % spec["step"] != 0:
            raise HexError(f"{spec['label']} must be a multiple of {spec['step']}")
        sites = spec.get("sites") or []
        if _is_checkbox(spec):
            if not value:
                continue
            for site in sites:
                _write(out, parse_addr(site["address"]), parse_bytes(site["patchedBytes"]))
            continue
        if sites:
            for site in sites:
                _write(out, parse_addr(site["address"]), encode_site_bytes(spec, value, site))
            continue
        _write(out, parse_addr(spec["address"]), encode_value(spec, value))
    return out


def checkbox_state(data: list[int], original: list[int], patched: list[int] | None) -> str:
    if patched is not None and data == patched:
        return "on"
    if data == original:
        return "off"
    return "unknown"


def compare_firmware(left: bytes, right: bytes) -> dict:
    if len(left) != IMAGE_SIZE or len(right) != IMAGE_SIZE:
        raise HexError(f"Image must be {IMAGE_SIZE} bytes (got {len(left)}/{len(right)})")
    covered = bytearray(IMAGE_SIZE)
    parameters: list[dict] = []
    for spec in PARAMETER_MAP["parameters"]:
        sites = parameter_sites(spec)
        site_diffs: list[dict] = []
        for site in sites:
            off = site["address"] - FLASH_BASE
            size = len(site["originalBytes"])
            if off < 0 or off + size > IMAGE_SIZE:
                continue
            old = list(left[off : off + size])
            new = list(right[off : off + size])
            covered[off : off + size] = b"\x01" * size
            if old != new:
                entry = {"address": site["address"], "oldBytes": old, "newBytes": new}
                if spec["encoding"] == "checkbox_sites":
                    entry["oldState"] = checkbox_state(old, site["originalBytes"], site["patchedBytes"])
                    entry["newState"] = checkbox_state(new, site["originalBytes"], site["patchedBytes"])
                site_diffs.append(entry)
        if not site_diffs:
            continue
        if spec["encoding"] == "checkbox_sites":
            parameters.append(
                {"id": spec["id"], "audience": spec["audience"], "kind": "checkbox", "sites": site_diffs}
            )
            continue
        primary = site_diffs[0]
        parameters.append(
            {
                "id": spec["id"],
                "audience": spec["audience"],
                "kind": "value",
                "address": primary["address"],
                "oldBytes": primary["oldBytes"],
                "newBytes": primary["newBytes"],
                "oldValue": decode_value(spec, primary["oldBytes"]),
                "newValue": decode_value(spec, primary["newBytes"]),
            }
        )

    unmapped: list[dict] = []
    for i, flag in enumerate(covered):
        if flag or left[i] == right[i]:
            continue
        addr = FLASH_BASE + i
        if unmapped and unmapped[-1]["address"] + len(unmapped[-1]["oldBytes"]) == addr:
            unmapped[-1]["oldBytes"].append(left[i])
            unmapped[-1]["newBytes"].append(right[i])
        else:
            unmapped.append({"address": addr, "oldBytes": [left[i]], "newBytes": [right[i]]})

    return {
        "parameters": parameters,
        "unmapped": unmapped,
        "parameterCount": len(parameters),
        "unmappedByteCount": sum(len(r["oldBytes"]) for r in unmapped),
    }


def site_status(actual: list[int], original: list[int], patched: list[int] | None = None) -> str:
    """Classify a whole mapped site. First-byte-only matches are not enough."""
    if actual == original:
        return "stock"
    if patched is not None and actual == patched:
        return "patched"
    return "other"


def overlay_ranges(image: bytes | None = None) -> dict:
    """Map parameter and preserve sites onto the 64 KiB flash window."""
    ranges: list[dict] = []
    for spec in PARAMETER_MAP["parameters"]:
        for i, site in enumerate(parameter_sites(spec)):
            ranges.append(
                {
                    "address": site["address"],
                    "size": len(site["originalBytes"]),
                    "kind": "parameter",
                    "id": spec["id"],
                    "siteIndex": i,
                    "audience": spec["audience"],
                    "group": spec["group"],
                    "encoding": spec["encoding"],
                    "originalBytes": site["originalBytes"],
                    "patchedBytes": site["patchedBytes"],
                }
            )
    for spec in PARAMETER_MAP["preserve"]:
        original = parse_bytes(spec["originalBytes"])
        ranges.append(
            {
                "address": parse_addr(spec["address"]),
                "size": len(original),
                "kind": "preserve",
                "id": spec["id"],
                "siteIndex": 0,
                "audience": None,
                "group": None,
                "encoding": None,
                "originalBytes": original,
                "patchedBytes": None,
                "label": spec.get("label"),
            }
        )

    covered: list[int | None] = [None] * IMAGE_SIZE
    overlaps: list[dict] = []
    for idx, rng in enumerate(ranges):
        off = rng["address"] - FLASH_BASE
        for i in range(rng["size"]):
            pos = off + i
            if pos < 0 or pos >= IMAGE_SIZE:
                continue
            existing = covered[pos]
            if existing is not None:
                other = ranges[existing]
                if other["id"] != rng["id"]:
                    overlaps.append(
                        {
                            "address": FLASH_BASE + pos,
                            "first": other["id"],
                            "second": rng["id"],
                        }
                    )
            covered[pos] = idx

    hits: list[dict] = []
    mapped = 0
    changed = 0
    for pos, idx in enumerate(covered):
        if idx is None:
            continue
        mapped += 1
        rng = ranges[idx]
        i = FLASH_BASE + pos - rng["address"]
        status = "stock"
        if image is not None:
            actual = image[pos]
            original = rng["originalBytes"][i]
            patched_list = rng["patchedBytes"]
            patched = patched_list[i] if patched_list is not None else None
            if actual == original:
                status = "stock"
            elif patched is not None and actual == patched:
                status = "patched"
            else:
                status = "other"
            if status != "stock":
                changed += 1
        hits.append(
            {
                "offset": pos,
                "address": FLASH_BASE + pos,
                "rangeIndex": idx,
                "id": rng["id"],
                "kind": rng["kind"],
                "status": status,
            }
        )

    return {
        "ranges": ranges,
        "hits": hits,
        "siteCount": len(ranges),
        "mappedByteCount": mapped,
        "changedByteCount": changed,
        "overlaps": overlaps,
    }


def image_from_hex_text(text: str) -> bytes:
    return load_image(text)


def hex_from_image(image: bytes) -> str:
    return dump_hex(image)
