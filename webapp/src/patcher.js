import { HexError, IntelHex } from "./intelHex.js";
import {
  decodeValue,
  encodeValue,
  encodeSiteBytes,
  fingerprintItems,
  parameterMap,
  parseAddr,
  parseBytes,
} from "./parameterMap.js";
import { t } from "./i18n.js";

export function checkOriginalBytes(image) {
  const failures = [];
  const items = [
    ...parameterMap.parameters.flatMap((p) => fingerprintItems(p)),
    ...parameterMap.preserve.map((p) => ({
      id: p.id,
      address: parseAddr(p.address),
      expected: parseBytes(p.originalBytes),
    })),
  ];
  for (const item of items) {
    const actual = image.readBytes(item.address, item.expected.length);
    if (actual.some((b, i) => b !== item.expected[i])) {
      failures.push({ ...item, actual });
    }
  }
  return failures;
}

export function readParameter(image, spec) {
  const bytes = image.readBytes(parseAddr(spec.address), spec.size);
  return decodeValue(spec, bytes);
}

export function buildDiff(values) {
  const diffs = [];
  for (const spec of parameterMap.parameters) {
    const value = values[spec.id];
    if (value === undefined) continue;
    if (spec.encoding === "checkbox_sites" && spec.sites?.length) {
      if (!value) continue;
      for (const site of spec.sites) {
        diffs.push({
          id: spec.id,
          label: spec.label,
          audience: spec.audience,
          address: parseAddr(site.address),
          oldBytes: parseBytes(site.originalBytes),
          newBytes: parseBytes(site.patchedBytes),
        });
      }
      continue;
    }
    if (spec.sites?.length) {
      for (const site of spec.sites) {
        const oldBytes = parseBytes(site.originalBytes);
        const newBytes = encodeSiteBytes(spec, value, site);
        if (oldBytes.length !== newBytes.length || oldBytes.some((b, i) => b !== newBytes[i])) {
          diffs.push({
            id: spec.id,
            label: spec.label,
            audience: spec.audience,
            address: parseAddr(site.address),
            oldBytes,
            newBytes,
          });
        }
      }
      continue;
    }
    const oldBytes = parseBytes(spec.originalBytes);
    const newBytes = encodeValue(spec, value);
    if (oldBytes.length !== newBytes.length || oldBytes.some((b, i) => b !== newBytes[i])) {
      diffs.push({
        id: spec.id,
        label: spec.label,
        audience: spec.audience,
        address: parseAddr(spec.address),
        oldBytes,
        newBytes,
      });
    }
  }
  return diffs;
}

export function applyPatches(image, values) {
  const failures = checkOriginalBytes(image);
  if (failures.length > 0) {
    const first = failures[0];
    throw new HexError(
      t("patch.mismatch", { addr: first.address.toString(16), id: first.id }),
    );
  }
  const patched = new IntelHex(
    image.records.map((r) => ({ ...r, data: new Uint8Array(r.data) })),
    image.newline,
  );
  for (const spec of parameterMap.parameters) {
    const value = values[spec.id];
    if (value === undefined) continue;
    if (value < spec.min || value > spec.max) {
      throw new HexError(t("patch.range", { label: spec.label, min: spec.min, max: spec.max }));
    }
    if (spec.step > 1 && value % spec.step !== 0) {
      throw new HexError(t("patch.step", { label: spec.label, step: spec.step }));
    }
    if (spec.encoding === "checkbox_sites" && spec.sites?.length) {
      if (!value) continue;
      for (const site of spec.sites) {
        const bytes = parseBytes(site.patchedBytes);
        const addr = parseAddr(site.address);
        for (let i = 0; i < bytes.length; i++) {
          patched.setByte(addr + i, bytes[i]);
        }
      }
      continue;
    }
    if (spec.sites?.length) {
      for (const site of spec.sites) {
        const bytes = encodeSiteBytes(spec, value, site);
        const addr = parseAddr(site.address);
        for (let i = 0; i < bytes.length; i++) {
          patched.setByte(addr + i, bytes[i]);
        }
      }
      continue;
    }
    const bytes = encodeValue(spec, value);
    const addr = parseAddr(spec.address);
    for (let i = 0; i < bytes.length; i++) {
      patched.setByte(addr + i, bytes[i]);
    }
  }
  return patched;
}

export function defaultValues() {
  const values = {};
  for (const spec of parameterMap.parameters) {
    values[spec.id] = spec.defaultValue;
  }
  return values;
}

export function applyPreset(presetId, values) {
  const preset = (parameterMap.presets ?? []).find((p) => p.id === presetId);
  if (!preset) throw new Error(`Unknown preset ${presetId}`);
  const ids = new Set(parameterMap.parameters.map((p) => p.id));
  if (preset.reset) {
    const defaults = defaultValues();
    for (const id of Object.keys(defaults)) values[id] = defaults[id];
  }
  for (const [id, value] of Object.entries(preset.values ?? {})) {
    if (!ids.has(id)) throw new Error(`Preset ${presetId} references unknown parameter ${id}`);
    values[id] = value;
  }
  return values;
}

export function presetMatches(preset, values) {
  if (preset.reset) {
    return parameterMap.parameters.every((p) => values[p.id] === p.defaultValue);
  }
  return Object.entries(preset.values ?? {}).every(([id, value]) => values[id] === value);
}
