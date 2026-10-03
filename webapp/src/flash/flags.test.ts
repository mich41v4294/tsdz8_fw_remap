import { describe, expect, it } from "vitest";
import { webUsbFlasherEnabled } from "./flags";

describe("webUsbFlasherEnabled", () => {
  it("is off when the query is absent", () => {
    expect(webUsbFlasherEnabled("")).toBe(false);
    expect(webUsbFlasherEnabled("?foo=1")).toBe(false);
    expect(webUsbFlasherEnabled("?webusb=0")).toBe(false);
  });

  it("is on for 1 / true / yes", () => {
    expect(webUsbFlasherEnabled("?webusb=1")).toBe(true);
    expect(webUsbFlasherEnabled("webusb=true")).toBe(true);
    expect(webUsbFlasherEnabled("?other=x&webusb=YES")).toBe(true);
  });
});
