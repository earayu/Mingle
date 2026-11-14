import { type FormEvent, useEffect, useState } from "react";
import type { Navigate } from "./App.tsx";
import {
  type AgentView,
  api,
  type CredentialField,
  type OnboardingState,
  type Platform,
  type PlatformInfo,
} from "./api.ts";
import { useCached } from "./cache.ts";
import { errorText, type MessageKey, useI18n } from "./i18n.ts";
import { PlatformIcon } from "./platforms.tsx";
import {
  BackIcon,
  Button,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Problem,
  Spinner,
  Step,
  type StepState,
  Steps,
  Waiting,
} from "./ui.tsx";

/** Put an agent in a chat app: pick the app, then follow its steps. */
export function ConnectPage({
  agent,
  platform,
  onNavigate,
  onChanged,
}: {
  agent: AgentView;
  platform: string | undefined;
  onNavigate: Navigate;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { value: platforms } = useCached<PlatformInfo[]>("platforms", api.platforms, []);

  const info = platforms?.find((p) => p.platform === platform);
  const back = () =>
    platform
      ? onNavigate({ kind: "connect", slug: agent.slug }, { replace: true })
      : onNavigate({ kind: "agent", slug: agent.slug });
  const done = () => {
    onChanged();
    onNavigate({ kind: "agent", slug: agent.slug }, { replace: true });
  };

  return (
    <>
      <PageHeader
        leading={
          <Button variant="ghost" small aria-label={t("connect.back")} onClick={back}>
            <BackIcon />
          </Button>
        }
        title={agent.name}
        meta={t("connect.title")}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[680px] flex-col gap-6 px-6 py-6 md:px-8">
          {platforms === null ? (
            <p className="flex items-center gap-2 text-ink2">
              <Spinner /> {t("qr.loading")}
            </p>
          ) : info?.onboarding ? (
            <PlatformFlow key={info.platform} agent={agent} info={info} onDone={done} />
          ) : (
            <PlatformGrid
              agent={agent}
              platforms={platforms}
              onPick={(p) => onNavigate({ kind: "connect", slug: agent.slug, platform: p })}
            />
          )}
        </div>
      </div>
    </>
  );
}

function PlatformGrid({
  agent,
  platforms,
  onPick,
}: {
  agent: AgentView;
  platforms: PlatformInfo[];
  onPick: (platform: Platform) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-title2 font-semibold">{t("connect.pickTitle")}</h2>
        <p className="text-ink2">{t("connect.pickBody", { name: agent.name })}</p>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {platforms.map((p) => {
          const count = agent.connections.filter((c) => c.platform === p.platform).length;
          const how =
            count > 0
              ? t("connect.addAnother")
              : p.onboarding?.kind === "qr"
                ? t("connect.howQr")
                : p.onboarding
                  ? t("connect.howToken")
                  : t("connect.soon");
          return (
            <button
              key={p.platform}
              type="button"
              disabled={!p.onboarding}
              onClick={() => onPick(p.platform)}
              className="flex min-w-0 items-center gap-3 rounded-card border border-line bg-card px-4 py-3.5 text-left shadow-card transition-[border-color,background-color] duration-[120ms] enabled:hover:border-accent disabled:opacity-50"
            >
              <PlatformIcon platform={p.platform} size={36} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-headline font-semibold">
                  {t(`platform.${p.platform}` as MessageKey)}
                </span>
                <span className="truncate text-small text-ink2">{how}</span>
              </span>
              {count > 0 ? (
                <span className="shrink-0 rounded-full bg-bg3 px-2 py-0.5 text-caption text-ink2">
                  {t("connect.added", { count: String(count) })}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="text-small text-ink3">{t("connect.many")}</p>
    </div>
  );
}

function PlatformFlow({ agent, info, onDone }: { agent: AgentView; info: PlatformInfo; onDone: () => void }) {
  const [manual, setManual] = useState(false);
  if (info.onboarding?.kind === "credentials") {
    return (
      <CredentialsFlow
        agent={agent}
        info={info}
        fields={info.onboarding.fields}
        stepsKey={`${info.platform}.steps` as MessageKey}
        {...(info.onboarding.setupUrl ? { setupUrl: withAgentName(info.onboarding.setupUrl, agent.name) } : {})}
        onDone={onDone}
      />
    );
  }
  if (manual) {
    return (
      <CredentialsFlow
        agent={agent}
        info={info}
        fields={info.manualFields}
        stepsKey={`${info.platform}.manualSteps` as MessageKey}
        onDone={onDone}
        onBack={() => setManual(false)}
      />
    );
  }
  return (
    <QrFlow
      agent={agent}
      info={info}
      onDone={onDone}
      {...(info.manualFields.length ? { onManual: () => setManual(true) } : {})}
    />
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

/** Token platforms: the platform's own steps, the last one being the form here. */
function CredentialsFlow({
  agent,
  info,
  fields,
  stepsKey,
  setupUrl,
  onDone,
  onBack,
}: {
  agent: AgentView;
  info: PlatformInfo;
  fields: CredentialField[];
  stepsKey: MessageKey;
  setupUrl?: string;
  onDone: () => void;
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const platformName = t(`platform.${info.platform}` as MessageKey);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.connect(agent.id, info.platform, values);
      setConnected(true);
      setTimeout(onDone, 900);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  const lines = t(stepsKey)
    .split("\n")
    .filter((l) => l.trim());
  const filled = fields.every((f) => values[f.key]?.trim());
  return (
    <div className="flex flex-col gap-6">
      <FlowTitle platform={info.platform} title={t("connect.flowTitle", { platform: spaced(platformName) })} />
      <form onSubmit={submit}>
        <Steps>
          {lines.map((line, i) => (
            <Step key={line} n={i + 1} state={connected ? "done" : "todo"} title={line}>
              {i === 0 && setupUrl ? (
                <LinkButton href={setupUrl}>{t(`${info.platform}.setup` as MessageKey)}</LinkButton>
              ) : null}
            </Step>
          ))}
          <Step n={lines.length + 1} state={connected ? "done" : "now"} title={t("connect.paste")}>
            {fields.map((f, i) => (
              <Field key={f.key} label={t(f.labelKey as MessageKey)}>
                <Input
                  autoFocus={i === 0}
                  required
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              </Field>
            ))}
            {error ? <Problem title={t("connect.failed")}>{error}</Problem> : null}
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" disabled={busy || !filled}>
                {busy ? (
                  <>
                    <Spinner /> {t("connect.connecting")}
                  </>
                ) : (
                  t("connect.connect")
                )}
              </Button>
              {onBack ? (
                <Button variant="ghost" onClick={onBack}>
                  {t("qr.backToQr")}
                </Button>
              ) : null}
            </div>
            <p className="text-caption text-ink3">{t("connect.secretNote")}</p>
          </Step>
        </Steps>
      </form>
      {connected ? <p className="text-green">{t("qr.done", { platform: platformName })}</p> : null}
    </div>
  );
}

function FlowTitle({ platform, title }: { platform: Platform; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <PlatformIcon platform={platform} size={40} />
      <h2 className="text-title2 font-semibold">{title}</h2>
    </div>
  );
}

/** Scan-to-create: the QR, then the phone's confirmation, then (maybe) an admin's approval. */
function QrFlow({
  agent,
  info,
  onDone,
  onManual,
}: {
  agent: AgentView;
  info: PlatformInfo;
  onDone: () => void;
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
      .startOnboarding(agent.id, info.platform)
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
  }, [agent.id, info.platform, attempt]);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const tick = async () => {
      const next = await api.onboarding(sessionId).catch(() => null);
      if (!active || !next) return;
      setState(next);
      if (next.state === "done") {
        active = false;
        setTimeout(onDone, next.pendingApproval ? 2500 : 1200);
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

  const restart = () => {
    setSessionId(null);
    setAttempt((n) => n + 1);
  };
  const expired =
    (state.state === "qr" && state.expiresAt <= now) || (state.state === "failed" && state.code === "expired");
  const remaining = state.state === "qr" ? Math.max(0, Math.round((state.expiresAt - now) / 1000)) : 0;
  const s = state.state;
  const stage =
    s === "starting" || s === "qr" || s === "failed"
      ? 1
      : s === "scanned" || s === "needs_code"
        ? 2
        : s === "awaiting_approval"
          ? 3
          : 4;
  const at = (n: number): StepState => (stage > n ? "done" : stage === n ? "now" : "later");

  return (
    <div className="flex flex-col gap-6">
      <FlowTitle platform={info.platform} title={t("connect.flowTitle", { platform: spaced(platformName) })} />
      <Steps>
        <Step n={1} state={at(1)} title={t(`${info.platform}.qr1` as MessageKey)}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {/* The QR stays on white in both themes so phones can read it. */}
            <div className="flex size-[220px] shrink-0 items-center justify-center rounded-card border border-line bg-white p-4">
              {state.state === "qr" && !expired ? (
                <div
                  className="size-[188px] [&_svg]:size-full"
                  role="img"
                  aria-label={t("qr.label", { platform: platformName })}
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG generated by our own server from a URL
                  dangerouslySetInnerHTML={{ __html: state.qrSvg }}
                />
              ) : expired ? (
                <button type="button" onClick={restart} className="text-small font-medium text-[#5450d6]">
                  {t("qr.refresh")}
                </button>
              ) : s === "failed" ? null : (
                <Spinner size={20} />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              {s === "failed" && !expired ? (
                <Problem title={t("connect.failed")} tone="red">
                  {errorTextFor(t, state.state === "failed" ? state.code : "unknown")}
                </Problem>
              ) : expired ? (
                <p className="text-small text-ink2">{t("qr.expired")}</p>
              ) : s === "qr" ? (
                <Waiting>
                  {remaining > 120
                    ? t("qr.waitingMinutes", { minutes: String(Math.ceil(remaining / 60)) })
                    : t("qr.waiting", {
                        minutes: String(Math.floor(remaining / 60)),
                        seconds: String(remaining % 60).padStart(2, "0"),
                      })}
                </Waiting>
              ) : (
                <Waiting>{t("qr.loading")}</Waiting>
              )}
              {s === "failed" && !expired ? (
                <Button className="self-start" onClick={restart}>
                  {t("connect.retry")}
                </Button>
              ) : null}
              {state.state === "qr" && !expired && info.onboarding?.kind === "qr" && info.onboarding.desktopLink ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-small text-ink2">{t("qr.orHere")}</span>
                  <LinkButton href={state.url} small>
                    {t("qr.openHere")}
                  </LinkButton>
                </div>
              ) : null}
              {onManual ? (
                <button type="button" onClick={onManual} className="self-start text-small text-accent hover:underline">
                  {t("qr.manual")}
                </button>
              ) : null}
            </div>
          </div>
        </Step>
        <Step n={2} state={at(2)} title={t(`${info.platform}.qr2` as MessageKey)}>
          {state.state === "needs_code" && sessionId ? (
            <CodeForm sessionId={sessionId} retry={state.retry} />
          ) : (
            <Waiting>{t("qr.scanned")}</Waiting>
          )}
        </Step>
        <Step n={3} state={at(3)} title={t("connect.finish")}>
          <Waiting>{t("connection.approvalHint")}</Waiting>
        </Step>
      </Steps>
      {state.state === "done" ? (
        <p className="rise text-headline font-medium text-green">
          {state.pendingApproval ? t("qr.donePending") : t("qr.done", { platform: platformName })}
        </p>
      ) : null}
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
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await api.submitCode(sessionId, code).catch(() => {});
        setBusy(false);
      }}
    >
      <p className="text-small text-ink2">{t(retry ? "qr.codeRetry" : "qr.code")}</p>
      <div className="flex items-end gap-2">
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
      </div>
    </form>
  );
}

function errorTextFor(t: ReturnType<typeof useI18n>["t"], code: string): string {
  const key = `qr.failed.${code}` as MessageKey;
  const text = t(key);
  return text === key ? t("qr.failed.unknown") : text;
}

/** Chinese copy leaves a space before a Latin name ("连接到 Slack"), none before a Chinese one ("连接到飞书"). */
function spaced(name: string): string {
  return /^[A-Za-z0-9]/.test(name) ? ` ${name}` : name;
}
