import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type Activity,
  type AgentView,
  api,
  type ConnectionView,
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
  const { t } = useI18n();
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
          <h1 className="truncate text-title font-semibold">{agent.name}</h1>
          <AgentStatusLine status={agent.status} detail={agent.statusDetail} />
        </div>
      </header>

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
                <span className="w-20 shrink-0 text-small text-text-secondary">{task.status.replace("_", " ")}</span>
                <span className="truncate">{task.title}</span>
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
                <span className="w-32 shrink-0 text-small text-text-secondary">
                  {r.nextFireAt
                    ? new Date(r.nextFireAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
                    : ""}
                </span>
                <span className="truncate">{r.body}</span>
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
          className="-mx-3 rounded-sm px-3 py-2 text-left whitespace-pre-wrap hover:bg-surface"
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
  const [adding, setAdding] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when switching to another agent
  useEffect(() => setAdding(false), [agent.id]);

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
  return (
    <li className="group flex min-h-11 flex-col justify-center border-b border-border py-2 last:border-0">
      <div className="flex items-center gap-3">
        <span className="w-20 shrink-0 text-text-secondary">{t(`platform.${connection.platform}` as MessageKey)}</span>
        <span className="min-w-0 flex-1 truncate">{connection.bot ?? ""}</span>
        <span className="flex items-center gap-2 text-small text-text-secondary">
          <StatusDot state={connection.state} />
          {t(`connection.${connection.state}` as MessageKey)}
        </span>
        <Button
          variant="text"
          className="opacity-0 group-hover:opacity-100 focus:opacity-100"
          onClick={async () => {
            await api.disconnect(connection.id);
            onChanged();
          }}
        >
          {t("connection.remove")}
        </Button>
      </div>
      {connection.state === "connected" && !connection.owner ? (
        <p className="pl-23 text-small text-text-tertiary">{t("connection.noOwner")}</p>
      ) : null}
      {connection.state === "error" && connection.detail ? (
        <p className="pl-23 text-small text-error">{connection.detail}</p>
      ) : null}
    </li>
  );
}

function AddConnection({ agentId, onDone, onCancel }: { agentId: string; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [chosen, setChosen] = useState<Platform | null>(null);

  useEffect(() => {
    api
      .platforms()
      .then(setPlatforms)
      .catch(() => {});
  }, []);

  const info = platforms.find((p) => p.platform === chosen);
  if (chosen && info?.onboarding?.kind === "credentials") {
    return <CredentialsForm agentId={agentId} info={info} onDone={onDone} onBack={() => setChosen(null)} />;
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

function CredentialsForm({
  agentId,
  info,
  onDone,
  onBack,
}: {
  agentId: string;
  info: PlatformInfo;
  onDone: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const fields = info.onboarding?.kind === "credentials" ? info.onboarding.fields : [];
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

  const steps = `${info.platform}.steps` as MessageKey;
  return (
    <form onSubmit={submit} className="panel flex flex-col gap-4 rounded-md bg-surface p-4">
      <span className="text-heading font-semibold">{t(`platform.${info.platform}` as MessageKey)}</span>
      <p className="text-small text-text-secondary">{t(steps)}</p>
      {fields.map((f) => (
        <Field key={f.key} label={t(f.labelKey as MessageKey)}>
          <Input
            autoFocus
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

function ActivityList({ items }: { items: Activity[] }) {
  const { t, locale } = useI18n();
  return (
    <ul className="flex flex-col">
      {items.map((m) => (
        <li key={m.id} className="flex flex-col gap-0.5 border-b border-border py-3 last:border-0">
          <div className="flex items-center gap-2 text-small text-text-secondary">
            <span className="truncate font-semibold text-text">{m.sender ?? ""}</span>
            <span className="truncate">
              {t(`platform.${m.platform}` as MessageKey)}
              {m.chat.kind !== "dm" && m.chat.name ? ` · ${m.chat.name}` : ""}
            </span>
            <span className="ml-auto shrink-0">{relativeTime(m.createdAt, locale)}</span>
          </div>
          <p className="line-clamp-3 whitespace-pre-wrap break-words">{m.body}</p>
          {m.files.length ? <p className="text-small text-text-secondary">{m.files.join(", ")}</p> : null}
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
