from __future__ import annotations

import json
import unittest
from pathlib import Path

from tools.firmware_map import (
    LOCALE_DIR,
    PARAMETER_MAP,
    apply_patches,
    apply_preset,
    build_diff,
    check_original_bytes,
    compare_firmware,
    decode_value,
    default_values,
    encode_value,
    fingerprint_items,
    hex_from_image,
    image_from_hex_text,
    overlay_ranges,
    parameter_sites,
    site_status,
    parse_addr,
    parse_bytes,
)
from tools.jlink_flasher.hexio import FLASH_BASE, IMAGE_SIZE, HexError

REPO_ROOT = Path(__file__).resolve().parents[1]
STOCK_HEX = REPO_ROOT / "original firmware thonghsheng.hex"


def _leaf_keys(obj, prefix=""):
    keys = set()
    if isinstance(obj, dict):
        for key, value in obj.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(value, dict):
                keys |= _leaf_keys(value, path)
            else:
                keys.add(path)
    return keys


class ParameterMapTests(unittest.TestCase):
    def test_has_a_short_summary_on_every_parameter(self) -> None:
        self.assertTrue(all(len(p["summary"].strip()) > 20 for p in PARAMETER_MAP["parameters"]))

    def test_committed_new_ids_and_preserve_locks(self) -> None:
        ids = {p["id"] for p in PARAMETER_MAP["parameters"]}
        preserve = {p["id"] for p in PARAMETER_MAP["preserve"]}
        for pid in (
            "throttle_pas_full_span",
            "uart_min_display_speed_kmh",
            "long_period_sample_gate_kmh",
            "long_period_sample_cap",
            "ride_target_fade_delta",
            "throttle_adc_watchdog_age",
            "throttle_adc_fault_age",
            "ntc_adc_overrange",
            "ntc_overrange_forced_percent",
            "battery_voltage_window",
            "battery_uv_recovery",
            "ride_protect_timeout_ticks",
            "pas4_foc_scale",
            "pas1_foc_scale",
            "pas3_foc_scale",
            "throttle_lockout_release",
            "throttle_overrange",
            "speed_fade_band_numerator",
            "speed_fade_band_divisor",
            "brake_debounce_depth",
            "pack_uv_cutoff_v",
            "pack_nominal_v",
            "pack_max_current_a",
            "torque_sensor_gain_eighths",
            "walk_assist_fraction_sixteenths",
            "walk_foc_scale_sixteenths",
            "uart_min_wheel_code",
            "pas_inactivity_timeout",
            "pas_pulse_timeout",
            "pas_engage_pulse_count",
            "torque_adc_rise_window",
            "assist_ramp_up_shift",
            "assist_ramp_down_shift",
            "throttle_ramp_up_shift",
            "throttle_ramp_down_shift",
            "torque_slope_engage_delta",
            "fault_report_debounce",
            "fade_period_slew_shift",
            "torque_offset_drop_threshold",
            "torque_offset_relearn_count",
            "hall_advance_high_threshold",
            "hall_advance_high",
            "hall_advance_medium",
            "current_headroom_deadband",
            "current_headroom_slew_cap",
            "battery_average_sample_count",
            "battery_uv_predebounce",
            "battery_uv_latch_threshold",
            "throttle_ramp_down_bulk_threshold",
            "throttle_ramp_up_bulk_threshold",
        ):
            self.assertIn(pid, ids)
        self.assertNotIn("protect_timeout_cmp_200", preserve)
        self.assertIn("ride_protect_timeout_ticks", ids)
        for pid in (
            "long_period_sample_cap_shift",
            "long_period_sample_gate_shift",
            "ntc_adc_overrange_shift",
            "pas_foc_shared_mantissa",
            "throttle_lockout_shift",
            "speed_fade_band_muls",
            "overload_cutout_arm_shift",
            "pas_inactivity_timeout_shift",
            "fade_throttle_window_base",
            "uart_frame_byte0_timeout_shift",
            "chip_id_f1c0_boot",
        ):
            self.assertIn(pid, preserve)
        for pid in (
            "pas2_foc_scale",
            "fade_throttle_adc_low",
            "fade_throttle_adc_high",
            "protect_assist_clear_ticks",
            "uart_frame_byte0_timeout",
            "foc_outer_pi_kp",
            "foc_outer_pi_ki",
            "foc_vq_limit_floor",
            "pwm_rearm_delay_isr_ticks",
            "torque_hold_engage_ticks",
            "torque_engage_current_floor",
            "torque_release_period_threshold",
            "foc_pi_update_interval",
            "foc_duty_bulk_step_threshold",
            "torque_confirm_count",
            "torque_event_count_cap",
            "pas_pulse_asymmetry_gate",
            "foc_pi_kp",
            "foc_pi_ki",
            "hall_torque_sample_limit",
            "motor_running_current_floor",
            "motor_running_period_gate",
            "torque_sensor_fault_adc_low",
            "torque_sensor_fault_adc_high",
            "torque_assist_rise_shift",
            "torque_assist_fall_shift",
            "torque_adc_slew_shift",
            "wheel_period_constant_k",
            "hall_fault_debounce",
            "hall_advance_mid_threshold",
            "hall_advance_low_threshold",
            "foc_throttle_gate_base",
        ):
            self.assertIn(pid, ids)
        self.assertIn("wheel_period_constant_base", preserve)
        self.assertEqual(len(PARAMETER_MAP["parameters"]), 120)

    def test_requires_audience_on_every_parameter(self) -> None:
        audiences = {p["audience"] for p in PARAMETER_MAP["parameters"]}
        self.assertTrue(all(p["audience"] in ("rider", "advanced") for p in PARAMETER_MAP["parameters"]))
        self.assertIn("rider", audiences)
        self.assertIn("advanced", audiences)

    def test_round_trips_every_mapped_stock_value(self) -> None:
        for spec in PARAMETER_MAP["parameters"]:
            decoded = decode_value(spec, parse_bytes(spec["originalBytes"]))
            self.assertEqual(decoded, spec["defaultValue"], spec["id"])
            self.assertEqual(encode_value(spec, decoded), parse_bytes(spec["originalBytes"]), spec["id"])

    def test_writes_only_the_requested_ceiling_byte(self) -> None:
        values = {**default_values(), "speed_ceiling_kmh": 50}
        self.assertEqual(
            build_diff(values),
            [
                {
                    "id": "speed_ceiling_kmh",
                    "label": "Speed ceiling",
                    "audience": "rider",
                    "address": 0x1000881A,
                    "oldBytes": [0x19],
                    "newBytes": [0x32],
                }
            ],
        )

    def test_encodes_thumb_adds_imm8(self) -> None:
        spec = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "torque_engage_deadband")
        self.assertEqual(encode_value(spec, 163), [0xA3])
        self.assertEqual(decode_value(spec, [0xA3]), 163)
        self.assertEqual(encode_value(spec, 80), [0x50])
        self.assertEqual(decode_value(spec, [0x50]), 80)

    def test_encodes_ieee_f64_pas4_scale(self) -> None:
        spec = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "pas4_foc_scale")
        stock = [0xCD, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xEC, 0x3F]
        self.assertEqual(encode_value(spec, 90), stock)
        self.assertEqual(decode_value(spec, stock), 90)
        self.assertEqual(encode_value(spec, 80)[:2], [0x9A, 0x99])
        self.assertEqual(decode_value(spec, encode_value(spec, 80)), 80)

    def test_encodes_pas1_pas3_foc_high_words(self) -> None:
        pas1 = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "pas1_foc_scale")
        pas3 = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "pas3_foc_scale")
        self.assertEqual(encode_value(pas1, 40), [0x99, 0x99, 0xD9, 0x3F])
        self.assertEqual(encode_value(pas3, 80), [0x99, 0x99, 0xE9, 0x3F])
        self.assertEqual(decode_value(pas1, [0x99, 0x99, 0xD9, 0x3F]), 40)
        self.assertEqual(decode_value(pas3, [0x99, 0x99, 0xE9, 0x3F]), 80)
        self.assertEqual(encode_value(pas1, 80), [0x99, 0x99, 0xE9, 0x3F])
        with self.assertRaisesRegex(HexError, "mantissa"):
            encode_value(pas1, 50)

    def test_encodes_pack_float32(self) -> None:
        uv = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "pack_uv_cutoff_v")
        ov = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "pack_ov_cutoff_v")
        nom = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "pack_nominal_v")
        cur = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "pack_max_current_a")
        self.assertEqual(encode_value(uv, 41), [0x00, 0x00, 0x24, 0x42])
        self.assertEqual(encode_value(ov, 65), [0x00, 0x00, 0x82, 0x42])
        self.assertEqual(encode_value(nom, 48), [0x00, 0x00, 0x40, 0x42])
        self.assertEqual(encode_value(cur, 22), [0x00, 0x00, 0xB0, 0x41])
        self.assertEqual(decode_value(uv, [0x00, 0x00, 0x24, 0x42]), 41)
        self.assertEqual(encode_value(uv, 42), [0x00, 0x00, 0x28, 0x42])
        self.assertEqual(encode_value(ov, 66), [0x00, 0x00, 0x84, 0x42])

    def test_encodes_asrs_pair_sum(self) -> None:
        gain = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "torque_sensor_gain_eighths")
        walk = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "walk_assist_fraction_sixteenths")
        self.assertEqual(encode_value(gain, 3), [0x8A, 0x10, 0xC9, 0x10])
        self.assertEqual(decode_value(gain, [0x8A, 0x10, 0xC9, 0x10]), 3)
        self.assertEqual(encode_value(walk, 3), [0xD1, 0x10, 0x12, 0x11])
        self.assertEqual(decode_value(walk, [0xD1, 0x10, 0x12, 0x11]), 3)
        self.assertEqual(encode_value(gain, 4), [0x8A, 0x10, 0x89, 0x10])
        self.assertEqual(decode_value(gain, encode_value(gain, 4)), 4)
        with self.assertRaisesRegex(HexError, "powers of two"):
            encode_value(gain, 7)

    def test_throttle_offset_max_stays_inside_window(self) -> None:
        spec = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "throttle_adc_offset")
        self.assertEqual(spec["max"], 1240)
        self.assertLessEqual(spec["max"], 1241)

    def test_caps_unsafe_advanced_ranges(self) -> None:
        stopped = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "wheel_pulse_stopped_period")
        stall = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "stall_phase_balance_count")
        ntc = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "ntc_adc_overrange")
        pas = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "default_pas_level")
        wdog = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "throttle_adc_watchdog_age")
        self.assertEqual(stopped["max"], 16383)
        self.assertEqual(stall["max"], 64000)
        self.assertEqual(encode_value(stall, 64000), [250])
        self.assertEqual(ntc["max"], 944)
        self.assertEqual(pas["max"], 5)
        self.assertEqual(wdog["min"], 160)

    def test_encodes_thumb_subs_imm8(self) -> None:
        spec = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "battery_voltage_window")
        self.assertEqual(encode_value(spec, 32), [0x20])
        self.assertEqual(decode_value(spec, [0x20]), 32)
        self.assertEqual(encode_value(spec, 48), [0x30])

    def test_encodes_signed_throttle_low_edge(self) -> None:
        spec = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "throttle_adc_low")
        self.assertEqual(encode_value(spec, -1241), [0x27, 0xFB, 0xFF, 0xFF])
        self.assertEqual(decode_value(spec, [0x27, 0xFB, 0xFF, 0xFF]), -1241)
        self.assertEqual(encode_value(spec, -1000), [0x18, 0xFC, 0xFF, 0xFF])
        self.assertEqual(decode_value(spec, [0x18, 0xFC, 0xFF, 0xFF]), -1000)

    def test_rejects_movs_lsl_not_imm8_shift(self) -> None:
        spec = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "wheel_pulse_high_timeout")
        with self.assertRaisesRegex(HexError, "multiple of 16"):
            encode_value(spec, 2001)

    def test_encodes_ride_current_clamp_thumb_u16(self) -> None:
        spec = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "ride_current_clamp")
        self.assertEqual(encode_value(spec, 0), parse_bytes(spec["originalBytes"]))
        self.assertEqual(decode_value(spec, parse_bytes(spec["originalBytes"])), 0)
        self.assertEqual(encode_value(spec, 450), [0x01, 0x20, 0x00, 0x02, 0xC2, 0x30])
        self.assertEqual(decode_value(spec, [0x01, 0x20, 0x00, 0x02, 0xC2, 0x30]), 450)
        self.assertEqual(encode_value(spec, 32767), [0x7F, 0x20, 0x00, 0x02, 0xFF, 0x30])
        self.assertEqual(decode_value(spec, [0x7F, 0x20, 0x00, 0x02, 0xFF, 0x30]), 32767)
        with self.assertRaisesRegex(HexError, "450"):
            encode_value(spec, 449)
        with self.assertRaisesRegex(HexError, "450"):
            encode_value(spec, 1)

    def test_presets_only_reference_known_parameters(self) -> None:
        ids = {p["id"] for p in PARAMETER_MAP["parameters"]}
        presets = PARAMETER_MAP.get("presets") or []
        self.assertGreaterEqual(len(presets), 2)
        self.assertEqual({p["id"] for p in presets}, {"offroad_unlimit", "stock"})
        for preset in presets:
            self.assertTrue(set(preset.get("values") or {}).issubset(ids), preset["id"])

    def test_offroad_unlimit_preset_writes_the_four_limits(self) -> None:
        values = apply_preset("offroad_unlimit", {**default_values(), "pas1_percent": 40})
        self.assertEqual(values["pas1_percent"], 40)
        self.assertEqual(values["speed_ceiling_kmh"], 25)
        self.assertEqual(values["unlimit_speed_display_60"], 1)
        self.assertEqual(values["disable_speed_fade"], 1)
        self.assertEqual(values["ride_current_clamp"], 32767)
        self.assertEqual(values["skip_battery_voltage_guards"], 1)
        self.assertEqual(values["pack_max_current_a"], 30)
        self.assertEqual(values["overload_cutout_margin"], 255)
        self.assertEqual(
            {d["id"] for d in build_diff(apply_preset("offroad_unlimit", default_values()))},
            {
                "unlimit_speed_display_60",
                "disable_speed_fade",
                "ride_current_clamp",
                "skip_battery_voltage_guards",
                "pack_max_current_a",
                "overload_cutout_margin",
            },
        )
        raised = apply_preset("offroad_unlimit", {**default_values(), "speed_ceiling_kmh": 60})
        self.assertEqual(raised["speed_ceiling_kmh"], 25)

    def test_stock_preset_resets_other_changes(self) -> None:
        dirty = {**default_values(), "pas1_percent": 40, "ride_current_clamp": 32767}
        self.assertEqual(apply_preset("stock", dirty), default_values())



    def test_encodes_cmp_shift_n_pairs(self) -> None:
        rise = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "torque_assist_rise_shift")
        self.assertEqual(decode_value(rise, parse_bytes(rise["originalBytes"])), 3)
        self.assertEqual(encode_value(rise, 3), [0x07])
        self.assertEqual(encode_value(rise, 4), [0x0F])
        from tools.firmware_map import encode_site_bytes
        self.assertEqual(encode_site_bytes(rise, 4, rise["sites"][0]), [0x0F])
        self.assertEqual(encode_site_bytes(rise, 4, rise["sites"][1]), [0x1B, 0x09])  # lsrs r3,#4
        slew = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "torque_adc_slew_shift")
        self.assertEqual(encode_site_bytes(slew, 6, slew["sites"][1]), [0xB6, 0x11])  # asrs r6,#6
        self.assertEqual(encode_site_bytes(slew, 6, slew["sites"][0]), [0x3F])

    def test_encodes_asrs_shift_n(self) -> None:
        up = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "throttle_ramp_up_shift")
        self.assertEqual(decode_value(up, parse_bytes(up["originalBytes"])), 5)
        self.assertEqual(encode_value(up, 5), [0x52, 0x11])
        self.assertEqual(encode_value(up, 3), [0xD2, 0x10])  # asrs r2,r2,#3
        fade = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "fade_period_slew_shift")
        from tools.firmware_map import encode_site_bytes
        self.assertEqual(encode_site_bytes(fade, 2, fade["sites"][0]), [0x9B, 0x10])  # asrs r3,#2
        self.assertEqual(encode_site_bytes(fade, 2, fade["sites"][1]), [0x9B, 0x10])

class LocaleTests(unittest.TestCase):
    def test_en_and_sk_have_the_same_keys(self) -> None:
        en = json.loads((LOCALE_DIR / "en.json").read_text(encoding="utf-8"))
        sk = json.loads((LOCALE_DIR / "sk.json").read_text(encoding="utf-8"))
        self.assertEqual(_leaf_keys(en), _leaf_keys(sk))

    def test_every_parameter_is_translated(self) -> None:
        en = json.loads((LOCALE_DIR / "en.json").read_text(encoding="utf-8"))
        ids = {p["id"] for p in PARAMETER_MAP["parameters"]}
        self.assertEqual(ids, set(en["parameters"]))
        for pid, entry in en["parameters"].items():
            self.assertGreater(len(entry["label"]), 1, pid)
            self.assertGreater(len(entry["summary"]), 20, pid)

    def test_every_preset_is_translated(self) -> None:
        en = json.loads((LOCALE_DIR / "en.json").read_text(encoding="utf-8"))
        for preset in PARAMETER_MAP.get("presets") or []:
            self.assertGreater(len(en[f"presets.{preset['id']}.label"]), 1, preset["id"])
            self.assertGreater(len(en[f"presets.{preset['id']}.summary"]), 20, preset["id"])


class FirmwareCompareTests(unittest.TestCase):
    def _blank(self) -> bytearray:
        return bytearray(IMAGE_SIZE)

    def test_mapped_immediate_change(self) -> None:
        left = self._blank()
        right = self._blank()
        off = 0x1000881A - FLASH_BASE
        left[off] = 0x19
        right[off] = 0x32
        result = compare_firmware(bytes(left), bytes(right))
        self.assertEqual(result["parameterCount"], 1)
        self.assertEqual(result["unmappedByteCount"], 0)
        change = result["parameters"][0]
        self.assertEqual(change["id"], "speed_ceiling_kmh")
        self.assertEqual(change["oldValue"], 25)
        self.assertEqual(change["newValue"], 50)

    def test_checkbox_site_change(self) -> None:
        left = self._blank()
        right = self._blank()
        spec = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "disable_speed_fade")
        site = spec["sites"][0]
        off = parse_addr(site["address"]) - FLASH_BASE
        orig = parse_bytes(site["originalBytes"])
        patched = parse_bytes(site["patchedBytes"])
        left[off : off + len(orig)] = bytes(orig)
        right[off : off + len(patched)] = bytes(patched)
        result = compare_firmware(bytes(left), bytes(right))
        self.assertEqual(result["parameterCount"], 1)
        self.assertEqual(result["parameters"][0]["kind"], "checkbox")
        self.assertEqual(result["parameters"][0]["sites"][0]["oldState"], "off")
        self.assertEqual(result["parameters"][0]["sites"][0]["newState"], "on")

    def test_unmapped_byte(self) -> None:
        left = self._blank()
        right = self._blank()
        right[0x123] = 0xAA
        result = compare_firmware(bytes(left), bytes(right))
        self.assertEqual(result["parameterCount"], 0)
        self.assertEqual(result["unmappedByteCount"], 1)
        self.assertEqual(result["unmapped"][0]["address"], FLASH_BASE + 0x123)
        self.assertEqual(result["unmapped"][0]["newBytes"], [0xAA])

    def test_mixed_mapped_and_unmapped(self) -> None:
        left = self._blank()
        right = self._blank()
        off = 0x1000881A - FLASH_BASE
        left[off] = 0x19
        right[off] = 0x32
        right[0x200] = 0x01
        right[0x201] = 0x02
        result = compare_firmware(bytes(left), bytes(right))
        self.assertEqual(result["parameterCount"], 1)
        self.assertEqual(result["unmappedByteCount"], 2)
        self.assertEqual(len(result["unmapped"]), 1)
        self.assertEqual(result["unmapped"][0]["oldBytes"], [0, 0])

    def test_hex_roundtrip_still_compares(self) -> None:
        image = bytes((i * 17) & 0xFF for i in range(IMAGE_SIZE))
        other = bytearray(image)
        other[0x1000881A - FLASH_BASE] ^= 0xFF
        restored = image_from_hex_text(hex_from_image(image))
        restored_other = image_from_hex_text(hex_from_image(bytes(other)))
        result = compare_firmware(restored, restored_other)
        self.assertGreaterEqual(result["parameterCount"] + result["unmappedByteCount"], 1)


class FirmwareOverlayTests(unittest.TestCase):
    def test_covers_every_parameter_and_preserve_byte(self) -> None:
        overlay = overlay_ranges()
        self.assertEqual(overlay["overlaps"], [])
        expected: set[int] = set()
        for spec in PARAMETER_MAP["parameters"]:
            for site in parameter_sites(spec):
                for i in range(len(site["originalBytes"])):
                    expected.add(site["address"] + i)
        for spec in PARAMETER_MAP["preserve"]:
            data = parse_bytes(spec["originalBytes"])
            addr = parse_addr(spec["address"])
            for i in range(len(data)):
                expected.add(addr + i)
        hit_addrs = {hit["address"] for hit in overlay["hits"]}
        self.assertEqual(hit_addrs, expected)
        self.assertEqual(overlay["mappedByteCount"], len(expected))
        self.assertGreater(overlay["siteCount"], 0)
        self.assertEqual(overlay["changedByteCount"], 0)

    def test_blank_image_marks_nonzero_originals_as_other(self) -> None:
        overlay = overlay_ranges(bytes(IMAGE_SIZE))
        self.assertGreater(overlay["changedByteCount"], 0)
        ceiling = next(hit for hit in overlay["hits"] if hit["id"] == "speed_ceiling_kmh")
        self.assertEqual(ceiling["status"], "other")

    def test_site_status_compares_every_byte(self) -> None:
        spec = next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "unlimit_speed_display_60")
        site = spec["sites"][0]
        original = parse_bytes(site["originalBytes"])
        patched = parse_bytes(site["patchedBytes"])
        self.assertNotEqual(original, patched)
        self.assertEqual(site_status(original, original, patched), "stock")
        self.assertEqual(site_status(patched, original, patched), "patched")
        mutated = list(original)
        mutated[-1] ^= 0x01
        self.assertEqual(site_status(mutated, original, patched), "other")


@unittest.skipUnless(STOCK_HEX.is_file(), "stock HEX not present")
class PatcherVsStockTests(unittest.TestCase):
    def stock(self) -> bytes:
        return image_from_hex_text(STOCK_HEX.read_text(encoding="utf-8"))

    def test_accepts_mapped_stock_fingerprint(self) -> None:
        self.assertEqual(check_original_bytes(self.stock()), [])

    def test_refuses_already_changed_ceiling(self) -> None:
        image = bytearray(self.stock())
        image[0x1000881A - FLASH_BASE] = 0x3C
        failures = check_original_bytes(bytes(image))
        self.assertTrue(any(f["id"] == "speed_ceiling_kmh" for f in failures))
        with self.assertRaisesRegex(HexError, "does not match"):
            apply_patches(bytes(image), default_values())

    def test_applies_the_ceiling_byte(self) -> None:
        values = {**default_values(), "speed_ceiling_kmh": 50}
        patched = apply_patches(self.stock(), values)
        self.assertEqual(patched[0x1000881A - FLASH_BASE], 0x32)
        self.assertEqual(patched[0x1000308A - FLASH_BASE], 0x19)
        self.assertEqual(patched[0x100085D2 - FLASH_BASE], 0x59)

    def test_encodes_pas_percents_and_walk(self) -> None:
        values = {**default_values(), "pas1_percent": 40, "walk_assist_target": 400}
        patched = apply_patches(self.stock(), values)
        self.assertEqual(patched[0x10002EDC - FLASH_BASE], 40)
        self.assertEqual(patched[0x100032C2 - FLASH_BASE], 400 - 255)
        self.assertEqual(patched[0x10002F44 - FLASH_BASE], 0x64)

    def test_encodes_movs_lsl_and_literals(self) -> None:
        values = {
            **default_values(),
            "wheel_pulse_high_timeout": 2016,
            "stall_current_mag_sq": 25000,
            "pll_rate_clamp_low": -512,
        }
        diffs = build_diff(values)
        self.assertEqual([d["audience"] for d in diffs], ["advanced", "advanced", "advanced"])
        patched = apply_patches(self.stock(), values)
        self.assertEqual(patched[0x10008A96 - FLASH_BASE], 2016 >> 4)
        self.assertEqual(list(patched[0x100094CC - FLASH_BASE : 0x100094CC - FLASH_BASE + 4]), [0xA8, 0x61, 0x00, 0x00])
        self.assertEqual(list(patched[0x100094A4 - FLASH_BASE : 0x100094A4 - FLASH_BASE + 4]), [0x00, 0xFE, 0xFF, 0xFF])
        self.assertEqual(list(patched[0x10008A98 - FLASH_BASE : 0x10008A98 - FLASH_BASE + 2]), [0x12, 0x01])
        self.assertEqual(list(patched[0x100094B4 - FLASH_BASE : 0x100094B4 - FLASH_BASE + 4]), [0x30, 0x75, 0x00, 0x00])
        self.assertEqual(list(patched[0x10008DE0 - FLASH_BASE : 0x10008DE0 - FLASH_BASE + 4]), [0xC0, 0xF1, 0x00, 0x00])

    def test_rejects_applying_bad_movs_lsl(self) -> None:
        with self.assertRaisesRegex(HexError, "multiple of 16"):
            apply_patches(self.stock(), {**default_values(), "wheel_pulse_high_timeout": 2001})

    def test_matches_original_bytes_at_every_mapped_address(self) -> None:
        image = self.stock()
        for spec in PARAMETER_MAP["parameters"]:
            for item in fingerprint_items(spec):
                off = item["address"] - FLASH_BASE
                self.assertEqual(list(image[off : off + len(item["expected"])]), item["expected"])
        for spec in PARAMETER_MAP["preserve"]:
            data = parse_bytes(spec["originalBytes"])
            off = parse_addr(spec["address"]) - FLASH_BASE
            self.assertEqual(list(image[off : off + len(data)]), data)

    def test_unlimits_display_60_without_touching_uart(self) -> None:
        patched = apply_patches(self.stock(), {**default_values(), "unlimit_speed_display_60": 1})
        self.assertEqual(list(patched[0x10008824 - FLASH_BASE : 0x10008824 - FLASH_BASE + 2]), [0x03, 0xD3])
        self.assertEqual(
            list(patched[0x10008826 - FLASH_BASE : 0x10008826 - FLASH_BASE + 8]),
            [0x54, 0x49, 0x09, 0x78, 0x3C, 0x29, 0x03, 0xD1],
        )
        self.assertEqual(
            list(patched[0x10008890 - FLASH_BASE : 0x10008890 - FLASH_BASE + 8]),
            [0x3C, 0x2D, 0x01, 0xD1, 0x63, 0x25, 0x00, 0xBF],
        )
        self.assertEqual(patched[0x100085D2 - FLASH_BASE], 0x59)
        self.assertEqual(patched[0x1000881A - FLASH_BASE], 0x19)

    def test_offroad_unlimit_preset_keeps_stock_ceiling(self) -> None:
        patched = apply_patches(self.stock(), apply_preset("offroad_unlimit", default_values()))
        self.assertEqual(patched[0x1000881A - FLASH_BASE], 0x19)
        self.assertEqual(list(patched[0x10008824 - FLASH_BASE : 0x10008824 - FLASH_BASE + 2]), [0x03, 0xD3])
        self.assertEqual(
            list(patched[0x10008826 - FLASH_BASE : 0x10008826 - FLASH_BASE + 8]),
            [0x54, 0x49, 0x09, 0x78, 0x3C, 0x29, 0x03, 0xD1],
        )
        self.assertEqual(list(patched[0x10003A18 - FLASH_BASE : 0x10003A18 - FLASH_BASE + 4]), [0x00, 0x00, 0xF0, 0x41])
        self.assertEqual(patched[0x100031E4 - FLASH_BASE], 255)
        self.assertEqual(list(patched[0x100031D6 - FLASH_BASE : 0x100031D6 - FLASH_BASE + 2]), [0x49, 0x01])
        self.assertEqual(list(patched[0x10008898 - FLASH_BASE : 0x10008898 - FLASH_BASE + 4]), [0x07, 0xF0, 0x32, 0xFB])
        self.assertEqual(list(patched[0x100088F6 - FLASH_BASE : 0x100088F6 - FLASH_BASE + 2]), [0x02, 0xD2])
        self.assertEqual(patched[0x1000FF00 - FLASH_BASE : 0x1000FF00 - FLASH_BASE + 4], bytes([0x07, 0x49, 0x09, 0x78]))

    def test_disables_speed_fade_only_via_rebuild_cave(self) -> None:
        patched = apply_patches(self.stock(), {**default_values(), "disable_speed_fade": 1})
        self.assertEqual(list(patched[0x10008898 - FLASH_BASE : 0x10008898 - FLASH_BASE + 4]), [0x07, 0xF0, 0x32, 0xFB])
        self.assertEqual(
            list(patched[0x1000FF00 - FLASH_BASE : 0x1000FF00 - FLASH_BASE + 48]),
            [
                0x07, 0x49, 0x09, 0x78, 0x3C, 0x29, 0x07, 0xD1,
                0x06, 0x4F, 0x00, 0x20, 0x38, 0x86, 0x78, 0x86,
                0x05, 0x48, 0x04, 0x70, 0x31, 0x70, 0xF8, 0xBD,
                0x04, 0x49, 0x20, 0x46, 0x70, 0x47, 0x00, 0xBF,
                0x05, 0x27, 0x00, 0x20, 0x58, 0x25, 0x00, 0x20,
                0x02, 0x27, 0x00, 0x20, 0x33, 0x03, 0x00, 0x00,
            ],
        )
        self.assertEqual(list(patched[0x10008890 - FLASH_BASE : 0x10008890 - FLASH_BASE + 8]), [0x84, 0x42, 0x01, 0xD1, 0x8D, 0x42, 0x12, 0xD0])
        self.assertEqual(list(patched[0x100088F6 - FLASH_BASE : 0x100088F6 - FLASH_BASE + 2]), [0x02, 0xD2])
        self.assertEqual(list(patched[0x10008904 - FLASH_BASE : 0x10008904 - FLASH_BASE + 2]), [0x07, 0xD2])
        self.assertEqual(list(patched[0x10008922 - FLASH_BASE : 0x10008922 - FLASH_BASE + 2]), [0x03, 0xD2])
        self.assertEqual(patched[0x100088F0 - FLASH_BASE], 0x4B)
        self.assertEqual(list(patched[0x100088EA - FLASH_BASE : 0x100088EA - FLASH_BASE + 2]), [0x2D, 0x78])

    def test_disable_speed_fade_keeps_unlimit_remap_and_display_status(self) -> None:
        patched = apply_patches(
            self.stock(),
            {**default_values(), "unlimit_speed_display_60": 1, "disable_speed_fade": 1},
        )
        self.assertEqual(
            list(patched[0x10008826 - FLASH_BASE : 0x10008826 - FLASH_BASE + 8]),
            [0x54, 0x49, 0x09, 0x78, 0x3C, 0x29, 0x03, 0xD1],
        )
        self.assertEqual(
            list(patched[0x10008890 - FLASH_BASE : 0x10008890 - FLASH_BASE + 8]),
            [0x3C, 0x2D, 0x01, 0xD1, 0x63, 0x25, 0x00, 0xBF],
        )
        self.assertEqual(list(patched[0x10008898 - FLASH_BASE : 0x10008898 - FLASH_BASE + 4]), [0x07, 0xF0, 0x32, 0xFB])
        self.assertEqual(list(patched[0x100088F6 - FLASH_BASE : 0x100088F6 - FLASH_BASE + 2]), [0x02, 0xD2])

    def test_thermal_high_band_writes_both_imm8_sites(self) -> None:
        patched = apply_patches(self.stock(), {**default_values(), "thermal_protect_high_band": 100})
        self.assertEqual(patched[0x1000353A - FLASH_BASE], 100)
        self.assertEqual(patched[0x10003558 - FLASH_BASE], 100)
        self.assertEqual(patched[0x10003520 - FLASH_BASE], 0x4B)

    def test_battery_voltage_window_writes_both_sites(self) -> None:
        patched = apply_patches(self.stock(), {**default_values(), "battery_voltage_window": 48})
        self.assertEqual(patched[0x10002DAC - FLASH_BASE], 48)
        self.assertEqual(patched[0x10002DC2 - FLASH_BASE], 48)
        self.assertEqual(list(patched[0x10002DA4 - FLASH_BASE : 0x10002DA4 - FLASH_BASE + 2]), [0x02, 0xDD])

    def test_pas4_foc_scale_writes_the_independent_double(self) -> None:
        patched = apply_patches(self.stock(), {**default_values(), "pas4_foc_scale": 80})
        self.assertEqual(
            list(patched[0x10002FDC - FLASH_BASE : 0x10002FDC - FLASH_BASE + 8]),
            encode_value(
                next(p for p in PARAMETER_MAP["parameters"] if p["id"] == "pas4_foc_scale"),
                80,
            ),
        )
        self.assertEqual(list(patched[0x10002FD0 - FLASH_BASE : 0x10002FD0 - FLASH_BASE + 4]), [0x9A, 0x99, 0x99, 0x99])
        self.assertEqual(patched[0x10002F2A - FLASH_BASE], 0x55)

    def test_new_rider_and_protect_immediates(self) -> None:
        values = {
            **default_values(),
            "throttle_pas_full_span": 2700,
            "uart_min_display_speed_kmh": 15,
            "long_period_sample_gate_kmh": 150,
            "long_period_sample_cap": 1016,
            "ride_target_fade_delta": 20,
            "throttle_adc_watchdog_age": 180,
            "throttle_adc_fault_age": 80,
            "ntc_adc_overrange": 928,
            "ntc_overrange_forced_percent": 55,
            "battery_uv_recovery": 100,
            "ride_protect_timeout_ticks": 220,
        }
        patched = apply_patches(self.stock(), values)
        self.assertEqual(list(patched[0x100033E8 - FLASH_BASE : 0x100033E8 - FLASH_BASE + 4]), [0x8C, 0x0A, 0x00, 0x00])
        self.assertEqual(patched[0x10008660 - FLASH_BASE], 15)
        self.assertEqual(patched[0x100085BE - FLASH_BASE], 0x0A)
        self.assertEqual(patched[0x10008752 - FLASH_BASE], 150)
        self.assertEqual(patched[0x10008746 - FLASH_BASE], 1016 >> 3)
        self.assertEqual(list(patched[0x1000874A - FLASH_BASE : 0x1000874A - FLASH_BASE + 2]), [0xD2, 0x00])
        self.assertEqual(list(patched[0x10008756 - FLASH_BASE : 0x10008756 - FLASH_BASE + 2]), [0x5B, 0x01])
        self.assertEqual(patched[0x100089E4 - FLASH_BASE], 20)
        self.assertEqual(patched[0x10008A00 - FLASH_BASE], 20)
        self.assertEqual(patched[0x100087AC - FLASH_BASE], 180)
        self.assertEqual(patched[0x100087BE - FLASH_BASE], 80)
        self.assertEqual(patched[0x10002444 - FLASH_BASE], 928 >> 4)
        self.assertEqual(list(patched[0x10002446 - FLASH_BASE : 0x10002446 - FLASH_BASE + 2]), [0x09, 0x01])
        self.assertEqual(patched[0x1000244C - FLASH_BASE], 55)
        self.assertEqual(patched[0x10002E76 - FLASH_BASE], 100)
        self.assertEqual(patched[0x10007E96 - FLASH_BASE], 220)
        self.assertEqual(patched[0x100035D8 - FLASH_BASE], 200)

    def test_new_audit_expansion_immediates(self) -> None:
        values = {
            **default_values(),
            "throttle_lockout_release": 848,
            "throttle_overrange": 3700,
            "speed_fade_band_numerator": 24,
            "speed_fade_band_divisor": 20,
            "brake_debounce_depth": 5,
            "pas1_foc_scale": 80,
            "pas3_foc_scale": 40,
            "pack_uv_cutoff_v": 42,
            "pack_nominal_v": 50,
            "pack_max_current_a": 24,
            "pack_ov_cutoff_v": 66,
            "overload_cutout_arm_ticks": 832,
            "overload_cutout_margin": 60,
            "torque_sensor_gain_eighths": 4,
            "walk_assist_fraction_sixteenths": 4,
        }
        patched = apply_patches(self.stock(), values)
        self.assertEqual(patched[0x1000879E - FLASH_BASE], 848 >> 3)
        self.assertEqual(list(patched[0x100087A0 - FLASH_BASE : 0x100087A0 - FLASH_BASE + 2]), [0xDB, 0x00])
        self.assertEqual(
            list(patched[0x10008998 - FLASH_BASE : 0x10008998 - FLASH_BASE + 4]),
            [0x74, 0x0E, 0x00, 0x00],
        )
        self.assertEqual(patched[0x100088AC - FLASH_BASE], 24)
        self.assertEqual(patched[0x100088B0 - FLASH_BASE], 20)
        self.assertEqual(list(patched[0x100088AE - FLASH_BASE : 0x100088AE - FLASH_BASE + 2]), [0x48, 0x43])
        self.assertEqual(patched[0x10001F1A - FLASH_BASE], 5)
        self.assertEqual(list(patched[0x10002FD4 - FLASH_BASE : 0x10002FD4 - FLASH_BASE + 4]), [0x99, 0x99, 0xE9, 0x3F])
        self.assertEqual(list(patched[0x10002FD8 - FLASH_BASE : 0x10002FD8 - FLASH_BASE + 4]), [0x99, 0x99, 0xD9, 0x3F])
        self.assertEqual(list(patched[0x10002FD0 - FLASH_BASE : 0x10002FD0 - FLASH_BASE + 4]), [0x9A, 0x99, 0x99, 0x99])
        self.assertEqual(list(patched[0x10003A24 - FLASH_BASE : 0x10003A24 - FLASH_BASE + 4]), [0x00, 0x00, 0x28, 0x42])
        self.assertEqual(list(patched[0x10003A10 - FLASH_BASE : 0x10003A10 - FLASH_BASE + 4]), [0x00, 0x00, 0x48, 0x42])
        self.assertEqual(list(patched[0x10003A18 - FLASH_BASE : 0x10003A18 - FLASH_BASE + 4]), [0x00, 0x00, 0xC0, 0x41])
        self.assertEqual(list(patched[0x10003A28 - FLASH_BASE : 0x10003A28 - FLASH_BASE + 4]), [0x00, 0x00, 0x84, 0x42])
        self.assertEqual(patched[0x100031D4 - FLASH_BASE], 832 >> 5)
        self.assertEqual(list(patched[0x100031D6 - FLASH_BASE : 0x100031D6 - FLASH_BASE + 2]), [0x49, 0x01])
        self.assertEqual(patched[0x100031E4 - FLASH_BASE], 60)
        self.assertEqual(list(patched[0x1000801C - FLASH_BASE : 0x1000801C - FLASH_BASE + 4]), [0x8A, 0x10, 0x89, 0x10])
        self.assertEqual(list(patched[0x10002FE6 - FLASH_BASE : 0x10002FE6 - FLASH_BASE + 4]), [0xD1, 0x10, 0xD2, 0x10])

    def test_hall_offset_writes_all_three_literals(self) -> None:
        patched = apply_patches(self.stock(), {**default_values(), "hall_angle_offset": 0x1000})
        expected = [0x00, 0x10, 0x00, 0x00]
        self.assertEqual(list(patched[0x1000854C - FLASH_BASE : 0x1000854C - FLASH_BASE + 4]), expected)
        self.assertEqual(list(patched[0x100025B4 - FLASH_BASE : 0x100025B4 - FLASH_BASE + 4]), expected)
        self.assertEqual(list(patched[0x10009048 - FLASH_BASE : 0x10009048 - FLASH_BASE + 4]), expected)

    def test_rider_tier1_immediates(self) -> None:
        values = {
            **default_values(),
            "torque_engage_deadband": 80,
            "torque_assist_demand_floor": 400,
            "pwm_idle_shutdown_ticks": 150,
            "throttle_adc_offset": 608,
            "throttle_adc_bias": 832,
            "throttle_adc_span": 2400,
        }
        patched = apply_patches(self.stock(), values)
        self.assertEqual(patched[0x10007FF0 - FLASH_BASE], 80)
        self.assertEqual(patched[0x1000812C - FLASH_BASE], 400 - 255)
        self.assertEqual(patched[0x100035D8 - FLASH_BASE], 150)
        self.assertEqual(patched[0x10003312 - FLASH_BASE], 608 >> 3)
        self.assertEqual(patched[0x1000331A - FLASH_BASE], 832 >> 5)
        self.assertEqual(list(patched[0x100034B4 - FLASH_BASE : 0x100034B4 - FLASH_BASE + 4]), [0x60, 0x09, 0x00, 0x00])
        self.assertEqual(list(patched[0x10007E96 - FLASH_BASE : 0x10007E96 - FLASH_BASE + 2]), [0xC8, 0x28])
        self.assertEqual(list(patched[0x1000834A - FLASH_BASE : 0x1000834A - FLASH_BASE + 4]), [0x19, 0x21, 0x49, 0x01])

    def test_skips_battery_oc_without_ride_loop_clamps(self) -> None:
        diffs = build_diff({**default_values(), "skip_battery_voltage_guards": 1})
        self.assertEqual(len(diffs), 3)
        self.assertTrue(all(d["audience"] == "rider" for d in diffs))
        patched = apply_patches(self.stock(), {**default_values(), "skip_battery_voltage_guards": 1})
        self.assertEqual(list(patched[0x10002DA4 - FLASH_BASE : 0x10002DA4 - FLASH_BASE + 2]), [0x02, 0xE0])
        self.assertEqual(list(patched[0x10002DC8 - FLASH_BASE : 0x10002DC8 - FLASH_BASE + 2]), [0x15, 0xE0])
        self.assertEqual(list(patched[0x10002E12 - FLASH_BASE : 0x10002E12 - FLASH_BASE + 2]), [0x1E, 0xE0])
        self.assertEqual(list(patched[0x100034FE - FLASH_BASE : 0x100034FE - FLASH_BASE + 2]), [0x00, 0xDD])
        self.assertEqual(list(patched[0x1000350E - FLASH_BASE : 0x1000350E - FLASH_BASE + 2]), [0x00, 0xDD])

    def test_raises_ride_current_clamp_without_skipping_ble(self) -> None:
        patched = apply_patches(self.stock(), {**default_values(), "ride_current_clamp": 32767})
        self.assertEqual(
            list(patched[0x10003954 - FLASH_BASE : 0x10003954 - FLASH_BASE + 6]),
            [0x7F, 0x20, 0x00, 0x02, 0xFF, 0x30],
        )
        self.assertEqual(list(patched[0x100034FE - FLASH_BASE : 0x100034FE - FLASH_BASE + 2]), [0x00, 0xDD])
        self.assertEqual(list(patched[0x1000350E - FLASH_BASE : 0x1000350E - FLASH_BASE + 2]), [0x00, 0xDD])

    def test_overlay_classifies_stock_then_patches(self) -> None:
        overlay = overlay_ranges(self.stock())
        self.assertEqual(overlay["changedByteCount"], 0)
        self.assertTrue(all(hit["status"] == "stock" for hit in overlay["hits"]))

        patched = apply_patches(
            self.stock(),
            {**default_values(), "speed_ceiling_kmh": 50, "disable_speed_fade": 1},
        )
        overlay = overlay_ranges(bytes(patched))
        self.assertGreater(overlay["changedByteCount"], 0)
        by_id: dict[str, set[str]] = {}
        for hit in overlay["hits"]:
            by_id.setdefault(hit["id"], set()).add(hit["status"])
        self.assertEqual(by_id["speed_ceiling_kmh"], {"other"})
        self.assertIn("patched", by_id["disable_speed_fade"])
        self.assertNotIn("other", by_id["disable_speed_fade"])
        self.assertEqual(by_id["uart_start_byte_59"], {"stock"})


if __name__ == "__main__":
    unittest.main()
