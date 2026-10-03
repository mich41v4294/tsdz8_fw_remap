import { describe, expect, it } from "vitest";
import {
  FLASH_BASE,
  IMAGE_SIZE,
  NVM_PAGE_SIZE,
  NVMPROG,
  NVMPROG_IDLE,
  NVMPROG_PAGE_ERASE,
  NVMPROG_WRITE,
  NVMSTATUS,
} from "./constants";
import type { MemIf } from "./cortexM";
import { flashXmc1 } from "./xmc1";

class FakeNvm implements MemIf {
  flash = new Uint8Array(IMAGE_SIZE).fill(0xff);
  prog = 0;
  pendingWrite: number[] = [];

  async read32(addr: number): Promise<number> {
    if (addr === NVMSTATUS) return 0;
    if (addr === NVMPROG) return this.prog;
    if (addr >= FLASH_BASE && addr < FLASH_BASE + IMAGE_SIZE) {
      const o = addr - FLASH_BASE;
      return (
        this.flash[o]! |
        (this.flash[o + 1]! << 8) |
        (this.flash[o + 2]! << 16) |
        (this.flash[o + 3]! << 24)
      ) >>> 0;
    }
    return 0;
  }
  async write32(addr: number, value: number): Promise<void> {
    if (addr < FLASH_BASE || addr >= FLASH_BASE + IMAGE_SIZE) return;
    const o = addr - FLASH_BASE;
    if (this.prog === NVMPROG_PAGE_ERASE) {
      const page = Math.floor(o / NVM_PAGE_SIZE) * NVM_PAGE_SIZE;
      this.flash.fill(0xff, page, page + NVM_PAGE_SIZE);
      return;
    }
    if (this.prog === NVMPROG_WRITE) {
      this.flash[o] = value & 0xff;
      this.flash[o + 1] = (value >> 8) & 0xff;
      this.flash[o + 2] = (value >> 16) & 0xff;
      this.flash[o + 3] = (value >> 24) & 0xff;
    }
  }
  async read16(addr: number): Promise<number> {
    return (await this.read32(addr)) & 0xffff;
  }
  async write16(addr: number, value: number): Promise<void> {
    if (addr === NVMPROG) this.prog = value & 0xff;
  }
  async read8(): Promise<number> {
    return 0;
  }
  async write8(): Promise<void> {}
}

describe("XMC1 NVM programmer", () => {
  it("erases and programs a 64 KB image", async () => {
    const nvm = new FakeNvm();
    nvm.flash.fill(0x5a);
    const image = Uint8Array.from({ length: IMAGE_SIZE }, (_, i) => (i * 13) & 0xff);
    await flashXmc1(nvm, image);
    expect(nvm.prog).toBe(NVMPROG_IDLE);
    expect(nvm.flash).toEqual(image);
  });
});
