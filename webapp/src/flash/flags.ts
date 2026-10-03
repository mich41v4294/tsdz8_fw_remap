/** Experimental in-browser J-Link. Default off; enable with ?webusb=1 (or true/yes). */
export function webUsbFlasherEnabled(search?: string): boolean {
  const raw =
    search ?? (typeof location !== "undefined" ? location.search : "");
  const q = raw.startsWith("?") ? raw.slice(1) : raw;
  const v = (new URLSearchParams(q).get("webusb") ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
