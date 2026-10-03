import { SEGGER_VID } from "./constants";

export const CMD = {
  VERSION: 0x01,
  SET_SPEED: 0x05,
  GET_STATE: 0x07,
  SET_KS_POWER: 0x08,
  GET_SPEEDS: 0xc0,
  SELECT_IF: 0xc7,
  HW_JTAG3: 0xcf,
  GET_MAX_MEM_BLOCK: 0xd4,
  GET_CAPS: 0xe8,
  GET_CAPS_EX: 0xed,
  GET_HW_VERSION: 0xf0,
} as const;

export const IF_SWD = 1;

export class JLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JLinkError";
  }
}

export interface BulkUsb {
  write(data: Uint8Array): Promise<void>;
  read(n: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export function encodeSwdIo(direction: Uint8Array, data: Uint8Array, bitCount: number): Uint8Array {
  const numBytes = Math.ceil(bitCount / 8);
  if (direction.length < numBytes || data.length < numBytes) {
    throw new JLinkError("SWD payload shorter than bit count");
  }
  const buf = new Uint8Array(4 + 2 * numBytes);
  buf[0] = CMD.HW_JTAG3;
  buf[1] = 0;
  buf[2] = bitCount & 0xff;
  buf[3] = (bitCount >> 8) & 0xff;
  buf.set(direction.subarray(0, numBytes), 4);
  buf.set(data.subarray(0, numBytes), 4 + numBytes);
  return buf;
}

export function parseSwdIoResponse(resp: Uint8Array, bitCount: number): Uint8Array {
  const numBytes = Math.ceil(bitCount / 8);
  if (resp.length < numBytes + 1) {
    throw new JLinkError(`SWD response short (${resp.length} < ${numBytes + 1})`);
  }
  if (resp[numBytes] !== 0) {
    throw new JLinkError(`J-Link SWD I/O error 0x${resp[numBytes].toString(16)}`);
  }
  return resp.subarray(0, numBytes);
}

function u16le(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >> 8) & 0xff]);
}

function u32le(bytes: Uint8Array, offset = 0): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

export class JLinkUsb {
  caps = 0;
  firmware = "";
  vtrefMv = 0;
  maxMemBlock = 0x2000;

  constructor(private readonly usb: BulkUsb) {}

  async writeCmd(bytes: Uint8Array): Promise<void> {
    await this.usb.write(bytes);
  }

  async readExact(n: number): Promise<Uint8Array> {
    return this.usb.read(n);
  }

  async hello(): Promise<void> {
    await this.writeCmd(Uint8Array.from([CMD.GET_CAPS]));
    this.caps = u32le(await this.readExact(4));
    try {
      await this.writeCmd(Uint8Array.from([CMD.VERSION]));
      const lenBytes = await this.readExact(2);
      const n = lenBytes[0]! | (lenBytes[1]! << 8);
      const raw = await this.readExact(n);
      const z = raw.indexOf(0);
      this.firmware = new TextDecoder().decode(z >= 0 ? raw.subarray(0, z) : raw).trim();
    } catch {
      this.firmware = "";
    }
  }

  async selectSwd(): Promise<void> {
    await this.writeCmd(Uint8Array.from([CMD.SELECT_IF, 0xff]));
    const mask = u32le(await this.readExact(4));
    if (mask !== 0xffffffff && (mask & (1 << IF_SWD)) === 0) {
      throw new JLinkError(`Probe does not report SWD (IF mask 0x${mask.toString(16)})`);
    }
    await this.writeCmd(Uint8Array.from([CMD.SELECT_IF, IF_SWD]));
    await this.readExact(4);
  }

  async setSpeedKhz(khz: number): Promise<void> {
    const payload = new Uint8Array(3);
    payload[0] = CMD.SET_SPEED;
    payload.set(u16le(khz), 1);
    await this.writeCmd(payload);
  }

  async setKickstartPower(on: boolean): Promise<void> {
    await this.writeCmd(Uint8Array.from([CMD.SET_KS_POWER, on ? 1 : 0]));
  }

  async readVtrefMv(): Promise<number> {
    await this.writeCmd(Uint8Array.from([CMD.GET_STATE]));
    const st = await this.readExact(8);
    this.vtrefMv = st[0]! | (st[1]! << 8);
    return this.vtrefMv;
  }

  async swdIo(direction: Uint8Array, data: Uint8Array, bitCount: number): Promise<Uint8Array> {
    const pkt = encodeSwdIo(direction, data, bitCount);
    await this.writeCmd(pkt);
    const numBytes = Math.ceil(bitCount / 8);
    const resp = await this.readExact(numBytes + 1);
    return parseSwdIoResponse(resp, bitCount);
  }

  async close(): Promise<void> {
    await this.usb.close();
  }
}

function findBulkPair(device: USBDevice): { iface: number; inEp: number; outEp: number } {
  const cfg = device.configuration;
  if (!cfg) throw new JLinkError("USB device has no configuration");
  for (const iface of cfg.interfaces) {
    for (const alt of iface.alternates) {
      let inEp: number | null = null;
      let outEp: number | null = null;
      for (const ep of alt.endpoints) {
        if (ep.type !== "bulk") continue;
        if (ep.direction === "in") inEp = ep.endpointNumber;
        if (ep.direction === "out") outEp = ep.endpointNumber;
      }
      if (inEp != null && outEp != null) {
        return { iface: iface.interfaceNumber, inEp, outEp };
      }
    }
  }
  throw new JLinkError("No bulk IN/OUT pair on this J-Link interface");
}

export class WebUsbBulk implements BulkUsb {
  constructor(
    private readonly device: USBDevice,
    private readonly inEp: number,
    private readonly outEp: number,
  ) {}

  async write(data: Uint8Array): Promise<void> {
    let off = 0;
    while (off < data.length) {
      const slice = data.subarray(off);
      const copy = new Uint8Array(slice.byteLength);
      copy.set(slice);
      const r = await this.device.transferOut(this.outEp, copy.buffer);
      if (r.status !== "ok" || !r.bytesWritten) {
        throw new JLinkError(`USB OUT failed (${r.status})`);
      }
      off += r.bytesWritten;
    }
  }

  async read(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const r = await this.device.transferIn(this.inEp, n - off);
      if (r.status !== "ok" || !r.data) {
        throw new JLinkError(`USB IN failed (${r.status})`);
      }
      const chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      out.set(chunk, off);
      off += chunk.length;
    }
    return out;
  }

  async close(): Promise<void> {
    try {
      await this.device.close();
    } catch {
      /* already closed */
    }
  }
}

export function webUsbAvailable(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

export async function openWebJlink(): Promise<{ jlink: JLinkUsb; product: string }> {
  if (!webUsbAvailable()) {
    throw new JLinkError("This browser has no WebUSB. Use desktop Chrome/Edge, or the Python CLI.");
  }
  const usb = navigator.usb;
  if (!usb) {
    throw new JLinkError("This browser has no WebUSB. Use desktop Chrome/Edge, or the Python CLI.");
  }
  const device = await usb.requestDevice({ filters: [{ vendorId: SEGGER_VID }] });
  await device.open();
  if (!device.configuration) {
    await device.selectConfiguration(1);
  }
  const { iface, inEp, outEp } = findBulkPair(device);
  try {
    await device.claimInterface(iface);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JLinkError(
      `Could not claim the J-Link USB interface (${msg}). Close J-Flash / JLinkExe / pylink. ` +
        "On Windows the SEGGER driver often owns the device — use python -m tools.jlink_flasher instead.",
    );
  }
  const jlink = new JLinkUsb(new WebUsbBulk(device, inEp, outEp));
  const product = device.productName ?? `J-Link ${device.productId.toString(16)}`;
  return { jlink, product };
}
