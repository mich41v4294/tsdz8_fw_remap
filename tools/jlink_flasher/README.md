# J-Link flasher (pylink CLI)

Host tool that dumps, programs, and verifies the Tongsheng TSDZ8 **64 KB** image at `0x10001000` on an Infineon **XMC1302** using a SEGGER J-Link in **stock J-Link mode**. It does not reflash the probe.

The browser patcher downloads a HEX. This CLI is the default way to dump, program, and verify. Experimental in-browser WebUSB is off unless the patcher is opened with `?webusb=1`.

## Install

1. Install [SEGGER J-Link Software](https://www.segger.com/downloads/jlink/).
2. Install [Python 3](https://www.python.org).
3. From the repo root, use a launcher (creates `tools/jlink_flasher/.venv` and installs pylink):

**Windows:** double-click [`../../jlink-flash.bat`](../../jlink-flash.bat) for a menu, or pass a subcommand. PowerShell: [`../../jlink-flash.ps1`](../../jlink-flash.ps1).

**macOS / Linux:**

```bash
./jlink-flash.sh
./jlink-flash.sh flash patched.hex
```

You can still run the module directly after `python3 -m pip install -r tools/jlink_flasher/requirements.txt`.

## Wiring

SWDIO, SWCLK, GND, and **VTref as a sense pin only**. Power the controller from the battery **or** pass `--power` (J-Link kickstart). Never both — that can damage the board.

ST-Link is not this path.

## Commands

No arguments opens a menu (info / dump / flash / verify). Otherwise:

```bash
./jlink-flash.sh info
./jlink-flash.sh dump out.hex
./jlink-flash.sh flash patched.hex
./jlink-flash.sh verify patched.hex
```

Equivalent: `python3 -m tools.jlink_flasher …`

Shared flags: `--device` (default `XMC1302-T038x0064`), `--speed` (kHz, default 4000), `--serial`, `--power`, `--skip-chip-id`.

`flash` prints the off-road / legality note, programs the full 64 KB window, reads it back, then resets the core. It refuses HEX files that are not a contiguous 64 KB at `0x10001000`. After halt it checks `SCU_IDCHIP[23:8] == 0xF1C0` unless `--skip-chip-id`.

## Tests (no hardware)

```bash
python3 -m unittest tools.jlink_flasher.test_hexio tools.jlink_flasher.test_probe tools.jlink_flasher.test_cli
```

Live J-Link tests are not in CI. Set nothing special; attach a probe and run `info` yourself.
