import {
  FLASH_BASE,
  IMAGE_SIZE,
  NVM_BASE,
  NVM_BLOCK_SIZE,
  NVM_PAGE_SIZE,
  NVMPROG,
  NVMPROG_IDLE,
  NVMPROG_PAGE_ERASE,
  NVMPROG_WRITE,
  NVMSTATUS,
  NVMSTATUS_BUSY,
  NVMSTATUS_VERR_MASK,
  SRAM_CODE,
  SRAM_DATA,
} from "./constants";
import { CortexM, isSramHost, type MemIf } from "./cortexM";

export class XmcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmcError";
  }
}

export type ProgressFn = (done: number, total: number, phase: string) => void;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function thumbLe(halfwords: number[]): Uint8Array {
  const out = new Uint8Array(halfwords.length * 2);
  for (let i = 0; i < halfwords.length; i++) {
    out[i * 2] = halfwords[i]! & 0xff;
    out[i * 2 + 1] = (halfwords[i]! >> 8) & 0xff;
  }
  return out;
}

/**
 * Cortex-M0 Thumb: r0=NVM_BASE, r1=dest, r2=src, r3=16-byte block count.
 * One-shot write 0x51, STMIA 4 words, wait BUSY, check VERR, idle, loop.
 * Success: r0=0 + BKPT #0; fail: r0=0xff + BKPT #1, separated by NOPs.
 */
export const SRAM_WRITE_THUMB = thumbLe([
  0x2b00, // cmp r3, #0
  0xd00f, // beq done
  0x2451, // movs r4, #0x51
  0x8084, // strh r4, [r0, #4]
  0xcaf0, // ldmia r2!, {r4-r7}
  0xc9f0, // stmia r1!, {r4-r7}
  0x8804, // wait: ldrh r4, [r0, #0]
  0x2501, // movs r5, #1
  0x422c, // tst r4, r5
  0xd1fb, // bne wait
  0x00a4, // lsrs r4, r4, #2
  0x2503, // movs r5, #3
  0x402c, // ands r4, r5
  0xd107, // bne fail
  0x2400, // movs r4, #0
  0x8084, // strh r4, [r0, #4]
  0x3b01, // subs r3, #1
  0xd1ef, // bne body
  0x2000, // done: movs r0, #0
  0xbe00, // bkpt #0
  0xbf00, // nop
  0xbf00, // nop
  0x20ff, // fail: movs r0, #0xff
  0xbe01, // bkpt #1
]);

export const SRAM_WRITE_DONE_OFF = 18 * 2;
export const SRAM_WRITE_FAIL_OFF = 22 * 2;

/**
 * r0=NVM_BASE, r1=page address, r3=page count. Write 0x92 then one word to trigger erase.
 */
export const SRAM_ERASE_THUMB = thumbLe([
  0x2b00, // cmp r3, #0
  0xd011, // beq done
  0x2492, // movs r4, #0x92
  0x8084, // strh r4, [r0, #4]
  0x2400, // movs r4, #0
  0x600c, // str r4, [r1]
  0x8804, // wait: ldrh r4, [r0, #0]
  0x2501, // movs r5, #1
  0x422c, // tst r4, r5
  0xd1fb, // bne wait
  0x00a4, // lsrs r4, r4, #2
  0x2503, // movs r5, #3
  0x402c, // ands r4, r5
  0xd109, // bne fail
  0x2400, // movs r4, #0
  0x8084, // strh r4, [r0, #4]
  0x31ff, // adds r1, #255
  0x3101, // adds r1, #1
  0x3b01, // subs r3, #1
  0xd1ed, // bne body
  0x2000, // done: movs r0, #0
  0xbe00, // bkpt #0
  0xbf00, // nop
  0xbf00, // nop
  0x20ff, // fail: movs r0, #0xff
  0xbe01, // bkpt #1
]);

export const SRAM_ERASE_DONE_OFF = 20 * 2;
export const SRAM_ERASE_FAIL_OFF = 24 * 2;

export function assertSramHalt(
  halt: { pc: number; r0: number },
  doneOff: number,
  failOff: number,
  what: string,
): void {
  const p = (halt.pc & ~1) - SRAM_CODE;
  const success = p >= doneOff && p < failOff;
  const fail = p >= failOff && p <= failOff + 4;
  if (halt.r0 === 0xff || fail) {
    throw new XmcError(`NVM VERR during ${what}`);
  }
  if (halt.r0 === 0 && success) return;
  throw new XmcError(
    `SRAM helper halted at PC 0x${halt.pc.toString(16)} r0=0x${halt.r0.toString(16)} during ${what}`,
  );
}

async function waitIdle(mem: MemIf): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    const st = await mem.read32(NVMSTATUS);
    if ((st & NVMSTATUS_BUSY) === 0) {
      checkVerr(st);
      return;
    }
    if (i < 8) continue;
    await sleep(1);
  }
  throw new XmcError("NVM busy timeout");
}

export function nvmVerr(status: number): number {
  return (status & NVMSTATUS_VERR_MASK) >>> 2;
}

export function checkVerr(status: number): void {
  const v = nvmVerr(status);
  if (v !== 0) throw new XmcError(`NVM VERR=${v}`);
}

async function setAction(mem: MemIf, action: number): Promise<void> {
  await mem.write16(NVMPROG, action & 0xffff);
}

export async function eraseUserFlash(
  mem: MemIf,
  base = FLASH_BASE,
  size = IMAGE_SIZE,
  onProgress?: ProgressFn,
): Promise<void> {
  if (size % NVM_PAGE_SIZE) throw new XmcError("Erase size is not page-aligned");
  const pages = size / NVM_PAGE_SIZE;
  await setAction(mem, NVMPROG_IDLE);
  await waitIdle(mem);
  for (let i = 0; i < pages; i++) {
    const addr = base + i * NVM_PAGE_SIZE;
    await setAction(mem, NVMPROG_PAGE_ERASE);
    await mem.write32(addr, 0xffffffff);
    await waitIdle(mem);
    await setAction(mem, NVMPROG_IDLE);
    onProgress?.(i + 1, pages, "erase");
  }
}

export async function programUserFlash(
  mem: MemIf,
  image: Uint8Array,
  base = FLASH_BASE,
  onProgress?: ProgressFn,
): Promise<void> {
  if (image.length !== IMAGE_SIZE) {
    throw new XmcError(`Image must be ${IMAGE_SIZE} bytes`);
  }
  if (base % NVM_BLOCK_SIZE) throw new XmcError("Flash base is not block-aligned");
  const blocks = image.length / NVM_BLOCK_SIZE;
  await setAction(mem, NVMPROG_IDLE);
  await waitIdle(mem);
  for (let i = 0; i < blocks; i++) {
    const addr = base + i * NVM_BLOCK_SIZE;
    const off = i * NVM_BLOCK_SIZE;
    await setAction(mem, NVMPROG_WRITE);
    for (let w = 0; w < 4; w++) {
      const o = off + w * 4;
      const word =
        image[o]! | (image[o + 1]! << 8) | (image[o + 2]! << 16) | (image[o + 3]! << 24);
      await mem.write32(addr + w * 4, word >>> 0);
    }
    await waitIdle(mem);
    await setAction(mem, NVMPROG_IDLE);
    if ((i & 0x1f) === 0x1f || i === blocks - 1) onProgress?.(i + 1, blocks, "write");
  }
}

async function idleNvm(mem: MemIf): Promise<void> {
  try {
    await setAction(mem, NVMPROG_IDLE);
  } catch {
    /* still try to leave idle if the AP is alive */
  }
}

async function flashViaAp(mem: MemIf, image: Uint8Array, onProgress?: ProgressFn): Promise<void> {
  try {
    await eraseUserFlash(mem, FLASH_BASE, IMAGE_SIZE, onProgress);
    await programUserFlash(mem, image, FLASH_BASE, onProgress);
  } finally {
    await idleNvm(mem);
  }
}

async function flashViaSram(mem: CortexM, image: Uint8Array, onProgress?: ProgressFn): Promise<void> {
  const pages = IMAGE_SIZE / NVM_PAGE_SIZE;
  try {
    await mem.halt();
    const eraseHalt = await mem.runFromSram(SRAM_ERASE_THUMB, {
      r0: NVM_BASE,
      r1: FLASH_BASE,
      r2: 0,
      r3: pages,
    }, 30_000);
    assertSramHalt(eraseHalt, SRAM_ERASE_DONE_OFF, SRAM_ERASE_FAIL_OFF, "page erase");
    onProgress?.(pages, pages, "erase");

    const chunkPages = 1;
    const chunkBytes = chunkPages * NVM_PAGE_SIZE;
    const chunks = IMAGE_SIZE / chunkBytes;
    for (let c = 0; c < chunks; c++) {
      const off = c * chunkBytes;
      const dest = FLASH_BASE + off;
      await mem.writeMem(SRAM_DATA, image.subarray(off, off + chunkBytes));
      const halt = await mem.runFromSram(SRAM_WRITE_THUMB, {
        r0: NVM_BASE,
        r1: dest,
        r2: SRAM_DATA,
        r3: chunkBytes / NVM_BLOCK_SIZE,
      }, 8_000);
      assertSramHalt(halt, SRAM_WRITE_DONE_OFF, SRAM_WRITE_FAIL_OFF, `write at 0x${dest.toString(16)}`);
      onProgress?.(c + 1, chunks, "write");
    }
  } finally {
    await idleNvm(mem);
  }
}

export async function flashXmc1(
  mem: MemIf,
  image: Uint8Array,
  onProgress?: ProgressFn,
): Promise<void> {
  if (image.length !== IMAGE_SIZE) {
    throw new XmcError(`Image must be ${IMAGE_SIZE} bytes`);
  }
  if (isSramHost(mem)) {
    await flashViaSram(mem, image, onProgress);
    return;
  }
  await flashViaAp(mem, image, onProgress);
}
