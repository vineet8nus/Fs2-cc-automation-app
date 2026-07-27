import { describe, expect, it } from "vitest";
import { isAtcBusinessHours } from "../src/sap/RealAdtClient";

// All timestamps below are UTC instants; comments give the equivalent
// Asia/Singapore (UTC+8) wall-clock time isAtcBusinessHours actually
// evaluates against.
describe("isAtcBusinessHours (default window: 10:00-18:00 Asia/Singapore, Mon-Fri)", () => {
  it("is true mid-morning on a weekday (Wed 11:00 SGT)", () => {
    expect(isAtcBusinessHours(new Date("2026-07-22T03:00:00Z"))).toBe(true); // Wed 11:00 SGT
  });

  it("is true right at the opening boundary (Wed 10:00 SGT)", () => {
    expect(isAtcBusinessHours(new Date("2026-07-22T02:00:00Z"))).toBe(true); // Wed 10:00 SGT
  });

  it("is false right at the closing boundary (Wed 18:00 SGT, end exclusive)", () => {
    expect(isAtcBusinessHours(new Date("2026-07-22T10:00:00Z"))).toBe(false); // Wed 18:00 SGT
  });

  it("is false late at night on a weekday (Wed 23:00 SGT)", () => {
    expect(isAtcBusinessHours(new Date("2026-07-22T15:00:00Z"))).toBe(false); // Wed 23:00 SGT
  });

  it("is false before opening on a weekday (Wed 06:00 SGT)", () => {
    expect(isAtcBusinessHours(new Date("2026-07-21T22:00:00Z"))).toBe(false); // Wed 06:00 SGT
  });

  it("is false on a Saturday even during the daytime window (Sat 11:00 SGT)", () => {
    expect(isAtcBusinessHours(new Date("2026-07-25T03:00:00Z"))).toBe(false); // Sat 11:00 SGT
  });

  it("is false on a Sunday even during the daytime window (Sun 11:00 SGT)", () => {
    expect(isAtcBusinessHours(new Date("2026-07-26T03:00:00Z"))).toBe(false); // Sun 11:00 SGT
  });
});
