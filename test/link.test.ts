import { describe, expect, it } from "vitest";
import { backoff, type LinkState, step, stored } from "../src/core/link.ts";

const delays = [100, 200, 400];
const at = (state: LinkState, event: Parameters<typeof step>[1]) => step(state, event, 1000, delays);
const connecting: LinkState = { kind: "connecting", attempt: 0 };

describe("connection state machine", () => {
  it("connects, and an offline bot always has a way back", () => {
    expect(at(connecting, { kind: "opened" })).toEqual({ state: { kind: "connected" }, effect: "none" });
    // Network trouble: try again later, by itself.
    const failed = at(connecting, { kind: "failed" });
    expect(failed).toEqual({
      state: { kind: "waiting", attempt: 1, code: "network", retryAt: 1100 },
      effect: "retry_later",
    });
    expect(at(failed.state, { kind: "timer" })).toEqual({
      state: { kind: "connecting", attempt: 1 },
      effect: "connect",
    });
    // Each failure waits longer, up to the last delay.
    expect(at({ kind: "connecting", attempt: 1 }, { kind: "failed" }).state).toMatchObject({ retryAt: 1200 });
    expect(backoff(9, delays)).toBe(400);
  });

  it("stops on problems only the person can fix, and reconnects when asked", () => {
    for (const code of ["credentials_revoked", "permission_missing", "credentials_missing"] as const) {
      expect(at(connecting, { kind: "failed", code })).toEqual({ state: { kind: "stopped", code }, effect: "close" });
    }
    const stopped: LinkState = { kind: "stopped", code: "credentials_revoked" };
    expect(at(stopped, { kind: "timer" }).effect).toBe("none");
    expect(at(stopped, { kind: "connect" })).toEqual({ state: connecting, effect: "connect" });
  });

  it("follows what the adapter reports", () => {
    const connected: LinkState = { kind: "connected" };
    expect(at(connected, { kind: "reported", state: { kind: "reconnecting", attempt: 2 } })).toEqual({
      state: connecting,
      effect: "none",
    });
    expect(at(connecting, { kind: "reported", state: { kind: "connected" } }).state).toEqual(connected);
    // The adapter gave up: Mingle closes it and starts over later.
    expect(at(connected, { kind: "reported", state: { kind: "error", code: "unknown" } })).toMatchObject({
      state: { kind: "waiting", code: "unknown" },
      effect: "retry_later",
    });
    expect(at(connected, { kind: "reported", state: { kind: "error", code: "credentials_revoked" } })).toEqual({
      state: { kind: "stopped", code: "credentials_revoked" },
      effect: "close",
    });
  });

  it("keeps a state reported while connecting", () => {
    const approval: LinkState = { kind: "awaiting_approval" };
    expect(at(connecting, { kind: "reported", state: { kind: "awaiting_approval" } }).state).toEqual(approval);
    expect(at(approval, { kind: "opened" })).toEqual({ state: approval, effect: "none" });
    // Refused during the attempt, then the attempt throws: stays stopped, no retry.
    const stopped: LinkState = { kind: "stopped", code: "credentials_revoked" };
    expect(at(stopped, { kind: "failed" })).toEqual({ state: stopped, effect: "none" });
    // An attempt that resolves after the state moved on is discarded.
    expect(at(stopped, { kind: "opened" }).effect).toBe("discard");
  });

  it("ends at removal", () => {
    const removed = at({ kind: "connected" }, { kind: "remove" });
    expect(removed).toEqual({ state: { kind: "removed" }, effect: "close" });
    expect(at(removed.state, { kind: "connect" }).effect).toBe("none");
    expect(at(removed.state, { kind: "opened" }).effect).toBe("discard");
  });

  it("stores every state as the console reads it", () => {
    expect(stored(connecting)).toEqual({ state: "reconnecting", stateDetail: null });
    expect(stored({ kind: "waiting", attempt: 1, code: "network", retryAt: 0 })).toEqual({
      state: "error",
      stateDetail: "network",
    });
    expect(stored({ kind: "stopped", code: "credentials_missing" })).toEqual({
      state: "error",
      stateDetail: "credentials_missing",
    });
  });
});
