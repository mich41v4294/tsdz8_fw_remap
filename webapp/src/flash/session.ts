import {
  CAP_SET_KS_POWER,
  DEFAULT_SWD_KHZ,
  FLASH_BASE,
  IDCHIP_ADDR,
  IDCHIP_EXPECTED,
  IMAGE_SIZE,
  idchipField,
} from "./constants";
import { CortexM } from "./cortexM";
import { hasCap, JLinkError, JLinkUsb, openWebJlink } from "./jlinkUsb";
import { SwdHost } from "./swd";
import { flashXmc1 } from "./xmc1";

export class FlashSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlashSessionError";
  }
}

export type StatusFn = (msg: string) => void;

export class FlashSession {
  dpidr = 0;
  vtrefMv = 0;
  firmware = "";
  product = "";
  vtrefWarn = "";

  constructor(
    readonly jlink: JLinkUsb,
    readonly swd: SwdHost,
    readonly mem: CortexM,
  ) {}

  static async connect(
    opts: { speedKhz?: number; power?: boolean; skipChipId?: boolean; status?: StatusFn } = {},
  ): Promise<FlashSession> {
    const status = opts.status ?? (() => undefined);
    status("Requesting J-Link (WebUSB)…");
    const { jlink, product } = await openWebJlink();
    try {
      status("J-Link hello…");
      await jlink.hello();
      await jlink.selectSwd();
      await jlink.setSpeedKhz(opts.speedKhz ?? DEFAULT_SWD_KHZ);
      if (hasCap(jlink.caps, CAP_SET_KS_POWER)) {
        await jlink.setKickstartPower(Boolean(opts.power));
      } else if (opts.power) {
        throw new FlashSessionError("This J-Link cannot switch target power");
      }
      const vtrefMv = await jlink.readVtrefMv();
      let vtrefWarn = "";
      if (vtrefMv === 0) {
        vtrefWarn = "VTref reports 0 V (common on clones); continuing.";
        status(vtrefWarn);
      } else if (!opts.power && vtrefMv < 1500) {
        throw new FlashSessionError(
          `VTref is ${(vtrefMv / 1000).toFixed(2)} V. Power the controller (battery) or enable probe power. Do not do both.`,
        );
      }
      status("SWD connect…");
      const swd = new SwdHost(jlink);
      const dpidr = await swd.connectDebug();
      const mem = new CortexM(swd);
      await mem.halt();
      if (!opts.skipChipId) {
        const word = await mem.read32(IDCHIP_ADDR);
        const field = idchipField(word);
        if (field !== IDCHIP_EXPECTED) {
          throw new FlashSessionError(
            `SCU_IDCHIP[23:8]=0x${field.toString(16)} (raw 0x${word.toString(16)}), expected 0x${IDCHIP_EXPECTED.toString(16)}`,
          );
        }
      }
      const session = new FlashSession(jlink, swd, mem);
      session.dpidr = dpidr;
      session.vtrefMv = vtrefMv;
      session.firmware = jlink.firmware;
      session.product = product;
      session.vtrefWarn = vtrefWarn;
      return session;
    } catch (err) {
      await jlink.close();
      throw err;
    }
  }

  infoLine(): string {
    const vt = this.vtrefMv === 0 ? "0 V (unreported)" : `${(this.vtrefMv / 1000).toFixed(2)} V`;
    const warn = this.vtrefWarn ? ` — ${this.vtrefWarn}` : "";
    return `${this.product} fw=${this.firmware || "?"} DPIDR=0x${this.dpidr.toString(16)} VTref=${vt}${warn}`;
  }

  async dumpFlash(onProgress?: StatusFn): Promise<Uint8Array> {
    await this.mem.halt();
    return this.mem.readMem(FLASH_BASE, IMAGE_SIZE, (done, total) => {
      onProgress?.(`Reading flash ${done}/${total}`);
    });
  }

  async verify(image: Uint8Array, onProgress?: StatusFn): Promise<void> {
    if (image.length !== IMAGE_SIZE) {
      throw new FlashSessionError(`Image must be ${IMAGE_SIZE} bytes`);
    }
    const got = await this.dumpFlash(onProgress);
    for (let i = 0; i < IMAGE_SIZE; i++) {
      if (got[i] !== image[i]) {
        throw new FlashSessionError(`Verify failed at 0x${(FLASH_BASE + i).toString(16)}`);
      }
    }
  }

  async flash(image: Uint8Array, status?: StatusFn): Promise<void> {
    if (image.length !== IMAGE_SIZE) {
      throw new FlashSessionError(`Image must be ${IMAGE_SIZE} bytes`);
    }
    await this.mem.halt();
    await flashXmc1(this.mem, image, (done, total, phase) => {
      status?.(`${phase} ${done}/${total}`);
    });
    status?.("verifying…");
    await this.verify(image, status);
    await this.mem.resetRun();
  }

  async close(): Promise<void> {
    await this.jlink.close();
  }
}

export { JLinkError, FLASH_BASE, IMAGE_SIZE };
