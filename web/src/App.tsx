import {
  memo,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentPage } from "./AgentPage.tsx";
import { type AgentView, ApiError, api, captureToken, clearResponseCache } from "./api.ts";
import { prefetchChat } from "./Chat.tsx";
import { ConnectPage } from "./Connect.tsx";
import { prefetchCached, reconcileList } from "./cache.ts";
import { I18n, type MessageKey, translator, useI18n, useLocaleSettings } from "./i18n.ts";
import iconUrl from "./icon.svg";
import { NewAgent } from "./NewAgent.tsx";
import { onNavigateRequest } from "./online.ts";
import { usePolling } from "./poll.ts";
import { SettingsPage } from "./Settings.tsx";
import { KEYS, keysAria, useShellShortcuts } from "./shortcuts.ts";
import {
  AgentStatusText,
  Avatar,
  Button,
  Eyebrow,
  PlusIcon,
  SettingsIcon,
  Shortcut,
  UpdateIcon,
  Waiting,
} from "./ui.tsx";
import { updates, useUpdates } from "./updates.ts";
import { Welcome } from "./Welcome.tsx";

export type View =
  | { kind: "home" }
  | { kind: "new" }
  | { kind: "settings"; focus?: "network" }
  /** `tab`: a link straight to the private chat (`/a/<slug>/chat`), as the desktop app's notifications open. */
  | { kind: "agent"; slug: string; tab?: "chat" }
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
  const agent = /^\/a\/([^/]+)(\/chat)?/.exec(path);
  if (!agent?.[1]) return { kind: "home" };
  return agent[2]
    ? { kind: "agent", slug: decodeURIComponent(agent[1]), tab: "chat" }
    : { kind: "agent", slug: decodeURIComponent(agent[1]) };
}

function pathFor(view: View): string {
  switch (view.kind) {
    case "agent":
      return `/a/${encodeURIComponent(view.slug)}${view.tab === "chat" ? "/chat" : ""}`;
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

export function App() {
  const { locale, localePreference, setLocale } = useLocaleSettings();
  const i18n = useMemo(
    () => ({ t: translator(locale), locale, localePreference, setLocale }),
    [locale, localePreference, setLocale],
  );
  return (
    <I18n.Provider value={i18n}>
      <Shell />
    </I18n.Provider>
  );
}

export type Navigate = (view: View, options?: { replace?: boolean }) => void;

/** One request per view object: the same view keeps its request, a new navigation makes a new one. */
const requests = new WeakMap<View, { tab: "chat" }>();
function requested(view: View, tab: "chat"): { tab: "chat" } {
  let request = requests.get(view);
  if (!request) {
    request = { tab };
    requests.set(view, request);
  }
  return request;
}

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
      clearResponseCache();
      setToken(next);
      setView(viewFromPath());
      if (next) setProblem(null);
    };
    addEventListener("popstate", onPop);
    addEventListener("hashchange", onHash);
    // The menu bar icon opens an agent's page in the desktop app.
    const offNavigate = onNavigateRequest((path) => {
      history.pushState(null, "", path);
      setView(viewFromPath());
      setMenuOpen(false);
    });
    return () => {
      removeEventListener("popstate", onPop);
      removeEventListener("hashchange", onHash);
      offNavigate();
    };
  }, []);

  const refreshVersion = useRef(0);
  const dragging = useRef(false);
  const setDragging = useCallback((active: boolean) => {
    dragging.current = active;
  }, []);
  const refresh = useCallback(async () => {
    if (dragging.current) return;
    const version = ++refreshVersion.current;
    try {
      const status = await api.status();
      if (version !== refreshVersion.current || dragging.current) return;
      setAgents((prev) => reconcileList(prev, status.agents, (a) => a.id));
      setVersion(status.version);
      setProblem(null);
    } catch (e) {
      if (version !== refreshVersion.current) return;
      setProblem(e instanceof ApiError && e.status === 401 ? "unauthorized" : "offline");
    }
  }, []);

  const reorder = useCallback(
    async (ids: string[]) => {
      // Any poll started before this drop must not overwrite the optimistic order.
      const version = ++refreshVersion.current;
      setAgents((prev) => {
        if (!prev) return prev;
        const byId = new Map(prev.map((a) => [a.id, a]));
        const seen = new Set<string>();
        const next: AgentView[] = [];
        for (const id of ids) {
          const item = byId.get(id);
          if (item && !seen.has(id)) {
            seen.add(id);
            next.push(item);
          }
        }
        for (const item of prev) {
          if (!seen.has(item.id)) next.push(item);
        }
        return next;
      });
      try {
        await api.reorderAgents(ids);
      } catch {
        if (version === refreshVersion.current) void refresh();
      }
    },
    [refresh],
  );

  usePolling(refresh, 2000, Boolean(token));

  useShellShortcuts({
    newAgent: () => navigate({ kind: "new" }),
    settings: () => navigate({ kind: "settings" }),
    agent: (index) => {
      const agent = agents?.[index];
      if (agent) navigate({ kind: "agent", slug: agent.slug });
    },
    escape: () => setMenuOpen(false),
  });

  // A new agent goes into the list right away, so routing to its page does not race the next
  // status poll and fall back to the first agent.
  const created = useCallback(
    async (agent: AgentView) => {
      setAgents((list) => (list && !list.some((a) => a.id === agent.id) ? [...list, agent] : list));
      await refresh();
    },
    [refresh],
  );

  const localHarnesses = useMemo(
    () => new Set((agents ?? []).filter((a) => !a.remote).map((a) => a.harness)),
    [agents],
  );

  if (problem === "unauthorized") return <Unauthorized />;

  const slug = view.kind === "agent" || view.kind === "connect" ? view.slug : undefined;
  // Each navigation that names a tab is a new request, so opening the same link again switches back to it.
  const requestedTab = view.kind === "agent" && view.tab ? requested(view, view.tab) : undefined;
  const current = slug ? agents?.find((a) => a.slug === slug) : undefined;

  let page: React.ReactNode =
    agents === null && problem === null ? (
      <div className="px-6 py-6 md:px-8">
        <Waiting>{t("app.loading")}</Waiting>
      </div>
    ) : null;
  if (agents !== null) {
    if (view.kind === "settings")
      page = (
        <SettingsPage version={version} usedHarnesses={localHarnesses} {...(view.focus ? { focus: view.focus } : {})} />
      );
    else if (view.kind === "new")
      page = (
        <NewAgent
          first={agents.length === 0}
          only={agents.length === 1 && !agents[0]?.remote ? agents[0] : undefined}
          taken={agents.map((a) => a.name)}
          onNavigate={navigate}
          onCreated={created}
        />
      );
    else if (view.kind === "connect" && current)
      page = <ConnectPage agent={current} platform={view.platform} onNavigate={navigate} onChanged={refresh} />;
    else if (current)
      page = (
        <AgentPage
          key={current.id}
          agent={current}
          requestedTab={requestedTab}
          onNavigate={navigate}
          onChanged={refresh}
        />
      );
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
          <Sidebar
            agents={agents ?? []}
            view={view}
            currentId={current?.id}
            onNavigate={navigate}
            onReorder={reorder}
            onDraggingChange={setDragging}
          />
        </aside>
      )}

      {menuOpen && !bare ? (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="flex w-[260px] max-w-[85%] bg-wing shadow-card">
            <Sidebar
              agents={agents ?? []}
              view={view}
              currentId={current?.id}
              onNavigate={navigate}
              onReorder={reorder}
              onDraggingChange={setDragging}
            />
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

const SIDEBAR_ROW =
  "flex w-full items-center gap-2.5 rounded-control px-2.5 text-left transition-colors duration-[120ms] hover:bg-black/5 dark:hover:bg-white/5 aria-[current=page]:bg-sel";

function prefetchAgent(agent: AgentView): void {
  prefetchCached(`conversations:${agent.id}`, () => api.conversations(agent.id));
  prefetchCached(`handoffs:${agent.id}`, () => api.handoffs(agent.id));
  prefetchCached(`work:${agent.id}`, () => api.work(agent.id));
  if (agent.chat?.unread) prefetchChat(agent.id);
}

const SidebarAgentRow = memo(function SidebarAgentRow({
  agent: a,
  index: i,
  current: on,
  onNavigate,
  onRowPointerDown,
  suppressClickRef,
}: {
  agent: AgentView;
  index: number;
  current: boolean;
  onNavigate: Navigate;
  onRowPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, agentId: string) => void;
  suppressClickRef: RefObject<boolean>;
}) {
  const { t } = useI18n();
  // One name per chat app, even with several bots in it.
  const apps = [...new Set(a.connections.map((c) => c.platform))]
    .map((p) => t(`platform.${p}` as MessageKey))
    .join(t("list.separator"));
  const keys = KEYS.agent(i);
  const more = [a.doing ? t("agent.doing", { count: String(a.doing) }) : "", apps]
    .filter(Boolean)
    .join(t("list.separator"));
  const warm = on ? undefined : () => prefetchAgent(a);
  return (
    <Shortcut label={a.name} keys={keys} side="right">
      <button
        type="button"
        title={keys ? undefined : a.name}
        aria-keyshortcuts={keys ? keysAria(keys) : undefined}
        onClick={() => {
          if (suppressClickRef.current) return;
          onNavigate({ kind: "agent", slug: a.slug });
        }}
        onPointerDown={(e) => onRowPointerDown(e, a.id)}
        onPointerEnter={warm}
        onFocus={warm}
        aria-current={on ? "page" : undefined}
        className={`${SIDEBAR_ROW} min-h-[46px] py-1.5`}
      >
        <Avatar name={a.name} src={a.avatar} size={28} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{a.name}</span>
          <span className="text-caption text-ink2">
            <AgentStatusText status={a.status} where={a.remote} more={more} />
          </span>
        </span>
        {a.chat?.unread ? (
          <span className="size-2 shrink-0 rounded-full bg-accent" title={t("privateChat.unread")}>
            <span className="sr-only">{t("privateChat.unread")}</span>
          </span>
        ) : null}
      </button>
    </Shortcut>
  );
});

const Sidebar = memo(function Sidebar({
  agents,
  view,
  currentId,
  onNavigate,
  onReorder,
  onDraggingChange,
}: {
  agents: AgentView[];
  view: View;
  currentId: string | undefined;
  onNavigate: Navigate;
  onReorder: (ids: string[]) => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const { t } = useI18n();
  const update = useUpdates();
  // Only what needs the user: an update that is ready, or one they install themselves.
  // An update downloading in the background shows nothing until it is ready.
  const offer = update?.available && (update.ready || !update.automaticDownloads) ? update : null;
  const warmBrains = () => prefetchCached("brains", () => api.brains(), 10_000);

  const listRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const activeCleanupRef = useRef<(() => void) | null>(null);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  useEffect(() => () => activeCleanupRef.current?.(), []);

  const onRowPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, agentId: string) => {
      if (event.button !== 0 || agentsRef.current.length < 2 || activeCleanupRef.current) return;
      const listEl = listRef.current;
      if (!listEl) return;

      const startX = event.clientX;
      const startY = event.clientY;
      const isTouch = event.pointerType === "touch";
      const buttonEl = event.currentTarget;

      let started = false;
      let settled = false;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let ghost: HTMLElement | null = null;
      let rows: HTMLElement[] = [];
      let rowIds: string[] = [];
      let rects: DOMRect[] = [];
      let fromIdx = -1;
      let targetIdx = -1;
      let slotH = 0;
      let offsetY = 0;
      let minTop = 0;
      let maxTop = 0;

      const resetDom = () => {
        ghost?.remove();
        ghost = null;
        for (const row of rows) {
          row.classList.remove("agent-drag-sliding");
          row.style.transform = "";
          row.style.opacity = "";
          row.style.pointerEvents = "";
        }
        document.body.style.cursor = "";
      };

      const removeListeners = () => {
        clearTimeout(holdTimer);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
      };

      const abortImmediately = () => {
        clearTimeout(settleTimer);
        removeListeners();
        resetDom();
        if (started) onDraggingChange(false);
        activeCleanupRef.current = null;
      };

      const update = (clientY: number) => {
        if (!ghost) return;
        const fromRect = rects[fromIdx] as DOMRect;
        const top = Math.max(minTop, Math.min(clientY - offsetY, maxTop));
        ghost.style.top = `${top}px`;
        const centerY = top + fromRect.height / 2;

        let nextIdx = 0;
        for (let i = 0; i < rects.length; i++) {
          if (i === fromIdx) continue;
          const r = rects[i] as DOMRect;
          if (r.top + r.height / 2 < centerY) nextIdx++;
        }

        if (nextIdx !== targetIdx) {
          targetIdx = nextIdx;
          rows.forEach((row, i) => {
            if (i === fromIdx) return;
            if (fromIdx < targetIdx && i > fromIdx && i <= targetIdx) {
              row.style.transform = `translateY(${-slotH}px)`;
            } else if (fromIdx > targetIdx && i >= targetIdx && i < fromIdx) {
              row.style.transform = `translateY(${slotH}px)`;
            } else {
              row.style.transform = "";
            }
          });
        }
      };

      const startDrag = (clientY: number) => {
        rows = [...listEl.querySelectorAll<HTMLElement>("[data-agent-row]")];
        rowIds = rows.map((row) => row.dataset.agentRow ?? "");
        fromIdx = rowIds.indexOf(agentId);
        if (fromIdx < 0 || rows.length < 2) return;

        started = true;
        targetIdx = fromIdx;
        suppressClickRef.current = true;
        onDraggingChange(true);

        rects = rows.map((row) => row.getBoundingClientRect());
        const fromRect = rects[fromIdx] as DOMRect;
        const listRect = listEl.getBoundingClientRect();
        slotH = fromRect.height + 2;
        offsetY = clientY - fromRect.top;
        minTop = listRect.top - 4;
        maxTop = listRect.bottom - fromRect.height + 4;

        const clone = buttonEl.cloneNode(true) as HTMLElement;
        clone.removeAttribute("id");
        clone.removeAttribute("aria-describedby");
        clone.classList.add("agent-drag-ghost");
        clone.style.width = `${fromRect.width}px`;
        clone.style.height = `${fromRect.height}px`;
        clone.style.left = `${fromRect.left}px`;
        clone.style.top = `${fromRect.top}px`;
        document.body.appendChild(clone);
        ghost = clone;

        const sourceRow = rows[fromIdx] as HTMLElement;
        sourceRow.style.opacity = "0";
        sourceRow.style.pointerEvents = "none";
        rows.forEach((row, i) => {
          if (i !== fromIdx) row.classList.add("agent-drag-sliding");
        });
        document.body.style.cursor = "grabbing";
        update(clientY);
      };

      const finish = (commit: boolean, pointerStillDown = false) => {
        if (settled) return;
        settled = true;
        removeListeners();

        if (!started) {
          activeCleanupRef.current = null;
          return;
        }

        const destIdx = commit ? targetIdx : fromIdx;
        if (!commit) {
          rows.forEach((row, i) => {
            if (i !== fromIdx) row.style.transform = "";
          });
        }

        const fromRect = rects[fromIdx] as DOMRect;
        const destRect = rects[destIdx] as DOMRect;
        let destTop = fromRect.top;
        if (destIdx < fromIdx) destTop = destRect.top;
        else if (destIdx > fromIdx) destTop = destRect.bottom - fromRect.height;

        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (ghost) {
          ghost.classList.add("settling");
          ghost.style.top = `${destTop}px`;
        }

        const releaseClickGuard = () => {
          if (pointerStillDown) {
            const release = () => {
              setTimeout(() => {
                suppressClickRef.current = false;
              }, 0);
            };
            window.addEventListener("pointerup", release, { once: true });
            window.addEventListener("pointercancel", release, { once: true });
          } else {
            setTimeout(() => {
              suppressClickRef.current = false;
            }, 0);
          }
        };

        const complete = () => {
          resetDom();
          activeCleanupRef.current = null;
          onDraggingChange(false);
          releaseClickGuard();
          if (commit && destIdx !== fromIdx) {
            const nextIds = [...rowIds];
            const [moved] = nextIds.splice(fromIdx, 1);
            if (moved) {
              nextIds.splice(destIdx, 0, moved);
              onReorder(nextIds);
            }
          }
        };

        if (reduced) complete();
        else settleTimer = setTimeout(complete, 165);
      };

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
          if (isTouch) {
            if (dist >= 8) {
              clearTimeout(holdTimer);
              finish(false);
            }
          } else if (dist >= 5) {
            startDrag(ev.clientY);
          }
        } else {
          update(ev.clientY);
        }
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape" && started) {
          ev.preventDefault();
          finish(false, true);
        }
      };

      suppressClickRef.current = false;
      activeCleanupRef.current = abortImmediately;
      if (isTouch) {
        holdTimer = setTimeout(() => {
          if (!started && !settled) startDrag(startY);
        }, 220);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    [onDraggingChange, onReorder],
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col px-2 pb-3">
      {/* The brand row: in the desktop app it sits right of the traffic lights and moves the window. */}
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 pr-1.5 pl-[max(10px,calc(var(--mygo-titlebar-inset-left,0px)+2px))]">
        <span className="font-semibold">{t("app.title")}</span>
      </div>
      <Eyebrow>{t("sidebar.agents")}</Eyebrow>
      <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain">
        <div ref={listRef} className="flex flex-col gap-0.5">
          {agents.map((a, i) => (
            <div key={a.id} data-agent-row={a.id}>
              <SidebarAgentRow
                agent={a}
                index={i}
                current={currentId === a.id}
                onNavigate={onNavigate}
                onRowPointerDown={onRowPointerDown}
                suppressClickRef={suppressClickRef}
              />
            </div>
          ))}
        </div>
        <Shortcut label={t("agents.new")} keys={KEYS.newAgent} side="right">
          <button
            type="button"
            onClick={() => onNavigate({ kind: "new" })}
            onPointerEnter={warmBrains}
            onFocus={warmBrains}
            aria-keyshortcuts={keysAria(KEYS.newAgent)}
            aria-current={view.kind === "new" ? "page" : undefined}
            className={`${SIDEBAR_ROW} h-8 text-ink2 hover:text-ink`}
          >
            <PlusIcon className="mx-1.5" />
            {t("agents.new")}
          </button>
        </Shortcut>
      </nav>
      <div className="flex-1" />
      <div className="flex flex-col gap-0.5 border-t border-line pt-2">
        {offer ? (
          <button
            type="button"
            title={t(offer.ready ? "update.ready" : "update.available", { version: offer.available ?? "" })}
            onClick={() => (offer.ready ? updates.restart() : updates.check())}
            className="flex h-8 w-full items-center gap-2.5 rounded-control bg-accent-tint px-2.5 text-left font-medium text-accent transition-[filter] duration-[120ms] hover:brightness-95 dark:hover:brightness-125"
          >
            <UpdateIcon className="mx-1.5" />
            <span className="min-w-0 flex-1 truncate">
              {offer.ready ? t("update.restart") : t("update.install", { version: offer.available ?? "" })}
            </span>
          </button>
        ) : null}
        <Shortcut label={t("settings.title")} keys={KEYS.settings} side="right">
          <button
            type="button"
            onClick={() => onNavigate({ kind: "settings" })}
            onPointerEnter={warmBrains}
            onFocus={warmBrains}
            aria-keyshortcuts={keysAria(KEYS.settings)}
            aria-current={view.kind === "settings" ? "page" : undefined}
            className={`${SIDEBAR_ROW} h-8 text-ink2 hover:text-ink aria-[current=page]:text-ink`}
          >
            <SettingsIcon className="mx-1.5" />
            {t("settings.title")}
          </button>
        </Shortcut>
      </div>
    </div>
  );
});

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
