import { useCallback, useEffect, useState } from "react";
import {
  type AccessEntry,
  type AgentView,
  api,
  type BotPermission,
  type ConnectionView,
  type PermissionId,
  type PlatformInfo,
} from "./api.ts";
import { QrFlow } from "./Connect.tsx";
import { AllMe, Contacts } from "./Contacts.tsx";
import { prefetchCached, useCached } from "./cache.ts";
import { errorText, type MessageKey, useI18n } from "./i18n.ts";
import { PlatformIcon } from "./platforms.tsx";
import { onEscape } from "./shortcuts.ts";
import { Button, Group, GroupRow, MoreMenu, PlusIcon, Section, StatusDot } from "./ui.tsx";

export const connectionRowId = (id: string) => `connection-${id}`;
const listRowId = (id: string) => `chat-app-${id}`;

/**
 * The agent's bots in its settings (docs/spec.md 4.7, DESIGN.md "Agent · 设置"): one row each, like a
 * Mac settings list. A row opens the bot's own page, where its people and who can reach it live.
 */
export function ChatAppList({
  agent,
  onOpen,
  onConnect,
  onChanged,
}: {
  agent: AgentView;
  onOpen: (connectionId: string) => void;
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
            <ChatAppRow
              key={c.id}
              connection={c}
              onOpen={() => onOpen(c.id)}
              onPrefetch={() => {
                prefetchCached(`contacts:${agent.id}`, () => api.contacts(agent.id), 10_000);
                prefetchCached("platforms", api.platforms, 60_000);
              }}
            />
          ))}
        </Group>
      )}
      <AllMe agent={agent} onChanged={onChanged} />
    </Section>
  );
}

function ChatAppRow({
  connection,
  onOpen,
  onPrefetch,
}: {
  connection: ConnectionView;
  onOpen: () => void;
  onPrefetch?: () => void;
}) {
  const { t } = useI18n();
  const platform = t(`platform.${connection.platform}` as MessageKey);
  const owner = connection.ownerContact;
  return (
    <button
      type="button"
      id={listRowId(connection.id)}
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      className="flex min-h-[56px] w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left transition-colors duration-[120ms] hover:bg-bg2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      <PlatformIcon platform={connection.platform} size={32} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium" title={connection.bot ?? undefined}>
          {connection.bot ?? platform}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-small text-ink2">
          <StatusDot state={connection.state} />
          <span className="truncate">
            {platform} · {t(`connection.${connection.state}` as MessageKey)}
            {owner && (owner.name || connection.ownerShared)
              ? ` · ${owner.name ? t("connection.ownerIs", { name: owner.name }) : t("connection.ownerUnnamed")}`
              : null}
          </span>
        </span>
      </span>
      <ChevronIcon />
      {connection.state === "error" ? (
        <span className="w-full pl-11 text-caption text-red">{connectionDetail(t, connection)}</span>
      ) : null}
    </button>
  );
}

/** Back from a bot's page lands on its row in the list. */
export function focusChatAppRow(connectionId: string) {
  const row = document.getElementById(listRowId(connectionId));
  row?.scrollIntoView({ block: "center" });
  row?.focus({ preventScroll: true });
}

/**
 * One bot, opened from the list: the bot itself with its actions, who can reach it, and the people
 * who wrote to it. A page in place, as a Mac settings pane drills in; never a dialog.
 */
export function BotPage({
  agent,
  connection,
  onBack,
  onChanged,
}: {
  agent: AgentView;
  connection: ConnectionView;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <nav className="-mb-3 -ml-2.5">
        <Button variant="ghost" small onClick={onBack}>
          <BackIcon />
          {t("agent.tabSettings")}
        </Button>
      </nav>
      <section aria-label={connection.bot ?? t(`platform.${connection.platform}` as MessageKey)}>
        <Group>
          <ConnectionRow connection={connection} onChanged={onChanged} onRemoved={onBack} />
        </Group>
      </section>
      <BotPermissions agent={agent} connection={connection} onChanged={onChanged} />
      <BotAccess agent={agent} connection={connection} onChanged={onChanged} />
      <Contacts key={`contacts-${agent.id}`} agent={agent} connection={connection.id} onChanged={onChanged} />
    </>
  );
}

/**
 * The platform permissions this bot's app has (docs/spec.md 4.2, 6.1). Where the platform can add
 * grants to an existing app (Feishu), each permission is a row: what it gives the agent, and either
 * "On" or a button that runs the scan again in place for that one permission (the confirm page lists
 * what is being added, and the same connection keeps working). Optional ones are not asked for when
 * the bot is created, so connecting stays simple, and are turned on here later. Elsewhere, a bot that
 * only sees the group messages that @ it says so, with a link to the platform's own setting.
 */
function BotPermissions({
  agent,
  connection,
  onChanged,
}: {
  agent: AgentView;
  connection: ConnectionView;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { value: platforms } = useCached<PlatformInfo[]>("platforms", api.platforms, []);
  /** The scan running in place, with the permissions it adds; null while none is. */
  const [scanning, setScanning] = useState<PermissionId[] | null>(null);
  const [read, setRead] = useState(0);
  const permissions = usePermissions(connection.id, connection.state === "connected", read);
  const missing = permissions?.find((p) => p.id === "group_messages" && !p.granted) ?? null;
  /** Every permission not granted yet; one scan can turn them all on (docs/spec.md 6.1). */
  const off = permissions?.filter((p) => !p.granted) ?? [];
  const info = platforms?.find((p) => p.platform === connection.platform);
  const rescan = Boolean(info?.reauthorize);
  const grant = missing?.grant;
  if (!rescan && !grant) return null;

  if (!rescan) {
    const steps = grant?.steps;
    return (
      <Section title={t("connection.permissions")}>
        <p className="-mt-1 px-1 text-small text-ink2">
          {steps
            ? t("permission.missingWithSteps", {
                missing: t("permission.groupMessages"),
                steps: t(`permission.steps.${steps}` as MessageKey),
              })
            : t("permission.groupMessages")}
        </p>
        {grant ? (
          <a
            href={grant.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center self-start rounded-control border border-line2 px-2.5 text-small font-medium hover:bg-bg3"
          >
            {t("permission.grant")}
          </a>
        ) : null}
      </Section>
    );
  }

  return (
    <Section title={t("connection.permissions")}>
      {scanning && info ? (
        <div className="flex flex-col items-start gap-4 rounded-card border border-line bg-card px-4 py-3.5">
          <QrFlow
            agent={agent}
            info={info}
            update={connection.id}
            adding={scanning}
            onDone={() => {
              setScanning(null);
              setRead((n) => n + 1);
              void onChanged();
            }}
          />
          <Button variant="ghost" small onClick={() => setScanning(null)}>
            {t("agent.cancel")}
          </Button>
        </div>
      ) : permissions && permissions.length > 0 ? (
        <>
          <Group>
            {permissions.map((p) => (
              <GroupRow key={p.id}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span>{t(`permission.name.${p.id}` as MessageKey)}</span>
                  <span className="text-small text-ink2">
                    {t(`permission.about.${p.id}` as MessageKey, { name: agent.name })}
                  </span>
                </span>
                {p.granted ? (
                  <span className="shrink-0 text-small text-ink3">{t("permission.on")}</span>
                ) : (
                  <Button small className="shrink-0" onClick={() => setScanning([p.id])}>
                    {t("permission.turnOn")}
                  </Button>
                )}
              </GroupRow>
            ))}
          </Group>
          <div className="flex items-center gap-3 px-1">
            {off.length > 1 ? (
              <Button small className="shrink-0" onClick={() => setScanning(off.map((p) => p.id))}>
                {t("permission.turnOnAll")}
              </Button>
            ) : null}
            <p className="text-caption text-ink3">{t("permission.rescanHint")}</p>
          </div>
        </>
      ) : (
        <>
          <p className="-mt-1 px-1 text-small text-ink2">{t("connection.permissionsHint")}</p>
          <Button variant="ghost" small className="self-start" onClick={() => setScanning([])}>
            {t("connection.permissionsUpdate")}
          </Button>
        </>
      )}
    </Section>
  );
}

/**
 * Who can talk to the agent through this bot (docs/spec.md 4.7), said for this bot's chat app: the
 * rule in one sentence, the one switch where it changes anything, and the groups already decided.
 * People decided show in the contacts below, with their decision.
 */
function BotAccess({
  agent,
  connection,
  onChanged,
}: {
  agent: AgentView;
  connection: ConnectionView;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<AccessEntry[] | null>(null);
  const [all, setAll] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setEntries(await api.access(agent.id));
    } catch {
      setEntries((current) => current ?? []);
    }
  }, [agent.id]);
  // Read again when a request is answered elsewhere (the side panel), as well as on opening.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the count is the signal to read again
  useEffect(() => {
    void load();
  }, [load, agent.requests.length]);
  const change = async (entry: AccessEntry, access: "allowed" | "blocked") => {
    setFailure(null);
    try {
      await api.setAccess(agent.id, entry.kind, entry.id, access);
    } catch (error) {
      setFailure(errorText(t, error));
    }
    await load();
    onChanged();
  };
  const platform = t(`platform.${connection.platform}` as MessageKey);
  const groups = (entries ?? []).filter((e) => e.kind === "group" && e.connection === connection.id);
  const shown = all ? groups : groups.slice(0, 6);
  const org = connection.trust === "org";
  return (
    <Section title={t("access.title")}>
      <p className="-mt-1 px-1 text-small text-ink2">
        {t(`access.rule.${connection.trust}` as MessageKey, { platform, name: agent.name })}
      </p>
      {org || shown.length > 0 ? (
        <Group>
          {org ? (
            <GroupRow>
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span>{t("access.askAll")}</span>
                  <span className="text-small text-ink2">{t("access.askAllHint", { name: agent.name })}</span>
                </span>
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-[var(--accent-btn)]"
                  checked={agent.askAll}
                  onChange={async (e) => {
                    setFailure(null);
                    try {
                      await api.setAskAll(agent.id, e.target.checked);
                    } catch (error) {
                      setFailure(errorText(t, error));
                    }
                    onChanged();
                  }}
                />
              </label>
            </GroupRow>
          ) : null}
          {shown.map((entry) => (
            <GroupRow key={entry.id}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate" title={entry.name ?? undefined}>
                  {entry.name ?? t("access.unnamed")}
                </span>
                <span className="truncate text-caption text-ink2">{t("chat.group")}</span>
              </span>
              <span className="shrink-0 text-small text-ink3">
                {t(entry.access === "blocked" ? "access.declined" : "access.allowed")}
              </span>
              <MoreMenu
                label={t("agent.more")}
                items={[
                  entry.access === "allowed"
                    ? { label: t("access.revoke"), danger: true, onSelect: () => void change(entry, "blocked") }
                    : { label: t("access.allow"), onSelect: () => void change(entry, "allowed") },
                ]}
              />
            </GroupRow>
          ))}
        </Group>
      ) : null}
      {groups.length > shown.length ? (
        <Button variant="ghost" small className="self-start" onClick={() => setAll(true)}>
          {t("access.showAll", { count: String(groups.length) })}
        </Button>
      ) : null}
      {failure ? <p className="px-1 text-caption text-red">{failure}</p> : null}
    </Section>
  );
}

function BackIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0" aria-hidden="true">
      <path
        d="m7.5 2.5-3.5 3.5 3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ConnectionRow({
  connection,
  onChanged,
  onRemoved,
}: {
  connection: ConnectionView;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const platform = t(`platform.${connection.platform}` as MessageKey);
  const owner = connection.ownerContact;
  // Another bot on this platform has a different owner: name them, or both read as "you".
  const shared = connection.ownerShared;
  const hint =
    connection.state === "error"
      ? connectionDetail(t, connection)
      : shared && owner && !owner.name
        ? t("connection.nameOwnerHint", { platform })
        : null;
  return (
    <GroupRow id={connectionRowId(connection.id)} tabIndex={-1} className="flex-wrap outline-none">
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
      {confirming ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape backs out of the question it belongs to
        <span
          className="flex shrink-0 items-center gap-1.5"
          onKeyDown={onEscape(() => {
            if (!removing) setConfirming(false);
          })}
        >
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
                onRemoved();
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
          <Button small variant="ghost" autoFocus disabled={removing} onClick={() => setConfirming(false)}>
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
            items={[{ label: t("connection.remove"), danger: true, onSelect: () => setConfirming(true) }]}
          />
        </span>
      )}
      {failure ? <p className="w-full pl-11 text-caption text-red">{failure}</p> : null}
      {hint ? (
        <p className={`w-full pl-11 text-caption ${connection.state === "error" ? "text-red" : "text-ink3"}`}>{hint}</p>
      ) : null}
      {connection.state === "connected" && connection.claim ? (
        <div className="w-full pl-11">
          <ClaimCode connection={connection} onChanged={onChanged} />
        </div>
      ) : null}
    </GroupRow>
  );
}

/**
 * The permissions the owner can grant this bot on its platform, read live (docs/spec.md 4.2), or
 * null while unknown (offline, or the platform would not say). Read again whenever the window comes
 * back, since the owner may grant one on the platform.
 */
function usePermissions(connectionId: string, connected: boolean, again: number): BotPermission[] | null {
  const [permissions, setPermissions] = useState<BotPermission[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` asks for a fresh read after a rescan.
  useEffect(() => {
    if (!connected) {
      setPermissions(null);
      return;
    }
    let live = true;
    const read = () =>
      api
        .permissions(connectionId)
        .then(({ permissions }) => {
          if (live) setPermissions(permissions);
        })
        .catch(() => {});
    void read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [connectionId, connected, again]);
  return permissions;
}

/**
 * How to claim a bot the platform named no owner for: the code, big enough to read off and type,
 * the one-tap link where the platform has one, and how long it lasts. Expired, a button for a new one.
 */
export function ClaimCode({
  connection,
  onChanged,
}: {
  connection: ConnectionView;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const claim = connection.claim;
  if (!claim) return null;
  const left = claim.expiresAt ? claim.expiresAt - Date.now() : 0;
  const code = claim.code && left > 0 ? claim.code : null;
  const renew = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.claim(connection.id);
      await onChanged();
    } catch (error) {
      setFailure(errorText(t, error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 py-1">
      <p className="text-small text-ink2">{t(code ? "connection.claimHint" : "connection.claimExpired")}</p>
      {code ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="selectable font-mono text-title3 font-semibold tracking-[0.18em]">{code}</span>
          {claim.url ? (
            <a
              href={claim.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center rounded-control border border-line2 px-2.5 text-small font-medium hover:bg-bg3"
            >
              {t("connection.claimOpen", { platform: t(`platform.${connection.platform}` as MessageKey) })}
            </a>
          ) : null}
          <span className="text-caption text-ink3">
            {t("connection.claimLeft", { minutes: String(Math.min(10, Math.max(1, Math.ceil(left / 60_000)))) })}
          </span>
        </div>
      ) : (
        <Button small className="self-start" disabled={busy} onClick={renew}>
          {t("connection.claimNew")}
        </Button>
      )}
      {failure ? <p className="text-caption text-red">{failure}</p> : null}
    </div>
  );
}

export function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-ink3" aria-hidden="true">
      <path
        d="m4.5 2.5 3.5 3.5-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function connectionDetail(t: ReturnType<typeof useI18n>["t"], c: ConnectionView): string {
  const key = `connection.detail.${c.detail}` as MessageKey;
  return t(key) !== key ? t(key) : t("connection.detail.unknown");
}

/** Try an offline bot again now. Offered on every error: waiting for the automatic retry is never the only way. */
export function ReconnectButton({ connection }: { connection: ConnectionView }) {
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
