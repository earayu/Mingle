import { describe, expect, it, vi } from "vitest";
import { fetchCached, peek, prefetchCached, reconcileList, sameJson } from "../web/src/cache.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("console read cache", () => {
  it("shares a read under way and keeps its answer", async () => {
    let calls = 0;
    const load = async () => ++calls;
    const [a, b] = await Promise.all([fetchCached("shared", load), fetchCached("shared", load)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(peek("shared")).toBe(1);
  });

  it("never lets an older answer replace a fresh one", async () => {
    const old = deferred<string>();
    const first = fetchCached("ordered", () => old.promise);
    await fetchCached("ordered", async () => "after install", true);
    old.resolve("before install");
    await first;
    expect(peek("ordered")).toBe("after install");
  });

  it("keeps the last answer when a read fails", async () => {
    await fetchCached("failing", async () => "known");
    await expect(fetchCached("failing", async () => Promise.reject(new Error("offline")), true)).rejects.toThrow(
      "offline",
    );
    expect(peek("failing")).toBe("known");
  });

  it("compares JSON structures accurately with sameJson", () => {
    expect(sameJson({ a: 1, b: [true, { c: "x" }] }, { a: 1, b: [true, { c: "x" }] })).toBe(true);
    expect(sameJson({ a: 1, b: [true, { c: "x" }] }, { a: 1, b: [true, { c: "y" }] })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameJson(null, {})).toBe(false);
  });

  it("reconciles lists while preserving references for unchanged arrays and items", () => {
    const a1 = { id: "a", name: "Alex", meta: { n: 1 } };
    const b1 = { id: "b", name: "Bea", meta: { n: 2 } };
    const prev = [a1, b1];

    // Identical payload returns the exact previous array reference.
    const same = reconcileList(
      prev,
      [
        { id: "a", name: "Alex", meta: { n: 1 } },
        { id: "b", name: "Bea", meta: { n: 2 } },
      ],
      (x) => x.id,
    );
    expect(same).toBe(prev);

    // Updating one item keeps the unchanged item's object identity.
    const next = reconcileList(
      prev,
      [
        { id: "a", name: "Alex", meta: { n: 1 } },
        { id: "b", name: "Bea", meta: { n: 3 } },
      ],
      (x) => x.id,
    );
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(a1);
    expect(next[1]).not.toBe(b1);
    expect(next[1]?.meta.n).toBe(3);

    // Reordering produces a new array while keeping each item's identity.
    const reordered = reconcileList(
      prev,
      [
        { id: "b", name: "Bea", meta: { n: 2 } },
        { id: "a", name: "Alex", meta: { n: 1 } },
      ],
      (x) => x.id,
    );
    expect(reordered).not.toBe(prev);
    expect(reordered[0]).toBe(b1);
    expect(reordered[1]).toBe(a1);
  });

  it("warms cache with prefetchCached and skips redundant reads within staleMs", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const load = async () => ++calls;

      prefetchCached("warm-key", load, 3000);
      // Duplicate call while in-flight is ignored.
      prefetchCached("warm-key", load, 3000);
      await vi.runAllTimersAsync();
      expect(calls).toBe(1);
      expect(peek("warm-key")).toBe(1);

      // Within staleMs, prefetch does nothing.
      vi.advanceTimersByTime(1500);
      prefetchCached("warm-key", load, 3000);
      await vi.runAllTimersAsync();
      expect(calls).toBe(1);

      // Past staleMs, prefetch refreshes.
      vi.advanceTimersByTime(2000);
      prefetchCached("warm-key", load, 3000);
      await vi.runAllTimersAsync();
      expect(calls).toBe(2);
      expect(peek("warm-key")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
