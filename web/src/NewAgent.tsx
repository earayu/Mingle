import { type FormEvent, useEffect, useState } from "react";
import type { Navigate } from "./App.tsx";
import { api, type Harness, type ModelList } from "./api.ts";
import { errorText, type MessageKey, useI18n } from "./i18n.ts";
import {
  ApiKeyHint,
  Button,
  Field,
  HarnessIcon,
  Input,
  PageHeader,
  Problem,
  Select,
  Spinner,
  Step,
  Steps,
  Textarea,
} from "./ui.tsx";

const ROLE_TEMPLATES = ["assistant", "group", "coder", "translator"] as const;

export function NewAgent({
  first,
  onNavigate,
  onCreated,
}: {
  first: boolean;
  onNavigate: Navigate;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [harness, setHarness] = useState("");
  const [model, setModel] = useState("");
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .harnesses()
      .then((list) => {
        setHarnesses(list);
        setHarness((current) => current || list[0]?.id || "");
      })
      .catch(() => setHarnesses([]));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const agent = await api.createAgent({ name: name.trim(), role, harness, ...(model ? { model } : {}) });
      onCreated();
      // Straight on to the next step: putting it in a chat app.
      onNavigate({ kind: "connect", slug: agent.slug }, { replace: true });
    } catch (e) {
      setError(errorText(t, e));
      setBusy(false);
    }
  }

  const named = name.trim().length > 0;
  const form = (
    <form onSubmit={submit} className="flex flex-col gap-8">
      <Steps>
        <Step n={1} state={named ? "done" : "now"} title={t("new.step1")} open>
          <Input
            autoFocus
            required
            aria-label={t("create.name")}
            value={name}
            maxLength={40}
            placeholder={t("create.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </Step>
        <Step n={2} state={named ? "now" : "todo"} open title={t("new.step2")} hint={t("new.step2Hint")}>
          <Textarea
            value={role}
            rows={4}
            aria-label={t("create.role")}
            placeholder={t("create.rolePlaceholder")}
            onChange={(e) => setRole(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            {ROLE_TEMPLATES.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setRole(t(`role.${key}.text` as MessageKey))}
                className="h-7 rounded-full border border-line2 px-3 text-small text-ink2 transition-colors duration-[120ms] hover:border-accent hover:text-accent"
              >
                {t(`role.${key}` as MessageKey)}
              </button>
            ))}
          </div>
        </Step>
        <Step n={3} state={named ? "now" : "todo"} open title={t("new.step3")} hint={t("new.step3Hint")}>
          <BrainPicker
            harnesses={harnesses}
            harness={harness}
            model={model}
            onHarness={(id) => {
              setHarness(id);
              setModel("");
            }}
            onModel={setModel}
          />
        </Step>
      </Steps>
      <div className="flex flex-col gap-3 border-t border-line pt-5">
        <p className="text-small text-ink2">{t("create.notice")}</p>
        {error ? <p className="text-small text-red">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || !named || !harness}>
            {busy ? t("new.creating") : t("new.create")}
          </Button>
          <Button variant="ghost" onClick={() => onNavigate({ kind: "home" })}>
            {t("create.cancel")}
          </Button>
        </div>
      </div>
    </form>
  );

  if (first) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="drag h-[52px] shrink-0" />
        <div className="mx-auto flex w-full max-w-[520px] flex-col gap-6 px-6 pb-12">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-title2 font-semibold">{t("new.title")}</h1>
            <p className="text-ink2">{t("new.subtitle")}</p>
          </div>
          {form}
        </div>
      </div>
    );
  }
  return (
    <>
      <PageHeader title={t("new.title")} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[560px] flex-col gap-6 px-6 py-6 md:px-8">{form}</div>
      </div>
    </>
  );
}

/** Installed harnesses as choices, and the models the chosen one offers right now. */
export function BrainPicker({
  harnesses,
  harness,
  model,
  onHarness,
  onModel,
}: {
  harnesses: Harness[] | null;
  harness: string;
  model: string;
  onHarness: (id: string) => void;
  onModel: (id: string) => void;
}) {
  const { t } = useI18n();
  if (harnesses === null) {
    return (
      <p className="flex items-center gap-2 text-small text-ink2">
        <Spinner /> {t("brain.looking")}
      </p>
    );
  }
  if (harnesses.length === 0) {
    return (
      <Problem title={t("brain.none")}>
        {t("brain.noneBody")}{" "}
        <a
          className="text-accent underline-offset-2 hover:underline"
          href="https://claude.com/claude-code"
          target="_blank"
          rel="noreferrer"
        >
          Claude Code
        </a>
        {" · "}
        <a
          className="text-accent underline-offset-2 hover:underline"
          href="https://developers.openai.com/codex/cli"
          target="_blank"
          rel="noreferrer"
        >
          Codex
        </a>
      </Problem>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label={t("create.brain")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {harnesses.map((h) => (
          // biome-ignore lint/a11y/useSemanticElements: a styled choice; a native radio cannot take this look
          <button
            key={h.id}
            type="button"
            role="radio"
            aria-checked={h.id === harness}
            onClick={() => onHarness(h.id)}
            className="flex min-w-0 items-center gap-3 rounded-control border border-line2 bg-bg px-3 py-2.5 text-left transition-colors duration-[120ms] hover:bg-bg2 aria-checked:border-accent aria-checked:bg-accent-tint aria-checked:ring-1 aria-checked:ring-accent"
          >
            <HarnessIcon harness={h} size={28} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{h.name}</span>
              {h.version ? <span className="truncate text-caption text-ink3">{h.version}</span> : null}
            </span>
          </button>
        ))}
      </div>
      {harness ? <ModelPicker harness={harness} value={model} onChange={onModel} /> : null}
    </div>
  );
}

export function ModelPicker({
  harness,
  value,
  onChange,
  inline = false,
}: {
  harness: string;
  value: string;
  onChange: (id: string) => void;
  /** In a settings row: just the control, no label. */
  inline?: boolean;
}) {
  const { t } = useI18n();
  const [list, setList] = useState<ModelList | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    api
      .models(harness)
      .then((next) => live && setList(next))
      .catch(() => live && setList({ kind: "unsupported" }));
    return () => {
      live = false;
    };
  }, [harness]);

  const wrap = (control: React.ReactNode) =>
    inline ? (
      control
    ) : (
      <Field label={t("create.model")} hint={value ? undefined : t("brain.defaultHint")}>
        {control}
      </Field>
    );
  if (list === null) {
    return wrap(
      <span className="flex h-[34px] items-center gap-2 text-small text-ink2">
        <Spinner /> {t("brain.models")}
      </span>,
    );
  }
  if (list.kind === "unauthenticated") {
    return inline ? (
      <span className="text-small text-amber">{t("brain.signedOut")}</span>
    ) : (
      <Problem title={t("brain.signedOut")}>
        {t("brain.signedOutBody")}
        <ApiKeyHint harness={harness} />
      </Problem>
    );
  }
  // "default" is Claude Code's own name for "whatever it would pick": that is our first option.
  const models = list.kind === "ok" ? list.models.filter((m) => m.id !== "default") : [];
  const fallback = list.kind === "ok" ? list.models.find((m) => m.isDefault) : undefined;
  return wrap(
    <Select
      aria-label={t("create.model")}
      className={inline ? "!w-[220px]" : ""}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{fallback ? t("brain.defaultNamed", { name: fallback.name }) : t("brain.default")}</option>
      {models.map((m) => (
        <option key={m.id} value={m.id} disabled={Boolean(m.disabled)}>
          {m.provider ? `${m.name} · ${m.provider}` : m.name}
        </option>
      ))}
      {value && !models.some((m) => m.id === value) ? <option value={value}>{value}</option> : null}
    </Select>,
  );
}
