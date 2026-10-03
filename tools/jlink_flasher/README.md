# J-Link flasher (pylink CLI)

Host tool that dumps, programs, and verifies the Tongsheng TSDZ8 **64 KB** image at `0x10001000` on an Infineon **XMC1302** using a SEGGER J-Link in **stock J-Link mode**. It does not reflash the probe.

The browser patcher can also talk to the same probe over WebUSB (desktop Chrome/Edge). Use this CLI when WebUSB cannot claim the device (typical on Windows while the SEGGER driver owns the USB interface).

## Install

1. Install [SEGGER J-Link Software](https://www.segger.com/downloads/jlink/).
2. From the repo root:

```bash
python3 -m pip install -r tools/jlink_flasher/requirements.txt
```

## Wiring

SWDIO, SWCLK, GND, and **VTref as a sense pin only**. Power the controller from the battery **or** pass `--power` (J-Link kickstart). Never both — that can damage the board.

ST-Link is not this path.

## Commands

```bash
python3 -m tools.jlink_flasher info
python3 -m tools.jlink_flasher dump out.hex
python3 -m tools.jlink_flasher flash patched.hex
python3 -m tools.jlink_flasher verify patched.hex
```

Shared flags: `--device` (default `XMC1302-T038x0064`), `--speed` (kHz, default 4000), `--serial`, `--power`, `--skip-chip-id`.

`flash` prints the off-road / legality note, programs the full 64 KB window, reads it back, then resets the core. It refuses HEX files that are not a contiguous 64 KB at `0x10001000`. After halt it checks `SCU_IDCHIP[23:8] == 0xF1C0` unless `--skip-chip-id`.

## Tests (no hardware)

```bash
python3 -m unittest tools.jlink_flasher.test_hexio tools.jlink_flasher.test_probe
```

Live J-Link tests are not in CI. Set nothing special; attach a probe and run `info` yourself.
