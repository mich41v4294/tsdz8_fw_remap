import mapJson from "./parameter_map.json";
import { HexError } from "./intelHex";

export type Encoding =
  | "uint8_kmh"
  | "uint8_percent"
  | "uint8_pas_level"
  | "uint8_wheel_code"
  | "uint8_plus_255"
  | "thumb_movs_lsl"
  | "thumb_cmp_imm8"
  | "literal_le32"
  | "literal_i32"
  | "checkbox_sites";

export type ParameterGroup = "speed" | "assist" | "motor" | "protect" | "foc";
export type ParameterAudience = "rider" | "advanced";
export type ParameterControl = "number" | "checkbox";

export interface PatchSite {
  address: string;
  originalBytes: string[];
  patchedBytes: string[];
}

export interface ParameterSpec {
  id: string;
  label: string;
  audience: ParameterAudience;
  group: ParameterGroup;
  unit: string;
  address: string;
  size: number;
  encoding: Encoding;
  originalBytes: string[];
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  confidence: "high" | "medium" | "low";
  summary: string;
  notes: string;
  shift?: number;
  control?: ParameterControl;
  sites?: PatchSite[];
}

export interface PreserveSpec {
  id: string;
  label: string;
  address: string;
  originalBytes: string[];
  notes: string;
}

export interface ParameterMap {
  firmware: {
    id: string;
    label: string;
    mcu: string;
    flashBase: string;
    flashEnd: string;
    imageSize: number;
  };
  notes: string[];
  parameters: ParameterSpec[];
  preserve: PreserveSpec[];
}

export const parameterMap = mapJson as ParameterMap;

export const AUDIENCE_LABELS: Record<ParameterAudience, string> = {
  rider: "Rider settings",
  advanced: "Advanced firmware tunables",
};

export const GROUP_LABELS: Record<ParameterGroup, string> = {
  speed: "Speed",
  assist: "Assist",
  motor: "Motor",
  protect: "Protection",
  foc: "FOC / commutation",
};

export const GROUP_ORDER: ParameterGroup[] = ["speed", "assist", "motor", "protect", "foc"];

export function parseAddr(hex: string): number {
  return Number.parseInt(hex, 16);
}

export function parseBytes(hexBytes: string[]): number[] {
  return hexBytes.map((b) => Number.parseInt(b, 16));
}

function shiftOf(spec: ParameterSpec): number {
  return spec.shift ?? 0;
}

function packLe32(value: number): number[] {
  const v = value | 0;
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

function unpackLe32(bytes: number[]): number {
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
}

export function encodeValue(spec: ParameterSpec, value: number): number[] {
  switch (spec.encoding) {
    case "uint8_kmh":
    case "uint8_percent":
    case "uint8_pas_level":
    case "uint8_wheel_code":
    case "thumb_cmp_imm8":
      return [value & 0xff];
    case "uint8_plus_255":
      return [(value - 255) & 0xff];
    case "thumb_movs_lsl": {
      const shift = shiftOf(spec);
      const denom = 1 << shift;
      if (!Number.isInteger(value) || value % denom !== 0) {
        throw new HexError(`${spec.label} must be a multiple of ${denom}`);
      }
      const imm = value / denom;
      if (imm < 0 || imm > 255) {
        throw new HexError(`${spec.label} does not fit in a Thumb movs imm8<<${shift}`);
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
    default:
      throw new Error(`Unknown encoding ${spec.encoding}`);
  }
}

export function decodeValue(spec: ParameterSpec, bytes: number[]): number {
  switch (spec.encoding) {
    case "uint8_kmh":
    case "uint8_percent":
    case "uint8_pas_level":
    case "uint8_wheel_code":
    case "thumb_cmp_imm8":
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
    default:
      throw new Error(`Unknown encoding ${spec.encoding}`);
  }
}

export function parametersByAudience(audience: ParameterAudience): ParameterSpec[] {
  return parameterMap.parameters.filter((p) => p.audience === audience);
}

export function fingerprintItems(spec: ParameterSpec): { id: string; address: number; expected: number[] }[] {
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
