import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentPage } from "./AgentPage.tsx";
import { type AgentView, ApiError, api, captureToken } from "./api.ts";
import { CreateAgent } from "./CreateAgent.tsx";
import { detectLocale, I18n, type Locale, translator, useI18n } from "./i18n.ts";
import { AgentStatusLine, Avatar, Button, Code, Muted, Select } from "./ui.tsx";

type View = { kind: "agent"; slug: string } | { kind: "new" } | { kind: "home" };
type Theme = "system" | "light" | "dark";

function viewFromPath(): View {
  const path = location.pathname;
  if (path === "/new") return { kind: "new" };
  const match = /^\/a\/([^/]+)/.exec(path);
  return match?.[1] ? { kind: "agent", slug: decodeURIComponent(match[1]) } : { kind: "home" };
}

function pathFor(view: View): string {
  return view.kind === "agent" ? `/a/${encodeURIComponent(view.slug)}` : view.kind === "new" ? "/new" : "/";
}

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

function Shell() {
  const { t } = useI18n();
  const [token, setToken] = useState(captureToken);
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [problem, setProblem] = useState<"offline" | "unauthorized" | null>(token ? null : "unauthorized");
  const [view, setView] = useState<View>(viewFromPath);

  const navigate = useCallback((next: View) => {
    history.pushState(null, "", pathFor(next));
    setView(next);
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

  const current = view.kind === "agent" ? agents?.find((a) => a.slug === view.slug) : undefined;
  const showCreate = view.kind === "new" || (agents?.length === 0 && view.kind !== "home");

  return (
    <div className="flex h-full">
      <aside className="panel hidden w-[220px] shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="flex h-14 items-center px-4 text-heading font-semibold">{t("app.title")}</div>
        <nav className="flex flex-1 flex-col overflow-y-auto">
          {(agents ?? []).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => navigate({ kind: "agent", slug: a.slug })}
              aria-current={current?.id === a.id ? "page" : undefined}
              className="flex h-11 items-center gap-3 px-4 text-left hover:bg-bg aria-[current=page]:bg-bg"
            >
              <Avatar name={a.name} size={24} />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <AgentStatusLine status={a.status} />
            </button>
          ))}
          {agents?.length === 0 ? <p className="px-4 py-3 text-small text-text-tertiary">{t("agents.empty")}</p> : null}
        </nav>
        <div className="flex flex-col gap-2 border-t border-border p-4">
          <Button onClick={() => navigate({ kind: "new" })}>{t("agents.new")}</Button>
          <Settings />
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-0 max-w-[640px] px-10 py-10">
          {problem === "offline" ? <p className="mb-6 text-small text-error">{t("error.offline")}</p> : null}
          {agents === null ? null : showCreate ? (
            <CreateAgent
              onCreated={(agent) => {
                refresh();
                navigate({ kind: "agent", slug: agent.slug });
              }}
              {...(agents.length > 0 ? { onCancel: () => history.back() } : {})}
            />
          ) : current ? (
            <AgentPage
              agent={current}
              onChanged={refresh}
              onDeleted={() => {
                refresh();
                navigate({ kind: "home" });
              }}
            />
          ) : agents.length === 0 ? (
            <Empty onCreate={() => navigate({ kind: "new" })} />
          ) : (
            <Pick agents={agents} onPick={(slug) => navigate({ kind: "agent", slug })} />
          )}
        </div>
      </main>
    </div>
  );
}

function Empty({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-start gap-4 pt-20">
      <h1 className="text-title font-semibold">{t("empty.title")}</h1>
      <Muted>{t("empty.body")}</Muted>
      <Button variant="primary" onClick={onCreate}>
        {t("empty.action")}
      </Button>
    </div>
  );
}

/** With agents but none selected (or on a narrow window), list them in the content area. */
function Pick({ agents, onPick }: { agents: AgentView[]; onPick: (slug: string) => void }) {
  return (
    <ul className="flex flex-col">
      {agents.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => onPick(a.slug)}
            className="flex h-14 w-full items-center gap-3 border-b border-border text-left hover:bg-surface"
          >
            <Avatar name={a.name} />
            <span className="flex-1 truncate">{a.name}</span>
            <AgentStatusLine status={a.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Settings() {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("mingle.theme") as Theme) || "system");

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem("mingle.theme", theme);
  }, [theme]);

  return (
    <div className="flex flex-col gap-2">
      <Select aria-label={t("settings.language")} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
        <option value="en">English</option>
        <option value="zh-CN">简体中文</option>
      </Select>
      <Select aria-label={t("settings.appearance")} value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
        <option value="system">{t("settings.system")}</option>
        <option value="light">{t("settings.light")}</option>
        <option value="dark">{t("settings.dark")}</option>
      </Select>
    </div>
  );
}

function Unauthorized() {
  const { t } = useI18n();
  return (
    <main className="flex h-full items-start justify-center">
      <div className="flex max-w-[480px] flex-col gap-3 pt-32">
        <h1 className="text-title font-semibold">{t("auth.title")}</h1>
        <Muted>{t("auth.body")}</Muted>
        <div className="rounded-sm bg-surface px-3 py-2">
          <Code>mingle open</Code>
        </div>
      </div>
    </main>
  );
}
