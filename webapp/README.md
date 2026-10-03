# TSDZ8 stock parameter patcher

Browser editor for the Tongsheng TSDZ8 stock HEX. It patches documented immediates after a Ghidra pass over the ride loop, UART parser, assist mapper, PAS cadence, and FOC/stall path. Flash with the pylink CLI ([`../tools/jlink_flasher/`](../tools/jlink_flasher/)). Experimental **WebUSB** (desktop Chrome/Edge, stock J-Link firmware) is off unless you open the page with `?webusb=1`.

Rider settings and advanced firmware tunables are separate in the UI. Advanced is collapsed by default.

## Verified behavior

- **ParseDisplayUartFrame** (`0x100084CC`) accepts Tongsheng `0x59` frames. Assist-flag bits become PAS 0–6 at `0x20002706`. The max-speed byte is stored at `0x20002705` only when it is greater than 10. On-road / off-road hold-toggle stays on the VD04; the motor has one ceiling.
- **CompareWheelSpeedCeiling** (`0x10008810`) clears the assist-allow bit when wheel speed at ride-state `+0x38` is `>= kmh<<5`. Stock `movs r3, #0x19` is the 25 km/h wall. Other `#0x19` sites are an 800-tick timeout, current staging, and fade `*25/22`.
- **ApplyAssistLevelTargets** (`0x10002E9A`) writes PAS 1–5 percents to `g_bAssistPercent`. **CalculateTorqueAssistCurrent** multiplies filtered torque demand by that byte. FOC caps at `g_wScaledAssist` use separate soft-float 0.4 / 0.5 / 0.8 / 0.9 / 1.0 (PAS1/PAS3 share a mantissa word and are not exposed).
- **RunRideControlLoop** stores walk target **450** (`255 + 0xC3`) into `wCurrentTarget`.
- Init-block 1000 / 728 at `0x200025AC` / `0x2000258A` are write-only from `InitializeRideDefaults` with no proven clamp xref. They are not exposed.

## Rider settings

| Parameter | Address | Stock |
|---|---|---|
| Speed ceiling | `0x1000881A` | 25 km/h |
| Default max speed | `0x1000308A` | 25 km/h (silent display) |
| Default wheel-size code | `0x10003084` | 28 |
| Default PAS level | `0x100030B2` | 5 |
| PAS 1–5 percents | `0x10002EDC` … `0x10002F44` | 30/50/70/85/100 |
| Walk-assist target | `0x100032C2` | 450 |
| Unlimit speed when display sends 60 | `0x10008824`, `0x10008890` | off |
| Disable speed fade (full power always) | `0x100088F6`, `0x10008922` | off |
| Unlimit power and battery current | `0x10002DA4`… | off |

## Advanced firmware tunables

FOC / stall / hall / PAS pulse / protection immediates, including speed-fade floor 600, PAS timeouts 2000/4100, torque slew floor 300, PLL clamps 2400 / -1024, stall mag² 20000, hall +60° (`0x1555`), and Clarke IIR new-weight 2768. Wrong values can stall, cut assist, or rotate commutation.

UART `0x59`, the ceiling `lsls #5`, the PAS pointer, the PAS==6 compare, init byte `0x43`, chip-id `0xF1C0`, complementary IIR 30000, and the `movs` left-shifts are fingerprint-locked.

## Use

On Windows, from the repo root, double-click [`../start-webapp.bat`](../start-webapp.bat) or run [`../start-webapp.ps1`](../start-webapp.ps1) (needs [Node.js LTS](https://nodejs.org)).

```bash
cd webapp
npm install
npm test
npm run dev
```

`npm test` always checks the parameter map. Tests that parse the stock HEX skip unless `original firmware thonghsheng.hex` is at the repo root.

Load your Tongsheng stock HEX (local dumps are often named `original firmware thonghsheng.hex`; see [`../firmware/README.md`](../firmware/README.md)). Download is refused if known stock bytes do not match.

**Flash:** from the repo root, use the pylink CLI (default):

```bash
./jlink-flash.sh flash patched.hex
```

Windows: [`../jlink-flash.bat`](../jlink-flash.bat) / [`../jlink-flash.ps1`](../jlink-flash.ps1) (menu if no args). Needs [Python 3](https://www.python.org) and [SEGGER J-Link Software](https://www.segger.com/downloads/jlink/).

Experimental WebUSB in the page is off unless you open `?webusb=1`. Close J-Flash / JLinkExe first. VTref sense only unless you tick probe power; never power from battery and J-Link together. Raising the cap can make the bike illegal on public roads; that is your responsibility.

To serve the built site on a homelab, see **Self-host** in [`../README.md`](../README.md) (`docker compose up -d --build`, port 8080).
