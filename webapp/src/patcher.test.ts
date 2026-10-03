import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HexError } from "./intelHex";
import { IntelHex } from "./intelHex";
import {
  decodeValue,
  encodeValue,
  fingerprintItems,
  parameterMap,
  parseAddr,
  parseBytes,
} from "./parameterMap";
import { applyPatches, buildDiff, checkOriginalBytes, defaultValues } from "./patcher";

const STOCK_HEX = resolve(dirname(fileURLToPath(import.meta.url)), "../../original firmware thonghsheng.hex");
const describeStock = existsSync(STOCK_HEX) ? describe : describe.skip;

function stockImage(): IntelHex {
  return IntelHex.parse(readFileSync(STOCK_HEX, "utf8"));
}

describe("patcher", () => {
  it("has a short summary on every parameter", () => {
    expect(parameterMap.parameters.every((p) => p.summary.trim().length > 20)).toBe(true);
  });

  it("requires audience on every parameter", () => {
    expect(parameterMap.parameters.every((p) => p.audience === "rider" || p.audience === "advanced")).toBe(
      true,
    );
    expect(parameterMap.parameters.some((p) => p.audience === "rider")).toBe(true);
    expect(parameterMap.parameters.some((p) => p.audience === "advanced")).toBe(true);
  });

  it("round-trips every mapped stock value from originalBytes", () => {
    for (const spec of parameterMap.parameters) {
      const decoded = decodeValue(spec, parseBytes(spec.originalBytes));
      expect(decoded).toBe(spec.defaultValue);
      expect(encodeValue(spec, decoded)).toEqual(parseBytes(spec.originalBytes));
    }
  });

  it("writes only the requested ceiling byte and tags the diff as rider", () => {
    const values = { ...defaultValues(), speed_ceiling_kmh: 50 };
    const diffs = buildDiff(values);
    expect(diffs).toEqual([
      {
        id: "speed_ceiling_kmh",
        label: "Speed ceiling",
        audience: "rider",
        address: 0x1000881a,
        oldBytes: [0x19],
        newBytes: [0x32],
      },
    ]);
  });

  it("rejects a movs_lsl value that is not imm8<<shift", () => {
    const spec = parameterMap.parameters.find((p) => p.id === "pas_high_pulse_timeout");
    expect(spec).toBeTruthy();
    expect(() => encodeValue(spec!, 2001)).toThrow(HexError);
  });
});

describeStock("patcher vs stock dump", () => {
  it("accepts the mapped stock firmware fingerprint", () => {
    expect(checkOriginalBytes(stockImage())).toEqual([]);
  });

  it("refuses a file whose 25 km/h immediate is already changed", () => {
    const image = stockImage();
    image.setByte(0x1000881a, 0x3c);
    const failures = checkOriginalBytes(image);
    expect(failures.some((f) => f.id === "speed_ceiling_kmh")).toBe(true);
    expect(() => applyPatches(image, defaultValues())).toThrow(/does not match/);
  });

  it("applies the ceiling byte on a matching image", () => {
    const values = { ...defaultValues(), speed_ceiling_kmh: 50 };
    const patched = applyPatches(stockImage(), values);
    expect(patched.getByte(0x1000881a)).toBe(0x32);
    expect(patched.getByte(0x1000308a)).toBe(0x19);
    expect(patched.getByte(0x100085d2)).toBe(0x59);
  });

  it("encodes PAS percents and walk target from 255", () => {
    const values = { ...defaultValues(), pas1_percent: 40, walk_assist_target: 400 };
    const patched = applyPatches(stockImage(), values);
    expect(patched.getByte(0x10002edc)).toBe(40);
    expect(patched.getByte(0x100032c2)).toBe(400 - 255);
    expect(patched.getByte(0x10002f44)).toBe(0x64);
  });

  it("encodes thumb_movs_lsl and 32-bit literals without touching preserve bytes", () => {
    const values = {
      ...defaultValues(),
      pas_high_pulse_timeout: 2016,
      stall_current_mag_sq: 25000,
      pll_rate_clamp_low: -512,
    };
    const diffs = buildDiff(values);
    expect(diffs.map((d) => d.audience)).toEqual(["advanced", "advanced", "advanced"]);
    const patched = applyPatches(stockImage(), values);
    expect(patched.getByte(0x10008a96)).toBe(2016 >> 4);
    expect(patched.readBytes(0x100094cc, 4)).toEqual([0xa8, 0x61, 0x00, 0x00]);
    expect(patched.readBytes(0x100094a4, 4)).toEqual([0x00, 0xfe, 0xff, 0xff]);
    expect(patched.readBytes(0x10008a98, 2)).toEqual([0x12, 0x01]);
    expect(patched.readBytes(0x100094b4, 4)).toEqual([0x30, 0x75, 0x00, 0x00]);
    expect(patched.readBytes(0x10008de0, 4)).toEqual([0xc0, 0xf1, 0x00, 0x00]);
  });

  it("rejects applying a movs_lsl value that is not imm8<<shift", () => {
    expect(() => applyPatches(stockImage(), { ...defaultValues(), pas_high_pulse_timeout: 2001 })).toThrow(
      /multiple of 16/,
    );
  });

  it("matches originalBytes to the stock HEX at every mapped address", () => {
    const image = stockImage();
    for (const spec of parameterMap.parameters) {
      for (const item of fingerprintItems(spec)) {
        expect(image.readBytes(item.address, item.expected.length)).toEqual(item.expected);
      }
    }
    for (const spec of parameterMap.preserve) {
      expect(image.readBytes(parseAddr(spec.address), spec.originalBytes.length)).toEqual(
        parseBytes(spec.originalBytes),
      );
    }
  });

  it("unlimits the 60 km/h display path without touching UART 0x59", () => {
    const patched = applyPatches(stockImage(), { ...defaultValues(), unlimit_speed_display_60: 1 });
    expect(patched.readBytes(0x10008824, 2)).toEqual([0x03, 0xe0]);
    expect(patched.readBytes(0x10008890, 8)).toEqual([0x3c, 0x2d, 0x01, 0xd1, 0x63, 0x25, 0x00, 0xbf]);
    expect(patched.getByte(0x100085d2)).toBe(0x59);
    expect(patched.getByte(0x1000881a)).toBe(0x19);
  });

  it("disables both speed-fade cut paths", () => {
    const patched = applyPatches(stockImage(), { ...defaultValues(), disable_speed_fade: 1 });
    expect(patched.readBytes(0x100088f6, 2)).toEqual([0x0e, 0xe0]);
    expect(patched.readBytes(0x10008922, 2)).toEqual([0x0c, 0xe0]);
    expect(patched.getByte(0x100088f0)).toBe(0x4b);
  });

  it("skips battery OC and ride-loop current clamps", () => {
    const diffs = buildDiff({ ...defaultValues(), unlimit_power_and_current: 1 });
    expect(diffs).toHaveLength(5);
    expect(diffs.every((d) => d.audience === "rider")).toBe(true);
    const patched = applyPatches(stockImage(), { ...defaultValues(), unlimit_power_and_current: 1 });
    expect(patched.readBytes(0x10002da4, 2)).toEqual([0x02, 0xe0]);
    expect(patched.readBytes(0x10002dc8, 2)).toEqual([0x15, 0xe0]);
    expect(patched.readBytes(0x10002e12, 2)).toEqual([0x1e, 0xe0]);
    expect(patched.readBytes(0x100034fe, 2)).toEqual([0x00, 0xe0]);
    expect(patched.readBytes(0x1000350e, 2)).toEqual([0x00, 0xe0]);
  });
});
