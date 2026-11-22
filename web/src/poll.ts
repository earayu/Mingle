import { useEffect } from "react";

/**
 * Run `refresh` now and every `ms` while the console is in view. A hidden window (minimized,
 * another tab, the desktop app closed to the menu bar) skips the ticks and refreshes as soon as
 * it is shown again, so nothing polls the local API for a page nobody sees.
 */
export function usePolling(refresh: () => unknown, ms: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let inflight = false;
    const run = () => {
      if (inflight) return;
      inflight = true;
      void Promise.resolve(refresh()).finally(() => {
        inflight = false;
      });
    };
    const tick = () => {
      if (!document.hidden) run();
    };
    const onVisible = () => {
      if (!document.hidden) run();
    };
    run();
    const timer = setInterval(tick, ms);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, ms, enabled]);
}
