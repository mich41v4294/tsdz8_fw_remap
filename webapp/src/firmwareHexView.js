import { FLASH_BASE, IMAGE_SIZE } from "./intelHex.js";
import { decodeValue, parameterMap, parameterSites } from "./parameterMap.js";
import { bytesEqual, checkboxState } from "./firmwareDiff.js";

export const HEX_BYTES_PER_ROW = 16;
export const BIN_BYTES_PER_ROW = 8;
export const HEX_ROW_HEIGHT = 22;
export const OVERLAY_NONE = 0xffff;

const STATUS = { unmapped: 0, stock: 1, patched: 2, other: 3 };

export function bytesPerRow(mode) {
  return mode === "bin" ? BIN_BYTES_PER_ROW : HEX_BYTES_PER_ROW;
}

export function dumpRowCount(mode) {
  return IMAGE_SIZE / bytesPerRow(mode);
}

export function formatDumpByte(value, mode) {
  if (mode === "bin") return value.toString(2).padStart(8, "0");
  return value.toString(16).padStart(2, "0").toUpperCase();
}

export function asciiChar(value) {
  return value >= 32 && value < 127 ? String.fromCharCode(value) : ".";
}

function byteStatus(actual, original, patched) {
  if (actual === original) return STATUS.stock;
  if (patched != null && actual === patched) return STATUS.patched;
  return STATUS.other;
}

export function siteStatus(actual, original, patched) {
  if (bytesEqual(actual, original)) return "stock";
  if (patched && bytesEqual(actual, patched)) return "patched";
  return "other";
}

export function statusName(code) {
  if (code === STATUS.stock) return "stock";
  if (code === STATUS.patched) return "patched";
  if (code === STATUS.other) return "other";
  return "unmapped";
}

export function buildOverlay(image) {
  const ranges = [];
  for (const spec of parameterMap.parameters) {
    const sites = parameterSites(spec);
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      ranges.push({
        address: site.address,
        size: site.originalBytes.length,
        kind: "parameter",
        id: spec.id,
        siteIndex: i,
        audience: spec.audience,
        group: spec.group,
        encoding: spec.encoding,
        originalBytes: site.originalBytes,
        patchedBytes: site.patchedBytes,
      });
    }
  }
  for (const spec of parameterMap.preserve) {
    const originalBytes = spec.originalBytes.map((b) => Number.parseInt(b, 16));
    ranges.push({
      address: Number.parseInt(spec.address, 16),
      size: originalBytes.length,
      kind: "preserve",
      id: spec.id,
      siteIndex: 0,
      audience: "",
      group: "",
      encoding: "",
      originalBytes,
      patchedBytes: null,
      label: spec.label,
    });
  }

  const rangeIndex = new Uint16Array(IMAGE_SIZE).fill(OVERLAY_NONE);
  const status = new Uint8Array(IMAGE_SIZE);
  const overlaps = [];

  for (let idx = 0; idx < ranges.length; idx++) {
    const range = ranges[idx];
    const off = range.address - FLASH_BASE;
    for (let i = 0; i < range.size; i++) {
      const pos = off + i;
      if (pos < 0 || pos >= IMAGE_SIZE) continue;
      if (rangeIndex[pos] !== OVERLAY_NONE) {
        const other = ranges[rangeIndex[pos]];
        if (other.id !== range.id) {
          overlaps.push({ address: FLASH_BASE + pos, first: other.id, second: range.id });
        }
        continue;
      }
      rangeIndex[pos] = idx;
    }
  }

  let mappedByteCount = 0;
  let changedByteCount = 0;
  for (let pos = 0; pos < IMAGE_SIZE; pos++) {
    const idx = rangeIndex[pos];
    if (idx === OVERLAY_NONE) continue;
    mappedByteCount += 1;
    const range = ranges[idx];
    const i = FLASH_BASE + pos - range.address;
    const actual = image[pos];
    const patched = range.patchedBytes ? range.patchedBytes[i] : null;
    const code = byteStatus(actual, range.originalBytes[i], patched);
    status[pos] = code;
    if (code !== STATUS.stock) changedByteCount += 1;
  }

  return {
    ranges,
    rangeIndex,
    status,
    siteCount: ranges.length,
    mappedByteCount,
    changedByteCount,
    overlaps,
  };
}

export function inspectAddress(overlay, image, address) {
  const off = address - FLASH_BASE;
  if (off < 0 || off >= IMAGE_SIZE) return null;
  const value = image[off];
  const rangeIdx = overlay.rangeIndex[off];
  if (rangeIdx === OVERLAY_NONE) {
    return {
      address,
      mapped: false,
      value,
      siteBytes: [value],
      status: "unmapped",
    };
  }
  const range = overlay.ranges[rangeIdx];
  const start = range.address - FLASH_BASE;
  const siteBytes = Array.from(image.subarray(start, start + range.size));
  let decoded = null;
  let checkbox = null;
  if (range.kind === "parameter") {
    const spec = parameterMap.parameters.find((p) => p.id === range.id);
    if (spec?.encoding === "checkbox_sites") {
      checkbox = checkboxState(siteBytes, range.originalBytes, range.patchedBytes);
    } else if (spec) {
      try {
        decoded = decodeValue(spec, siteBytes);
      } catch {
        decoded = null;
      }
    }
  }
  return {
    address,
    mapped: true,
    range,
    value,
    siteBytes,
    originalBytes: range.originalBytes,
    patchedBytes: range.patchedBytes,
    decoded,
    checkbox,
    status: siteStatus(siteBytes, range.originalBytes, range.patchedBytes),
  };
}

export function parseGotoAddress(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let n;
  if (/^0x/i.test(raw)) {
    n = Number.parseInt(raw, 16);
  } else if (/[a-f]/i.test(raw)) {
    n = Number.parseInt(raw, 16);
  } else if (/^\d+$/.test(raw)) {
    n = Number.parseInt(raw, 10);
    if (n < IMAGE_SIZE) n = FLASH_BASE + n;
  } else {
    n = Number.parseInt(raw, 16);
  }
  if (!Number.isFinite(n)) return null;
  if (n < FLASH_BASE) n = FLASH_BASE + n;
  if (n < FLASH_BASE || n >= FLASH_BASE + IMAGE_SIZE) return null;
  return n;
}

export function rowIndexForAddress(address, mode) {
  const off = address - FLASH_BASE;
  if (off < 0 || off >= IMAGE_SIZE) return 0;
  return Math.floor(off / bytesPerRow(mode));
}
