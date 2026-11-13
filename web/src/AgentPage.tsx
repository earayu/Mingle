import { useCallback, useEffect, useState } from "react";
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
import { errorText, type MessageKey, statusDetailText, useI18n } from "./i18n.ts";
import { ModelPicker } from "./NewAgent.tsx";
import { online, useOnline } from "./online.ts";
import { PlatformIcon } from "./platforms.tsx";
import { OnlineRows } from "./Settings.tsx";
import {
  AgentStatusText,
  ApiKeyHint,
  Avatar,
  Button,
  Group,
  GroupRow,
  HarnessIcon,
  MoreMenu,
  PageHeader,
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
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [work, setWork] = useState<{ tasks: Task[]; reminders: Reminder[] }>({ tasks: [], reminders: [] });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<"activity" | "settings">("activity");

  const refresh = useCallback(() => {
    api
      .activity(agent.id)
      .then(setActivity)
      .catch(() => {});
    api
      .work(agent.id)
      .then(setWork)
      .catch(() => {});
  }, [agent.id]);

  useEffect(() => {
    setActivity(null);
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when switching to another agent
  useEffect(() => {
    setConfirmDelete(false);
    setNotice(null);
    setTab("activity");
  }, [agent.id]);

  const busy = agent.status === "thinking" || agent.status === "working";
  const retry = async (ids: string[]) => {
    try {
      const { retried } = await api.retry(agent.id, ids);
      setNotice(
        retried.length > 0
          ? t("agent.retrying", { count: String(retried.length), name: agent.name })
          : t("agent.retryOffline"),
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
  const replied = (activity ?? []).some((m) => m.direction === "out");
  const setupDone = agent.connections.length > 0 && replied;

  const hasNeeds = agent.connections.length > 0 || troubled.length > 0 || unanswered.length > 0 || failed.length > 0;
  const needsYou = hasNeeds ? (
    <NeedsYou
      agent={agent}
      unanswered={unanswered.map((m) => m.id)}
      failed={failed.map((m) => m.id)}
      troubled={troubled}
      onRetry={retry}
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
                onClick={async () => {
                  const { stopped } = await api.stop(agent.id);
                  setNotice(t(stopped ? "agent.stopped" : "agent.idleNothing"));
                }}
              >
                {t("agent.stop")}
              </Button>
            ) : null}
            <MoreMenu
              label={t("agent.more")}
              items={[
                { label: t("agent.openHome"), onSelect: () => api.openHome(agent.id) },
                {
                  label: t("agent.delete"),
                  danger: true,
                  onSelect: () => {
                    setTab("settings");
                    setConfirmDelete(true);
                  },
                },
              ]}
            />
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="flex max-w-[680px] flex-col gap-7 px-6 py-6 md:px-8">
            {confirmDelete ? (
              <DeleteConfirm
                agent={agent}
                onCancel={() => setConfirmDelete(false)}
                onDeleted={async () => {
                  // Refresh first: with the old list, "home" would pick the deleted agent again.
                  await onChanged();
                  onNavigate({ kind: "home" }, { replace: true });
                }}
              />
            ) : null}
            {notice ? <p className="rise -mb-3 text-small text-ink2">{notice}</p> : null}
            {agent.status === "error" ? <AgentError agent={agent} /> : null}

            {tab === "settings" ? (
              <>
                <Connections agent={agent} onConnect={connect} onChanged={onChanged} />
                <RoleEditor agent={agent} onSaved={onChanged} />
                <Brain agent={agent} onSaved={onChanged} />
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
                    <GroupRow>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span>{t("agent.delete")}</span>
                        <span className="text-caption text-ink2">{t("agent.deleteBody")}</span>
                      </span>
                      <Button small variant="danger" onClick={() => setConfirmDelete(true)}>
                        {t("agent.delete")}
                      </Button>
                    </GroupRow>
                  </Group>
                </Section>
              </>
            ) : (
              <>
                {activity !== null && !setupDone ? (
                  <GettingStarted agent={agent} heard={(activity ?? []).length > 0} onConnect={connect} />
                ) : null}
                {agent.connections.some((c) => c.state === "connected") ? <KeepOnline /> : null}
                {/* Narrow windows have no right panel: what needs the person comes first. */}
                {needsYou ? <div className="flex flex-col gap-7 min-[1140px]:hidden">{needsYou}</div> : null}
                {activity && activity.length > 0 ? (
                  <Section title={t("agent.activity")}>
                    <ActivityList items={activity} onRetry={retry} />
                  </Section>
                ) : null}
                <div className="flex flex-col gap-7 min-[1140px]:hidden">
                  <Work work={work} />
                </div>
              </>
            )}
          </div>
        </div>
        <aside className="hidden w-[320px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-line bg-wing px-4 py-5 min-[1140px]:flex">
          {needsYou}
          {agent.connections.length ? <ChatAppsSummary agent={agent} onManage={() => setTab("settings")} /> : null}
          <Work work={work} />
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
          {agent.status === "error" ? (
            <p className="text-small text-red">{t("start.replyFailed", { name: agent.name })}</p>
          ) : (
            <Waiting>{t("start.replying", { name: agent.name })}</Waiting>
          )}
        </Step>
      </Steps>
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
}: {
  agent: AgentView;
  unanswered: string[];
  failed: string[];
  troubled: ConnectionView[];
  onConnect: () => void;
  onRetry: (ids: string[]) => Promise<void>;
}) {
  const { t } = useI18n();
  // Retrying while the harness still fails only fails again; say so, but let the person try.
  const retryAction = (ids: string[]) => (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <RetryButton onRetry={() => onRetry(ids)} label={t("needs.retry")} />
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
        {c.state === "error" ? connectionDetail(t, c) : t("connection.approvalHint")}
      </Problem>
    )),
    ...(failed.length > 0
      ? [
          <Problem key="failed" tone="red" title={t("needs.failed", { count: String(failed.length) })}>
            {t("needs.failedBody", { name: agent.name })}
            {retryAction(failed)}
          </Problem>,
        ]
      : []),
    ...(unanswered.length > 0
      ? [
          <Problem key="unanswered" title={t("needs.unanswered", { count: String(unanswered.length) })}>
            {t("needs.unansweredBody", { name: agent.name })}
            {retryAction(unanswered)}
          </Problem>,
        ]
      : []),
  ];
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
      {agent.connections.length === 0 ? (
        <Button className="self-start" onClick={onConnect}>
          {t("start.connectAction")}
        </Button>
      ) : null}
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
            <span className="min-w-0 flex-1 truncate">{c.bot ?? t(`platform.${c.platform}` as MessageKey)}</span>
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

function Work({ work }: { work: { tasks: Task[]; reminders: Reminder[] } }) {
  const { t, locale } = useI18n();
  return (
    <>
      <Section title={t("agent.tasks")}>
        {work.tasks.length === 0 ? (
          <p className="px-1 text-small text-ink3">{t("agent.noTasks")}</p>
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
          <p className="px-1 text-small text-ink3">{t("agent.noReminders")}</p>
        ) : (
          <Group>
            {work.reminders.map((r) => (
              <GroupRow key={r.id} className="min-h-[44px] flex-col items-start gap-0.5">
                <span className="line-clamp-2 wrap-anywhere" title={r.body}>
                  {r.body}
                </span>
                <span className="text-caption text-ink2">
                  {r.nextFireAt ? shortDateTime(r.nextFireAt, locale) : ""}
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
  if (agent.connections.length === 0) return null;
  return (
    <Section
      title={t("agent.chatApps")}
      action={
        <Button variant="ghost" small onClick={onConnect}>
          <PlusIcon /> {t("agent.add")}
        </Button>
      }
    >
      <Group>
        {agent.connections.map((c) => (
          <ConnectionRow key={c.id} connection={c} onChanged={onChanged} />
        ))}
      </Group>
    </Section>
  );
}

function ConnectionRow({ connection, onChanged }: { connection: ConnectionView; onChanged: () => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const platform = t(`platform.${connection.platform}` as MessageKey);
  const hint = connection.state === "connected" && !connection.owner ? t("connection.noOwner") : null;
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
          </span>
        </span>
      </span>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="hidden text-small text-ink2 sm:inline">{t("connection.removeAsk")}</span>
          <Button
            small
            variant="danger"
            onClick={async () => {
              await api.disconnect(connection.id);
              onChanged();
            }}
          >
            {t("connection.removeYes")}
          </Button>
          <Button small variant="ghost" onClick={() => setConfirming(false)}>
            {t("agent.deleteNo")}
          </Button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
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
            items={[{ label: t("connection.remove"), danger: true, onSelect: () => setConfirming(true) }]}
          />
        </span>
      )}
      {hint ? <p className="w-full pl-11 text-caption text-ink3">{hint}</p> : null}
    </GroupRow>
  );
}

function RoleEditor({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.role);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(agent.role);
  }, [agent.role, editing]);

  async function save() {
    await api.setRole(agent.id, draft);
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
      {saved ? <p className="px-1 text-small text-ink2">{t("agent.roleSaved")}</p> : null}
    </Section>
  );
}

/** Which harness and model drive the agent. A change applies from the next message. */
function Brain({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const { t } = useI18n();
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .harnesses()
      .then(setHarnesses)
      .catch(() => setHarnesses([]));
  }, []);

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
  // Why a listed harness cannot be chosen: current or alternative, name and reason.
  const blockers = (harnesses ?? [])
    .filter((h) => h.disabled)
    .map(
      (h) =>
        `${h.name}${h.version ? ` ${h.version}` : ""}: ${errorText(t, { code: h.disabled?.code, next: h.disabled?.reason })}`,
    );
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
              <option key={h.id} value={h.id} disabled={Boolean(h.disabled)}>
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
      {blockers.map((line) => (
        <p key={line} className="px-1 text-small wrap-anywhere text-ink2">
          {line}
        </p>
      ))}
      {error ? <p className="px-1 text-small text-red">{error}</p> : null}
      {state === "saved" ? <p className="px-1 text-small text-ink2">{t("agent.brainSaved")}</p> : null}
    </Section>
  );
}

function DeleteConfirm({
  agent,
  onCancel,
  onDeleted,
}: {
  agent: AgentView;
  onCancel: () => void;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <div className="rise flex flex-col gap-3 rounded-card border border-red-line bg-red-tint px-4 py-3.5">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">{t("agent.deleteTitle", { name: agent.name })}</span>
        <span className="text-small text-ink2">{t("agent.deleteBody")}</span>
      </div>
      <div className="flex gap-2">
        <Button
          variant="danger"
          small
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await api.remove(agent.id);
            await onDeleted();
          }}
        >
          {t("agent.deleteYes")}
        </Button>
        <Button variant="ghost" small onClick={onCancel}>
          {t("agent.deleteNo")}
        </Button>
      </div>
    </div>
  );
}

/** Disabled while the request runs, so a double click does not send it twice. */
function RetryButton({ onRetry, label }: { onRetry: () => Promise<void>; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      small
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await onRetry().finally(() => setBusy(false));
      }}
    >
      {label}
    </Button>
  );
}

function ActivityList({ items, onRetry }: { items: Activity[]; onRetry: (ids: string[]) => Promise<void> }) {
  const { t, locale } = useI18n();
  return (
    <Group>
      {items.map((m) => {
        const who = m.sender ?? (m.senderIsOwner ? t("activity.you") : t("activity.someone"));
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
                <p className="flex items-center gap-1.5 text-caption text-amber">
                  <StatusDot state="awaiting_approval" />
                  {t("agent.unanswered")}
                  <RetryLink onRetry={() => onRetry([m.id])} />
                </p>
              ) : null}
              {m.direction === "in" && m.state === "failed" ? (
                <p className="flex items-center gap-1.5 text-caption text-red">
                  <StatusDot state="error" />
                  {t("agent.failed")}
                  <RetryLink onRetry={() => onRetry([m.id])} />
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
    </Group>
  );
}

/** "Retry" inline after a message's state, in the same small type. */
function RetryLink({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className="ml-1 font-medium text-accent hover:underline disabled:opacity-45"
      onClick={async () => {
        setBusy(true);
        await onRetry().finally(() => setBusy(false));
      }}
    >
      {t("agent.retry")}
    </button>
  );
}
