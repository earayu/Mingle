import { useEffect, useState } from "react";

/**
 * What keeps the agents online in the desktop app, from the `Online` service it binds
 * (desktop/online.go): opening at login, staying awake on power, notifications.
 * In a browser there is no `window.mygo`, and none of these.
 */
export interface OnlineState {
  openAtLogin: boolean;
  keepAwake: boolean;
  notifications: boolean;
  cardDismissed: boolean;
  platform: "darwin" | "windows" | "linux" | string;
}

interface Mygo {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  on<T = unknown>(event: string, listener: (payload: T) => void): () => void;
}

function mygo(): Mygo | undefined {
  return (window as { mygo?: Mygo }).mygo;
}

export const online = {
  setOpenAtLogin: (on: boolean) => mygo()?.call("Online.SetOpenAtLogin", on),
  setKeepAwake: (on: boolean) => mygo()?.call("Online.SetKeepAwake", on),
  setNotifications: (on: boolean) => mygo()?.call("Online.SetNotifications", on),
  dismissCard: () => mygo()?.call("Online.DismissCard"),
};

/** The settings, kept current; null outside the desktop app or before it answers. */
export function useOnline(): OnlineState | null {
  const [state, setState] = useState<OnlineState | null>(null);
  useEffect(() => {
    const rt = mygo();
    if (!rt) return;
    let live = true;
    const off = rt.on<OnlineState>("mingle:online", setState);
    rt.call<OnlineState>("Online.State")
      .then((s) => {
        if (live) setState(s);
      })
      // An app older than this console binds no Online service.
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** The menu bar icon asks to show a page, such as an agent's: `listener` gets its path. */
export function onNavigateRequest(listener: (path: string) => void): () => void {
  return mygo()?.on<string>("mingle:navigate", listener) ?? (() => {});
}
