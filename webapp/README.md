# TSDZ8 stock parameter patcher

Browser editor for the Tongsheng TSDZ8 stock HEX. It patches documented immediates after a Ghidra pass over the ride loop, UART parser, assist mapper, wheel-pulse / P0.4 period path, and FOC/stall path. A second tab compares two firmware images and names mapped parameter changes. A third tab dumps the full 64 KiB image in hex or binary with mapped sites highlighted. The UI is English and Slovak.

Flash with the pylink CLI ([`../tools/jlink_flasher/`](../tools/jlink_flasher/)). Experimental **WebUSB** (desktop Chrome/Edge, stock J-Link firmware) is off unless you open the page with `?webusb=1`.

Rider settings and advanced firmware tunables are separate in the UI. Advanced is collapsed by default.

This directory is a static site (plain ES modules). There is no Node.js build step. GitHub Pages publishes it from `main` at https://mich41v4294.github.io/tsdz8_fw_remap/.

## Verified behavior

- **ParseDisplayUartFrame** (`0x100084CC`) accepts Tongsheng `0x59` frames. Assist-flag bits become PAS 0–6 at `0x20002706`. The max-speed byte is stored at `0x20002705` when speed is greater than **10** or the wheel code also changes past **5**. On-road / off-road hold-toggle stays on the VD04; the motor has one ceiling.
- **UpdateDisplayWheelPeriodStatusBit** (`0x10008810`) compares the P0.4 wheel-pulse **period** at `0x20002590` to `kmh<<5` (stock 25 → 800) and writes display TX bit `0x40000`. That cell is a period (stopped 4100), not km/h. Live motor taper is **ApplyWheelSpeedFade**. Other `#0x19` sites are an 800-tick timeout, current staging, fade `*25/22`, and a torque-path `25<<5`.
- **ApplyAssistLevelTargets** (`0x10002E9A`) writes PAS 1–5 percents to `g_bAssistPercent`. **CalculateTorqueAssistCurrent** multiplies filtered torque demand by that byte after a **+163** ADC deadband on the learned offset. FOC caps at `g_wScaledAssist` use separate soft-float 0.4 / 0.5 / 0.8 / 0.9 / 1.0 (PAS1/PAS3 high words are the PAS 1 / PAS 3 FOC scale sliders and share mantissa `0x9999999A`; PAS4 0.9 at `0x10002FDC` is). A throttle window of **2679** after the shared −1241 edge forces PAS 1–5 to full current. Walk writes **3/16** of full current into the assist target and an independent **1/16** FOC cap into `g_wScaledAssist`.
- **DecodePasCadencePulseEdges** (`0x1000815C`) validates pedal edges (stock 3 qualifying edges), times high/low pulses (timeout **1500**), clears cadence after **1000** unchanged samples, and every **50** ticks samples torque-ADC rise into `0x200025A8` (feeds the slope-engage gate — not a cadence-edge timer).
- **RunRideControlLoop** stores walk target **450** (`255 + 0xC3`) into `wCurrentTarget`. Handlebar throttle is `ReadThrottleAdcResult` (`0x100023E4`): when PAS is 1–5 and ADC is in 1241–3600 (`adc-1241` vs span 2359), it stages `(ADC-600)*2+800` then **ble**-clamps to `g_wFullCurrentLimit`. **Ride current clamp** `0` keeps `ConvertFloatToSignedInt` into that word; **450–32767** replaces the convert with a Thumb uint16. Skipping those `ble`s makes throttle twitch. Zero current for **200** ticks shuts PWM down.
- Init-block 1000 / 728 / 641 seed fade RAM from `InitializeRideDefaults` and are rebuilt by `RebuildWheelSpeedFadeThresholds` (scatter-copied to SRAM `0x2000146A`). They are not exposed. **Disable speed fade** is an 8-byte in-function gate at `0x10008890` (no far `BL`): off-road display 60 zeros the fade periods; on-road 25 keeps stock math. Unlimit-when-display-60 shares that slot and forces TX bit `0x40000` always on (`bcc`→`b` at `0x10008824`); disable overwrites the 60→99 remap and leaves the handshake.
- Thermal protect averages **LookupTemperatureAdcPercent** (not a shunt ADC): below **75** clears bit `0x2000000`; **91** is the fade-band upper reference (≥92 trips). NTC ADC ≥**944** forces percent **60**.
- Sensorless Clarke/stall (`HandleUnreachableClarkePhaseCurrents` / `HandleUnreachableSvmStallProtect`) stay unreachable after scatter-load/RAM-alias scan; mag² / phase-balance / Clarke IIR sliders are low confidence and inert on stock. Stall mag² would trip when raw mag² is **below** the threshold if that path were live.

## Rider settings

| Parameter | Address | Stock |
|---|---|---|
| Speed ceiling (P0.4 period vs km/h<<5; display TX `0x40000`) | `0x1000881A` | 25 km/h |
| PAS-full throttle span | `0x100033E8` | 2679 |
| Default max speed | `0x1000308A` | 25 km/h (silent display) |
| Display speed accept floor | `0x10008660` | 10 km/h |
| Display wheel-code accept floor | `0x10008650` | 5 |
| Default wheel-size code | `0x10003084` | 28 |
| Default PAS level | `0x100030B2` | 5 |
| PAS 1–5 percents | `0x10002EDC` … `0x10002F44` | 30/50/70/85/100 |
| Walk-assist target | `0x100032C2` | 450 |
| Unlimit speed when display sends 60 | `0x10008824`, `0x10008890` | off |
| Disable speed fade | `0x10008890` | off |
| Bypass battery OV/UV flag branches | `0x10002DA4`… | off |
| Ride current clamp | `0x10003954` | 0 (stock derived) |

## Advanced firmware tunables

FOC / stall / hall / wheel-pulse / protection immediates, including speed-fade floor 600, fade band 25/22, wheel-pulse timeouts 2000/4100, thermal percent bands 75/91, NTC overrange 944→60, pack UV 41 V / OV 65 V / nominal 48 V / max current 22 A, overload cutout arm 800 / margin 49 (first trip 691), battery OV/UV window 32 / UV recovery 93 / average-16 / UV debounce 5+3, UART-silence protect timeout 200, long-period sample gate 125 (4000 ticks, just under stopped 4100), PAS 1/3/4 FOC scales 0.4/0.8/0.9, walk FOC 1/16, PAS inactivity/pulse/engage 1000/1500/2 plus asymmetry gate 5, torque engage deadband 163 / PAS demand floor 300 / throttle lockout 840, torque-ADC rise window 50 / slope engage 30, torque assist rise/fall and assist ramp shifts, torque sensor fault ADC low, torque confirm 2 / event cap 10 / FOC-product release 600, torque offset relearn 80/100, hall +30° (`0x1555`×3) plus torque-band advances 5000/3500 and torque-angle sample limit 4000, FOC inner PI Kp/Ki 400/2 plus outer PI 4864/16, Vq limit floor 3000, PWM re-arm delay 6000 ISR ticks, FOC PI update interval 16 / duty bulk 31, UART frame byte0 timeout 1000, motor-running current floor 600 / period gate 4000 (debounce 500 coupled), current headroom deadband 70 / slew cap 12, throttle ramp bulk 15/31 with shifts 4/5, assist ramp shifts 4/4, wheel-period slew shift 4, fault-report debounce 30, torque slew floor 300, PLL clamps 2400 / -1024, stall mag² 20000 (direction: higher = easier trip; path may be dormant), Clarke IIR new-weight 2768 (low confidence), throttle overrange 3686, and brake debounce 3. Wrong values can stall, cut assist, or rotate commutation. The wheel-period slew threshold patches both `cmp #0x10` sites. Default PAS is capped at 5 so a silent display cannot boot into walk. Scale-table halfwords 800/600 at motor-calib +0xC/+0xE have zero recovered readers and stay unmapped.

UART `0x59`, the ceiling `lsls #5`, the PAS pointer, the PAS==6 compare, init byte `0x43`, chip-id `0xF1C0`, complementary IIR 30000, the torque-path `25<<5`, the PAS 1/3 FOC mantissa, and the `movs` left-shifts are fingerprint-locked.

## Use

On Windows, from the repo root, double-click [`../start-webapp.bat`](../start-webapp.bat) or run [`../start-webapp.ps1`](../start-webapp.ps1) (needs [Python 3](https://www.python.org)).

```bash
../start-webapp.sh
```

Or from this directory:

```bash
python3 serve.py
```

The parameter-map and firmware-compare tests live in Python:

```bash
cd ..
python3 -m unittest tools.test_firmware_map
```

Those tests always check the parameter map and locale key coverage. Tests that parse the stock HEX skip unless `original firmware thonghsheng.hex` is at the repo root.

Load your Tongsheng stock HEX (local dumps are often named `original firmware thonghsheng.hex`; see [`../firmware/README.md`](../firmware/README.md)). Download is refused if known stock bytes do not match. The Hex tab loads a HEX or raw 64 KiB image (no stock fingerprint required) and highlights mapped parameter and locked fingerprint bytes in hex or binary.

**Flash:** from the repo root, use the pylink CLI (default):

```bash
./jlink-flash.sh flash patched.hex
```

Windows: [`../jlink-flash.bat`](../jlink-flash.bat) / [`../jlink-flash.ps1`](../jlink-flash.ps1) (menu if no args). Needs [Python 3](https://www.python.org) and [SEGGER J-Link Software](https://www.segger.com/downloads/jlink/).

Experimental WebUSB in the page is off unless you open `?webusb=1`. Close J-Flash / JLinkExe first. VTref sense only unless you tick probe power; never power from battery and J-Link together. Raising the cap can make the bike illegal on public roads; that is your responsibility.

To serve the built site on a homelab, see **Self-host** in [`../README.md`](../README.md) (`GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build`, port 8080). The topbar shows the short git commit used for that build.
