import { describe, expect, it } from "vitest";
import { hearingSettings } from "../web/src/api.ts";

/** What the console shows under "hear every message" (docs/spec.md 4.2), from new and older hosts. */
describe("hearing settings in the console", () => {
  it("reads the tier, names and who it is talking with", () => {
    expect(
      hearingSettings({ pace: "auto", tier: null, defaultTier: "fast", live: ["Li Lei"], aliases: ["小跟班"] }),
    ).toEqual({ tier: null, defaultTier: "fast", live: ["Li Lei"], aliases: ["小跟班"] });
    expect(hearingSettings({ pace: "muted", tier: "save", defaultTier: "balanced", live: [], aliases: [] })?.tier).toBe(
      "save",
    );
  });

  it("has none for a host on an older Mingle, which sends only the pace", () => {
    // An SSH host on 0.4.6 answers like this; the console keeps the switch and the pace line.
    expect(hearingSettings({ pace: "auto" })).toBeNull();
    expect(hearingSettings({ pace: "every", everyMs: 3_600_000 })).toBeNull();
    expect(hearingSettings({ pace: "auto", slowedMs: 480_000 })).toBeNull();
    expect(hearingSettings(null)).toBeNull();
  });
});
