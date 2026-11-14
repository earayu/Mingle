import { useCallback, useEffect, useState } from "react";

/**
 * The last answer to each read, kept for the life of the console. Some reads start every
 * harness's executable or ask a harness for its models, which takes from half a second to
 * seconds; a page that shows what it saw last time and replaces it when the fresh answer
 * arrives opens at once instead of filling in late. Failures are never kept.
 */
const answers = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();

export function peek<T>(key: string): T | undefined {
  return answers.get(key) as T | undefined;
}

export function remember<T>(key: string, value: T): T {
  answers.set(key, value);
  return value;
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
): { value: T | null; reload: () => Promise<void> } {
  const [, setVersion] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names what load reads
  const read = useCallback(
    async (again: boolean, exact: (() => Promise<T>) | undefined) => {
      if (key === null) return;
      try {
        await fetchCached(key, exact ?? load, again);
        setFailed((k) => (k === key ? null : k));
      } catch {
        setFailed(key);
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
  if (key === null) return { value: null, reload };
  const known = peek<T>(key);
  return { value: known !== undefined ? known : failed === key && fallback !== undefined ? fallback : null, reload };
}
