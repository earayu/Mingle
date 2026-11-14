import { describe, expect, it } from "vitest";
import { fetchCached, peek } from "../web/src/cache.ts";

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
});
