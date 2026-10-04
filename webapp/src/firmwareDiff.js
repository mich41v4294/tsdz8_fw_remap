import { HexError, IntelHex, FLASH_BASE, IMAGE_SIZE } from "./intelHex.js";
import { decodeValue, parameterMap, parameterSites } from "./parameterMap.js";
import { t } from "./i18n.js";

export function bytesEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function checkboxState(bytes, originalBytes, patchedBytes) {
  if (patchedBytes && bytesEqual(bytes, patchedBytes)) return "on";
  if (bytesEqual(bytes, originalBytes)) return "off";
  return "unknown";
}

export function loadFirmwareBytes(name, text, buffer) {
  const lower = name.toLowerCase();
  const trimmed = (text || "").trimStart();
  const looksHex = lower.endsWith(".hex") || trimmed.startsWith(":");
  if (looksHex) {
    return IntelHex.parse(text).toFlatImage();
  }
  const raw = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (raw.length !== IMAGE_SIZE) {
    throw new HexError(t("compare.binSize", { got: String(raw.length), want: String(IMAGE_SIZE) }));
  }
  return raw;
}

export function compareFirmware(left, right) {
  if (left.length !== IMAGE_SIZE || right.length !== IMAGE_SIZE) {
    throw new HexError(
      t("compare.binSize", {
        got: `${left.length}/${right.length}`,
        want: String(IMAGE_SIZE),
      }),
    );
  }
  const covered = new Uint8Array(IMAGE_SIZE);
  const parameters = [];

  for (const spec of parameterMap.parameters) {
    const sites = parameterSites(spec);
    const siteDiffs = [];
    for (const site of sites) {
      const off = site.address - FLASH_BASE;
      if (off < 0 || off + site.originalBytes.length > IMAGE_SIZE) continue;
      const size = site.originalBytes.length;
      const oldBytes = Array.from(left.subarray(off, off + size));
      const newBytes = Array.from(right.subarray(off, off + size));
      for (let i = 0; i < size; i++) covered[off + i] = 1;
      if (!bytesEqual(oldBytes, newBytes)) {
        const entry = { address: site.address, oldBytes, newBytes };
        if (spec.encoding === "checkbox_sites") {
          entry.oldState = checkboxState(oldBytes, site.originalBytes, site.patchedBytes);
          entry.newState = checkboxState(newBytes, site.originalBytes, site.patchedBytes);
        }
        siteDiffs.push(entry);
      }
    }
    if (siteDiffs.length === 0) continue;

    if (spec.encoding === "checkbox_sites") {
      parameters.push({
        id: spec.id,
        audience: spec.audience,
        kind: "checkbox",
        sites: siteDiffs,
      });
      continue;
    }

    const primary = siteDiffs[0];
    parameters.push({
      id: spec.id,
      audience: spec.audience,
      kind: "value",
      address: primary.address,
      oldBytes: primary.oldBytes,
      newBytes: primary.newBytes,
      oldValue: decodeValue(spec, primary.oldBytes),
      newValue: decodeValue(spec, primary.newBytes),
    });
  }

  const unmapped = [];
  for (let i = 0; i < IMAGE_SIZE; i++) {
    if (covered[i]) continue;
    if (left[i] === right[i]) continue;
    const last = unmapped[unmapped.length - 1];
    const addr = FLASH_BASE + i;
    if (last && last.address + last.oldBytes.length === addr) {
      last.oldBytes.push(left[i]);
      last.newBytes.push(right[i]);
    } else {
      unmapped.push({ address: addr, oldBytes: [left[i]], newBytes: [right[i]] });
    }
  }

  return {
    parameters,
    unmapped,
    parameterCount: parameters.length,
    unmappedByteCount: unmapped.reduce((n, r) => n + r.oldBytes.length, 0),
  };
}
