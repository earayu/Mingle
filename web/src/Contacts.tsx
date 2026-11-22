import { type FormEvent, useState } from "react";
import { type AgentView, api, type ContactAccount, type ContactEntry } from "./api.ts";
import { useCached } from "./cache.ts";
import { errorText, type MessageKey, useI18n } from "./i18n.ts";
import { PlatformIcon } from "./platforms.tsx";
import { Button, Field, Group, GroupRow, HelpTip, Input, MoreMenu, Section, Select, Textarea } from "./ui.tsx";

/** Rows shown before "Show all": the people the agent talks to most recently. */
const FIRST_ROWS = 6;
/** The API's limit on a note, in UTF-8 bytes (docs/spec.md 4.2). */
const NOTE_MAX_BYTES = 2048;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const listFormats = new Map<string, Intl.ListFormat>();
function formatList(locale: string, items: readonly string[]): string {
  let fmt = listFormats.get(locale);
  if (!fmt) {
    fmt = new Intl.ListFormat(locale, { type: "conjunction" });
    listFormats.set(locale, fmt);
  }
  return fmt.format(items);
}
/** Remembered per agent and set of owner accounts: the owner said they are not all one person. */
const notAllMeKey = (agentId: string, ids: readonly string[]) =>
  `mingle:not-all-me:${agentId}:${[...ids].sort().join(",")}`;

/**
 * The agent's address book (docs/spec.md 4.2): everyone who has written to it, with the same human's
 * accounts on several chat apps linked into one person who shares a name and a note. Linking only
 * tells people apart; it grants nothing.
 */
export function Contacts({
  agent,
  connection,
  onChanged,
}: {
  agent: AgentView;
  /** The bot whose page this is: only the people who wrote to it are listed. */
  connection: string;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { value: everyone, reload } = useCached<ContactEntry[]>(
    `contacts:${agent.id}`,
    () => api.contacts(agent.id),
    [],
  );
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!everyone) return null;
  const entries = everyone.filter((e) => e.accounts.some((a) => a.connection === connection));
  const key = (e: ContactEntry) => e.person ?? (e.accounts[0] as ContactAccount).id;
  const changed = async () => {
    await reload();
    onChanged();
  };
  const waiting = new Set(agent.requests.filter((r) => r.kind === "contact").map((r) => r.id));
  const shown = all ? entries : entries.slice(0, FIRST_ROWS);
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-0.5">
          {t("contacts.title")}
          <HelpTip label={t("contacts.title")}>{t("contacts.help", { name: agent.name })}</HelpTip>
        </span>
      }
    >
      {entries.length === 0 ? (
        <p className="-mt-1 px-1 text-small text-ink3">{t("contacts.none", { name: agent.name })}</p>
      ) : (
        <Group>
          {shown.map((entry) =>
            open === key(entry) ? (
              <Editor
                key={key(entry)}
                agent={agent}
                entry={entry}
                others={everyone.filter((e) => key(e) !== key(entry))}
                onClose={() => setOpen(null)}
                onChanged={changed}
              />
            ) : (
              <Row
                key={key(entry)}
                agentName={agent.name}
                entry={entry}
                here={entry.accounts.filter((a) => a.connection === connection)}
                waiting={entry.accounts.some((a) => waiting.has(a.id))}
                onOpen={() => {
                  setOpen(key(entry));
                  setError(null);
                }}
              />
            ),
          )}
          {!all && entries.length > FIRST_ROWS ? (
            <GroupRow onClick={() => setAll(true)} className="text-small text-ink2 hover:text-ink">
              {t("contacts.showAll", { count: String(entries.length) })}
            </GroupRow>
          ) : null}
        </Group>
      )}
      {error ? <p className="px-1 text-small text-red">{error}</p> : null}
    </Section>
  );
}

/** What to call an entry in the console: its name, "you" for the only owner, else the contact ID. */
function useLabel() {
  const { t } = useI18n();
  return (entry: ContactEntry) => {
    const first = entry.accounts[0] as ContactAccount;
    const name = entry.name ?? entry.accounts.find((a) => a.name)?.name ?? null;
    if (name) return name;
    if (entry.accounts.some((a) => a.owner && !a.ownerShared)) return t("activity.you");
    return t("activity.unnamed", { id: first.id });
  };
}

function Icons({ accounts }: { accounts: readonly ContactAccount[] }) {
  const platforms = [...new Set(accounts.map((a) => a.platform))].slice(0, 3);
  return (
    <span className="flex shrink-0 items-center">
      {platforms.map((p, i) => (
        <span key={p} className={`rounded-[7px] ring-2 ring-card ${i > 0 ? "-ml-2" : ""}`}>
          <PlatformIcon platform={p} size={24} />
        </span>
      ))}
    </span>
  );
}

function Row({
  agentName,
  entry,
  here,
  waiting,
  onOpen,
}: {
  agentName: string;
  entry: ContactEntry;
  /** Their accounts on this bot. */
  here: readonly ContactAccount[];
  /** Waiting for the owner to let them in. */
  waiting: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const label = useLabel();
  const platforms = [...new Set(entry.accounts.map((a) => t(`platform.${a.platform}` as MessageKey)))];
  const tags = [
    // Department and title, where the chat app gives them: who they are, before what is marked.
    entry.accounts.find((a) => a.profile)?.profile ?? null,
    waiting ? t("contacts.waiting") : here.some((a) => a.access === "blocked") ? t("access.declined") : null,
    entry.accounts.some((a) => a.owner) ? t("contacts.owner") : null,
    entry.accounts.some((a) => a.bot) ? t("contacts.bot") : null,
    entry.accounts.some((a) => a.linkedBy === "agent") ? t("contacts.linkedByAgent", { name: agentName }) : null,
    entry.note ? t("contacts.hasNote") : null,
  ].filter(Boolean);
  return (
    <GroupRow onClick={onOpen}>
      <Icons accounts={entry.accounts} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{label(entry)}</span>
        <span className="truncate text-small text-ink2">{[platforms.join(" · "), ...tags].join(" · ")}</span>
      </span>
      <span className="shrink-0 text-small text-ink3">{t("contacts.edit")}</span>
    </GroupRow>
  );
}

/** One entry opened in place: its name and note, each account, and linking to another entry. */
function Editor({
  agent,
  entry,
  others,
  onClose,
  onChanged,
}: {
  agent: AgentView;
  entry: ContactEntry;
  others: readonly ContactEntry[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const label = useLabel();
  const first = entry.accounts[0] as ContactAccount;
  // The name given to them, not the one their app reports: that shows as the placeholder.
  const given = entry.person ? (entry.name ?? "") : first.name !== first.platformName ? (first.name ?? "") : "";
  const [name, setName] = useState(given);
  const [note, setNote] = useState(entry.note ?? "");
  const dirty = name.trim() !== given || note.trim() !== (entry.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = bytes(note) > NOTE_MAX_BYTES;

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (tooLong) return;
    await act(async () => {
      await api.editContact(agent.id, first.id, {
        ...(name.trim() !== given ? { name } : {}),
        ...(note.trim() !== (entry.note ?? "") ? { note } : {}),
      });
      onClose();
    });
  };
  const placeholder = entry.person ? label({ ...entry, name: null }) : (first.platformName ?? label(entry));

  return (
    <form
      onSubmit={save}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="rise flex flex-col gap-3 bg-group px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <Icons accounts={entry.accounts} />
        <Input
          autoFocus
          aria-label={t("contacts.name")}
          placeholder={placeholder}
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1"
        />
      </div>
      {entry.accounts.length > 1 && entry.accounts.some((a) => a.linkedBy === "agent") ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="min-w-0 flex-1 text-small text-ink2">{t("contacts.agentLinked", { name: agent.name })}</span>
          <Button
            type="button"
            small
            disabled={busy}
            onClick={() =>
              act(() =>
                api.linkContacts(
                  agent.id,
                  entry.accounts.map((a) => a.id),
                ),
              )
            }
          >
            {t("contacts.confirm")}
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-card">
        {entry.accounts.map((a) => (
          <AccountLine
            key={a.id}
            agentName={agent.name}
            account={a}
            alone={entry.accounts.length === 1}
            onBot={(bot) => act(() => api.editContact(agent.id, a.id, { bot }))}
            onAccess={(access) => act(() => api.setAccess(agent.id, "contact", a.id, access))}
            onUnlink={() => act(() => api.unlinkContact(agent.id, a.id))}
          />
        ))}
      </ul>
      {others.length > 0 ? (
        <Select
          aria-label={t("contacts.linkTo")}
          value=""
          disabled={busy}
          onChange={(e) => {
            const other = others.find((o) => (o.accounts[0] as ContactAccount).id === e.target.value);
            if (other) void act(() => api.linkContacts(agent.id, [first.id, (other.accounts[0] as ContactAccount).id]));
          }}
          className="text-small text-ink2"
        >
          <option value="">{t("contacts.linkTo")}</option>
          {others.map((o) => {
            const id = (o.accounts[0] as ContactAccount).id;
            const where = [...new Set(o.accounts.map((a) => t(`platform.${a.platform}` as MessageKey)))].join(" · ");
            return (
              <option key={id} value={id}>
                {label(o)} · {where}
              </option>
            );
          })}
        </Select>
      ) : null}
      <Field label={t("contacts.note")}>
        <Textarea
          aria-invalid={tooLong}
          placeholder={t("contacts.notePlaceholder", { name: agent.name })}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={`min-h-20 text-small ${tooLong ? "!border-red" : ""}`}
        />
        {tooLong ? <span className="text-caption text-red">{t("contacts.noteTooLong")}</span> : null}
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" small disabled={busy || tooLong || !dirty}>
          {t("agent.save")}
        </Button>
        <Button type="button" variant="ghost" small onClick={onClose}>
          {t("agent.cancel")}
        </Button>
        {error ? (
          <p role="alert" className="text-small text-red">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function AccountLine({
  agentName,
  account,
  alone,
  onBot,
  onAccess,
  onUnlink,
}: {
  agentName: string;
  account: ContactAccount;
  alone: boolean;
  onBot: (bot: boolean) => void;
  onAccess: (access: "allowed" | "blocked") => void;
  onUnlink: () => void;
}) {
  const { t } = useI18n();
  const platform = t(`platform.${account.platform}` as MessageKey);
  const tags = [
    account.profile,
    account.owner ? t("contacts.owner") : null,
    account.bot ? t("contacts.bot") : null,
    account.linkedBy === "agent" ? t("contacts.linkedByAgent", { name: agentName }) : null,
    account.access === "blocked" ? t("access.declined") : null,
  ].filter(Boolean);
  const items = [
    // The owner always gets through; someone undecided is answered under "Needs you".
    ...(account.access === "allowed"
      ? [{ label: t("access.revoke"), danger: true, onSelect: () => onAccess("blocked") }]
      : account.access === "blocked"
        ? [{ label: t("access.allow"), onSelect: () => onAccess("allowed") }]
        : []),
    ...(account.owner
      ? []
      : [{ label: account.bot ? t("contacts.notBot") : t("contacts.markBot"), onSelect: () => onBot(!account.bot) }]),
    ...(alone ? [] : [{ label: t("contacts.unlink"), onSelect: onUnlink }]),
  ];
  return (
    <li className="flex min-h-11 items-center gap-2.5 px-3 py-1.5">
      <PlatformIcon platform={account.platform} size={20} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-small">
          {account.platformName ?? t("activity.unnamed", { id: account.id })}
          <span className="text-ink3"> · {platform}</span>
        </span>
        {tags.length ? <span className="truncate text-caption text-ink2">{tags.join(" · ")}</span> : null}
      </span>

      {items.length ? <MoreMenu label={t("agent.more")} items={items} /> : null}
    </li>
  );
}

/**
 * The owner's accounts on several apps, not yet one person: asked once whether they are all the
 * owner. Yes links them, so the console can call every one "you"; no is remembered on this computer.
 */
export function AllMe({ agent, onChanged }: { agent: AgentView; onChanged: () => void }) {
  const { value: entries, reload } = useCached<ContactEntry[]>(
    `contacts:${agent.id}`,
    () => api.contacts(agent.id),
    [],
  );
  if (!entries) return null;
  return (
    <AllMeCard
      key={agent.id}
      agentId={agent.id}
      entries={entries}
      onLinked={async () => {
        await reload();
        onChanged();
      }}
    />
  );
}

function AllMeCard({
  agentId,
  entries,
  onLinked,
}: {
  agentId: string;
  entries: readonly ContactEntry[];
  onLinked: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const owners = entries.flatMap((e) => e.accounts.filter((a) => a.owner));
  const linked = new Set(
    entries.filter((e) => e.accounts.some((a) => a.owner)).map((e) => e.person ?? e.accounts[0]?.id),
  );
  const ids = owners.map((a) => a.id);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(notAllMeKey(agentId, ids)) === "1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allOwnerLinked = owners.every((a) => a.linkedBy === "owner");
  if (owners.length < 2 || (linked.size === 1 && allOwnerLinked) || dismissed) return null;
  const platforms = formatList(locale, [...new Set(owners.map((a) => t(`platform.${a.platform}` as MessageKey)))]);
  return (
    <div className="rise flex flex-col gap-2.5 rounded-card border border-line bg-bg2 px-4 py-3">
      <div className="flex items-center gap-3">
        <Icons accounts={owners} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{t("contacts.allMe")}</span>
          <span className="text-small text-ink2">
            {t("contacts.allMeBody", { platforms, count: String(owners.length) })}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          small
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.linkContacts(agentId, ids);
              await onLinked();
            } catch (e) {
              setError(errorText(t, e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("contacts.allMeYes")}
        </Button>
        <Button
          small
          variant="ghost"
          onClick={() => {
            localStorage.setItem(notAllMeKey(agentId, ids), "1");
            setDismissed(true);
          }}
        >
          {t("contacts.allMeNo")}
        </Button>
        {error ? <p className="text-small text-red">{error}</p> : null}
      </div>
    </div>
  );
}
