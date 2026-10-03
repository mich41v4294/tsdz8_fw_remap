import { describe, expect, it } from "vitest";
import { bitsToInt, intToBits, packBits, parity32, unpackBits } from "./bits";
import { CAP_GET_EXT_CAPS, CAP_GET_MAX_BLOCK_SIZE, CAP_SELECT_TIF, IDCHIP_EXPECTED, idchipField } from "./constants";
import { requestByte, ctrlStatPowered, SwdHost } from "./swd";
import {
  attachJlinkDevice,
  CMD,
  encodeSwdIo,
  findJlinkInterface,
  parseSwdIoResponse,
  JLinkUsb,
  USB_CLASS_CDC_DATA,
  USB_CLASS_VENDOR,
  WebUsbBulk,
  type BulkUsb,
  type UsbInterfaceView,
} from "./jlinkUsb";

describe("SWD request", () => {
  it("encodes DP IDCODE as 0xA5", () => {
    expect(requestByte(false, true, 0)).toBe(0xa5);
  });

  it("extracts IDCHIP[23:8]", () => {
    expect(idchipField(0x00f1c000)).toBe(IDCHIP_EXPECTED);
  });

  it("matches DP CTRL/STAT power-up ACK bits as unsigned", () => {
    const ack = 0xa0000000;
    expect((ack & ack) === ack).toBe(false);
    expect(ctrlStatPowered(ack)).toBe(true);
    expect(ctrlStatPowered(0xf0000000)).toBe(true);
    expect(ctrlStatPowered(0x50000000)).toBe(false);
  });
});

describe("bit packing", () => {
  it("round-trips LSB-first bits", () => {
    const bits = intToBits(0xe79e, 16);
    const packed = packBits(bits);
    expect(unpackBits(packed, 16)).toEqual(bits);
    expect(bitsToInt(bits)).toBe(0xe79e);
  });

  it("uses unsigned shifts for high bits", () => {
    const bits = intToBits(0x80000000, 32);
    expect(bits[31]).toBe(true);
    expect(bitsToInt(bits)).toBe(0x80000000);
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

  it("rejects an oversized VERSION length", async () => {
    const usb = new ScriptUsb([
      Uint8Array.from([0, 0, 0, 0]),
      Uint8Array.from([0x01, 0x02]), // 513
    ]);
    const j = new JLinkUsb(usb);
    await expect(j.hello()).rejects.toThrow(/VERSION length/);
  });

  it("does not send GET_CAPS_EX when only SWO bit 23 is set", async () => {
    const fw = new TextEncoder().encode("fw\0");
    const caps = 1 << 23;
    const usb = new ScriptUsb([
      Uint8Array.from([caps & 0xff, (caps >> 8) & 0xff, (caps >> 16) & 0xff, (caps >> 24) & 0xff]),
      Uint8Array.from([fw.length, 0]),
      fw,
    ]);
    const j = new JLinkUsb(usb);
    await j.hello();
    expect(usb.writes.some((w) => w[0] === CMD.GET_CAPS_EX)).toBe(false);
    expect(j.firmware).toBe("fw");
  });

  it("drains GET_CAPS_EX when advertised", async () => {
    const fw = new TextEncoder().encode("fw\0");
    const caps = 1 << CAP_GET_EXT_CAPS;
    const usb = new ScriptUsb([
      Uint8Array.from([caps & 0xff, (caps >> 8) & 0xff, (caps >> 16) & 0xff, (caps >> 24) & 0xff]),
      new Uint8Array(32),
      Uint8Array.from([fw.length, 0]),
      fw,
    ]);
    const j = new JLinkUsb(usb);
    await j.hello();
    expect(usb.writes[1]![0]).toBe(CMD.GET_CAPS_EX);
    expect(j.firmware).toBe("fw");
  });

  it("reads GET_MAX_MEM_BLOCK when the cap bit is set", async () => {
    const fw = new TextEncoder().encode("fw\0");
    const caps = 1 << CAP_GET_MAX_BLOCK_SIZE;
    const usb = new ScriptUsb([
      Uint8Array.from([caps & 0xff, (caps >> 8) & 0xff, 0, 0]),
      Uint8Array.from([fw.length, 0]),
      fw,
      Uint8Array.from([0x00, 0x10, 0, 0]),
    ]);
    const j = new JLinkUsb(usb);
    await j.hello();
    expect(usb.writes.at(-1)![0]).toBe(CMD.GET_MAX_MEM_BLOCK);
    expect(j.maxMemBlock).toBe(0x1000);
  });
});

describe("SELECT_IF", () => {
  it("skips SELECT_IF when GET_CAPS bit 17 is clear", async () => {
    const usb = new ScriptUsb([]);
    const j = new JLinkUsb(usb);
    j.caps = 0;
    await j.selectSwd();
    expect(usb.writes).toEqual([]);
  });

  it("sends SELECT_IF when SELECT_TIF is advertised", async () => {
    const usb = new ScriptUsb([
      Uint8Array.from([0x03, 0, 0, 0]),
      Uint8Array.from([0x01, 0, 0, 0]),
    ]);
    const j = new JLinkUsb(usb);
    j.caps = 1 << CAP_SELECT_TIF;
    await j.selectSwd();
    expect(usb.writes[0]![0]).toBe(CMD.SELECT_IF);
    expect(usb.writes[0]![1]).toBe(0xff);
    expect(usb.writes[1]![1]).toBe(1);
  });
});

function bulkEp(n: number, direction: "in" | "out") {
  return { endpointNumber: n, direction, type: "bulk" as const };
}

function vendorIface(interfaceNumber = 0): UsbInterfaceView {
  return {
    interfaceNumber,
    alternates: [
      {
        alternateSetting: 0,
        interfaceClass: USB_CLASS_VENDOR,
        interfaceSubclass: USB_CLASS_VENDOR,
        interfaceProtocol: USB_CLASS_VENDOR,
        endpoints: [bulkEp(1, "out"), bulkEp(1, "in")],
      },
    ],
  };
}

function cdcIface(interfaceNumber = 1): UsbInterfaceView {
  return {
    interfaceNumber,
    alternates: [
      {
        alternateSetting: 0,
        interfaceClass: USB_CLASS_CDC_DATA,
        interfaceSubclass: 0,
        interfaceProtocol: 0,
        endpoints: [bulkEp(2, "out"), bulkEp(2, "in")],
      },
    ],
  };
}

describe("findJlinkInterface", () => {
  it("prefers the vendor 0xFF bulk pair over CDC", () => {
    const found = findJlinkInterface([cdcIface(0), vendorIface(2)]);
    expect(found.iface).toBe(2);
    expect(found.inEp).toBe(1);
    expect(found.outEp).toBe(1);
  });

  it("rejects CDC-only devices", () => {
    expect(() => findJlinkInterface([cdcIface(0)])).toThrow(/vendor bulk/i);
  });

  it("accepts a vendor-only J-Link", () => {
    expect(findJlinkInterface([vendorIface(0)]).iface).toBe(0);
  });
});

function usbIface(view: UsbInterfaceView) {
  return {
    interfaceNumber: view.interfaceNumber,
    claimed: false,
    alternate: view.alternates[0]!,
    alternates: view.alternates,
  };
}

class FakeUsbDevice {
  opened = false;
  closeCount = 0;
  claimed: number[] = [];
  released: number[] = [];
  ops: string[] = [];
  productId = 0x0105;
  productName = "J-Link EDU";
  configuration: { configurationValue: number; interfaces: ReturnType<typeof usbIface>[] } | null;
  throwOnClaim = false;

  constructor(ifaces: UsbInterfaceView[], opened = false) {
    this.configuration = {
      configurationValue: 1,
      interfaces: ifaces.map(usbIface),
    };
    this.opened = opened;
  }

  async open() {
    if (this.opened) throw new Error("InvalidStateError: already open");
    this.opened = true;
  }
  async close() {
    this.opened = false;
    this.closeCount += 1;
  }
  async selectConfiguration() {}
  async claimInterface(n: number) {
    this.ops.push("claim");
    if (this.throwOnClaim) throw new Error("Access denied");
    this.claimed.push(n);
  }
  async releaseInterface(n: number) {
    this.released.push(n);
  }
  async selectAlternateInterface() {
    this.ops.push("alt");
  }
  async transferIn(): Promise<USBInTransferResult> {
    return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
  }
  async transferOut(_ep: number, data: BufferSource): Promise<USBOutTransferResult> {
    const n = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
    return { status: "ok", bytesWritten: n };
  }
}

describe("attachJlinkDevice", () => {
  it("closes the device when claimInterface throws", async () => {
    const device = new FakeUsbDevice([vendorIface(0)]);
    device.throwOnClaim = true;
    await expect(attachJlinkDevice(device as unknown as USBDevice)).rejects.toThrow(/claim/);
    expect(device.opened).toBe(false);
    expect(device.closeCount).toBeGreaterThanOrEqual(1);
  });

  it("closes first if Chrome left the device open", async () => {
    const device = new FakeUsbDevice([vendorIface(0)], true);
    device.throwOnClaim = true;
    await expect(attachJlinkDevice(device as unknown as USBDevice)).rejects.toThrow(/claim/);
    expect(device.opened).toBe(false);
    expect(device.closeCount).toBeGreaterThanOrEqual(2);
  });

  it("closes when only CDC interfaces are present", async () => {
    const device = new FakeUsbDevice([cdcIface(0)]);
    await expect(attachJlinkDevice(device as unknown as USBDevice)).rejects.toThrow(/vendor bulk/i);
    expect(device.opened).toBe(false);
    expect(device.closeCount).toBeGreaterThanOrEqual(1);
  });

  it("claims the interface before selecting a non-zero alternate", async () => {
    const iface: UsbInterfaceView = {
      interfaceNumber: 0,
      alternates: [
        {
          alternateSetting: 1,
          interfaceClass: USB_CLASS_VENDOR,
          interfaceSubclass: USB_CLASS_VENDOR,
          interfaceProtocol: USB_CLASS_VENDOR,
          endpoints: [bulkEp(1, "out"), bulkEp(1, "in")],
        },
      ],
    };
    const device = new FakeUsbDevice([iface]);
    const { jlink } = await attachJlinkDevice(device as unknown as USBDevice);
    expect(device.ops.indexOf("claim")).toBeGreaterThanOrEqual(0);
    expect(device.ops.indexOf("alt")).toBeGreaterThan(device.ops.indexOf("claim"));
    await jlink.close();
  });
});

class LeftoverUsb {
  inCalls = 0;
  packets: Uint8Array[];
  released = false;
  closed = false;
  constructor(packets: Uint8Array[]) {
    this.packets = packets;
  }
  async transferIn(_ep: number, _len: number): Promise<USBInTransferResult> {
    this.inCalls += 1;
    const p = this.packets.shift();
    if (!p) throw new Error("no packet");
    return { status: "ok", data: new DataView(p.buffer, p.byteOffset, p.byteLength) };
  }
  async transferOut(_ep: number, data: BufferSource): Promise<USBOutTransferResult> {
    return { status: "ok", bytesWritten: data instanceof ArrayBuffer ? data.byteLength : data.byteLength };
  }
  async releaseInterface() {
    this.released = true;
  }
  async close() {
    this.closed = true;
  }
}

describe("WebUsbBulk leftover IN", () => {
  it("keeps extra IN bytes for the next read", async () => {
    const packet = Uint8Array.from([1, 2, 3, 4]);
    const usb = new LeftoverUsb([packet]);
    const bulk = new WebUsbBulk(usb as unknown as USBDevice, 1, 1, 0);
    const a = await bulk.read(2);
    expect([...a]).toEqual([1, 2]);
    expect(usb.inCalls).toBe(1);
    const b = await bulk.read(2);
    expect([...b]).toEqual([3, 4]);
    expect(usb.inCalls).toBe(1);
  });

  it("releases the interface on close", async () => {
    const usb = new LeftoverUsb([]);
    const bulk = new WebUsbBulk(usb as unknown as USBDevice, 1, 1, 3);
    await bulk.close();
    expect(usb.released).toBe(true);
    expect(usb.closed).toBe(true);
  });

  it("throws on an empty IN packet", async () => {
    const usb = new LeftoverUsb([new Uint8Array(0)]);
    const bulk = new WebUsbBulk(usb as unknown as USBDevice, 1, 1, 0);
    await expect(bulk.read(4)).rejects.toThrow(/0 bytes/);
  });
});

function ackBits(ack: number, bitCount: number): Uint8Array {
  const bits = Array(bitCount).fill(false) as boolean[];
  const ackStart = 9;
  bits[ackStart] = (ack & 1) === 1;
  bits[ackStart + 1] = (ack & 2) === 2;
  bits[ackStart + 2] = (ack & 4) === 4;
  return packBits(bits);
}

describe("SWD FAULT", () => {
  it("writes ABORT then rethrows", async () => {
    const bitCounts: number[] = [];
    const io = {
      async swdIo(_dir: Uint8Array, _data: Uint8Array, bitCount: number) {
        bitCounts.push(bitCount);
        if (bitCounts.length === 1) return ackBits(0b100, bitCount);
        return ackBits(0b001, bitCount);
      },
    };
    const swd = new SwdHost(io);
    await expect(swd.readDp(0)).rejects.toThrow(/FAULT/);
    expect(bitCounts.length).toBeGreaterThanOrEqual(2);
  });
});
