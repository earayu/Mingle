import { type FormEvent, useState } from "react";
import { type AgentView, api, type EnvVar, type Harness } from "./api.ts";
import { useCached } from "./cache.ts";
import { errorText, useI18n } from "./i18n.ts";
import {
  AlertIcon,
  Button,
  EyeIcon,
  Group,
  GroupRow,
  HelpTip,
  Input,
  MoreMenu,
  PlusIcon,
  Section,
  shortDateTime,
} from "./ui.tsx";

/** Typed names become variable names: `daily webhook-url` → `DAILY_WEBHOOK_URL`. */
const normalize = (raw: string) =>
  raw
    .toUpperCase()
    .replace(/[\s\-.]+/g, "_")
    .replace(/[^A-Z0-9_]/g, "");

/** What the console can tell while typing. System names are the API's to refuse. */
function nameProblem(name: string): string | null {
  if (!name) return null;
  if (/^\d/.test(name)) return "env_name_invalid";
  if (name.startsWith("MINGLE_")) return "env_name_reserved";
  return null;
}

type Editing = { readonly mode: "add" } | { readonly mode: "replace"; readonly name: string };

/**
 * The agent's own environment variables (docs/spec.md 4.4): write-only values, kept in the
 * system credential store, read by the agent in its shell. A change applies from the next message.
 */
export function AgentEnv({ agent }: { agent: AgentView }) {
  const { t } = useI18n();
  const { value: vars, reload: load } = useCached<EnvVar[]>(`env:${agent.id}`, () => api.env(agent.id), []);
  const { value: harnesses } = useCached<Harness[]>("harnesses", api.harnesses, []);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const harness = harnesses?.find((h) => h.id === agent.harness);
  const start = (next: Editing) => {
    setEditing(next);
    setConfirming(null);
    setSaved(false);
    setError(null);
  };

  if (!vars) return null;
  const list = (
    <Group>
      {editing?.mode === "add" ? (
        <EnvForm
          taken={vars.map((v) => v.name)}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setSaved(true);
            await load();
          }}
          agentId={agent.id}
        />
      ) : null}
      {vars.map((v) =>
        editing?.mode === "replace" && editing.name === v.name ? (
          <EnvForm
            key={v.name}
            fixedName={v.name}
            taken={[]}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              setSaved(true);
              await load();
            }}
            agentId={agent.id}
          />
        ) : (
          <EnvRow
            key={v.name}
            variable={v}
            confirming={confirming === v.name}
            onReplace={() => start({ mode: "replace", name: v.name })}
            onAskDelete={() => {
              setConfirming(v.name);
              setEditing(null);
              setSaved(false);
            }}
            onCancelDelete={() => setConfirming(null)}
            onDelete={async () => {
              try {
                await api.deleteEnv(agent.id, v.name);
              } catch (e) {
                setError(errorText(t, e));
              }
              setConfirming(null);
              await load();
            }}
          />
        ),
      )}
      {vars.length === 0 && !editing ? (
        <GroupRow onClick={() => start({ mode: "add" })} className="text-ink2 hover:text-ink">
          <PlusIcon />
          {t("env.addFirst")}
        </GroupRow>
      ) : null}
    </Group>
  );

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-0.5">
          {t("env.title")}
          <HelpTip label={t("env.title")}>{t("env.help")}</HelpTip>
        </span>
      }
      action={
        vars.length > 0 && !editing ? (
          <Button variant="ghost" small onClick={() => start({ mode: "add" })}>
            <PlusIcon /> {t("agent.add")}
          </Button>
        ) : null
      }
    >
      {harness?.noEnv ? (
        <p className="flex items-center gap-1.5 px-1 text-small text-amber">
          <AlertIcon className="text-amber-dot" />
          {t("env.unsupported", { harness: harness.name })}
        </p>
      ) : null}
      {list}
      {error ? <p className="px-1 text-small text-red">{error}</p> : null}
      {saved ? <p className="rise px-1 text-small text-ink2">{t("env.saved")}</p> : null}
    </Section>
  );
}

function EnvRow({
  variable,
  confirming,
  onReplace,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  variable: EnvVar;
  confirming: boolean;
  onReplace: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <GroupRow className={`min-h-[48px] ${confirming ? "bg-red-tint" : variable.missing ? "bg-amber-tint" : ""}`}>
      <span
        className="selectable min-w-0 flex-1 truncate font-mono text-small"
        title={`${variable.name} · ${t("env.updated", { time: shortDateTime(variable.updatedAt, locale) })}`}
      >
        {variable.name}
      </span>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="sr-only">{t("env.deleteAsk", { name: variable.name })}</span>
          <Button
            small
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onDelete();
              setBusy(false);
            }}
          >
            {t("env.delete")}
          </Button>
          <Button small variant="ghost" onClick={onCancelDelete}>
            {t("agent.cancel")}
          </Button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          {variable.missing ? (
            <span className="flex items-center gap-1 pr-1.5 text-small text-amber">
              <AlertIcon className="text-amber-dot" />
              {t("env.missing")}
            </span>
          ) : (
            <span aria-hidden className="pr-2 font-mono text-small tracking-[2px] text-ink3">
              ••••••
            </span>
          )}
          <Button small onClick={onReplace}>
            {variable.missing ? t("env.refill") : t("env.replace")}
          </Button>
          <MoreMenu label={t("agent.more")} items={[{ label: t("env.delete"), danger: true, onSelect: onAskDelete }]} />
        </span>
      )}
    </GroupRow>
  );
}

/** Add a variable, or replace one's value (`fixedName`). Opens in place, never in a dialog. */
function EnvForm({
  agentId,
  fixedName,
  taken,
  onCancel,
  onSaved,
}: {
  agentId: string;
  fixedName?: string;
  taken: readonly string[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(fixedName ?? "");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: "name" | "value"; text: string } | null>(null);
  const problem = fixedName ? null : nameProblem(name);
  // An existing name is not an error: saving replaces its value, and the button says so.
  const replacing = Boolean(fixedName) || taken.includes(name);
  const ready = Boolean(name) && !problem && value.length > 0 && !busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      // A pasted value often carries the line break after it.
      await api.setEnv(agentId, name, value.replace(/\r?\n$/, ""));
      await onSaved();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setError({ field: code.startsWith("env_name") ? "name" : "value", text: errorText(t, e) });
      setBusy(false);
    }
  }

  const nameError = problem
    ? t(`error.${problem}` as "error.env_name_invalid")
    : error?.field === "name"
      ? error.text
      : null;
  const valueError = error?.field === "value" ? error.text : null;
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
      className="rise flex flex-col gap-2 bg-group px-4 py-3"
    >
      <div className="flex flex-wrap items-start gap-2">
        {fixedName ? (
          <span className="flex h-[34px] min-w-0 flex-[1_1_160px] items-center truncate font-mono text-small">
            {fixedName}
          </span>
        ) : (
          <Input
            autoFocus
            aria-label={t("env.name")}
            aria-invalid={Boolean(nameError)}
            placeholder={t("env.name")}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={name}
            onChange={(e) => {
              setName(normalize(e.target.value));
              if (error?.field === "name") setError(null);
            }}
            className={`!w-auto min-w-0 flex-[1_1_160px] font-mono text-small ${nameError ? "!border-red" : ""}`}
          />
        )}
        <span className="relative flex min-w-0 flex-[2_1_200px]">
          <Input
            autoFocus={Boolean(fixedName)}
            aria-label={fixedName ? t("env.newValue") : t("env.value")}
            aria-invalid={Boolean(valueError)}
            placeholder={fixedName ? t("env.newValue") : t("env.value")}
            type={shown ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error?.field === "value") setError(null);
            }}
            className="pr-9 font-mono text-small"
          />
          <button
            type="button"
            aria-label={shown ? t("env.hide") : t("env.show")}
            aria-pressed={shown}
            onClick={() => setShown((s) => !s)}
            className="absolute top-[3px] right-[3px] flex size-7 items-center justify-center rounded-small text-ink3 hover:bg-bg3 hover:text-ink2"
          >
            <EyeIcon off={shown} />
          </button>
        </span>
        <span className="flex shrink-0 gap-2">
          <Button type="submit" variant="primary" disabled={!ready}>
            {replacing ? t("env.replace") : t("agent.save")}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("agent.cancel")}
          </Button>
        </span>
      </div>
      {nameError || valueError ? (
        <p role="alert" className="text-small text-red">
          {nameError ?? valueError}
        </p>
      ) : null}
    </form>
  );
}
