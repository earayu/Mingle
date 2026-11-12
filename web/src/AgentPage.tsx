import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type Activity,
  type AgentView,
  api,
  type ConnectionView,
  type CredentialField,
  type OnboardingState,
  type Platform,
  type PlatformInfo,
  type Reminder,
  type Task,
} from "./api.ts";
import { errorText, type MessageKey, useI18n } from "./i18n.ts";
import {
  AgentStatusLine,
  Avatar,
  Button,
  Field,
  Input,
  Muted,
  relativeTime,
  Section,
  StatusDot,
  shortDateTime,
  Textarea,
} from "./ui.tsx";

export function AgentPage({
  agent,
  onChanged,
  onDeleted,
}: {
  agent: AgentView;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { t, locale } = useI18n();
  const [activity, setActivity] = useState<Activity[]>([]);
  const [work, setWork] = useState<{ tasks: Task[]; reminders: Reminder[] }>({ tasks: [], reminders: [] });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when switching to another agent
  useEffect(() => {
    setConfirmDelete(false);
    setNotice(null);
  }, [agent.id]);

  async function stop() {
    const { stopped } = await api.stop(agent.id);
    setNotice(t(stopped ? "agent.stopped" : "agent.idleNothing"));
  }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex items-center gap-4">
        <Avatar name={agent.name} size={48} />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-title font-semibold" title={agent.name}>
            {agent.name}
          </h1>
          <AgentStatusLine status={agent.status} detail={agent.status === "working" ? agent.statusDetail : null} />
        </div>
      </header>
      {agent.status === "error" && agent.statusDetail ? (
        <p className="-mt-6 rounded-sm bg-surface px-3 py-2 font-mono text-small wrap-anywhere text-text-secondary">
          {agent.statusDetail}
        </p>
      ) : null}

      <RoleEditor agent={agent} onSaved={onChanged} />
      <Connections agent={agent} onChanged={onChanged} />

      <Section title={t("agent.activity")}>
        {activity.length === 0 ? <Muted>{t("agent.noActivity")}</Muted> : <ActivityList items={activity} />}
      </Section>

      {work.tasks.length > 0 ? (
        <Section title={t("agent.tasks")}>
          <ul className="flex flex-col">
            {work.tasks.map((task) => (
              <li key={task.id} className="flex h-11 items-center gap-3 border-b border-border last:border-0">
                <span className="w-16 shrink-0 text-small text-text-secondary">
                  {t(`task.${task.status}` as MessageKey)}
                </span>
                <span className="min-w-0 flex-1 truncate" title={task.title}>
                  {task.title}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {work.reminders.length > 0 ? (
        <Section title={t("agent.reminders")}>
          <ul className="flex flex-col">
            {work.reminders.map((r) => (
              <li key={r.id} className="flex h-11 items-center gap-3 border-b border-border last:border-0">
                <span className="w-28 shrink-0 whitespace-nowrap text-small text-text-secondary">
                  {r.nextFireAt ? shortDateTime(r.nextFireAt, locale) : ""}
                </span>
                <span className="min-w-0 flex-1 truncate" title={r.body}>
                  {r.body}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-6">
        <Button onClick={() => api.openHome(agent.id)}>{t("agent.openHome")}</Button>
        <Button onClick={stop}>{t("agent.stop")}</Button>
        {confirmDelete ? (
          <span className="flex items-center gap-2">
            <span className="text-small text-text-secondary">{t("agent.deleteConfirm", { name: agent.name })}</span>
            <Button
              variant="primary"
              onClick={async () => {
                await api.remove(agent.id);
                onDeleted();
              }}
            >
              {t("agent.deleteYes")}
            </Button>
            <Button variant="text" onClick={() => setConfirmDelete(false)}>
              {t("agent.deleteNo")}
            </Button>
          </span>
        ) : (
          <Button variant="text" onClick={() => setConfirmDelete(true)}>
            {t("agent.delete")}
          </Button>
        )}
        {notice ? <span className="text-small text-text-secondary">{notice}</span> : null}
      </footer>
    </div>
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
    <Section title={t("agent.role")}>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea autoFocus rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="primary" onClick={save}>
              {t("agent.save")}
            </Button>
            <Button variant="text" onClick={() => setEditing(false)}>
              {t("agent.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setEditing(true);
            setSaved(false);
          }}
          className="-mx-3 rounded-sm px-3 py-2 text-left whitespace-pre-wrap wrap-anywhere hover:bg-surface"
        >
          {agent.role.trim() ? agent.role.trim() : <span className="text-text-tertiary">{t("agent.roleEmpty")}</span>}
        </button>
      )}
      {saved ? <p className="text-small text-text-secondary">{t("agent.roleSaved")}</p> : null}
    </Section>
  );
}

function Connections({ agent, onChanged }: { agent: AgentView; onChanged: () => void }) {
  const { t } = useI18n();
  // ?connect=<platform> opens the add panel on that platform (deep link; used by scripts/ui-review.mjs).
  const [linked] = useState(() => new URLSearchParams(location.search).get("connect") as Platform | null);
  const [adding, setAdding] = useState(Boolean(linked));

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when switching to another agent
  useEffect(() => setAdding((current) => current && Boolean(linked)), [agent.id]);

  return (
    <Section
      title={t("agent.chatApps")}
      action={
        adding ? null : (
          <Button variant="text" onClick={() => setAdding(true)}>
            {t("agent.add")}
          </Button>
        )
      }
    >
      {agent.connections.length === 0 && !adding ? <Muted>{t("agent.noConnections")}</Muted> : null}
      <ul className="flex flex-col">
        {agent.connections.map((c) => (
          <ConnectionRow key={c.id} connection={c} onChanged={onChanged} />
        ))}
      </ul>
      {adding ? (
        <AddConnection
          agentId={agent.id}
          agentName={agent.name}
          initial={linked}
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
    </Section>
  );
}

function ConnectionRow({ connection, onChanged }: { connection: ConnectionView; onChanged: () => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const detailKey = `connection.detail.${connection.detail}` as MessageKey;
  const hint =
    connection.state === "error"
      ? t(detailKey) !== detailKey
        ? t(detailKey)
        : t("connection.detail.unknown")
      : connection.state === "awaiting_approval"
        ? t("connection.approvalHint")
        : connection.state === "connected" && !connection.owner
          ? t("connection.noOwner")
          : null;

  return (
    <li className="flex flex-col gap-1 border-b border-border py-3 last:border-0">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate" title={connection.bot ?? undefined}>
            {connection.bot ?? t(`platform.${connection.platform}` as MessageKey)}
          </span>
          <span className="text-small text-text-secondary">{t(`platform.${connection.platform}` as MessageKey)}</span>
        </div>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-1">
            <Button
              variant="primary"
              onClick={async () => {
                await api.disconnect(connection.id);
                onChanged();
              }}
            >
              {t("connection.removeYes")}
            </Button>
            <Button variant="text" onClick={() => setConfirming(false)}>
              {t("agent.deleteNo")}
            </Button>
          </span>
        ) : (
          <>
            <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-small text-text-secondary">
              <StatusDot state={connection.state} />
              {t(`connection.${connection.state}` as MessageKey)}
            </span>
            <Button variant="text" className="shrink-0" onClick={() => setConfirming(true)}>
              {t("connection.remove")}
            </Button>
          </>
        )}
      </div>
      {confirming ? <p className="text-small text-text-secondary">{t("connection.removeConfirm")}</p> : null}
      {!confirming && connection.invite ? (
        <a
          href={connection.invite}
          target="_blank"
          rel="noreferrer"
          className="self-start text-small text-text-secondary underline-offset-2 hover:text-text hover:underline"
        >
          {t("connection.invite")} ↗
        </a>
      ) : null}
      {!confirming && hint ? (
        <p className={`text-small ${connection.state === "error" ? "text-error" : "text-text-tertiary"}`}>{hint}</p>
      ) : null}
    </li>
  );
}

function AddConnection({
  agentId,
  agentName,
  initial,
  onDone,
  onCancel,
}: {
  agentId: string;
  agentName: string;
  initial: Platform | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [chosen, setChosen] = useState<Platform | null>(initial);

  useEffect(() => {
    api
      .platforms()
      .then(setPlatforms)
      .catch(() => {});
  }, []);

  const [manual, setManual] = useState(false);
  const info = platforms.find((p) => p.platform === chosen);
  const back = () => {
    setChosen(null);
    setManual(false);
  };
  if (chosen && info?.onboarding?.kind === "credentials") {
    return (
      <CredentialsForm
        agentId={agentId}
        info={info}
        fields={info.onboarding.fields}
        {...(info.onboarding.setupUrl ? { setupUrl: withAgentName(info.onboarding.setupUrl, agentName) } : {})}
        onDone={onDone}
        onBack={back}
      />
    );
  }
  if (chosen && info?.onboarding?.kind === "qr") {
    return manual ? (
      <CredentialsForm
        agentId={agentId}
        info={info}
        fields={info.manualFields}
        onDone={onDone}
        onBack={() => setManual(false)}
      />
    ) : (
      <QrOnboarding
        agentId={agentId}
        info={info}
        onDone={onDone}
        onBack={back}
        {...(info.manualFields.length ? { onManual: () => setManual(true) } : {})}
      />
    );
  }

  return (
    <div className="panel flex flex-col gap-3 rounded-md bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-small text-text-secondary">{t("connect.title")}</span>
        <Button variant="text" onClick={onCancel}>
          {t("create.cancel")}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {platforms.map((p) => (
          <button
            key={p.platform}
            type="button"
            disabled={!p.onboarding}
            onClick={() => setChosen(p.platform)}
            className="flex h-14 flex-col items-start justify-center rounded-sm bg-bg px-3 text-left enabled:hover:ring-1 enabled:hover:ring-border disabled:opacity-50"
          >
            <span>{t(`platform.${p.platform}` as MessageKey)}</span>
            {!p.onboarding ? <span className="text-small text-text-tertiary">{t("connect.soon")}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Put the agent's name into a prefilled setup link (it sits inside URL-encoded JSON). */
function withAgentName(url: string, name: string): string {
  const safe = JSON.stringify(name.trim().slice(0, 35)).slice(1, -1);
  // Handles allow only a-z, 0-9, "-", "_" and "."; names in other scripts fall back to a generic one.
  const handle =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "mingle-agent";
  return url
    .replaceAll("__MINGLE_AGENT_NAME__", encodeURIComponent(safe))
    .replaceAll("__MINGLE_AGENT_HANDLE__", encodeURIComponent(handle));
}

function CredentialsForm({
  agentId,
  info,
  fields,
  setupUrl,
  onDone,
  onBack,
}: {
  agentId: string;
  info: PlatformInfo;
  fields: CredentialField[];
  setupUrl?: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.connect(agentId, info.platform, values);
      onDone();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  const steps = `${info.platform}.${info.onboarding?.kind === "qr" ? "manualSteps" : "steps"}` as MessageKey;
  return (
    <form onSubmit={submit} className="panel flex flex-col gap-4 rounded-md bg-surface p-4">
      <span className="text-heading font-semibold">{t(`platform.${info.platform}` as MessageKey)}</span>
      {/* One line reads as a sentence; several become numbered steps. */}
      {t(steps).includes("\n") ? (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-small text-text-secondary">
          {t(steps)
            .split("\n")
            .map((line) => (
              <li key={line}>{line}</li>
            ))}
        </ol>
      ) : (
        <p className="text-small text-text-secondary">{t(steps)}</p>
      )}
      {setupUrl ? (
        <a
          href={setupUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center self-start rounded-sm border border-border bg-bg px-3 text-body text-text transition-colors duration-[120ms] hover:border-text-tertiary"
        >
          {t(`${info.platform}.setup` as MessageKey)} ↗
        </a>
      ) : null}
      {fields.map((f, i) => (
        <Field key={f.key} label={t(f.labelKey as MessageKey)}>
          <Input
            autoFocus={i === 0}
            required
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            value={values[f.key] ?? ""}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          />
        </Field>
      ))}
      {error ? <p className="text-small text-error">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t("connect.connecting") : t("connect.connect")}
        </Button>
        <Button variant="text" onClick={onBack}>
          {t("connect.back")}
        </Button>
      </div>
    </form>
  );
}

/** Scan-to-create flow (DESIGN.md "接入 IM"): QR, three steps, state advancing in place. */
function QrOnboarding({
  agentId,
  info,
  onDone,
  onBack,
  onManual,
}: {
  agentId: string;
  info: PlatformInfo;
  onDone: () => void;
  onBack: () => void;
  onManual?: () => void;
}) {
  const { t } = useI18n();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<OnboardingState>({ state: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const platformName = t(`platform.${info.platform}` as MessageKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt restarts the flow
  useEffect(() => {
    let id: string | null = null;
    let stopped = false;
    setState({ state: "starting" });
    api
      .startOnboarding(agentId, info.platform)
      .then((r) => {
        id = r.id;
        if (stopped) api.cancelOnboarding(r.id).catch(() => {});
        else setSessionId(r.id);
      })
      .catch((e) => setState({ state: "failed", code: (e as { code?: string }).code ?? "unknown" }));
    return () => {
      stopped = true;
      if (id) api.cancelOnboarding(id).catch(() => {});
    };
  }, [agentId, info.platform, attempt]);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const tick = async () => {
      const next = await api.onboarding(sessionId).catch(() => null);
      if (!active || !next) return;
      setState(next);
      if (next.state === "done") {
        active = false;
        setTimeout(onDone, next.pendingApproval ? 2500 : 800);
      }
    };
    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sessionId, onDone]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const expired = state.state === "qr" && state.expiresAt <= now;
  const failedExpired = state.state === "failed" && state.code === "expired";
  const remaining = state.state === "qr" ? Math.max(0, Math.round((state.expiresAt - now) / 1000)) : 0;
  const restart = () => {
    setSessionId(null);
    setAttempt((n) => n + 1);
  };

  return (
    <div className="panel flex flex-col gap-4 rounded-md bg-surface p-4">
      <span className="text-heading font-semibold">{platformName}</span>
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        {/* The QR stays on white in both themes so phones can read it; text on it uses fixed light-theme greys. */}
        <div className="flex size-[248px] shrink-0 items-center justify-center rounded-md bg-white p-6">
          {state.state === "qr" && !expired ? (
            <div
              className="size-[200px] [&_svg]:size-full"
              role="img"
              aria-label={t("qr.label", { platform: platformName })}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG generated by our own server from a URL
              dangerouslySetInnerHTML={{ __html: state.qrSvg }}
            />
          ) : expired || failedExpired ? (
            <Button onClick={restart}>{t("qr.refresh")}</Button>
          ) : state.state === "done" || state.state === "awaiting_approval" || state.state === "scanned" ? (
            <span className="text-center text-small text-[#6b6b66]">{t("qr.scanned")}</span>
          ) : state.state === "failed" ? null : (
            <span className="text-small text-[#a3a39e]">{t("qr.loading")}</span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-text-secondary">
            <li>{t(`${info.platform}.qr1` as MessageKey)}</li>
            <li>{t(`${info.platform}.qr2` as MessageKey)}</li>
            <li>{t(`${info.platform}.qr3` as MessageKey)}</li>
          </ol>
          <OnboardingStatus state={state} expired={expired} remaining={remaining} platformName={platformName} />
          {state.state === "needs_code" && sessionId ? <CodeForm sessionId={sessionId} retry={state.retry} /> : null}
          {state.state === "qr" && !expired && info.onboarding?.kind === "qr" && info.onboarding.desktopLink ? (
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer"
              className="text-small text-text-secondary underline underline-offset-2 hover:text-text"
            >
              {t("qr.openHere")}
            </a>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="text" onClick={onBack}>
          {t("connect.back")}
        </Button>
        {onManual && state.state !== "done" ? (
          <Button variant="text" onClick={onManual}>
            {t("qr.manual")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The code the phone shows after scanning, typed here (WeChat asks for this on some accounts). */
function CodeForm({ sessionId, retry }: { sessionId: string; retry: boolean }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the field when the platform asks again
  useEffect(() => setCode(""), [retry]);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await api.submitCode(sessionId, code).catch(() => {});
        setBusy(false);
      }}
    >
      <Field label={t("qr.codeLabel")}>
        <Input
          autoFocus
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={busy || !code.trim()}>
        {t("qr.codeSubmit")}
      </Button>
    </form>
  );
}

function OnboardingStatus({
  state,
  expired,
  remaining,
  platformName,
}: {
  state: OnboardingState;
  expired: boolean;
  remaining: number;
  platformName: string;
}) {
  const { t } = useI18n();
  const line = (dot: string, text: string, tone = "text-text-secondary") => (
    <p className={`flex items-start gap-2 text-small ${tone}`}>
      {/* One text line tall, so the dot centres on the first line. */}
      <span className="flex h-[18px] shrink-0 items-center">
        <StatusDot state={dot} />
      </span>
      <span>{text}</span>
    </p>
  );
  if (expired || (state.state === "failed" && state.code === "expired")) return line("offline", t("qr.expired"));
  switch (state.state) {
    case "starting":
      return line("offline", t("qr.loading"));
    case "qr":
      // Minutes while there is plenty of time; a ticking clock only in the last two minutes.
      return line(
        "awaiting_credentials",
        remaining > 120
          ? t("qr.waitingMinutes", { minutes: String(Math.ceil(remaining / 60)) })
          : t("qr.waiting", {
              minutes: String(Math.floor(remaining / 60)),
              seconds: String(remaining % 60).padStart(2, "0"),
            }),
      );
    case "scanned":
      return line("reconnecting", t("qr.scanned"));
    case "awaiting_approval":
      return line("awaiting_approval", t("connection.approvalHint"));
    case "needs_code":
      return line("reconnecting", t(state.retry ? "qr.codeRetry" : "qr.code"));
    case "done":
      return state.pendingApproval
        ? line("awaiting_approval", t("qr.donePending"))
        : line("connected", t("qr.done", { platform: platformName }));
    case "failed":
      return line("error", errorTextFor(t, state.code), "text-error");
  }
}

function errorTextFor(t: ReturnType<typeof useI18n>["t"], code: string): string {
  const key = `qr.failed.${code}` as MessageKey;
  const text = t(key);
  return text === key ? t("qr.failed.unknown") : text;
}

function ActivityList({ items }: { items: Activity[] }) {
  const { t, locale } = useI18n();
  return (
    <ul className="flex flex-col">
      {items.map((m) => (
        <li key={m.id} className="flex flex-col gap-0.5 border-b border-border py-3 last:border-0">
          <div className="flex items-baseline gap-2 text-small text-text-secondary">
            <span className="max-w-[45%] shrink-0 truncate font-semibold text-text" title={m.sender ?? undefined}>
              {m.sender ?? (m.senderIsOwner ? t("activity.you") : t("activity.someone"))}
            </span>
            <span className="min-w-0 flex-1 truncate" title={m.chat.name ?? undefined}>
              {t(`platform.${m.platform}` as MessageKey)} ·{" "}
              {m.chat.kind === "dm" ? t("chat.dm") : (m.chat.name ?? t("chat.group"))}
            </span>
            <span className="shrink-0 whitespace-nowrap">{relativeTime(m.createdAt, locale)}</span>
          </div>
          <p className="line-clamp-3 whitespace-pre-wrap wrap-anywhere">{m.body}</p>
          {m.files.length ? (
            <p className="truncate font-mono text-small text-text-secondary" title={m.files.join(", ")}>
              {m.files.join(", ")}
            </p>
          ) : null}
          {m.direction === "in" && m.state === "unanswered" ? (
            <p className="flex items-center gap-2 text-small text-text-secondary">
              <StatusDot state="error" />
              {t("agent.unanswered")}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
