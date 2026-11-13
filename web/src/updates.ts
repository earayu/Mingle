import { useEffect, useState } from "react";

/**
 * The desktop app's updates, from the `Updates` service it binds (desktop/updates.go).
 * In a browser there is no `window.mygo`, and so no updates to show.
 */
export interface UpdateState {
  supported: boolean;
  current: string;
  available?: string;
  ready: boolean;
  automaticDownloads: boolean;
}

interface Mygo {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  on<T = unknown>(event: string, listener: (payload: T) => void): () => void;
}

function mygo(): Mygo | undefined {
  return (window as { mygo?: Mygo }).mygo;
}

export const inDesktopApp = (): boolean => mygo() !== undefined;

export const updates = {
  check: () => mygo()?.call("Updates.Check"),
  restart: () => mygo()?.call("Updates.Restart"),
  setAutomaticDownloads: (on: boolean) => mygo()?.call("Updates.SetAutomaticDownloads", on),
};

/** The state of updates, kept current; null outside the desktop app or before it answers. */
export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const rt = mygo();
    if (!rt) return;
    let live = true;
    const off = rt.on<UpdateState>("mingle:updates", setState);
    rt.call<UpdateState>("Updates.State")
      .then((s) => {
        if (live) setState(s);
      })
      // An app older than this console binds no Updates service.
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}
