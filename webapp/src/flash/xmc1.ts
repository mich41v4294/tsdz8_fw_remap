import {
  FLASH_BASE,
  IMAGE_SIZE,
  NVM_BLOCK_SIZE,
  NVM_PAGE_SIZE,
  NVMPROG,
  NVMPROG_IDLE,
  NVMPROG_PAGE_ERASE,
  NVMPROG_WRITE,
  NVMSTATUS,
  NVMSTATUS_BUSY,
} from "./constants";
import type { MemIf } from "./cortexM";

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

async function waitIdle(mem: MemIf): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    const st = await mem.read16(NVMSTATUS);
    if ((st & NVMSTATUS_BUSY) === 0) return;
    if (i < 8) continue;
    await sleep(1);
  }
  throw new XmcError("NVM busy timeout");
}

async function setAction(mem: MemIf, action: number): Promise<void> {
  await mem.write16(NVMPROG, action);
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

export async function flashXmc1(
  mem: MemIf,
  image: Uint8Array,
  onProgress?: ProgressFn,
): Promise<void> {
  await eraseUserFlash(mem, FLASH_BASE, IMAGE_SIZE, onProgress);
  await programUserFlash(mem, image, FLASH_BASE, onProgress);
}
