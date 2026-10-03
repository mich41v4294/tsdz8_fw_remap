import {
  CAP_GET_EXT_CAPS,
  CAP_GET_MAX_BLOCK_SIZE,
  CAP_SELECT_TIF,
  SEGGER_VID,
} from "./constants";

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
export const VERSION_MAX_LEN = 256;

export const USB_CLASS_CDC_COMM = 0x02;
export const USB_CLASS_CDC_DATA = 0x0a;
export const USB_CLASS_VENDOR = 0xff;

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
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

export function hasCap(caps: number, bit: number): boolean {
  return ((caps >>> bit) & 1) === 1;
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
    if (hasCap(this.caps, CAP_GET_EXT_CAPS)) {
      await this.writeCmd(Uint8Array.from([CMD.GET_CAPS_EX]));
      await this.readExact(32);
    }
    await this.writeCmd(Uint8Array.from([CMD.VERSION]));
    const lenBytes = await this.readExact(2);
    const n = lenBytes[0]! | (lenBytes[1]! << 8);
    if (n === 0 || n > VERSION_MAX_LEN) {
      throw new JLinkError(`VERSION length ${n} is out of range`);
    }
    const raw = await this.readExact(n);
    const z = raw.indexOf(0);
    this.firmware = new TextDecoder().decode(z >= 0 ? raw.subarray(0, z) : raw).trim();
    if (hasCap(this.caps, CAP_GET_MAX_BLOCK_SIZE)) {
      await this.writeCmd(Uint8Array.from([CMD.GET_MAX_MEM_BLOCK]));
      this.maxMemBlock = u32le(await this.readExact(4));
    }
  }

  async selectSwd(): Promise<void> {
    if (!hasCap(this.caps, CAP_SELECT_TIF)) {
      return;
    }
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

export type UsbEndpointView = {
  endpointNumber: number;
  direction: "in" | "out";
  type: string;
};

export type UsbAlternateView = {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  endpoints: UsbEndpointView[];
};

export type UsbInterfaceView = {
  interfaceNumber: number;
  alternates: UsbAlternateView[];
};

export type JlinkBulkPair = {
  iface: number;
  alternateSetting: number;
  inEp: number;
  outEp: number;
};

function bulkPair(alt: UsbAlternateView): { inEp: number; outEp: number } | null {
  const bulk = alt.endpoints.filter((ep) => ep.type === "bulk");
  if (bulk.length !== 2) return null;
  let inEp: number | null = null;
  let outEp: number | null = null;
  for (const ep of bulk) {
    if (ep.direction === "in") inEp = ep.endpointNumber;
    if (ep.direction === "out") outEp = ep.endpointNumber;
  }
  if (inEp == null || outEp == null) return null;
  return { inEp, outEp };
}

function isCdc(alt: UsbAlternateView): boolean {
  return alt.interfaceClass === USB_CLASS_CDC_COMM || alt.interfaceClass === USB_CLASS_CDC_DATA;
}

function isVendorFf(alt: UsbAlternateView): boolean {
  return (
    alt.interfaceClass === USB_CLASS_VENDOR &&
    alt.interfaceSubclass === USB_CLASS_VENDOR &&
    alt.interfaceProtocol === USB_CLASS_VENDOR
  );
}

function isVendorClass(alt: UsbAlternateView): boolean {
  return alt.interfaceClass === USB_CLASS_VENDOR;
}

function altOf(interfaces: UsbInterfaceView[], pair: JlinkBulkPair): UsbAlternateView | undefined {
  const iface = interfaces.find((x) => x.interfaceNumber === pair.iface);
  return iface?.alternates.find((a) => a.alternateSetting === pair.alternateSetting);
}

export function findJlinkInterface(interfaces: UsbInterfaceView[]): JlinkBulkPair {
  const candidates: JlinkBulkPair[] = [];
  for (const iface of interfaces) {
    for (const alt of iface.alternates) {
      if (isCdc(alt)) continue;
      const pair = bulkPair(alt);
      if (!pair) continue;
      candidates.push({
        iface: iface.interfaceNumber,
        alternateSetting: alt.alternateSetting,
        ...pair,
      });
    }
  }
  const preferred = candidates.find((c) => {
    const alt = altOf(interfaces, c);
    return alt ? isVendorFf(alt) : false;
  });
  if (preferred) return preferred;
  const vendorClass = candidates.find((c) => {
    const alt = altOf(interfaces, c);
    return alt ? isVendorClass(alt) : false;
  });
  if (vendorClass) return vendorClass;
  throw new JLinkError(
    "No J-Link vendor bulk interface (class 0xFF, two bulk endpoints). CDC/COM ports are ignored.",
  );
}

function interfacesFromDevice(device: USBDevice): UsbInterfaceView[] {
  const cfg = device.configuration;
  if (!cfg) throw new JLinkError("USB device has no configuration");
  return cfg.interfaces.map((iface) => ({
    interfaceNumber: iface.interfaceNumber,
    alternates: iface.alternates.map((alt) => ({
      alternateSetting: alt.alternateSetting,
      interfaceClass: alt.interfaceClass,
      interfaceSubclass: alt.interfaceSubclass,
      interfaceProtocol: alt.interfaceProtocol,
      endpoints: alt.endpoints.map((ep) => ({
        endpointNumber: ep.endpointNumber,
        direction: ep.direction,
        type: ep.type,
      })),
    })),
  }));
}

export async function closeQuietly(device: USBDevice): Promise<void> {
  try {
    await device.close();
  } catch {
    /* already closed or never opened */
  }
}

export class WebUsbBulk implements BulkUsb {
  private leftover = new Uint8Array(0);

  constructor(
    private readonly device: USBDevice,
    private readonly inEp: number,
    private readonly outEp: number,
    private readonly iface: number,
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
      if (this.leftover.length > 0) {
        const take = Math.min(this.leftover.length, n - off);
        out.set(this.leftover.subarray(0, take), off);
        this.leftover = new Uint8Array(this.leftover.subarray(take));
        off += take;
        continue;
      }
      const r = await this.device.transferIn(this.inEp, n - off);
      if (r.status !== "ok" || !r.data) {
        throw new JLinkError(`USB IN failed (${r.status})`);
      }
      const chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      if (chunk.length === 0) {
        throw new JLinkError("USB IN returned 0 bytes");
      }
      const need = n - off;
      if (chunk.length <= need) {
        out.set(chunk, off);
        off += chunk.length;
      } else {
        out.set(chunk.subarray(0, need), off);
        this.leftover = new Uint8Array(chunk.subarray(need));
        off = n;
      }
    }
    return out;
  }

  async close(): Promise<void> {
    try {
      await this.device.releaseInterface(this.iface);
    } catch {
      /* not claimed */
    }
    await closeQuietly(this.device);
  }
}

export function webUsbAvailable(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

function claimError(err: unknown): JLinkError {
  const msg = err instanceof Error ? err.message : String(err);
  return new JLinkError(
    `Could not claim the J-Link USB interface (${msg}). Close J-Flash / JLinkExe / pylink. ` +
      "On Windows the SEGGER driver often owns the device — use python -m tools.jlink_flasher instead.",
  );
}

export async function attachJlinkDevice(device: USBDevice): Promise<{ jlink: JLinkUsb; product: string }> {
  let claimed = -1;
  try {
    if (device.opened) {
      await closeQuietly(device);
    }
    await device.open();
    if (!device.configuration) {
      await device.selectConfiguration(1);
    }
    const found = findJlinkInterface(interfacesFromDevice(device));
    try {
      await device.claimInterface(found.iface);
    } catch (err) {
      throw claimError(err);
    }
    claimed = found.iface;
    if (found.alternateSetting !== 0) {
      await device.selectAlternateInterface(found.iface, found.alternateSetting);
    }
    const jlink = new JLinkUsb(new WebUsbBulk(device, found.inEp, found.outEp, found.iface));
    const product = device.productName ?? `J-Link ${device.productId.toString(16)}`;
    return { jlink, product };
  } catch (err) {
    if (claimed >= 0) {
      try {
        await device.releaseInterface(claimed);
      } catch {
        /* */
      }
    }
    await closeQuietly(device);
    throw err;
  }
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
  return attachJlinkDevice(device);
}
