# TSDZ8 stock parameter patcher

Browser tool and notes from a Ghidra pass over Tongsheng TSDZ8 stock motor firmware (Infineon XMC1xxx). It patches documented immediates (speed ceiling, PAS percents, walk target, FOC/stall/protect constants) and writes a checksum-correct Intel HEX. A compare view diffs two dumps and names mapped parameter changes. A hex view shows the full 64 KiB image with mapped sites highlighted.

It does **not** include vendor firmware or a Ghidra project. Flashing is the host CLI ([`tools/jlink_flasher/`](tools/jlink_flasher/)). Experimental Chrome WebUSB is off unless the patcher is opened with `?webusb=1`.

Hosted UI (GitHub Pages, every push to `main`): https://mich41v4294.github.io/tsdz8_fw_remap/

**Off-road / private property only.** Raising the motor speed or current cap can make the bike illegal on public roads. That is your responsibility.

## What is here

| Path | Contents |
|---|---|
| [`webapp/`](webapp/) | Static ES-module patcher, firmware compare, and hex visualizer (English / Slovak). Load a HEX, edit rider/advanced fields, download a patched HEX. |
| [`webapp/src/parameter_map.json`](webapp/src/parameter_map.json) | Addresses, encodings, original bytes, fingerprints. |
| [`start-webapp.sh`](start-webapp.sh) / [`start-webapp.bat`](start-webapp.bat) / [`start-webapp.ps1`](start-webapp.ps1) | Double-click / shell launchers (`python3 serve.py` on http://localhost:8080). |
| [`jlink-flash.bat`](jlink-flash.bat) / [`jlink-flash.ps1`](jlink-flash.ps1) / [`jlink-flash.sh`](jlink-flash.sh) | Local-venv launchers for the J-Link CLI (menu if no args; otherwise pass-through). |
| [`docker-compose.yml`](docker-compose.yml) | Homelab / Dockhand stack; builds [`webapp/Dockerfile`](webapp/Dockerfile) and serves on port 8080. |
| [`firmware/`](firmware/) | How to supply your own stock dump (SHA-256, filename). |
| [`tools/jlink_flasher/`](tools/jlink_flasher/) | pylink CLI: dump / flash / verify at `0x10001000`. |
| [`tools/firmware_map.py`](tools/firmware_map.py) | Python encode/decode and firmware compare used by unit tests. |

Not committed: `original firmware thonghsheng.hex`, `tsdz8_motor.gpr` / `.rep` (local Ghidra DB), `analysis/` (coverage notes).

## Use

Open https://mich41v4294.github.io/tsdz8_fw_remap/ (published from [`webapp/`](webapp/) on each `main` commit). HEX files stay in the browser.

**Windows:** install [Python 3](https://www.python.org), then double-click [`start-webapp.bat`](start-webapp.bat) (or run [`start-webapp.ps1`](start-webapp.ps1)). It serves the static site at http://localhost:8080.

For J-Link dump/flash/verify (the default flasher), also install [SEGGER J-Link Software](https://www.segger.com/downloads/jlink/), then double-click [`jlink-flash.bat`](jlink-flash.bat) (menu) or `jlink-flash.bat flash your-patched.hex`. PowerShell: [`jlink-flash.ps1`](jlink-flash.ps1).

**macOS / Linux:**

```bash
./start-webapp.sh
```

Or:

```bash
cd webapp
python3 serve.py
```

Drop your stock HEX onto the Patcher tab. Download is refused if known stock bytes do not match. The Compare tab diffs two HEX (or raw 64 KiB) files and lists mapped parameter changes plus leftover bytes. The Hex tab dumps the whole 64 KiB window in hex or binary with mapped parameter and locked-fingerprint bytes highlighted.

Flash with the CLI:

```bash
./jlink-flash.sh flash your-patched.hex
```

Experimental in-browser WebUSB (desktop Chrome/Edge) is off unless you open the patcher with `?webusb=1`. Close J-Flash / JLinkExe first. VTref is sense-only unless you opt into probe power — do not power from the battery and the J-Link at the same time. See [`tools/jlink_flasher/README.md`](tools/jlink_flasher/README.md).

## Tests

```bash
python3 -m unittest tools.jlink_flasher.test_hexio tools.jlink_flasher.test_probe tools.jlink_flasher.test_cli tools.test_firmware_map
```

Tests that need the real dump are skipped when the HEX is absent. With the file at the repo root they run against the mapped fingerprints.

## Self-host (Docker / Dockhand)

The patcher is a static site. Clone this private repo on the homelab (SSH deploy key or GitHub PAT) and build locally — nothing is published to a registry.

```bash
docker compose up -d --build
```

The UI is on port **8080**. In Dockhand, add a stack from this GitHub repo, compose file `docker-compose.yml`, and credentials that can clone the private repo. Rebuild when you pull.

HEX edit and download work over plain HTTP. The default flasher is the Python CLI (no HTTPS). Experimental WebUSB (`?webusb=1`) needs a secure context (HTTPS or `localhost`).

## License

This repository's source and notes are MIT (see [`LICENSE`](LICENSE)). Tongsheng firmware remains their copyright; do not add HEX/BIN dumps or Ghidra databases to the tree.
