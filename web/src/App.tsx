import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentPage } from "./AgentPage.tsx";
import { type AgentView, ApiError, api, captureToken } from "./api.ts";
import { ConnectPage } from "./Connect.tsx";
import { detectLocale, I18n, type Locale, translator, useI18n } from "./i18n.ts";
import iconUrl from "./icon.svg";
import { NewAgent } from "./NewAgent.tsx";
import { applyTheme, SettingsPage, savedTheme } from "./Settings.tsx";
import { Avatar, Button, Eyebrow, PlusIcon, SettingsIcon, StatusDot } from "./ui.tsx";
import { Welcome } from "./Welcome.tsx";

export type View =
  | { kind: "home" }
  | { kind: "new" }
  | { kind: "settings" }
  | { kind: "agent"; slug: string }
  | { kind: "connect"; slug: string; platform?: string };

function viewFromPath(): View {
  const path = location.pathname;
  if (path === "/new") return { kind: "new" };
  if (path === "/settings") return { kind: "settings" };
  const connect = /^\/a\/([^/]+)\/connect(?:\/([^/]+))?/.exec(path);
  if (connect?.[1]) {
    const slug = decodeURIComponent(connect[1]);
    return connect[2] ? { kind: "connect", slug, platform: connect[2] } : { kind: "connect", slug };
  }
  const agent = /^\/a\/([^/]+)/.exec(path);
  return agent?.[1] ? { kind: "agent", slug: decodeURIComponent(agent[1]) } : { kind: "home" };
}

function pathFor(view: View): string {
  switch (view.kind) {
    case "agent":
      return `/a/${encodeURIComponent(view.slug)}`;
    case "connect":
      return `/a/${encodeURIComponent(view.slug)}/connect${view.platform ? `/${view.platform}` : ""}`;
    case "new":
      return "/new";
    case "settings":
      return "/settings";
    default:
      return "/";
  }
}

// The desktop app's window injects `window.mygo`. On macOS the window is translucent and the
// sidebar shows its material; Windows and Linux windows are opaque and keep the usual colours.
if ("mygo" in window && /Mac/.test(navigator.userAgent)) document.documentElement.dataset.shell = "desktop";
applyTheme(savedTheme());

export function App() {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const i18n = useMemo(
    () => ({
      t: translator(locale),
      locale,
      setLocale: (next: Locale) => {
        localStorage.setItem("mingle.locale", next);
        document.documentElement.lang = next;
        setLocaleState(next);
      },
    }),
    [locale],
  );
  return (
    <I18n.Provider value={i18n}>
      <Shell />
    </I18n.Provider>
  );
}

export type Navigate = (view: View, options?: { replace?: boolean }) => void;

function Shell() {
  const { t } = useI18n();
  const [token, setToken] = useState(captureToken);
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [version, setVersion] = useState("");
  const [problem, setProblem] = useState<"offline" | "unauthorized" | null>(token ? null : "unauthorized");
  const [view, setView] = useState<View>(viewFromPath);
  const [menuOpen, setMenuOpen] = useState(() => new URLSearchParams(location.search).get("menu") === "1");

  const navigate: Navigate = useCallback((next, options) => {
    if (options?.replace) history.replaceState(null, "", pathFor(next));
    else history.pushState(null, "", pathFor(next));
    setView(next);
    setMenuOpen(false);
  }, []);

  useEffect(() => {
    const onPop = () => setView(viewFromPath());
    // A fresh `mingle open` link pasted into an existing tab only changes the fragment.
    const onHash = () => {
      const next = captureToken();
      setToken(next);
      setView(viewFromPath());
      if (next) setProblem(null);
    };
    addEventListener("popstate", onPop);
    addEventListener("hashchange", onHash);
    return () => {
      removeEventListener("popstate", onPop);
      removeEventListener("hashchange", onHash);
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const status = await api.status();
      setAgents(status.agents);
      setVersion(status.version);
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof ApiError && e.status === 401 ? "unauthorized" : "offline");
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [token, refresh]);

  if (problem === "unauthorized") return <Unauthorized />;

  const slug = view.kind === "agent" || view.kind === "connect" ? view.slug : undefined;
  const current = slug ? agents?.find((a) => a.slug === slug) : undefined;

  let page: React.ReactNode = null;
  if (agents !== null) {
    if (view.kind === "settings") page = <SettingsPage version={version} />;
    else if (view.kind === "new")
      page = <NewAgent first={agents.length === 0} onNavigate={navigate} onCreated={refresh} />;
    else if (view.kind === "connect" && current)
      page = <ConnectPage agent={current} platform={view.platform} onNavigate={navigate} onChanged={refresh} />;
    else if (current) page = <AgentPage agent={current} onNavigate={navigate} onChanged={refresh} />;
    else if (agents.length === 0) page = <Welcome onStart={() => navigate({ kind: "new" })} />;
    else {
      // Nothing chosen, or a link to an agent that is gone: show the first one.
      const first = agents[0] as AgentView;
      queueMicrotask(() => navigate({ kind: "agent", slug: first.slug }, { replace: true }));
    }
  }

  // The first run is one focused flow: no sidebar until the first agent exists.
  const bare = agents !== null && agents.length === 0 && view.kind !== "settings";

  return (
    <div className="flex h-full">
      {bare ? null : (
        <aside className="sidebar hidden w-[220px] shrink-0 border-r border-line bg-wing md:flex">
          <Sidebar agents={agents ?? []} view={view} currentId={current?.id} onNavigate={navigate} />
        </aside>
      )}

      {menuOpen && !bare ? (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="flex w-[260px] max-w-[85%] bg-wing shadow-card">
            <Sidebar agents={agents ?? []} view={view} currentId={current?.id} onNavigate={navigate} />
          </div>
          <button
            type="button"
            aria-label={t("nav.close")}
            className="flex-1 bg-black/25"
            onClick={() => setMenuOpen(false)}
          />
        </div>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        {bare ? null : (
          <div className="drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 md:hidden">
            <Button variant="ghost" small aria-label={t("nav.menu")} onClick={() => setMenuOpen(true)}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Button>
            <span className="truncate font-semibold">{current?.name ?? t("app.title")}</span>
          </div>
        )}
        {problem === "offline" ? (
          <div role="alert" className="shrink-0 border-b border-amber-line bg-amber-tint px-6 py-2 text-small">
            {t("error.offline")}
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">{page}</div>
      </main>
    </div>
  );
}

function Sidebar({
  agents,
  view,
  currentId,
  onNavigate,
}: {
  agents: AgentView[];
  view: View;
  currentId: string | undefined;
  onNavigate: Navigate;
}) {
  const { t } = useI18n();
  const row =
    "flex w-full items-center gap-2.5 rounded-control px-2.5 text-left transition-colors duration-[120ms] hover:bg-black/5 dark:hover:bg-white/5 aria-[current=page]:bg-sel";
  return (
    <div className="flex min-w-0 flex-1 flex-col px-2 pb-3">
      {/* The brand row: in the desktop app it sits right of the traffic lights and moves the window. */}
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 pr-1.5 pl-[max(10px,calc(var(--mygo-titlebar-inset-left,0px)+2px))]">
        <img src={iconUrl} alt="" className="size-5 rounded-[5px] dark:ring-1 dark:ring-white/20" />
        <span className="font-semibold">{t("app.title")}</span>
      </div>
      <Eyebrow>{t("sidebar.agents")}</Eyebrow>
      <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {agents.map((a) => {
          const on = currentId === a.id;
          const apps = a.connections.map((c) => t(`platform.${c.platform}` as never)).join("、");
          return (
            <button
              key={a.id}
              type="button"
              title={a.name}
              onClick={() => onNavigate({ kind: "agent", slug: a.slug })}
              aria-current={on ? "page" : undefined}
              className={`${row} min-h-[46px] py-1.5`}
            >
              <Avatar name={a.name} size={28} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{a.name}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-caption text-ink2">
                  <StatusDot state={a.status} />
                  <span className="truncate">
                    {t(`status.${a.status}`)}
                    {apps ? ` · ${apps}` : ""}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onNavigate({ kind: "new" })}
          aria-current={view.kind === "new" ? "page" : undefined}
          className={`${row} h-8 text-ink2 hover:text-ink`}
        >
          <PlusIcon className="mx-1.5" />
          {t("agents.new")}
        </button>
      </nav>
      <div className="flex-1" />
      <div className="flex flex-col gap-0.5 border-t border-line pt-2">
        <button
          type="button"
          onClick={() => onNavigate({ kind: "settings" })}
          aria-current={view.kind === "settings" ? "page" : undefined}
          className={`${row} h-8 text-ink2 hover:text-ink aria-[current=page]:text-ink`}
        >
          <SettingsIcon className="mx-1.5" />
          {t("settings.title")}
        </button>
      </div>
    </div>
  );
}

function Unauthorized() {
  const { t } = useI18n();
  return (
    <main className="drag flex h-full items-start justify-center bg-bg px-6">
      <div className="flex max-w-[440px] flex-col gap-3 pt-32">
        <img src={iconUrl} alt="" className="mb-2 size-12 rounded-[12px]" />
        <h1 className="text-title2 font-semibold">{t("auth.title")}</h1>
        <p className="text-ink2">{t("auth.body")}</p>
        <code className="self-start rounded-control bg-bg3 px-3 py-1.5 font-mono text-small">mingle open</code>
      </div>
    </main>
  );
}
