import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentEnv } from "./AgentEnv.tsx";
import type { Navigate } from "./App.tsx";
import {
  type Activity,
  type AgentView,
  api,
  type ConnectionView,
  type Harness,
  type Reminder,
  type Task,
} from "./api.ts";
import { fetchCached, peek, useCached } from "./cache.ts";
import { errorText, type MessageKey, statusDetailText, useI18n } from "./i18n.ts";
import { ModelPicker } from "./NewAgent.tsx";
import { online, useOnline } from "./online.ts";
import { PlatformIcon } from "./platforms.tsx";
import { usePolling } from "./poll.ts";
import { OnlineRows } from "./Settings.tsx";
import {
  AgentStatusText,
  ApiKeyHint,
  Avatar,
  Button,
  Group,
  GroupRow,
  HarnessIcon,
  Input,
  MoreMenu,
  PageHeader,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Problem,
  relativeTime,
  Section,
  Segmented,
  Select,
  StatusDot,
  Step,
  Steps,
  shortDateTime,
  Textarea,
  Waiting,
} from "./ui.tsx";

type WorkData = { tasks: Task[]; reminders: Reminder[] };

export function AgentPage({
  agent,
  onNavigate,
  onChanged,
}: {
  agent: AgentView;
  onNavigate: Navigate;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  // The last activity and work seen for an agent show at once when its page opens again.
  const [activity, setActivity] = useState<Activity[] | null>(() => peek<Activity[]>(`activity:${agent.id}`) ?? null);
  const [work, setWork] = useState<WorkData | null>(() => peek<WorkData>(`work:${agent.id}`) ?? null);
  const [activityError, setActivityError] = useState(false);
  const [workError, setWorkError] = useState(false);
  const activityPending = useRef(false);
  const workPending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<"activity" | "settings">("activity");
  const connectionsRef = useRef<HTMLElement>(null);
  const [manageRequest, setManageRequest] = useState(0);

  // "Manage" in the side panel: land on the settings connections, even when already there.
  useLayoutEffect(() => {
    if (manageRequest === 0) return;
    connectionsRef.current?.scrollIntoView({ block: "start" });
    connectionsRef.current?.focus({ preventScroll: true });
  }, [manageRequest]);

  // Each resource guards itself: a slow call is not superseded by the next poll, and one
  // request in flight does not hold back the other resource. `fresh` lets a remount read
  // again even if a previous mount's read is still resolving; only the latest read caches.
  const refreshActivity = useCallback(async () => {
    if (activityPending.current) return;
    activityPending.current = true;
    try {
      setActivity(await fetchCached(`activity:${agent.id}`, () => api.activity(agent.id), true));
      setActivityError(false);
    } catch {
      setActivityError(true);
    } finally {
      activityPending.current = false;
    }
  }, [agent.id]);
  const refreshWork = useCallback(async () => {
    if (workPending.current) return;
    workPending.current = true;
    try {
      setWork(await fetchCached(`work:${agent.id}`, () => api.work(agent.id), true));
      setWorkError(false);
    } catch {
      setWorkError(true);
    } finally {
      workPending.current = false;
    }
  }, [agent.id]);
  const refresh = useCallback(() => {
    void refreshActivity();
    void refreshWork();
  }, [refreshActivity, refreshWork]);

  // Switching to another agent starts from what was last seen for it.
  useEffect(() => {
    setActivity(peek<Activity[]>(`activity:${agent.id}`) ?? null);
    setWork(peek<WorkData>(`work:${agent.id}`) ?? null);
    setActivityError(false);
    setWorkError(false);
    setConfirmDelete(false);
    setPauseFailure(null);
    setNotice(null);
    setTab("activity");
    setManageRequest(0);
  }, [agent.id]);
  usePolling(refresh, 2500);

  // A notice answers one click; it must not outlive what it describes.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a notice belongs to the tab it was shown on
  useEffect(() => setNotice(null), [tab]);

  const busy = agent.status === "thinking" || agent.status === "working";
  const paused = agent.status === "paused";
  const [switching, setSwitching] = useState(false);
  const [pauseFailure, setPauseFailure] = useState<string | null>(null);
  // The settings row answers in place, where the click was: it already reads "paused" or not, and
  // a failure shows under it. The top notice is only for the paused card, which sits up there.
  const setPaused = async (pause: boolean, from: "card" | "row" = "card") => {
    setSwitching(true);
    setPauseFailure(null);
    try {
      await (pause ? api.pause(agent.id) : api.resume(agent.id));
      if (from === "card") setNotice(t(pause ? "agent.pausedNotice" : "agent.resumed", { name: agent.name }));
    } catch (error) {
      if (from === "row") setPauseFailure(errorText(t, error));
      else setNotice(errorText(t, error));
    } finally {
      setSwitching(false);
    }
    await onChanged();
    refresh();
  };
  const retry = async (ids: string[]) => {
    try {
      const { retried, offline } = await api.retry(agent.id, ids);
      const bots = agent.connections
        .filter((c) => offline.includes(c.id))
        .map((c) => c.bot ?? t(`platform.${c.platform}` as MessageKey));
      setNotice(
        retried.length > 0
          ? t("agent.retrying", { count: String(retried.length), name: agent.name })
          : bots.length > 0
            ? t("agent.retryOffline", { bot: bots.join(", ") })
            : t("agent.retryNothing"),
      );
    } catch (error) {
      setNotice(errorText(t, error));
    }
    refresh();
  };
  const ignore = async (ids: string[]) => {
    try {
      const { ignored } = await api.ignore(agent.id, ids);
      const changed = new Set(ignored);
      setActivity((items) => items?.map((m) => (changed.has(m.id) ? { ...m, state: "ignored" } : m)) ?? null);
      setNotice(
        ignored.length ? t("agent.ignoredNotice", { count: String(ignored.length) }) : t("agent.ignoreUnchanged"),
      );
    } catch (error) {
      setNotice(errorText(t, error));
    }
    refresh();
  };
  const connect = () => onNavigate({ kind: "connect", slug: agent.slug });
  const unanswered = (activity ?? []).filter((m) => m.direction === "in" && m.state === "unanswered");
  const failed = (activity ?? []).filter((m) => m.direction === "in" && m.state === "failed");
  const troubled = agent.connections.filter((c) => c.state === "error" || c.state === "awaiting_approval");

  // With no bot left, the side panel is where to add one again (the getting-started card is gone by then).
  const hasNeeds =
    agent.connections.length > 0 ||
    agent.hasReplied ||
    troubled.length > 0 ||
    unanswered.length > 0 ||
    failed.length > 0;
  const needsYou = hasNeeds ? (
    <NeedsYou
      agent={agent}
      unanswered={unanswered.map((m) => m.id)}
      failed={failed.map((m) => m.id)}
      troubled={troubled}
      onRetry={retry}
      onIgnore={ignore}
      onConnect={connect}
    />
  ) : null;

  return (
    <>
      <PageHeader
        leading={<Avatar name={agent.name} size={26} />}
        title={agent.name}
        meta={<AgentStatusText status={agent.status} detail={agent.statusDetail} />}
        actions={
          <>
            <Segmented
              label={t("agent.view")}
              value={tab}
              onChange={setTab}
              options={[
                { value: "activity", label: t("agent.tabActivity") },
                { value: "settings", label: t("agent.tabSettings") },
              ]}
            />
            {busy ? (
              <Button
                small
                title={t("agent.stopHint")}
                onClick={async () => {
                  try {
                    const { stopped } = await api.stop(agent.id);
                    setNotice(t(stopped ? "agent.stopped" : "agent.idleNothing"));
                  } catch (error) {
                    setNotice(errorText(t, error));
                  }
                }}
              >
                {t("agent.stop")}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="flex max-w-[680px] flex-col gap-7 px-6 py-6 md:px-8">
            {notice ? <p className="rise -mb-3 text-small text-ink2">{notice}</p> : null}
            {paused ? <PausedCard name={agent.name} disabled={switching} onResume={() => setPaused(false)} /> : null}
            {agent.status === "error" ? <AgentError agent={agent} /> : null}

            {tab === "settings" ? (
              <>
                <section
                  ref={connectionsRef}
                  aria-label={t("agent.chatApps")}
                  tabIndex={-1}
                  className="rounded-card focus:outline-2 focus:outline-offset-4 focus:outline-accent"
                >
                  <Connections
                    agent={agent}
                    onConnect={connect}
                    onChanged={() => {
                      void onChanged();
                      // A renamed owner shows by the new name in the activity right away.
                      void refreshActivity();
                    }}
                  />
                </section>
                <RoleEditor agent={agent} onSaved={onChanged} />
                <Brain agent={agent} onSaved={onChanged} />
                <AgentEnv agent={agent} />
                <Section title={t("agent.lifecycle")}>
                  <Group>
                    <GroupRow className="flex-wrap">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span>
                          {paused
                            ? t("agent.pausedTitle", { name: agent.name })
                            : t("agent.pauseTitle", { name: agent.name })}
                        </span>
                        <span className="text-caption text-ink2">
                          {paused
                            ? t("agent.pausedBody")
                            : busy
                              ? `${t("agent.pauseBody")} ${t("agent.pauseBusy")}`
                              : t("agent.pauseBody")}
                        </span>
                      </span>
                      {paused ? (
                        <Button small disabled={switching} onClick={() => setPaused(false, "row")}>
                          <PlayIcon />
                          {t("agent.resume")}
                        </Button>
                      ) : (
                        <Button small disabled={switching} onClick={() => setPaused(true, "row")}>
                          <PauseIcon />
                          {t("agent.pause")}
                        </Button>
                      )}
                      {pauseFailure ? <p className="w-full text-caption text-red">{pauseFailure}</p> : null}
                    </GroupRow>
                    <ResetRow key={agent.id} agent={agent} busy={busy} disabled={switching} />
                    <DiagnosticsRow key={`d-${agent.id}`} agent={agent} />
                  </Group>
                </Section>
                <Section title={t("agent.home")}>
                  <Group>
                    <GroupRow>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span>{t("agent.homeTitle")}</span>
                        <span className="selectable truncate font-mono text-caption text-ink2" title={agent.home}>
                          {agent.home}
                        </span>
                      </span>
                      <Button small onClick={() => api.openHome(agent.id)}>
                        {t("agent.openHome")}
                      </Button>
                    </GroupRow>
                    <DeleteRow
                      agent={agent}
                      confirming={confirmDelete}
                      onAsk={() => setConfirmDelete(true)}
                      onCancel={() => setConfirmDelete(false)}
                      onDeleted={async () => {
                        // Refresh first: with the old list, "home" would pick the deleted agent again.
                        await onChanged();
                        onNavigate({ kind: "home" }, { replace: true });
                      }}
                    />
                  </Group>
                </Section>
              </>
            ) : (
              <>
                {!agent.hasReplied ? (
                  <GettingStarted
                    agent={agent}
                    heard={(activity ?? []).some((m) => m.direction === "in")}
                    onConnect={connect}
                  />
                ) : null}
                {agent.connections.some((c) => c.state === "connected") ? <KeepOnline /> : null}
                {/* Narrow windows have no right panel: what needs the person comes first. */}
                {needsYou ? <div className="flex flex-col gap-7 min-[1140px]:hidden">{needsYou}</div> : null}
                <Section title={t("agent.activity")}>
                  {activityError ? <LoadProblem title={t("agent.activityFailed")} onRetry={refreshActivity} /> : null}
                  {activity === null ? (
                    activityError ? null : (
                      <Waiting>{t("agent.activityLoading")}</Waiting>
                    )
                  ) : activity.length > 0 ? (
                    <ActivityList items={activity} onRetry={retry} onIgnore={ignore} />
                  ) : activityError ? null : (
                    <div className="flex flex-col items-start gap-3 rounded-card border border-line bg-bg2 p-5">
                      <svg
                        width="28"
                        height="28"
                        viewBox="0 0 24 24"
                        fill="none"
                        className="text-ink2"
                        aria-hidden="true"
                      >
                        <path
                          d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                        />
                        <path d="M7 10h8M7 14h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <div className="flex flex-col gap-1">
                        <h3 className="font-semibold">{t("agent.noActivity")}</h3>
                        <p className="text-small text-ink2">{t("agent.noActivityBody")}</p>
                        {agent.connections.length === 0 ? (
                          <p className="text-small text-ink2">{t("agent.noActivityConnect")}</p>
                        ) : null}
                      </div>
                      {agent.hasReplied && agent.connections.length === 0 ? (
                        <Button onClick={connect}>{t("start.connectAction")}</Button>
                      ) : null}
                    </div>
                  )}
                </Section>
                <div className="flex flex-col gap-7 min-[1140px]:hidden">
                  <Work work={work} error={workError} onRetry={refreshWork} />
                </div>
              </>
            )}
          </div>
        </div>
        <aside className="hidden w-[320px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-line bg-wing px-4 py-5 min-[1140px]:flex">
          {needsYou}
          {agent.connections.length ? (
            <ChatAppsSummary
              agent={agent}
              onManage={() => {
                setTab("settings");
                setManageRequest((request) => request + 1);
              }}
            />
          ) : null}
          <Work work={work} error={workError} onRetry={refreshWork} />
        </aside>
      </div>
    </>
  );
}

/** Until the agent has answered someone: the steps that get it there, and where it is. */
function GettingStarted({ agent, heard, onConnect }: { agent: AgentView; heard: boolean; onConnect: () => void }) {
  const { t } = useI18n();
  const connected = agent.connections.find((c) => c.state === "connected");
  const any = agent.connections.length > 0;
  return (
    <section className="flex flex-col gap-4 rounded-card border border-line bg-card px-5 py-4 shadow-card">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-headline font-semibold">{t("start.title")}</h2>
        <p className="text-small text-ink2">{t("start.body", { name: agent.name })}</p>
      </div>
      <Steps>
        <Step n={1} state="done" title={t("start.created")} />
        <Step n={2} state={any ? "done" : "now"} title={t("start.connect")}>
          <p className="text-small text-ink2">{t("start.connectBody")}</p>
          <Button variant="primary" className="self-start" onClick={onConnect}>
            {t("start.connectAction")}
          </Button>
        </Step>
        <Step n={3} state={!any ? "later" : heard ? "done" : "now"} title={t("start.say")}>
          <p className="text-small text-ink2">
            {connected ? t(`${connected.platform}.qr3` as MessageKey) : t("start.sayBody")}
          </p>
          {connected ? <Waiting>{t("start.waiting")}</Waiting> : <Waiting>{t("start.waitingConnection")}</Waiting>}
        </Step>
        <Step n={4} state={heard ? "now" : "later"} title={t("start.reply")}>
          {agent.status === "paused" ? (
            <p className="text-small text-ink2">{t("start.replyPaused", { name: agent.name })}</p>
          ) : agent.status === "error" ? (
            <p className="text-small text-red">{t("start.replyFailed", { name: agent.name })}</p>
          ) : !connected ? (
            <p className="text-small text-ink2">{t("start.replyDisconnected")}</p>
          ) : agent.status === "thinking" || agent.status === "working" ? (
            <Waiting>{t("start.replying", { name: agent.name })}</Waiting>
          ) : (
            <p className="text-small text-ink2">{t("start.replyIdle", { name: agent.name })}</p>
          )}
        </Step>
      </Steps>
    </section>
  );
}

/**
 * A paused agent, on both tabs: what pausing means for the people who write to it, and the way
 * back. Not a problem box: the owner chose this, nothing is broken.
 */
function PausedCard({ name, disabled, onResume }: { name: string; disabled: boolean; onResume: () => void }) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("agent.pausedTitle", { name })}
      className="rise flex flex-col gap-3 rounded-card border border-line bg-bg2 px-4 py-3.5 sm:flex-row sm:items-start"
    >
      <PauseIcon className="mt-0.5 hidden text-ink2 sm:block" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-headline font-semibold wrap-anywhere">{t("agent.pausedTitle", { name })}</h2>
        <p className="text-small text-ink2">{t("agent.pausedBody")}</p>
      </div>
      <Button variant="primary" className="self-start" disabled={disabled} onClick={onResume}>
        <PlayIcon />
        {t("agent.resume")}
      </Button>
    </section>
  );
}

/** Failure classes the console explains; anything else shows the generic text. */
const FAILURES = ["auth", "quota", "billing", "model_unavailable", "busy", "input_too_large", "not_installed"] as const;

function failureKey(failure: string | null): (typeof FAILURES)[number] | "unknown" {
  if (failure === "rate_limited" || failure === "overloaded" || failure === "provider") return "busy";
  return (FAILURES as readonly string[]).includes(failure ?? "") ? (failure as (typeof FAILURES)[number]) : "unknown";
}

/** Why the agent stopped, in plain words and with the next step; the harness's own words underneath. */
function AgentError({ agent }: { agent: AgentView }) {
  const { t } = useI18n();
  if (agent.statusDetail) {
    const detail = statusDetailText(t, agent.statusDetail);
    if (detail !== agent.statusDetail) {
      return (
        <Problem title={t("failure.unknown.title" as MessageKey, { name: agent.name })} tone="red">
          <span className="selectable wrap-anywhere">{detail}</span>
        </Problem>
      );
    }
  }
  const key = failureKey(agent.statusFailure);
  const vars = { harness: agent.harnessName, name: agent.name };
  return (
    <Problem title={t(`failure.${key}.title` as MessageKey, vars)} tone="red">
      <p>{t(`failure.${key}.body` as MessageKey, vars)}</p>
      {key === "auth" ? <ApiKeyHint harness={agent.harness} /> : null}
      {agent.statusDetail ? (
        <p className="selectable mt-1 font-mono text-caption text-ink3 wrap-anywhere">{agent.statusDetail}</p>
      ) : null}
    </Problem>
  );
}

/**
 * Once an agent can be reached, the desktop app offers what keeps it reachable: opening at
 * login and staying awake on power (docs/spec.md 9.1). Shown until the person closes it.
 */
function KeepOnline() {
  const { t } = useI18n();
  const state = useOnline();
  if (!state || state.cardDismissed) return null;
  return (
    <Section
      title={t("online.title")}
      action={
        <Button small onClick={() => online.dismissCard()}>
          {t("online.done")}
        </Button>
      }
    >
      <p className="px-1 text-small text-ink2">{t("online.body")}</p>
      <Group>
        <OnlineRows state={state} notifications={false} />
      </Group>
      <p className="px-1 text-caption text-ink3">{t("online.later")}</p>
    </Section>
  );
}

function NeedsYou({
  agent,
  unanswered,
  failed,
  troubled,
  onConnect,
  onRetry,
  onIgnore,
}: {
  agent: AgentView;
  unanswered: string[];
  failed: string[];
  troubled: ConnectionView[];
  onConnect: () => void;
  onRetry: (ids: string[]) => Promise<void>;
  onIgnore: (ids: string[]) => Promise<void>;
}) {
  const { t } = useI18n();
  // Retrying while the harness still fails only fails again; say so, but let the person try.
  const messageActions = (ids: string[]) => (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <MessageActions onRetry={() => onRetry(ids)} onIgnore={() => onIgnore(ids)} />
      {agent.status === "error" ? <span className="text-caption text-ink3">{t("needs.retryFirst")}</span> : null}
    </div>
  );
  const items = [
    ...troubled.map((c) => (
      <Problem
        key={c.id}
        tone={c.state === "error" ? "red" : "amber"}
        title={`${c.bot ?? t(`platform.${c.platform}` as MessageKey)} · ${t(`connection.${c.state}` as MessageKey)}`}
      >
        {c.state === "error" ? (
          <>
            {connectionDetail(t, c)}
            <div className="mt-2">
              <ReconnectButton connection={c} />
            </div>
          </>
        ) : (
          t("connection.approvalHint")
        )}
      </Problem>
    )),
    ...(failed.length > 0
      ? [
          <Problem key="failed" tone="red" title={t("needs.failed", { count: String(failed.length) })}>
            {t("needs.failedBody", { name: agent.name })}
            {messageActions(failed)}
          </Problem>,
        ]
      : []),
    ...(unanswered.length > 0
      ? [
          <Problem key="unanswered" title={t("needs.unanswered", { count: String(unanswered.length) })}>
            {t("needs.unansweredBody", { name: agent.name })}
            {messageActions(unanswered)}
          </Problem>,
        ]
      : []),
  ];
  // No bot left (the last one removed): nobody can reach the agent, so that comes first.
  if (agent.connections.length === 0 && agent.hasReplied) {
    items.unshift(
      <Problem key="no-bot" title={t("connection.none")}>
        <div className="mt-1">
          <Button small onClick={onConnect}>
            {t("start.connectAction")}
          </Button>
        </div>
      </Problem>,
    );
  }
  if (agent.connections.length === 0 && items.length === 0) return null;
  return (
    <Section title={t("needs.title")}>
      {items.length ? (
        <div className="flex flex-col gap-2">{items}</div>
      ) : (
        <p className="flex items-center gap-2 px-1 text-small text-ink2">
          <StatusDot state="connected" /> {t("needs.none")}
        </p>
      )}
    </Section>
  );
}

/** The agent's bots at a glance, in the side panel. */
function ChatAppsSummary({ agent, onManage }: { agent: AgentView; onManage: () => void }) {
  const { t } = useI18n();
  return (
    <Section
      title={t("agent.chatApps")}
      action={
        <Button variant="ghost" small onClick={onManage}>
          {t("agent.manage")}
        </Button>
      }
    >
      <Group>
        {agent.connections.map((c) => (
          <GroupRow key={c.id} className="min-h-[44px]">
            <PlatformIcon platform={c.platform} size={22} />
            <span className="min-w-0 flex-1 truncate">
              {c.bot ?? t(`platform.${c.platform}` as MessageKey)}
              {/* Two bots of one platform look alike: say whose each is. */}
              {c.ownerShared ? (
                <span className="text-ink3">
                  {" · "}
                  {c.ownerContact?.name ?? t("connection.ownerUnnamed")}
                </span>
              ) : null}
            </span>
            <StatusDot state={c.state} />
          </GroupRow>
        ))}
      </Group>
    </Section>
  );
}

function connectionDetail(t: ReturnType<typeof useI18n>["t"], c: ConnectionView): string {
  const key = `connection.detail.${c.detail}` as MessageKey;
  return t(key) !== key ? t(key) : t("connection.detail.unknown");
}

/** Try an offline bot again now. Offered on every error: waiting for the automatic retry is never the only way. */
function ReconnectButton({ connection }: { connection: ConnectionView }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      small
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await api
          .reconnect(connection.id)
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    >
      {t("connection.reconnect")}
    </Button>
  );
}

/** A failed load explains itself and offers a retry; it is not shown as an empty list. */
function LoadProblem({ title, onRetry }: { title: string; onRetry: () => Promise<void> }) {
  const { t } = useI18n();
  return (
    <Problem title={title}>
      <div className="flex flex-col items-start gap-2">
        <p>{t("agent.loadRetry")}</p>
        <Button small onClick={onRetry}>
          {t("agent.retry")}
        </Button>
      </div>
    </Problem>
  );
}

function Work({ work, error, onRetry }: { work: WorkData | null; error: boolean; onRetry: () => Promise<void> }) {
  const { t, locale } = useI18n();
  if (work === null) {
    return (
      <Section title={t("agent.work")}>
        {error ? (
          <LoadProblem title={t("agent.workFailed")} onRetry={onRetry} />
        ) : (
          <Waiting>{t("agent.workLoading")}</Waiting>
        )}
      </Section>
    );
  }
  return (
    <>
      {error ? <LoadProblem title={t("agent.workFailed")} onRetry={onRetry} /> : null}
      <Section title={t("agent.tasks")}>
        {work.tasks.length === 0 ? (
          <p className="px-1 text-small text-ink2">
            {t("agent.noTasks")}
            <span className="mt-1 block">{t("agent.noTasksBody")}</span>
          </p>
        ) : (
          <Group>
            {work.tasks.map((task) => (
              <GroupRow key={task.id} className="min-h-[44px]">
                <span className="line-clamp-2 min-w-0 flex-1 wrap-anywhere" title={task.title}>
                  {task.title}
                </span>
                <span className="shrink-0 rounded-full bg-bg3 px-2 py-0.5 text-caption text-ink2">
                  {t(`task.${task.status}` as MessageKey)}
                </span>
              </GroupRow>
            ))}
          </Group>
        )}
      </Section>
      <Section title={t("agent.reminders")}>
        {work.reminders.length === 0 ? (
          <p className="px-1 text-small text-ink2">
            {t("agent.noReminders")}
            <span className="mt-1 block">{t("agent.noRemindersBody")}</span>
          </p>
        ) : (
          <Group>
            {work.reminders.map((r) => (
              <GroupRow key={r.id} className="min-h-[44px] flex-col items-start gap-0.5">
                <span className="line-clamp-2 wrap-anywhere" title={r.body}>
                  {r.body}
                </span>
                <span className="text-caption text-ink2">
                  {r.nextFireAt ? shortDateTime(r.nextFireAt, locale) : ""}
                  {r.lastFiredAt ? (
                    <span className="text-ink3">
                      {" · "}
                      {t("agent.reminderLastFired", { time: shortDateTime(r.lastFiredAt, locale) })}
                    </span>
                  ) : null}
                </span>
              </GroupRow>
            ))}
          </Group>
        )}
      </Section>
    </>
  );
}

function Connections({
  agent,
  onConnect,
  onChanged,
}: {
  agent: AgentView;
  onConnect: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  // Always shown, even with no bot: removing the last one must not remove the way to add one.
  return (
    <Section
      title={t("agent.chatApps")}
      action={
        <Button variant="ghost" small onClick={onConnect}>
          <PlusIcon /> {t("agent.add")}
        </Button>
      }
    >
      {agent.connections.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-card border border-line bg-card px-4 py-3.5">
          <p className="text-small text-ink2">{t("connection.none")}</p>
          <Button variant="primary" small onClick={onConnect}>
            {t("start.connectAction")}
          </Button>
        </div>
      ) : (
        <Group>
          {agent.connections.map((c) => (
            <ConnectionRow key={c.id} agentId={agent.id} connection={c} onChanged={onChanged} />
          ))}
        </Group>
      )}
    </Section>
  );
}

function ConnectionRow({
  agentId,
  connection,
  onChanged,
}: {
  agentId: string;
  connection: ConnectionView;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [naming, setNaming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const platform = t(`platform.${connection.platform}` as MessageKey);
  const owner = connection.ownerContact;
  // Another bot on this platform has a different owner: name them, or both read as "you".
  const shared = connection.ownerShared;
  const hint =
    connection.state === "error"
      ? connectionDetail(t, connection)
      : connection.state === "connected" && !connection.owner
        ? t("connection.noOwner")
        : shared && owner && !owner.name
          ? t("connection.nameOwnerHint", { platform })
          : null;
  return (
    <GroupRow className="flex-wrap">
      <PlatformIcon platform={connection.platform} size={32} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium" title={connection.bot ?? undefined}>
          {connection.bot ?? platform}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-small text-ink2">
          <StatusDot state={connection.state} />
          <span className="truncate">
            {platform} · {t(`connection.${connection.state}` as MessageKey)}
            {owner && (owner.name || shared)
              ? ` · ${owner.name ? t("connection.ownerIs", { name: owner.name }) : t("connection.ownerUnnamed")}`
              : null}
          </span>
        </span>
      </span>
      {naming && owner ? (
        <OwnerNameForm
          agentId={agentId}
          contactId={owner.id}
          initial={owner.name ?? ""}
          onDone={(saved) => {
            setNaming(false);
            if (saved) onChanged();
          }}
        />
      ) : confirming ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="hidden text-small text-ink2 sm:inline">{t("connection.removeAsk")}</span>
          <Button
            small
            variant="danger"
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              setFailure(null);
              try {
                await api.disconnect(connection.id);
                onChanged();
              } catch (error) {
                setFailure(errorText(t, error));
                setConfirming(false);
              } finally {
                setRemoving(false);
              }
            }}
          >
            {t("connection.removeYes")}
          </Button>
          <Button small variant="ghost" onClick={() => setConfirming(false)}>
            {t("agent.cancel")}
          </Button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          {connection.state === "error" ? <ReconnectButton connection={connection} /> : null}
          {connection.invite ? (
            <a
              href={connection.invite}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center rounded-control border border-line2 px-2.5 text-small font-medium hover:bg-bg3"
            >
              {t("connection.invite")}
            </a>
          ) : null}
          <MoreMenu
            label={t("agent.more")}
            items={[
              ...(owner ? [{ label: t("connection.nameOwner"), onSelect: () => setNaming(true) }] : []),
              { label: t("connection.remove"), danger: true, onSelect: () => setConfirming(true) },
            ]}
          />
        </span>
      )}
      {failure ? <p className="w-full pl-11 text-caption text-red">{failure}</p> : null}
      {hint ? (
        <p className={`w-full pl-11 text-caption ${connection.state === "error" ? "text-red" : "text-ink3"}`}>{hint}</p>
      ) : null}
    </GroupRow>
  );
}

/** Name a bot's owner, so two people on one platform are not both "you". Empty clears the name. */
function OwnerNameForm({
  agentId,
  contactId,
  initial,
  onDone,
}: {
  agentId: string;
  contactId: string;
  initial: string;
  onDone: (saved: boolean) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex w-full flex-col gap-1.5 pl-11"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.nameContact(agentId, contactId, name);
          onDone(true);
        } catch (err) {
          setError(errorText(t, err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <Input
          className="min-w-0 flex-1"
          aria-label={t("connection.ownerName")}
          placeholder={t("connection.ownerName")}
          value={name}
          maxLength={64}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <Button small variant="primary" type="submit" disabled={busy}>
          {t("connection.ownerNameSave")}
        </Button>
        <Button small variant="ghost" type="button" onClick={() => onDone(false)}>
          {t("agent.cancel")}
        </Button>
      </span>
      {error ? <p className="text-caption text-red">{error}</p> : null}
    </form>
  );
}

function RoleEditor({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.role);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(agent.role);
  }, [agent.role, editing]);

  async function save() {
    setFailure(null);
    try {
      await api.setRole(agent.id, draft);
    } catch (error) {
      // Keep the editor open with the draft, so nothing typed is lost.
      setFailure(errorText(t, error));
      return;
    }
    setEditing(false);
    setSaved(true);
    onSaved();
  }

  return (
    <Section
      title={t("agent.role")}
      action={
        editing ? null : (
          <Button
            variant="ghost"
            small
            onClick={() => {
              setEditing(true);
              setSaved(false);
            }}
          >
            {t("agent.edit")}
          </Button>
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea autoFocus rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="primary" small onClick={save}>
              {t("agent.save")}
            </Button>
            <Button variant="ghost" small onClick={() => setEditing(false)}>
              {t("agent.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="selectable rounded-card border border-line bg-card px-4 py-3 whitespace-pre-wrap wrap-anywhere">
          {agent.role.trim() ? agent.role.trim() : <span className="text-ink3">{t("agent.roleEmpty")}</span>}
        </div>
      )}
      {failure ? <p className="px-1 text-small text-red">{failure}</p> : null}
      {saved ? <p className="px-1 text-small text-ink2">{t("agent.roleSaved")}</p> : null}
    </Section>
  );
}

/** Which harness and model drive the agent. A change applies from the next message. */
function Brain({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const { t } = useI18n();
  const { value: harnesses } = useCached<Harness[]>("harnesses", api.harnesses, []);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  async function save(patch: { harness?: string; model?: string | null }) {
    setState("saving");
    setError(null);
    try {
      await api.updateAgent(agent.id, patch);
      setState("saved");
      onSaved();
    } catch (e) {
      setError(errorText(t, e));
      setState("idle");
    }
  }

  const current = harnesses?.find((h) => h.id === agent.harness);
  const why = (h: Harness) =>
    h.disabled
      ? `${h.name}${h.version ? ` ${h.version}` : ""}: ${errorText(t, { code: h.disabled.code, next: h.disabled.reason })}`
      : "";
  // Only the harness this agent uses is explained here; others say why on hover.
  const blocker = current?.disabled ? why(current) : null;
  const missingCurrent = harnesses && !current ? agent.harness : null;
  return (
    <Section title={t("create.brain")}>
      <Group>
        <GroupRow>
          {current ? <HarnessIcon harness={current} size={24} /> : null}
          <span className="min-w-0 flex-1">{t("brain.harness")}</span>
          <Select
            aria-label={t("create.brain")}
            className="!w-[220px]"
            value={agent.harness}
            disabled={!harnesses || state === "saving"}
            onChange={(e) => save({ harness: e.target.value, model: null })}
          >
            {(harnesses ?? []).map((h) => (
              <option key={h.id} value={h.id} disabled={Boolean(h.disabled)} title={why(h) || undefined}>
                {h.disabled ? `${h.name} · ${t("brain.incompatible")}` : h.name}
              </option>
            ))}
            {harnesses && !current ? <option value={agent.harness}>{agent.harness}</option> : null}
          </Select>
        </GroupRow>
        {current && !current.disabled ? (
          <GroupRow>
            <span className="min-w-0 flex-1">{t("create.model")}</span>
            <ModelPicker
              inline
              harness={agent.harness}
              value={agent.model ?? ""}
              onChange={(id) => save({ model: id || null })}
            />
          </GroupRow>
        ) : null}
      </Group>
      {missingCurrent ? (
        <p className="px-1 text-small text-red">
          {missingCurrent}: {t("error.harness_unavailable")}
        </p>
      ) : null}
      {blocker ? <p className="px-1 text-small wrap-anywhere text-red">{blocker}</p> : null}
      {error ? <p className="px-1 text-small text-red">{error}</p> : null}
      {state === "saved" ? <p className="px-1 text-small text-ink2">{t("agent.brainSaved")}</p> : null}
    </Section>
  );
}

/** The delete row asks in place: the question replaces the row the click came from. */
function DeleteRow({
  agent,
  confirming,
  onAsk,
  onCancel,
  onDeleted,
}: {
  agent: AgentView;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(confirming);
  useLayoutEffect(() => {
    if (wasConfirming.current && !confirming) deleteButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const cancel = () => {
    setFailure(null);
    onCancel();
  };
  return (
    <GroupRow className={`flex-wrap transition-colors duration-[120ms] ${confirming ? "bg-red-tint" : ""}`}>
      <span className="flex min-w-0 flex-1 flex-col" aria-live="polite">
        <span className={confirming ? "font-medium" : undefined}>
          {confirming ? t("agent.deleteTitle", { name: agent.name }) : t("agent.delete")}
        </span>
        <span className="text-caption text-ink2">{t("agent.deleteBody")}</span>
      </span>
      {confirming ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape backs out of the question it belongs to
        <span
          className="flex shrink-0 items-center gap-1.5"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) cancel();
          }}
        >
          <Button
            small
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setFailure(null);
              try {
                await api.remove(agent.id);
              } catch (error) {
                setFailure(errorText(t, error));
                setBusy(false);
                return;
              }
              await onDeleted();
            }}
          >
            {t("agent.deleteYes")}
          </Button>
          <Button small autoFocus disabled={busy} onClick={cancel}>
            {t("agent.cancel")}
          </Button>
        </span>
      ) : (
        <Button ref={deleteButton} small variant="danger" onClick={onAsk}>
          {t("agent.delete")}
        </Button>
      )}
      {failure ? <p className="w-full text-caption text-red">{failure}</p> : null}
    </GroupRow>
  );
}

/**
 * Start the agent over in a new session, for a session that is stuck or muddled. Its history is
 * gone afterwards, so it asks in place first (DESIGN.md: no modal dialogs).
 */
function ResetRow({ agent, busy, disabled }: { agent: AgentView; busy: boolean; disabled: boolean }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // When the question closes (cancelled or done), keyboard focus goes back to the button that asked it.
  const resetButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(confirming);
  useLayoutEffect(() => {
    if (wasConfirming.current && !confirming) resetButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const cancel = () => setConfirming(false);
  return (
    <GroupRow className={`flex-wrap transition-colors duration-[120ms] ${confirming ? "bg-amber-tint" : ""}`}>
      <span className="flex min-w-0 flex-1 flex-col" aria-live="polite">
        <span className={confirming ? "font-medium" : undefined}>
          {confirming ? t("agent.resetAsk", { name: agent.name }) : t("agent.resetTitle")}
        </span>
        <span className="text-caption text-ink2">
          {busy ? `${t("agent.resetBody")} ${t("agent.resetBusy")}` : t("agent.resetBody")}
        </span>
      </span>
      {confirming ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape backs out of the question it belongs to
        <span
          className="flex shrink-0 items-center gap-1.5"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) cancel();
          }}
        >
          <Button
            small
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setResult(null);
              try {
                await api.resetSession(agent.id);
                setResult({ ok: true, text: t("agent.resetDone", { name: agent.name }) });
                setConfirming(false);
              } catch (error) {
                setResult({ ok: false, text: errorText(t, error) });
              } finally {
                setPending(false);
              }
            }}
          >
            {t("agent.reset")}
          </Button>
          <Button small autoFocus disabled={pending} onClick={cancel}>
            {t("agent.cancel")}
          </Button>
        </span>
      ) : (
        <Button
          ref={resetButton}
          small
          disabled={disabled}
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
        >
          {t("agent.reset")}
        </Button>
      )}
      {result ? <p className={`w-full text-caption ${result.ok ? "text-ink2" : "text-red"}`}>{result.text}</p> : null}
    </GroupRow>
  );
}

/** Copy text, falling back to a hidden text area where the clipboard API is not offered (some webviews). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/** Copy what someone helping needs. Where copying fails, the text shows in place to select by hand. */
function DiagnosticsRow({ agent }: { agent: AgentView }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<
    { kind: "copied" } | { kind: "manual"; text: string } | { kind: "error"; text: string } | null
  >(null);
  useEffect(() => {
    if (state?.kind !== "copied") return;
    const timer = setTimeout(() => setState(null), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <GroupRow className="flex-wrap">
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{t("agent.diagnosticsTitle")}</span>
        <span className="text-caption text-ink2">{t("agent.diagnosticsBody")}</span>
      </span>
      <Button
        small
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            const { text } = await api.diagnostics(agent.id);
            setState((await copyText(text)) ? { kind: "copied" } : { kind: "manual", text });
          } catch (error) {
            setState({ kind: "error", text: errorText(t, error) });
          } finally {
            setPending(false);
          }
        }}
      >
        {state?.kind === "copied" ? t("agent.diagnosticsCopied") : t("agent.diagnosticsCopy")}
      </Button>
      {state?.kind === "manual" ? (
        <pre className="selectable w-full overflow-x-auto rounded-control bg-bg2 p-3 font-mono text-caption whitespace-pre-wrap wrap-anywhere text-ink2">
          {state.text}
        </pre>
      ) : null}
      {state?.kind === "error" ? <p className="w-full text-caption text-red">{state.text}</p> : null}
    </GroupRow>
  );
}

/** Retry or dismiss a message; disabled while the request runs, so a double click does not send it twice. */
function MessageActions({
  onRetry,
  onIgnore,
  inline = false,
}: {
  onRetry: () => Promise<void>;
  onIgnore: () => Promise<void>;
  inline?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {inline ? (
        <>
          <button
            type="button"
            disabled={busy}
            className="min-h-7 px-1 font-medium text-accent hover:underline disabled:opacity-45"
            onClick={() => run(onRetry)}
          >
            {t("agent.retry")}
          </button>
          <button
            type="button"
            disabled={busy}
            className="min-h-7 px-1 font-medium text-ink2 hover:underline disabled:opacity-45"
            onClick={() => run(onIgnore)}
          >
            {t("agent.ignore")}
          </button>
        </>
      ) : (
        <>
          <Button small disabled={busy} onClick={() => run(onRetry)}>
            {t("agent.retry")}
          </Button>
          <Button small variant="ghost" disabled={busy} onClick={() => run(onIgnore)}>
            {t("agent.ignore")}
          </Button>
        </>
      )}
    </span>
  );
}

function ActivityList({
  items,
  onRetry,
  onIgnore,
}: {
  items: Activity[];
  onRetry: (ids: string[]) => Promise<void>;
  onIgnore: (ids: string[]) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  return (
    <Group>
      {items.map((m) => {
        // "You" only when it cannot be two people: two WeChat accounts are each an owner.
        const who =
          m.sender ??
          (m.senderIsOnlyOwner
            ? t("activity.you")
            : m.contactId
              ? t("activity.unnamed", { id: m.contactId })
              : t("activity.someone"));
        const where = m.chat.kind === "dm" ? t("chat.dm") : (m.chat.name ?? t("chat.group"));
        return (
          <div key={m.id} className={`flex gap-3 px-4 py-3 ${m.direction === "out" ? "bg-bg2" : ""}`}>
            <PlatformIcon platform={m.platform} size={20} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-baseline gap-2 text-small">
                <span className="max-w-[45%] shrink-0 truncate font-semibold" title={who}>
                  {who}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink3" title={where}>
                  {where}
                </span>
                <span className="shrink-0 whitespace-nowrap text-caption text-ink3">
                  {relativeTime(m.createdAt, locale)}
                </span>
              </div>
              <p className="selectable line-clamp-4 whitespace-pre-wrap wrap-anywhere">{m.body}</p>
              {m.files.length ? (
                <p className="truncate font-mono text-caption text-ink2" title={m.files.join(", ")}>
                  {m.files.join(", ")}
                </p>
              ) : null}
              {m.direction === "in" && m.state === "unanswered" ? (
                <p className="flex flex-wrap items-center gap-1.5 text-caption text-amber">
                  <StatusDot state="awaiting_approval" />
                  {t("agent.unanswered")}
                  <MessageActions inline onRetry={() => onRetry([m.id])} onIgnore={() => onIgnore([m.id])} />
                </p>
              ) : null}
              {m.direction === "in" && m.state === "waiting" ? (
                <p className="flex flex-wrap items-center gap-1.5 text-caption text-ink2">
                  <StatusDot state="reconnecting" />
                  {m.retryAt ? t("agent.waitingUntil", { time: shortDateTime(m.retryAt, locale) }) : t("agent.waiting")}
                  <MessageActions inline onRetry={() => onRetry([m.id])} onIgnore={() => onIgnore([m.id])} />
                </p>
              ) : null}
              {m.direction === "in" && m.state === "failed" ? (
                <p className="flex flex-wrap items-center gap-1.5 text-caption text-red">
                  <StatusDot state="error" />
                  {t("agent.failed")}
                  <MessageActions inline onRetry={() => onRetry([m.id])} onIgnore={() => onIgnore([m.id])} />
                </p>
              ) : null}
              {m.direction === "in" && m.triggers && m.state === "ignored" ? (
                <p className="text-caption text-ink3">{t("agent.ignored")}</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </Group>
  );
}
