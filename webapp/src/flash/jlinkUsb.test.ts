import { describe, expect, it } from "vitest";
import { bitsToInt, intToBits, packBits, parity32, unpackBits } from "./bits";
import { IDCHIP_EXPECTED, idchipField } from "./constants";
import { requestByte } from "./swd";
import { CMD, encodeSwdIo, parseSwdIoResponse, JLinkUsb, type BulkUsb } from "./jlinkUsb";

describe("SWD request", () => {
  it("encodes DP IDCODE as 0xA5", () => {
    expect(requestByte(false, true, 0)).toBe(0xa5);
  });

  it("extracts IDCHIP[23:8]", () => {
    expect(idchipField(0x00f1c000)).toBe(IDCHIP_EXPECTED);
  });
});

describe("bit packing", () => {
  it("round-trips LSB-first bits", () => {
    const bits = intToBits(0xe79e, 16);
    const packed = packBits(bits);
    expect(unpackBits(packed, 16)).toEqual(bits);
    expect(bitsToInt(bits)).toBe(0xe79e);
  });

  it("computes odd parity", () => {
    expect(parity32(0)).toBe(false);
    expect(parity32(1)).toBe(true);
    expect(parity32(3)).toBe(false);
  });
});

describe("J-Link SWD USB framing", () => {
  it("builds HW_JTAG3 with dummy alignment byte", () => {
    const dir = Uint8Array.from([0xff]);
    const data = Uint8Array.from([0xa5]);
    const pkt = encodeSwdIo(dir, data, 8);
    expect(pkt[0]).toBe(CMD.HW_JTAG3);
    expect(pkt[1]).toBe(0);
    expect(pkt[2]).toBe(8);
    expect(pkt[3]).toBe(0);
    expect([...pkt.subarray(4)]).toEqual([0xff, 0xa5]);
  });

  it("rejects a non-zero SWD status byte", () => {
    expect(() => parseSwdIoResponse(Uint8Array.from([0, 6]), 8)).toThrow(/error 0x6/);
  });
});

class ScriptUsb implements BulkUsb {
  writes: Uint8Array[] = [];
  constructor(private reads: Uint8Array[]) {}
  async write(data: Uint8Array) {
    this.writes.push(Uint8Array.from(data));
  }
  async read(n: number) {
    const next = this.reads.shift();
    if (!next || next.length !== n) throw new Error(`expected read ${n}, got ${next?.length}`);
    return next;
  }
  async close() {}
}

describe("JLinkUsb hello", () => {
  it("parses GET_CAPS and VERSION", async () => {
    const fw = new TextEncoder().encode("J-Link V9\0");
    const usb = new ScriptUsb([
      Uint8Array.from([0x00, 0x00, 0x40, 0x00]),
      Uint8Array.from([fw.length, 0]),
      fw,
    ]);
    const j = new JLinkUsb(usb);
    await j.hello();
    expect(usb.writes[0]![0]).toBe(CMD.GET_CAPS);
    expect(j.firmware).toBe("J-Link V9");
    expect(j.caps).toBe(0x00400000);
  });
});
