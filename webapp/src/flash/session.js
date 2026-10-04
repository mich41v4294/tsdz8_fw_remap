import {
  CAP_SET_KS_POWER,
  DEFAULT_SWD_KHZ,
  FLASH_BASE,
  IDCHIP_ADDR,
  IDCHIP_EXPECTED,
  IMAGE_SIZE,
  idchipField,
} from "./constants.js";
import { CortexM } from "./cortexM.js";
import { hasCap, JLinkError, openWebJlink } from "./jlinkUsb.js";
import { SwdHost } from "./swd.js";
import { flashXmc1 } from "./xmc1.js";
import { t } from "../i18n.js";

export class FlashSessionError extends Error {
  constructor(message) {
    super(message);
    this.name = "FlashSessionError";
  }
}

export class FlashSession {
  constructor(jlink, swd, mem) {
    this.jlink = jlink;
    this.swd = swd;
    this.mem = mem;
    this.dpidr = 0;
    this.vtrefMv = 0;
    this.firmware = "";
    this.product = "";
    this.vtrefWarn = "";
  }

  static async connect(opts = {}) {
    const status = opts.status ?? (() => undefined);
    status(t("probe.requesting"));
    const { jlink, product } = await openWebJlink();
    try {
      status(t("probe.hello"));
      await jlink.hello();
      await jlink.selectSwd();
      await jlink.setSpeedKhz(opts.speedKhz ?? DEFAULT_SWD_KHZ);
      if (hasCap(jlink.caps, CAP_SET_KS_POWER)) {
        await jlink.setKickstartPower(Boolean(opts.power));
      } else if (opts.power) {
        throw new FlashSessionError(t("probe.noPowerSwitch"));
      }
      const vtrefMv = await jlink.readVtrefMv();
      let vtrefWarn = "";
      if (vtrefMv === 0) {
        vtrefWarn = t("probe.vtrefZero");
        status(vtrefWarn);
      } else if (!opts.power && vtrefMv < 1500) {
        throw new FlashSessionError(t("probe.vtrefLow", { volts: (vtrefMv / 1000).toFixed(2) }));
      }
      status(t("probe.swd"));
      const swd = new SwdHost(jlink);
      const dpidr = await swd.connectDebug();
      const mem = new CortexM(swd);
      await mem.halt();
      if (!opts.skipChipId) {
        const word = await mem.read32(IDCHIP_ADDR);
        const field = idchipField(word);
        if (field !== IDCHIP_EXPECTED) {
          throw new FlashSessionError(
            t("probe.chipId", {
              field: field.toString(16),
              raw: word.toString(16),
              expected: IDCHIP_EXPECTED.toString(16),
            }),
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

  infoLine() {
    const vt = this.vtrefMv === 0 ? t("probe.vtUnreported") : `${(this.vtrefMv / 1000).toFixed(2)} V`;
    const warn = this.vtrefWarn ? ` — ${this.vtrefWarn}` : "";
    return t("probe.info", {
      product: this.product,
      firmware: this.firmware || "?",
      dpidr: this.dpidr.toString(16),
      vt,
      warn,
    });
  }

  async dumpFlash(onProgress) {
    await this.mem.halt();
    return this.mem.readMem(FLASH_BASE, IMAGE_SIZE, (done, total) => {
      onProgress?.(t("probe.reading", { done: String(done), total: String(total) }));
    });
  }

  async verify(image, onProgress) {
    if (image.length !== IMAGE_SIZE) {
      throw new FlashSessionError(t("probe.imageSize", { size: String(IMAGE_SIZE) }));
    }
    const got = await this.dumpFlash(onProgress);
    for (let i = 0; i < IMAGE_SIZE; i++) {
      if (got[i] !== image[i]) {
        throw new FlashSessionError(t("probe.verifyFail", { addr: (FLASH_BASE + i).toString(16) }));
      }
    }
  }

  async flash(image, status) {
    if (image.length !== IMAGE_SIZE) {
      throw new FlashSessionError(t("probe.imageSize", { size: String(IMAGE_SIZE) }));
    }
    await this.mem.halt();
    await flashXmc1(this.mem, image, (done, total, phase) => {
      const phaseLabel = phase === "erase" ? t("probe.erase") : t("probe.write");
      status?.(`${phaseLabel} ${done}/${total}`);
    });
    status?.(t("probe.verifying"));
    await this.verify(image, status);
    await this.mem.resetRun();
  }

  async close() {
    await this.jlink.close();
  }
}

export { JLinkError, FLASH_BASE, IMAGE_SIZE };
