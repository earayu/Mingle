import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Navigate } from "./App.tsx";
import {
  type AgentView,
  api,
  type CredentialField,
  type OnboardingState,
  type Platform,
  type PlatformInfo,
  type SetupCheckState,
  type SetupState,
} from "./api.ts";
import { useCached } from "./cache.ts";
import { guideVars, looksRight, pickTokens, recognizable } from "./guide.ts";
import { errorText, type MessageKey, useI18n } from "./i18n.ts";
import { PlatformIcon } from "./platforms.tsx";
import { usePolling } from "./poll.ts";
import {
  ArrowUpRight,
  BackIcon,
  Button,
  Copyable,
  copyText,
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
                : p.onboarding?.kind === "device"
                  ? t(`${p.platform}.how` as MessageKey)
                  : p.onboarding
                    ? optional(t, `${p.platform}.how`, "connect.howToken")
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
  if (info.setup) return <SetupFlow agent={agent} info={info} onDone={onDone} />;
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
    // A device-flow platform's fallback is its own token guide, not a developer console's.
    const device = info.onboarding?.kind === "device";
    return (
      <CredentialsFlow
        agent={agent}
        info={info}
        fields={info.manualFields}
        stepsKey={`${info.platform}.${device ? "steps" : "manualSteps"}` as MessageKey}
        {...(info.manualSetupUrl ? { setupUrl: withAgentName(info.manualSetupUrl, agent.name) } : {})}
        {...(device
          ? { backKey: `${info.platform}.backToCode` as MessageKey }
          : { setupLabelKey: "connect.openConsole" as MessageKey })}
        onDone={onDone}
        onBack={() => setManual(false)}
      />
    );
  }
  if (info.onboarding?.kind === "device") {
    return <DeviceFlow agent={agent} info={info} onDone={onDone} onManual={() => setManual(true)} />;
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
  setupLabelKey,
  backKey,
  onDone,
  onBack,
}: {
  agent: AgentView;
  info: PlatformInfo;
  fields: CredentialField[];
  stepsKey: MessageKey;
  setupUrl?: string;
  setupLabelKey?: MessageKey;
  backKey?: MessageKey;
  onDone: () => void;
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [bot, setBot] = useState<string | null>(null);
  /** What was last sent automatically, so a failed token is not sent again until it changes. */
  const autoSent = useRef("");
  const platformName = t(`platform.${info.platform}` as MessageKey);
  const vars = guideVars(agent);
  const doneText = optionalText(t, `${info.platform}.done`, { bot: "{bot}" });

  const submit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const connection = await api.connect(agent.id, info.platform, values);
        setBot(connection.bot);
        setConnected(true);
        // A platform with something to say once connected (where to try it) leaves time to read it.
        setTimeout(onDone, doneText ? 4000 : 900);
      } catch (e) {
        setError(errorText(t, e));
      } finally {
        setBusy(false);
      }
    },
    [agent.id, info.platform, values, onDone, t, doneText],
  );

  /** Pasting the platform's whole message is fine: each token is picked out, into the field it belongs to. */
  const change = (key: string, raw: string) => setValues(pickTokens(fields, values, key, raw));

  const filled = fields.every((f) => values[f.key]?.trim());
  const shaped = recognizable(fields) && fields.every((f) => looksRight(f, values[f.key] ?? ""));
  // Tokens with the platform's shape connect right away; an App ID and Secret wait for the button,
  // since a half-typed secret is still "filled".
  useEffect(() => {
    if (!filled || !shaped || busy || connected) return;
    const sent = JSON.stringify(values);
    if (autoSent.current === sent) return;
    autoSent.current = sent;
    void submit();
  }, [filled, shaped, busy, connected, values, submit]);

  const lines = t(stepsKey)
    .split("\n")
    .filter((l) => l.trim());
  return (
    <div className="flex flex-col gap-6">
      <FlowTitle platform={info.platform} title={t("connect.flowTitle", { platform: spaced(platformName) })} />
      <form onSubmit={submit}>
        <Steps>
          {lines.map((line, i) => (
            <Step
              key={line}
              n={i + 1}
              state={connected ? "done" : "todo"}
              title={<GuideText text={line} vars={vars} />}
            >
              {i === (SETUP_STEP[info.platform] ?? 0) && setupUrl ? (
                <LinkButton href={setupUrl}>{t(setupLabelKey ?? (`${info.platform}.setup` as MessageKey))}</LinkButton>
              ) : null}
            </Step>
          ))}
          <Step
            n={lines.length + 1}
            state={connected ? "done" : "now"}
            title={<GuideText text={optional(t, `${info.platform}.form`, "connect.paste")} vars={vars} />}
          >
            {fields.map((f, i) => {
              const value = values[f.key] ?? "";
              const off = Boolean(value.trim()) && !looksRight(f, value);
              return (
                <Field
                  key={f.key}
                  label={t(f.labelKey as MessageKey)}
                  {...(off ? { hint: t("connect.tokenShape") } : {})}
                >
                  <Input
                    autoFocus={i === 0}
                    required
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    onChange={(e) => change(f.key, e.target.value)}
                  />
                </Field>
              );
            })}
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
                  {t(backKey ?? "qr.backToQr")}
                </Button>
              ) : null}
            </div>
            {fields.some((f) => f.secret) ? <p className="text-caption text-ink3">{t("connect.secretNote")}</p> : null}
          </Step>
        </Steps>
      </form>
      {connected ? (
        <p className="rise text-headline font-medium text-green">
          {doneText ? doneText.replaceAll("{bot}", bot ?? agent.name) : t("qr.done", { platform: platformName })}
        </p>
      ) : null}
    </div>
  );
}

/** The guide step that carries the setup link, where it is not the first (GitHub signs in first). */
const SETUP_STEP: Partial<Record<Platform, number>> = { github: 1 };

/**
 * A step's sentence. A `backticked` part is something to type elsewhere, shown as a copy chip.
 * Variables are filled after splitting, so a name with a backtick cannot break the markup.
 */
function GuideText({ text, vars = {} }: { text: string; vars?: Record<string, string> }) {
  const fill = (part: string) => part.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed sentence
          <Copyable key={i} value={fill(part)} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed sentence
          <span key={i}>{fill(part)}</span>
        ),
      )}
    </>
  );
}

/**
 * Platforms that need this computer set up first (iMessage: macOS permissions). Every check is
 * re-read every few seconds, so a step ticks itself off once the person has done it.
 */
function SetupFlow({ agent, info, onDone }: { agent: AgentView; info: PlatformInfo; onDone: () => void }) {
  const { t } = useI18n();
  const platform = info.platform;
  const platformName = t(`platform.${platform}` as MessageKey);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    const next = await api.setup(platform).catch(() => null);
    if (next) setSetup(next);
  }, [platform]);
  usePolling(refresh, 2000, !connected);

  const act = async (action: string) => {
    setActing(action);
    try {
      setSetup(await api.setupAction(platform, action));
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setActing(null);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.connect(agent.id, platform, {});
      setConnected(true);
      setTimeout(onDone, 2500);
    } catch (e) {
      setError(errorText(t, e));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const app = setup?.app ?? "Mingle";
  const vars = { ...guideVars(agent), app };
  const checks = setup?.checks ?? [];
  const blocking = (s: SetupCheckState) => s === "missing" || s === "denied";
  const firstOpen = checks.findIndex((c) => c.state !== "ok");
  // A check that could not be read (an older macOS) does not hold the person back; connecting tells.
  const ready =
    setup !== null && checks.every((c) => c.state === "ok" || (c.id === "signed_in" && c.state === "unknown"));
  const stateOf = (i: number): StepState => {
    const c = checks[i];
    if (connected || c?.state === "ok") return "done";
    if (i === firstOpen) return "now";
    return c && blocking(c.state) ? "todo" : "later";
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <FlowTitle platform={platform} title={t("connect.flowTitle", { platform: spaced(platformName) })} />
        <p className="text-ink2">{t(`${platform}.intro` as MessageKey, { name: agent.name })}</p>
      </div>
      {setup === null ? (
        <Waiting>{t("setup.checking")}</Waiting>
      ) : (
        <Steps>
          {checks.map((c, i) => (
            <Step
              key={c.id}
              n={i + 1}
              state={stateOf(i)}
              title={t(`${platform}.check.${c.id}` as MessageKey, vars)}
              {...(c.state === "ok" ? {} : { hint: optionalText(t, `${platform}.why.${c.id}`, vars) })}
            >
              <SetupStepBody platform={platform} id={c.id} state={c.state} vars={vars} acting={acting} onAct={act} />
            </Step>
          ))}
          <Step
            n={checks.length + 1}
            state={connected ? "done" : ready ? "now" : "later"}
            title={t(`${platform}.form` as MessageKey)}
          >
            <p className="text-small text-ink2">{t(`${platform}.connectHint` as MessageKey, { name: agent.name })}</p>
            {error ? <Problem title={t("connect.failed")}>{error}</Problem> : null}
            <Button variant="primary" className="self-start" disabled={busy || connected} onClick={connect}>
              {busy ? (
                <>
                  <Spinner /> {t("connect.connecting")}
                </>
              ) : (
                t("connect.connect")
              )}
            </Button>
          </Step>
        </Steps>
      )}
      {!connected && setup !== null && !ready ? <p className="text-caption text-ink3">{t("setup.live")}</p> : null}
      {connected ? (
        <p className="rise text-headline font-medium text-green">
          {t(`${platform}.done` as MessageKey, { name: agent.name })}
        </p>
      ) : null}
    </div>
  );
}

/** What to do for one check that is not done yet, and the buttons that get the person there. */
function SetupStepBody({
  platform,
  id,
  state,
  vars,
  acting,
  onAct,
}: {
  platform: string;
  id: string;
  state: SetupCheckState;
  vars: Record<string, string>;
  acting: string | null;
  onAct: (action: string) => void;
}) {
  const { t } = useI18n();
  const how = optionalText(t, `${platform}.how.${id}.${state}`, vars) ?? optionalText(t, `${platform}.how.${id}`, vars);
  const actions = SETUP_ACTIONS[`${id}.${state}`] ?? SETUP_ACTIONS[id] ?? [];
  const waiting = actions.find((a) => a === acting);
  const button = (action: string, primary: boolean): ReactNode => (
    <Button
      key={action}
      small
      variant={primary ? "default" : "ghost"}
      disabled={acting !== null}
      onClick={() => onAct(action)}
    >
      {acting === action ? <Spinner /> : null}
      {t(`setup.action.${action}` as MessageKey, vars)}
    </Button>
  );
  return (
    <>
      {how ? (
        <p className="text-small text-ink2">
          <GuideText text={how} vars={vars} />
        </p>
      ) : null}
      {actions.length ? (
        <div className="flex flex-wrap items-center gap-2">{actions.map((a, i) => button(a, i === 0))}</div>
      ) : null}
      {waiting ? <Waiting>{optionalText(t, `setup.waiting.${waiting}`, vars) ?? t("setup.checking")}</Waiting> : null}
    </>
  );
}

/** Buttons under a check, by check id, or by id and state where they differ (a refused permission). */
const SETUP_ACTIONS: Record<string, string[]> = {
  signed_in: ["open_messages"],
  "signed_in.unknown": [],
  full_disk_access: ["open_full_disk_access", "reveal_app"],
  "full_disk_access.unknown": ["open_messages"],
  automation: ["allow_automation"],
  "automation.denied": ["open_automation"],
};

/** A message that exists only for some platforms or states; undefined where there is none. */
function optionalText(
  t: ReturnType<typeof useI18n>["t"],
  key: string,
  vars?: Record<string, string>,
): string | undefined {
  const text = t(key as MessageKey, vars);
  return text === key ? undefined : text;
}

function FlowTitle({ platform, title }: { platform: Platform; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <PlatformIcon platform={platform} size={40} />
      <h2 className="text-title2 font-semibold">{title}</h2>
    </div>
  );
}

/**
 * Sign in with a code (GitHub's device flow): the person signs in as the agent's own account,
 * enters the code Mingle shows, and authorizes. Mingle notices by itself and connects.
 */
function DeviceFlow({
  agent,
  info,
  onDone,
  onManual,
}: {
  agent: AgentView;
  info: PlatformInfo;
  onDone: () => void;
  onManual: () => void;
}) {
  const { t } = useI18n();
  const platform = info.platform;
  const platformName = t(`platform.${platform}` as MessageKey);
  const { sessionId, state, now, restart } = useOnboarding(agent.id, platform, (next) => {
    if (next.state === "done") setTimeout(onDone, 4000);
  });
  const [opened, setOpened] = useState(false);
  const vars = guideVars(agent);
  const s = state.state;
  const expired =
    (state.state === "device" && state.expiresAt <= now) || (state.state === "failed" && state.code === "expired");
  const minutes = state.state === "device" ? Math.max(1, Math.ceil((state.expiresAt - now) / 60_000)) : 0;
  const done = s === "done";
  const step2: StepState = done ? "done" : opened ? "done" : "now";
  const step3: StepState = done ? "done" : opened && !expired && s !== "failed" ? "now" : "later";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <FlowTitle platform={platform} title={t("connect.flowTitle", { platform: spaced(platformName) })} />
        <p className="text-ink2">{t(`${platform}.intro` as MessageKey, { name: agent.name })}</p>
      </div>
      <Steps>
        <Step
          n={1}
          state={done ? "done" : "todo"}
          title={t(`${platform}.account` as MessageKey, vars)}
          hint={t(`${platform}.accountWhy` as MessageKey, vars)}
        >
          <p className="text-small text-ink2">
            <GuideText text={t(`${platform}.accountHow` as MessageKey)} vars={vars} />
          </p>
          <LinkButton href="https://github.com/signup" small>
            {t(`${platform}.signup` as MessageKey)}
          </LinkButton>
        </Step>
        <Step n={2} state={step2} title={t(`${platform}.code` as MessageKey)} open={!done}>
          {state.state === "device" && !expired ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="selectable rounded-control border border-line2 bg-bg2 px-3 py-1.5 font-mono text-title2 font-semibold tracking-[0.12em]">
                  {state.userCode}
                </span>
                <a
                  href={state.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => {
                    void copyText(state.userCode);
                    setOpened(true);
                  }}
                  className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-control bg-accent px-3.5 font-medium whitespace-nowrap text-white transition-[filter] duration-[120ms] hover:brightness-110"
                >
                  {t(`${platform}.openCode` as MessageKey)}
                  <ArrowUpRight />
                </a>
              </div>
              <p className="text-caption text-ink3">
                {t(`${platform}.codeHint` as MessageKey, { minutes: String(minutes) })}
              </p>
            </div>
          ) : expired ? (
            <div className="flex flex-col gap-2">
              <p className="text-small text-ink2">{t(`${platform}.codeExpired` as MessageKey)}</p>
              <Button className="self-start" onClick={restart}>
                {t(`${platform}.newCode` as MessageKey)}
              </Button>
            </div>
          ) : s === "failed" && state.state === "failed" ? (
            <div className="flex flex-col gap-2">
              <Problem title={t("connect.failed")} tone="red">
                {errorTextFor(t, state.code)}
              </Problem>
              <Button className="self-start" onClick={restart}>
                {t("connect.retry")}
              </Button>
            </div>
          ) : done ? null : (
            <Waiting>{t(`${platform}.codeLoading` as MessageKey)}</Waiting>
          )}
          {!done && sessionId ? (
            <button type="button" onClick={onManual} className="self-start text-small text-accent hover:underline">
              {t(`${platform}.manual` as MessageKey)}
            </button>
          ) : null}
        </Step>
        <Step n={3} state={step3} title={t(`${platform}.authorize` as MessageKey)}>
          <Waiting>{t(`${platform}.authorizeWaiting` as MessageKey)}</Waiting>
        </Step>
      </Steps>
      {state.state === "done" ? (
        <p className="rise text-headline font-medium text-green">
          {t(`${platform}.done` as MessageKey, { bot: state.bot ?? agent.name })}
        </p>
      ) : null}
    </div>
  );
}

/** Start an onboarding session and follow it until it is done; `restart` begins a new one. */
function useOnboarding(agentId: string, platform: Platform, onState?: (state: OnboardingState) => void) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<OnboardingState>({ state: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt restarts the flow
  useEffect(() => {
    let id: string | null = null;
    let stopped = false;
    setState({ state: "starting" });
    api
      .startOnboarding(agentId, platform)
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
  }, [agentId, platform, attempt]);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const tick = async () => {
      const next = await api.onboarding(sessionId).catch(() => null);
      if (!active || !next) return;
      setState(next);
      if (next.state === "done") {
        active = false;
        clearInterval(timer);
      }
      onStateRef.current?.(next);
    };
    const timer = setInterval(tick, 1500);
    tick();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const restart = () => {
    setSessionId(null);
    setAttempt((n) => n + 1);
  };
  return { sessionId, state, now, restart };
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
  const { sessionId, state, now, restart } = useOnboarding(agent.id, info.platform, (next) => {
    if (next.state === "done") setTimeout(onDone, next.pendingApproval ? 2500 : 1200);
  });
  const platformName = t(`platform.${info.platform}` as MessageKey);
  // Scanning with another account adds a bot; the ones already here keep working.
  const existing = agent.connections.filter((c) => c.platform === info.platform).length;
  const anotherKey = `${info.platform}.another`;
  const another =
    existing > 0 && t(anotherKey as MessageKey) !== anotherKey
      ? t(anotherKey as MessageKey, { count: String(existing) })
      : null;

  // Where the platform does not take the name from Mingle, the phone may ask for one.
  const nameHint = optionalText(t, `${info.platform}.qrName`);
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
              {another ? <p className="text-small text-ink2">{another}</p> : null}
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
        <Step
          n={2}
          state={at(2)}
          title={t(`${info.platform}.qr2` as MessageKey, { name: agent.name })}
          {...(nameHint ? { hint: <GuideText text={nameHint} vars={guideVars(agent)} /> } : {})}
        >
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

/** A platform's own wording where it has one (iMessage has no bot token), else the shared one. */
function optional(t: ReturnType<typeof useI18n>["t"], key: string, fallback: MessageKey): string {
  const text = t(key as MessageKey);
  return text === key ? t(fallback) : text;
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
