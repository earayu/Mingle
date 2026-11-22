import { useCallback, useEffect, useState } from "react";

/**
 * The last answer to each read, kept for the life of the console. Some reads start every
 * harness's executable or ask a harness for its models, which takes from half a second to
 * seconds; a page that shows what it saw last time and replaces it when the fresh answer
 * arrives opens at once instead of filling in late. Failures are never kept.
 */
const answers = new Map<string, unknown>();
const rememberedAt = new Map<string, number>();
const pending = new Map<string, Promise<unknown>>();

export function peek<T>(key: string): T | undefined {
  return answers.get(key) as T | undefined;
}

export function remember<T>(key: string, value: T): T {
  answers.set(key, value);
  rememberedAt.set(key, Date.now());
  return value;
}

/** Fast structural equality for JSON values returned by the admin API. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sameJson(a[i], b[i])) return false;
    }
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const key of ak) {
    if (!Object.hasOwn(bo, key) || !sameJson(ao[key], bo[key])) return false;
  }
  return true;
}

/**
 * Reconcile a newly fetched list against the previous one by item identity, preserving object
 * references for unchanged items (and the array itself when nothing changed) so memoized rows
 * and pages skip re-rendering during polling.
 */
export function reconcileList<T>(prev: T[] | null, next: T[], keyOf: (item: T) => string): T[] {
  if (prev === next) return prev;
  if (!prev) return next;
  const byKey = new Map(prev.map((item) => [keyOf(item), item]));
  let same = prev.length === next.length;
  const out = next.map((item, i) => {
    const existing = byKey.get(keyOf(item));
    const kept = existing !== undefined && sameJson(existing, item) ? existing : item;
    if (same && kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : out;
}

/** Warm `key` ahead of navigation without duplicating an in-flight or freshly cached read. */
export function prefetchCached<T>(key: string, load: () => Promise<T>, staleMs = 3000): void {
  if (pending.has(key)) return;
  const at = rememberedAt.get(key);
  if (at !== undefined && Date.now() - at < staleMs) return;
  void fetchCached(key, load).catch(() => {});
}

/**
 * Read `key` and keep the answer. Callers arriving while a read is under way share it, unless
 * `fresh`: after a change (an install, a sign-in) a read that started before it may be stale.
 * Only the latest read writes the cache, so a late older answer never replaces a newer one.
 */
export function fetchCached<T>(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
  const shared = pending.get(key) as Promise<T> | undefined;
  if (shared && !fresh) return shared;
  const running: Promise<T> = load().then((value) => {
    if (pending.get(key) === running) remember(key, value);
    return value;
  });
  pending.set(key, running);
  const settle = () => {
    if (pending.get(key) === running) pending.delete(key);
  };
  running.then(settle, settle);
  return running;
}

/**
 * The value under `key`: the last known one at once, then what `load` reads. `fallback` stands
 * in when the read fails and nothing is known yet. `fresh`, when given, is a slower, exact read
 * that follows a quick `load` answered from the server's own cache; `reload` uses it too.
 * A null key reads nothing and gives null.
 */
export function useCached<T>(
  key: string | null,
  load: () => Promise<T>,
  fallback?: T,
  fresh?: () => Promise<T>,
): { value: T | null; error: unknown; reload: () => Promise<void> } {
  const [, setVersion] = useState(0);
  /** The key whose latest read failed, and why. A read of another key never shows it. */
  const [failed, setFailed] = useState<{ key: string; error: unknown } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names what load reads
  const read = useCallback(
    async (again: boolean, exact: (() => Promise<T>) | undefined) => {
      if (key === null) return;
      const before = peek<T>(key);
      try {
        const after = await fetchCached(key, exact ?? load, again);
        setFailed((f) => (f?.key === key ? null : f));
        // Conditional GET (304) returns the exact previous object reference: skip the re-render.
        if (after === before) return;
      } catch (error) {
        setFailed({ key, error });
      }
      setVersion((v) => v + 1);
    },
    [key],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names what fresh reads
  useEffect(() => {
    void read(false, undefined).then(() => (fresh ? read(true, fresh) : undefined));
  }, [read]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names what fresh reads
  const reload = useCallback(() => read(true, fresh), [read]);
  if (key === null) return { value: null, error: null, reload };
  const known = peek<T>(key);
  const here = failed?.key === key;
  return {
    value: known !== undefined ? known : here && fallback !== undefined ? fallback : null,
    error: here ? failed.error : null,
    reload,
  };
}
