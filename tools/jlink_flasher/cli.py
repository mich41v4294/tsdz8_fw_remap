from __future__ import annotations

import argparse
import sys
from pathlib import Path

from tools.jlink_flasher.hexio import FLASH_BASE, IMAGE_SIZE, dump_hex, load_image
from tools.jlink_flasher.probe import (
    DEFAULT_DEVICE,
    DEFAULT_SPEED_KHZ,
    ProbeError,
    flash_image,
    open_probe,
    probe_info,
    read_flash,
)

LEGAL = (
    "Off-road / private property only. Raising motor speed or current can make the bike "
    "illegal on public roads. Battery off, or do not supply 5 V from the J-Link VTref pin."
)


def _add_probe_flags(p: argparse.ArgumentParser) -> None:
    p.add_argument("--device", default=DEFAULT_DEVICE, help="SEGGER device name")
    p.add_argument("--speed", type=int, default=DEFAULT_SPEED_KHZ, help="SWD speed in kHz")
    p.add_argument("--serial", type=int, default=None, help="J-Link serial number")
    p.add_argument(
        "--power",
        action="store_true",
        help="Enable J-Link kickstart/target power (off by default)",
    )
    p.add_argument("--skip-chip-id", action="store_true", help="Do not require IDCHIP 0xF1C0")


def _open_kw(args: argparse.Namespace) -> dict:
    return {
        "device": args.device,
        "speed": args.speed,
        "serial": args.serial,
        "power": args.power,
        "skip_chip_id": args.skip_chip_id,
    }


def cmd_info(args: argparse.Namespace) -> int:
    with open_probe(**_open_kw(args)) as probe:
        print(probe_info(probe))
    return 0


def cmd_dump(args: argparse.Namespace) -> int:
    with open_probe(**_open_kw(args)) as probe:
        image = read_flash(probe, FLASH_BASE, IMAGE_SIZE)
    Path(args.output).write_text(dump_hex(image), encoding="ascii")
    print(f"Wrote {args.output} ({IMAGE_SIZE} bytes at 0x{FLASH_BASE:08X})")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    expected = load_image(Path(args.hex).read_text(encoding="utf-8"))
    with open_probe(**_open_kw(args)) as probe:
        actual = read_flash(probe, FLASH_BASE, IMAGE_SIZE)
    if actual != expected:
        mismatch = next(i for i, (a, b) in enumerate(zip(actual, expected, strict=True)) if a != b)
        raise ProbeError(f"Verify failed at 0x{FLASH_BASE + mismatch:08X}")
    print("Verify OK")
    return 0


def cmd_flash(args: argparse.Namespace) -> int:
    print(LEGAL, file=sys.stderr)
    image = load_image(Path(args.hex).read_text(encoding="utf-8"))
    with open_probe(**_open_kw(args)) as probe:
        flash_image(probe, image, base=FLASH_BASE, power=args.power)
    print("Flash + verify OK; target reset")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jlink-flash / python -m tools.jlink_flasher",
        description="Dump, program, and verify TSDZ8 XMC1302 firmware via SEGGER J-Link (pylink).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    info = sub.add_parser("info", help="Show probe and IDCHIP")
    _add_probe_flags(info)
    info.set_defaults(func=cmd_info)
    dump = sub.add_parser("dump", help="Read 64 KB flash to an Intel HEX file")
    _add_probe_flags(dump)
    dump.add_argument("output")
    dump.set_defaults(func=cmd_dump)
    flash = sub.add_parser("flash", help="Program a 64 KB HEX at 0x10001000 and verify")
    _add_probe_flags(flash)
    flash.add_argument("hex")
    flash.set_defaults(func=cmd_flash)
    verify = sub.add_parser("verify", help="Compare flash to a HEX file")
    _add_probe_flags(verify)
    verify.add_argument("hex")
    verify.set_defaults(func=cmd_verify)
    return parser


def _read_line(prompt: str) -> str | None:
    try:
        return input(prompt)
    except EOFError:
        return None


def _prompt_yes(question: str) -> bool:
    answer = _read_line(f"{question} [y/N] ")
    if answer is None:
        return False
    return answer.strip().lower() in ("y", "yes")


def interactive() -> int:
    print(LEGAL)
    print()
    print("1) info")
    print("2) dump")
    print("3) flash")
    print("4) verify")
    print("5) quit")
    choice = _read_line("Choice: ")
    if choice is None:
        return 0
    key = choice.strip().lower()
    if key in ("", "5", "q", "quit"):
        return 0

    argv: list[str]
    if key in ("1", "info"):
        argv = ["info"]
    elif key in ("2", "dump"):
        output = _read_line("Output HEX path: ")
        if output is None or not output.strip():
            return 0
        argv = ["dump", output.strip()]
    elif key in ("3", "flash"):
        hex_path = _read_line("HEX path: ")
        if hex_path is None or not hex_path.strip():
            return 0
        argv = ["flash", hex_path.strip()]
    elif key in ("4", "verify"):
        hex_path = _read_line("HEX path: ")
        if hex_path is None or not hex_path.strip():
            return 0
        argv = ["verify", hex_path.strip()]
    else:
        print("Unknown choice. Enter 1–5.", file=sys.stderr)
        return 1

    if _prompt_yes("Enable J-Link kickstart/target power?"):
        argv.append("--power")
    return _run(argv)


def _run(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (ProbeError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def main(argv: list[str] | None = None) -> int:
    raw = sys.argv[1:] if argv is None else argv
    if not raw:
        return interactive()
    return _run(raw)


if __name__ == "__main__":
    raise SystemExit(main())
