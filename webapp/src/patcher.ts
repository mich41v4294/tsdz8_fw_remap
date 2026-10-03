import { HexError, IntelHex } from "./intelHex";
import {
  decodeValue,
  encodeValue,
  fingerprintItems,
  parameterMap,
  parseAddr,
  parseBytes,
  type ParameterSpec,
} from "./parameterMap";

export interface FingerprintFailure {
  id: string;
  address: number;
  expected: number[];
  actual: number[];
}

export interface ByteDiff {
  id: string;
  label: string;
  audience: ParameterSpec["audience"];
  address: number;
  oldBytes: number[];
  newBytes: number[];
}

export function checkOriginalBytes(image: IntelHex): FingerprintFailure[] {
  const failures: FingerprintFailure[] = [];
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

export function readParameter(image: IntelHex, spec: ParameterSpec): number {
  const bytes = image.readBytes(parseAddr(spec.address), spec.size);
  return decodeValue(spec, bytes);
}

export function buildDiff(
  values: Record<string, number>,
): ByteDiff[] {
  const diffs: ByteDiff[] = [];
  for (const spec of parameterMap.parameters) {
    const value = values[spec.id];
    if (value === undefined) continue;
    if (spec.sites && spec.sites.length > 0) {
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

export function applyPatches(image: IntelHex, values: Record<string, number>): IntelHex {
  const failures = checkOriginalBytes(image);
  if (failures.length > 0) {
    const first = failures[0];
    throw new HexError(
      `This HEX does not match the mapped stock firmware at 0x${first.address.toString(16)} (${first.id}). Refusing to patch.`,
    );
  }
  const patched = new IntelHex(image.records.map((r) => ({ ...r, data: new Uint8Array(r.data) })), image.newline);
  for (const spec of parameterMap.parameters) {
    const value = values[spec.id];
    if (value === undefined) continue;
    if (value < spec.min || value > spec.max) {
      throw new HexError(`${spec.label} must be between ${spec.min} and ${spec.max}`);
    }
    if (spec.step > 1 && value % spec.step !== 0) {
      throw new HexError(`${spec.label} must be a multiple of ${spec.step}`);
    }
    if (spec.sites && spec.sites.length > 0) {
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
    const bytes = encodeValue(spec, value);
    const addr = parseAddr(spec.address);
    for (let i = 0; i < bytes.length; i++) {
      patched.setByte(addr + i, bytes[i]);
    }
  }
  return patched;
}

export function defaultValues(): Record<string, number> {
  const values: Record<string, number> = {};
  for (const spec of parameterMap.parameters) {
    values[spec.id] = spec.defaultValue;
  }
  return values;
}
