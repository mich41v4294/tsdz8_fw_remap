from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, Protocol

from tools.jlink_flasher.hexio import (
    FLASH_BASE,
    IDCHIP_ADDR,
    IDCHIP_EXPECTED,
    IMAGE_SIZE,
    HexError,
    idchip_field,
)

DEFAULT_DEVICE = "XMC1302-T038x0064"
DEFAULT_SPEED_KHZ = 4000


class ProbeError(RuntimeError):
    pass


class JLinkLike(Protocol):
    def open(self, serial_no: int | None = None) -> None: ...
    def close(self) -> None: ...
    def set_tif(self, iface: Any) -> bool: ...
    def connect(self, chip_name: str, speed: int | str = "auto") -> None: ...
    def set_speed(self, speed: int) -> None: ...
    def halt(self) -> bool: ...
    def halted(self) -> bool: ...
    def reset(self, halt: bool = True) -> None: ...
    def restart(self) -> None: ...
    def memory_read8(self, addr: int, count: int) -> list[int]: ...
    def memory_read32(self, addr: int, count: int) -> list[int]: ...
    def flash(
        self,
        data: list[int],
        addr: int,
        on_progress: Callable[..., Any] | None = None,
        power_on: bool = False,
    ) -> int: ...
    def exec_command(self, cmd: str) -> str: ...
    @property
    def product_name(self) -> str: ...
    def core_id(self) -> int: ...


def _load_pylink() -> Any:
    try:
        import pylink  # type: ignore[import-untyped]
    except ImportError as exc:
        raise ProbeError(
            "pylink is not installed. pip install -r tools/jlink_flasher/requirements.txt"
        ) from exc
    return pylink


def check_idchip(word: int, expected: int = IDCHIP_EXPECTED) -> None:
    field = idchip_field(word)
    if field != expected:
        raise ProbeError(
            f"SCU_IDCHIP[23:8]=0x{field:04X} (raw 0x{word:08X}), expected 0x{expected:04X}. "
            "Wrong MCU or not halted. Pass --skip-chip-id to override."
        )


def _set_kickstart_power(jlink: JLinkLike, enable: bool) -> None:
    cmd = "power on" if enable else "power off"
    try:
        jlink.exec_command(cmd)
    except Exception:
        setter = getattr(jlink, "set_kickstart_power", None)
        if callable(setter):
            setter(enable)


def _progress(action: str, message: str, percentage: int) -> None:
    print(f"\r{action} {percentage:3d}% {message}", end="", flush=True)


@contextmanager
def open_probe(
    *,
    device: str = DEFAULT_DEVICE,
    speed: int = DEFAULT_SPEED_KHZ,
    serial: int | None = None,
    power: bool = False,
    skip_chip_id: bool = False,
    jlink: JLinkLike | None = None,
) -> Iterator[JLinkLike]:
    pylink = _load_pylink() if jlink is None else None
    probe = jlink if jlink is not None else pylink.JLink()
    opened = False
    try:
        if serial is not None:
            probe.open(serial_no=serial)
        else:
            probe.open()
        opened = True
        if pylink is not None:
            probe.set_tif(pylink.enums.JLinkInterfaces.SWD)
        else:
            swd = getattr(probe, "SWD", 1)
            probe.set_tif(swd)
        _set_kickstart_power(probe, power)
        probe.connect(device, speed=speed)
        try:
            probe.set_speed(speed)
        except Exception:
            pass
        probe.halt()
        if not skip_chip_id:
            words = probe.memory_read32(IDCHIP_ADDR, 1)
            if not words:
                raise ProbeError("Could not read SCU_IDCHIP")
            check_idchip(int(words[0]))
        yield probe
    except ProbeError:
        raise
    except Exception as exc:
        msg = str(exc)
        raise ProbeError(msg or exc.__class__.__name__) from exc
    finally:
        if opened:
            try:
                probe.close()
            except Exception:
                pass


def read_flash(probe: JLinkLike, base: int = FLASH_BASE, size: int = IMAGE_SIZE) -> bytes:
    chunk = 1024
    out = bytearray()
    remaining = size
    addr = base
    while remaining:
        n = min(chunk, remaining)
        out.extend(probe.memory_read8(addr, n))
        addr += n
        remaining -= n
    if len(out) != size:
        raise ProbeError(f"Short flash read ({len(out)} != {size})")
    return bytes(out)


def flash_image(
    probe: JLinkLike,
    image: bytes,
    *,
    base: int = FLASH_BASE,
    power: bool = False,
) -> None:
    if len(image) != IMAGE_SIZE:
        raise HexError(f"Image must be {IMAGE_SIZE} bytes, got {len(image)}")
    probe.halt()
    probe.flash(list(image), base, on_progress=_progress, power_on=power)
    print()
    back = read_flash(probe, base, IMAGE_SIZE)
    if back != image:
        mismatch = next(i for i, (a, b) in enumerate(zip(back, image, strict=True)) if a != b)
        raise ProbeError(f"Verify failed at 0x{base + mismatch:08X}")
    probe.reset(halt=False)


def probe_info(probe: JLinkLike) -> str:
    name = getattr(probe, "product_name", "?")
    try:
        core = probe.core_id()
        core_s = f"0x{int(core):08X}"
    except Exception:
        core_s = "?"
    try:
        word = int(probe.memory_read32(IDCHIP_ADDR, 1)[0])
        chip = f"0x{word:08X} field=0x{idchip_field(word):04X}"
    except Exception as exc:
        chip = f"unread ({exc})"
    return f"product={name} core_id={core_s} IDCHIP {chip}"
