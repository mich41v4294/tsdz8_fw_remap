import mapJson from "./parameter_map.json?v=31" with { type: "json" };
import { HexError } from "./intelHex.js";
import { t } from "./i18n.js";

export const parameterMap = mapJson;

export const GROUP_ORDER = ["speed", "assist", "motor", "protect", "foc"];

export function parseAddr(hex) {
  return Number.parseInt(hex, 16);
}

export function parseBytes(hexBytes) {
  return hexBytes.map((b) => Number.parseInt(b, 16));
}

function shiftOf(spec) {
  return spec.shift ?? 0;
}

function packLe32(value) {
  const v = value | 0;
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

function unpackLe32(bytes) {
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
}

function packF64LePercent(value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value / 100, true);
  return [...new Uint8Array(buf)];
}

function unpackF64LePercent(bytes) {
  const buf = new ArrayBuffer(8);
  new Uint8Array(buf).set(bytes);
  return Math.round(new DataView(buf).getFloat64(0, true) * 100);
}

function packF32Le(value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return [...new Uint8Array(buf)];
}

function unpackF32Le(bytes) {
  const buf = new ArrayBuffer(4);
  new Uint8Array(buf).set(bytes);
  const value = new DataView(buf).getFloat32(0, true);
  return Math.abs(value - Math.round(value)) < 1e-5 ? Math.round(value) : value;
}

function mantissaLowOf(spec) {
  if (spec.mantissaLowBytes?.length === 4) {
    const b = parseBytes(spec.mantissaLowBytes);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  return 0x9999999a;
}

function packF64Hi32Percent(spec, value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value / 100, true);
  const bytes = [...new Uint8Array(buf)];
  const low = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  if (low !== mantissaLowOf(spec)) {
    throw new HexError(t("encode.mantissa", { label: spec.label }));
  }
  return bytes.slice(4, 8);
}

function unpackF64Hi32Percent(spec, bytes) {
  const low = mantissaLowOf(spec);
  const buf = new ArrayBuffer(8);
  const view = new Uint8Array(buf);
  view[0] = low & 0xff;
  view[1] = (low >> 8) & 0xff;
  view[2] = (low >> 16) & 0xff;
  view[3] = (low >> 24) & 0xff;
  view.set(bytes, 4);
  return Math.round(new DataView(buf).getFloat64(0, true) * 100);
}


function parseLsrs(halfword) {
  if ((halfword >> 11) !== 0b00001) {
    throw new HexError(t("encode.asrsPair", { label: "lsrs" }));
  }
  return {
    imm5: (halfword >> 6) & 0x1f,
    rm: (halfword >> 3) & 7,
    rd: halfword & 7,
  };
}

function packLsrs(imm5, rm, rd) {
  return 0x0800 | ((imm5 & 0x1f) << 6) | ((rm & 7) << 3) | (rd & 7);
}

function encodeCmpShiftN(spec, value) {
  const n = value | 0;
  const lo = spec.min ?? 1;
  const hi = spec.max ?? 7;
  if (n < lo || n > hi) {
    throw new HexError(t("encode.movs", { label: spec.label, shift: String(n) }));
  }
  return [(1 << n) - 1];
}

function decodeCmpShiftN(spec, bytes) {
  const imm = bytes[0];
  for (let n = 1; n <= 7; n++) {
    if ((1 << n) - 1 === imm) return n;
  }
  throw new HexError(t("encode.asrsPair", { label: spec.label }));
}

function encodeAsrsShiftN(spec, value, originalBytes) {
  const n = value | 0;
  const lo = spec.min ?? 1;
  const hi = spec.max ?? 7;
  if (n < lo || n > hi) {
    throw new HexError(t("encode.movs", { label: spec.label, shift: String(n) }));
  }
  const original = parseBytes(originalBytes ?? spec.originalBytes);
  if (original.length !== 2) {
    throw new HexError(t("encode.asrsPair", { label: spec.label }));
  }
  const { rm, rd } = parseAsrs(original[0] | (original[1] << 8));
  const w = packAsrs(n, rm, rd);
  return [w & 0xff, (w >> 8) & 0xff];
}

function decodeAsrsShiftN(spec, bytes) {
  if (bytes.length !== 2) {
    throw new HexError(t("encode.asrsPair", { label: spec.label }));
  }
  const { imm } = parseAsrs(bytes[0] | (bytes[1] << 8));
  const lo = spec.min ?? 1;
  const hi = spec.max ?? 7;
  if (imm < lo || imm > hi) {
    throw new HexError(t("encode.asrsPair", { label: spec.label }));
  }
  return imm;
}

export function encodeSiteBytes(spec, value, site) {
  if (spec.encoding === "thumb_asrs_shift_n") {
    return encodeAsrsShiftN(spec, value, site.originalBytes);
  }
  if (spec.encoding !== "thumb_cmp_shift_n") {
    return encodeValue(spec, value);
  }
  const role = site.role || "cmp_imm";
  const n = value | 0;
  if (role === "cmp_imm") return [(1 << n) - 1];
  const original = parseBytes(site.originalBytes);
  if (original.length !== 2) {
    throw new HexError(t("encode.asrsPair", { label: spec.label }));
  }
  const hw = original[0] | (original[1] << 8);
  let w;
  if (role === "lsrs") {
    const { rm, rd } = parseLsrs(hw);
    w = packLsrs(n, rm, rd);
  } else if (role === "asrs") {
    const { rm, rd } = parseAsrs(hw);
    w = packAsrs(n, rm, rd);
  } else {
    throw new HexError(t("encode.asrsPair", { label: spec.label }));
  }
  return [w & 0xff, (w >> 8) & 0xff];
}

function parseAsrs(halfword) {
  if ((halfword >> 11) !== 0b00010) {
    throw new HexError(t("encode.asrsPair", { label: "asrs" }));
  }
  return {
    imm5: (halfword >> 6) & 0x1f,
    rm: (halfword >> 3) & 7,
    rd: halfword & 7,
  };
}

function packAsrs(imm5, rm, rd) {
  return 0x1000 | ((imm5 & 0x1f) << 6) | ((rm & 7) << 3) | (rd & 7);
}

function asrsShiftsForValue(value, base, label) {
  if (!Number.isInteger(value) || value < 2) {
    throw new HexError(t("encode.asrsPair", { label }));
  }
  const bits = [];
  let v = value;
  let i = 0;
  while (v) {
    if (v & 1) bits.push(i);
    v >>= 1;
    i += 1;
    if (i > 16) break;
  }
  let a;
  let b;
  if (bits.length === 1) {
    const k = bits[0];
    if (k < 1) throw new HexError(t("encode.asrsPair", { label }));
    a = b = k - 1;
  } else if (bits.length === 2) {
    a = bits[0];
    b = bits[1];
  } else {
    throw new HexError(t("encode.asrsPair", { label }));
  }
  let s1 = base - a;
  let s2 = base - b;
  if (s1 > s2) {
    const tmp = s1;
    s1 = s2;
    s2 = tmp;
  }
  if (s1 < 0 || s2 < 0 || s1 > 31 || s2 > 31) {
    throw new HexError(t("encode.asrsPair", { label }));
  }
  return [s1, s2];
}

function encodeMovsMvnsNegExp(spec, value) {
  const label = spec.label;
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new HexError(t("encode.negExp", { label }));
  }
  return [(value - 1) & 0xff, 0x22, 0xd2, 0x43];
}

function decodeMovsMvnsNegExp(spec, bytes) {
  const label = spec.label;
  if (bytes.length !== 4 || bytes[1] !== 0x22 || bytes[2] !== 0xd2 || bytes[3] !== 0x43) {
    throw new HexError(t("encode.negExp", { label }));
  }
  if (bytes[0] > 3) throw new HexError(t("encode.negExp", { label }));
  return bytes[0] + 1;
}

function encodeSubsFromLiteral(spec, value) {
  const label = spec.label;
  const base = Number(spec.literalBase || 0);
  const imm = base - value;
  if (!Number.isInteger(value) || imm < 0 || imm > 255) {
    throw new HexError(t("encode.subsFromLiteral", { label, base: String(base) }));
  }
  return [imm & 0xff];
}

function decodeSubsFromLiteral(spec, bytes) {
  const base = Number(spec.literalBase || 0);
  return base - bytes[0];
}

function encodeLslLsr16Pow2Sixteenths(spec, value) {
  const label = spec.label;
  if (![1, 2, 4, 8].includes(value)) {
    throw new HexError(t("encode.asrsPair", { label }));
  }
  const lslImm = 12 + Math.log2(value);
  const w0 = (lslImm & 0x1f) << 6;
  const w1 = 0x0c00;
  return [w0 & 0xff, (w0 >> 8) & 0xff, w1 & 0xff, (w1 >> 8) & 0xff];
}

function decodeLslLsr16Pow2Sixteenths(spec, bytes) {
  const label = spec.label;
  if (bytes.length !== 4) throw new HexError(t("encode.asrsPair", { label }));
  const w0 = bytes[0] | (bytes[1] << 8);
  const w1 = bytes[2] | (bytes[3] << 8);
  if (w1 !== 0x0c00 || (w0 & 0xf83f) !== 0) {
    throw new HexError(t("encode.asrsPair", { label }));
  }
  const lslImm = (w0 >> 6) & 0x1f;
  if (lslImm < 12 || lslImm > 15) throw new HexError(t("encode.asrsPair", { label }));
  return 1 << (lslImm - 12);
}

function encodeAsrsPairSum(spec, value) {
  const label = spec.label;
  const base = spec.baseShift ?? 0;
  const original = parseBytes(spec.originalBytes);
  if (original.length !== 4) throw new HexError(t("encode.asrsPair", { label }));
  const first = parseAsrs(original[0] | (original[1] << 8));
  const second = parseAsrs(original[2] | (original[3] << 8));
  const [s1, s2] = asrsShiftsForValue(value, base, label);
  const w0 = packAsrs(s1, first.rm, first.rd);
  const w1 = packAsrs(s2, second.rm, second.rd);
  return [w0 & 0xff, (w0 >> 8) & 0xff, w1 & 0xff, (w1 >> 8) & 0xff];
}

function decodeAsrsPairSum(spec, bytes) {
  const label = spec.label;
  const base = spec.baseShift ?? 0;
  if (bytes.length !== 4) throw new HexError(t("encode.asrsPair", { label }));
  const first = parseAsrs(bytes[0] | (bytes[1] << 8));
  const second = parseAsrs(bytes[2] | (bytes[3] << 8));
  if (first.imm5 > base || second.imm5 > base) {
    throw new HexError(t("encode.asrsPair", { label }));
  }
  return (1 << (base - first.imm5)) + (1 << (base - second.imm5));
}

const THUMB_U16_LSLS8_ADDS = [null, 0x20, 0x00, 0x02, null, 0x30];

function encodeThumbU16MovsLsl8Adds(spec, value) {
  const label = spec.label;
  if (value === 0) return parseBytes(spec.originalBytes);
  if (!Number.isInteger(value) || value < 450 || value > 32767) {
    throw new HexError(t("encode.stockOrRange", { label }));
  }
  return [(value >> 8) & 0xff, 0x20, 0x00, 0x02, value & 0xff, 0x30];
}

function decodeThumbU16MovsLsl8Adds(spec, bytes) {
  const original = parseBytes(spec.originalBytes);
  if (bytes.length === original.length && bytes.every((b, i) => b === original[i])) return 0;
  if (
    bytes.length === 6 &&
    bytes[1] === THUMB_U16_LSLS8_ADDS[1] &&
    bytes[2] === THUMB_U16_LSLS8_ADDS[2] &&
    bytes[3] === THUMB_U16_LSLS8_ADDS[3] &&
    bytes[5] === THUMB_U16_LSLS8_ADDS[5]
  ) {
    return (bytes[0] << 8) | bytes[4];
  }
  throw new HexError(t("encode.stockOrRange", { label: spec.label }));
}

export function encodeValue(spec, value) {
  const label = spec.label;
  switch (spec.encoding) {
    case "uint8_kmh":
    case "uint8_percent":
    case "uint8_pas_level":
    case "uint8_wheel_code":
    case "thumb_cmp_imm8":
    case "thumb_movs_imm8":
    case "thumb_adds_imm8":
    case "thumb_subs_imm8":
      return [value & 0xff];
    case "uint8_plus_255":
      return [(value - 255) & 0xff];
    case "thumb_movs_lsl": {
      const shift = shiftOf(spec);
      const denom = 1 << shift;
      if (!Number.isInteger(value) || value % denom !== 0) {
        throw new HexError(t("encode.multiple", { label, denom: String(denom) }));
      }
      const imm = value / denom;
      if (imm < 0 || imm > 255) {
        throw new HexError(t("encode.movs", { label, shift: String(shift) }));
      }
      return [imm & 0xff];
    }
    case "literal_le32":
      return packLe32(value >>> 0);
    case "literal_i32":
      return packLe32(value);
    case "checkbox_sites": {
      const site = spec.sites?.[0];
      if (!site) throw new Error(`${spec.id} is missing sites`);
      return parseBytes(value ? site.patchedBytes : site.originalBytes);
    }
    case "thumb_u16_movs_lsl8_adds":
      return encodeThumbU16MovsLsl8Adds(spec, value);
    case "ieee_f64_le":
      return packF64LePercent(value);
    case "ieee_f64_hi32":
      return packF64Hi32Percent(spec, value);
    case "ieee_f32_le":
      return packF32Le(value);
    case "thumb_asrs_pair_sum":
      return encodeAsrsPairSum(spec, value);
    case "thumb_lsl_lsr16_pow2_sixteenths":
      return encodeLslLsr16Pow2Sixteenths(spec, value);
    case "thumb_movs_mvns_neg_exp":
      return encodeMovsMvnsNegExp(spec, value);
    case "thumb_subs_from_literal":
      return encodeSubsFromLiteral(spec, value);
    case "thumb_cmp_shift_n":
      return encodeCmpShiftN(spec, value);
    case "thumb_asrs_shift_n":
      return encodeAsrsShiftN(spec, value);
    default:
      throw new Error(`Unknown encoding ${spec.encoding}`);
  }
}

export function decodeValue(spec, bytes) {
  switch (spec.encoding) {
    case "uint8_kmh":
    case "uint8_percent":
    case "uint8_pas_level":
    case "uint8_wheel_code":
    case "thumb_cmp_imm8":
    case "thumb_movs_imm8":
    case "thumb_adds_imm8":
    case "thumb_subs_imm8":
      return bytes[0];
    case "uint8_plus_255":
      return bytes[0] + 255;
    case "thumb_movs_lsl":
      return bytes[0] << shiftOf(spec);
    case "literal_le32":
      return unpackLe32(bytes) >>> 0;
    case "literal_i32":
      return unpackLe32(bytes);
    case "checkbox_sites": {
      const site = spec.sites?.[0];
      if (!site) throw new Error(`${spec.id} is missing sites`);
      const patched = parseBytes(site.patchedBytes);
      return bytes.length === patched.length && bytes.every((b, i) => b === patched[i]) ? 1 : 0;
    }
    case "thumb_u16_movs_lsl8_adds":
      return decodeThumbU16MovsLsl8Adds(spec, bytes);
    case "ieee_f64_le":
      return unpackF64LePercent(bytes);
    case "ieee_f64_hi32":
      return unpackF64Hi32Percent(spec, bytes);
    case "ieee_f32_le":
      return unpackF32Le(bytes);
    case "thumb_asrs_pair_sum":
      return decodeAsrsPairSum(spec, bytes);
    case "thumb_lsl_lsr16_pow2_sixteenths":
      return decodeLslLsr16Pow2Sixteenths(spec, bytes);
    case "thumb_movs_mvns_neg_exp":
      return decodeMovsMvnsNegExp(spec, bytes);
    case "thumb_subs_from_literal":
      return decodeSubsFromLiteral(spec, bytes);
    case "thumb_cmp_shift_n":
      return decodeCmpShiftN(spec, bytes);
    case "thumb_asrs_shift_n":
      return decodeAsrsShiftN(spec, bytes);
    default:
      throw new Error(`Unknown encoding ${spec.encoding}`);
  }
}

export function parametersByAudience(audience) {
  return parameterMap.parameters.filter((p) => p.audience === audience);
}

export function fingerprintItems(spec) {
  if (spec.sites && spec.sites.length > 0) {
    return spec.sites.map((site, i) => ({
      id: `${spec.id}#${i}`,
      address: parseAddr(site.address),
      expected: parseBytes(site.originalBytes),
    }));
  }
  return [
    {
      id: spec.id,
      address: parseAddr(spec.address),
      expected: parseBytes(spec.originalBytes),
    },
  ];
}

export function parameterSites(spec) {
  if (spec.sites && spec.sites.length > 0) {
    return spec.sites.map((site) => ({
      address: parseAddr(site.address),
      originalBytes: parseBytes(site.originalBytes),
      patchedBytes: site.patchedBytes ? parseBytes(site.patchedBytes) : null,
    }));
  }
  return [
    {
      address: parseAddr(spec.address),
      originalBytes: parseBytes(spec.originalBytes),
      patchedBytes: null,
    },
  ];
}
