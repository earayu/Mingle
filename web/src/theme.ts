export type Theme = "system" | "light" | "dark";

export function savedTheme(): Theme {
  const saved = localStorage.getItem("mingle.theme");
  return saved === "light" || saved === "dark" ? saved : "system";
}

// IPC handlers run concurrently; keep rapid selections in the same order as the UI.
let nativeTheme = Promise.resolve();

export function applyTheme(theme: Theme): Promise<void> {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  localStorage.setItem("mingle.theme", theme);
  delete root.dataset.nativeTheme;

  const bridge = (window as { mygo?: { call(method: string, ...args: unknown[]): Promise<unknown> } }).mygo;
  if (!bridge) return Promise.resolve();

  nativeTheme = nativeTheme.then(async () => {
    try {
      await bridge.call("Appearance.SetTheme", theme);
      root.dataset.nativeTheme = theme;
    } catch {
      // An older desktop shell may serve a newer console without this binding.
      delete root.dataset.nativeTheme;
    }
  });
  return nativeTheme;
}
