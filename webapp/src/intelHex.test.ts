import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IntelHex, checksum, formatRecord, parseHexLine, FLASH_BASE, IMAGE_SIZE } from "./intelHex";

const STOCK_HEX = resolve(dirname(fileURLToPath(import.meta.url)), "../../original firmware thonghsheng.hex");
const describeStock = existsSync(STOCK_HEX) ? describe : describe.skip;

describe("intel hex", () => {
  it("rejects a bad checksum", () => {
    expect(() => parseHexLine(":00000001FF")).not.toThrow();
    expect(() => parseHexLine(":0000000100")).toThrow(/Checksum/);
  });

  it("formats a record with a correct checksum", () => {
    const rec = formatRecord({
      length: 1,
      address: 0x1000,
      type: 0,
      data: Uint8Array.from([0x19]),
    });
    const payload = Uint8Array.from([1, 0x10, 0x00, 0, 0x19]);
    expect(rec.checksum).toBe(checksum(payload));
    expect(rec.raw.startsWith(":")).toBe(true);
  });

  it("round-trips a contiguous 64 KB window through toFlatImage", () => {
    const image = Uint8Array.from({ length: IMAGE_SIZE }, (_, i) => (i * 17) & 0xff);
    const hex = IntelHex.fromFlatImage(image);
    expect(hex.records[0].type).toBe(4);
    expect(hex.toFlatImage()).toEqual(image);
    expect(IntelHex.parse(hex.serialize()).toFlatImage()).toEqual(image);
    expect(hex.getByte(FLASH_BASE)).toBe(image[0]);
    expect(hex.getByte(FLASH_BASE + IMAGE_SIZE - 1)).toBe(image[IMAGE_SIZE - 1]);
  });

  it("rejects holes when flattening", () => {
    const recs = [
      formatRecord({
        length: 2,
        address: 0,
        type: 4,
        data: Uint8Array.from([0x10, 0x00]),
      }),
      formatRecord({
        length: 1,
        address: 0x1000,
        type: 0,
        data: Uint8Array.from([0xaa]),
      }),
      formatRecord({ length: 0, address: 0, type: 1, data: new Uint8Array() }),
    ];
    expect(() => new IntelHex(recs).toFlatImage()).toThrow(/holes/);
  });
});

describeStock("intel hex vs stock dump", () => {
  it("round-trips the stock firmware with zero edits", () => {
    const original = readFileSync(STOCK_HEX, "utf8");
    const image = IntelHex.parse(original);
    expect(image.serialize()).toBe(original);
  });

  it("reads the Cortex-M vector table at flash base", () => {
    const image = IntelHex.parse(readFileSync(STOCK_HEX, "utf8"));
    expect(image.getByte(0x10001000)).toBe(0x10);
    expect(image.getByte(0x10001001)).toBe(0x32);
    expect(image.getByte(0x10001002)).toBe(0x00);
    expect(image.getByte(0x10001003)).toBe(0x20);
  });

  it("patches one byte and recalculates that record checksum", () => {
    const image = IntelHex.parse(readFileSync(STOCK_HEX, "utf8"));
    const before = image.getByte(0x1000881a);
    expect(before).toBe(0x19);
    image.setByte(0x1000881a, 0x3c);
    expect(image.getByte(0x1000881a)).toBe(0x3c);
    const patched = IntelHex.parse(image.serialize());
    expect(patched.getByte(0x1000881a)).toBe(0x3c);
    expect(patched.getByte(0x1000881b)).toBe(0x23);
  });
});
