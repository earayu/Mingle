import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type AccountUsage,
  api,
  type BrainStatus,
  type InstallPlan,
  type Job,
  type SignInState,
  type UpdateInfo,
  type UsageWindow,
} from "./api.ts";
import { selectBrains } from "./brains-list.ts";
import { useCached } from "./cache.ts";
import { type MessageKey, useI18n } from "./i18n.ts";
import { followJob } from "./jobs.ts";
import {
  Button,
  ChevronIcon,
  HarnessIcon,
  Input,
  LinkButton,
  Problem,
  StatusDot,
  shortDateTime,
  Waiting,
} from "./ui.tsx";

/**
 * Every harness OAR drives, installed or not. One that is missing can be installed from here
 * with its vendor's own installer, one that is signed out signed in with its own login, and
 * one its own updater says is behind updated with that updater.
 */

/** Poll a job until it ends. `onEnd` gets null when the job is gone and its outcome unknown. */
function useJob(start: (() => Promise<Job>) | null, onEnd: (job: Job | null) => void, initialJob?: Job) {
  const [job, setJob] = useState<Job | null>(initialJob ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new start function starts a new job
  useEffect(() => (start ? followJob(start, api.job, setJob, onEnd) : undefined), [start]);
  return job;
}

/** Install a harness: show what will run, then run it on the person's say-so. */
export function InstallBrain({
  brain,
  job,
  onInstall,
}: {
  brain: BrainStatus;
  job: Job | null;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const { value: plan } = useCached<InstallPlan>(`install-plan:${brain.id}`, () => api.installPlan(brain.id), {
    kind: "unsupported",
    detail: "",
  });

  if (job?.state === "running") return <Waiting>{t("brain.installing", { name: brain.name })}</Waiting>;
  if (job?.state === "done")
    return <p className="text-small text-green">{t("brain.installed", { name: brain.name })}</p>;
  if (!plan) return <Waiting>{t("brain.reading")}</Waiting>;
  return (
    <div className="flex flex-col gap-2.5">
      {plan.kind === "plan" ? (
        <>
          <p className="text-small text-ink2">{t("brain.installRuns")}</p>
          <Commands lines={plan.steps} />
          {job?.state === "failed" ? (
            <Problem title={t("brain.installFailed")} tone="red">
              <span className="selectable font-mono text-caption whitespace-pre-wrap wrap-anywhere">{job.detail}</span>
            </Problem>
          ) : null}
          <div className="flex items-center gap-2">
            <Button variant="primary" small onClick={onInstall}>
              {job?.state === "failed" ? t("connect.retry") : t("brain.install")}
            </Button>
            <a href={plan.source} target="_blank" rel="noreferrer" className="text-small text-accent hover:underline">
              {t("brain.vendorPage")}
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="text-small text-ink2">{plan.detail || t("brain.cannotInstall")}</p>
          {plan.steps ? <Commands lines={plan.steps} /> : null}
          {plan.source ? (
            <LinkButton href={plan.source} small>
              {t("brain.vendorPage")}
            </LinkButton>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Sign a harness in through its own login: a link to open, maybe a code to type back. */
export function SignInBrain({ brain, onDone }: { brain: BrainStatus; onDone: () => void }) {
  const { t } = useI18n();
  const [start, setStart] = useState<(() => Promise<Job>) | null>(null);
  const job = useJob(start, (j) => j?.state === "done" && onDone());
  const [answer, setAnswer] = useState("");

  if (!job || job.state === "cancelled") {
    return (
      <Button variant="primary" small className="self-start" onClick={() => setStart(() => () => api.signIn(brain.id))}>
        {t("brain.signIn")}
      </Button>
    );
  }
  if (job.state === "done") return <p className="text-small text-green">{t("brain.signedIn")}</p>;
  const url = [...job.events].reverse().find((e) => e.kind === "url" || e.kind === "code");
  const info = [...job.events].reverse().find((e) => e.kind === "info");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await api.answerJob(job.id, answer).catch(() => {});
    setAnswer("");
  };
  return (
    <div className="flex flex-col gap-2.5">
      {job.state === "failed" ? (
        <Problem title={t("brain.signInFailed")} tone="red">
          {job.detail}
        </Problem>
      ) : null}
      {url?.kind === "url" ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-small text-ink2">{t("brain.openToSignIn")}</span>
          <LinkButton href={url.url} small>
            {t("brain.openSignIn")}
          </LinkButton>
        </div>
      ) : url?.kind === "code" ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-small text-ink2">{t("brain.enterCode")}</span>
          <code className="self-start rounded-control bg-bg3 px-3 py-1.5 font-mono text-title3 tracking-widest">
            {url.code}
          </code>
          <LinkButton href={url.url} small>
            {t("brain.openSignIn")}
          </LinkButton>
        </div>
      ) : null}
      {info?.kind === "info" ? <p className="text-caption text-ink3">{info.message}</p> : null}
      {job.prompt ? (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <span className="text-small text-ink2">{job.prompt.message}</span>
          {job.prompt.options ? (
            <div className="flex flex-wrap gap-1.5">
              {job.prompt.options.map((o) => (
                <Button key={o.id} small onClick={() => api.answerJob(job.id, o.id)}>
                  {o.label}
                </Button>
              ))}
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                autoFocus
                type={job.prompt.secret ? "password" : "text"}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <Button type="submit" variant="primary" disabled={!answer.trim()}>
                {t("qr.codeSubmit")}
              </Button>
            </div>
          )}
        </form>
      ) : null}
      {job.state === "running" ? (
        <div className="flex items-center gap-3">
          <Waiting>{t("brain.waitingSignIn")}</Waiting>
          <Button variant="ghost" small onClick={() => api.cancelJob(job.id)}>
            {t("create.cancel")}
          </Button>
        </div>
      ) : (
        <Button small className="self-start" onClick={() => setStart(() => () => api.signIn(brain.id))}>
          {t("connect.retry")}
        </Button>
      )}
    </div>
  );
}

function Commands({ lines }: { lines: string[] }) {
  return (
    <pre className="selectable overflow-x-auto rounded-control bg-bg3 px-3 py-2 font-mono text-caption whitespace-pre-wrap wrap-anywhere">
      {lines.join("\n")}
    </pre>
  );
}

/** Whether an installed harness is signed in: the last known answer at once, re-read when shown. */
export function useSignIn(brain: BrainStatus | undefined) {
  const id = brain?.installed ? brain.id : null;
  const { value: state, reload } = useCached<SignInState>(
    id === null ? null : `sign-in:${id}`,
    () => api.signInState(id ?? ""),
    { kind: "unknown" },
  );
  return { state, reread: () => void reload() };
}

/** Whether the harness's own updater has a newer version. Asks its update source, so it is re-read when shown. */
function useUpdate(brain: BrainStatus) {
  const id = brain.installed && brain.canUpdate && !brain.disabled ? brain.id : null;
  const { value, reload } = useCached<UpdateInfo>(
    id === null ? null : `update:${id}`,
    () => api.updateCheck(id ?? ""),
    { kind: "unknown" },
  );
  return { update: value, recheck: () => void reload() };
}

/** The signed-in account's quota, where the harness reports it. Re-read when shown; the server holds it a minute. */
function useUsage(brain: BrainStatus, state: SignInState | null) {
  const id = brain.installed && !brain.disabled && state?.kind === "signed_in" ? brain.id : null;
  const { value } = useCached<AccountUsage>(id === null ? null : `usage:${id}`, () => api.accountUsage(id ?? ""), {
    kind: "unknown",
  });
  return value;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** "5-hour", "Weekly": by the window's length where the harness gives one, its own label otherwise. */
function windowName(t: ReturnType<typeof useI18n>["t"], w: UsageWindow): string {
  const ms = w.durationMs;
  if (ms === DAY_MS) return t("usage.day");
  if (ms === 7 * DAY_MS) return t("usage.week");
  if (ms !== undefined && ms >= 28 * DAY_MS && ms <= 31 * DAY_MS) return t("usage.month");
  if (ms !== undefined && ms < DAY_MS && ms % HOUR_MS === 0) return t("usage.hours", { count: String(ms / HOUR_MS) });
  return w.label;
}

/** Nearly gone: from here on the line says when the window starts over. */
const NEAR = 0.8;

/**
 * One quiet line under a signed-in harness: how much of each limit is gone. Amber only when a
 * limit is reached, with when it comes back and what happens to messages meanwhile.
 */
function UsageLine({ usage }: { usage: AccountUsage | null }) {
  const { t, locale } = useI18n();
  if (usage?.kind !== "available") return null;
  const full = usage.windows.filter((w) => w.used >= 1);
  if (usage.rateLimited || full.length) {
    // Every full window has to start over before a turn can run: the latest reset is the one.
    const back = Math.max(...full.map((w) => w.resetsAt ?? 0));
    return (
      <span className="text-caption text-amber">
        {back > Date.now() ? t("usage.reachedUntil", { time: shortDateTime(back, locale) }) : t("usage.reached")}
      </span>
    );
  }
  if (!usage.windows.length) return null;
  const parts = usage.windows.map((w) => {
    const text = t("usage.used", {
      window: windowName(t, w),
      percent: `${Math.min(99, Math.round(w.used * 100))}%`,
    });
    return w.used >= NEAR && w.resetsAt
      ? t("usage.usedResets", { used: text, time: shortDateTime(w.resetsAt, locale) })
      : text;
  });
  return <span className="selectable truncate text-caption text-ink3">{parts.join(" · ")}</span>;
}

/** Resume a job the catalog reports running, and remember the start function once set. */
function useResumableJob(resumeId: string | undefined) {
  // Set once: a finished job refreshes the catalog, which drops the running job; the
  // remembered start function must keep polling, not POST again or forget the outcome.
  const [start, setStart] = useState<(() => Promise<Job>) | null>(() => (resumeId ? () => api.job(resumeId) : null));
  // A row drawn from the cached catalog learns of a running job only when the fresh one arrives.
  useEffect(() => {
    if (resumeId) setStart((current) => current ?? (() => api.job(resumeId)));
  }, [resumeId]);
  return [start, setStart] as const;
}

/** One harness as a settings row: installed or not, signed in or not, and what to do about it. */
export function BrainRow({
  brain,
  onChanged,
  onActiveChange,
}: {
  brain: BrainStatus;
  onChanged: () => void;
  /** Lets a collapsible parent keep this row visible while an install or update is running or failed. */
  onActiveChange?: (id: string, active: boolean) => void;
}) {
  const { t } = useI18n();
  const { state, reread } = useSignIn(brain);
  const [open, setOpen] = useState(false);
  const { update, recheck } = useUpdate(brain);
  const usage = useUsage(brain, state);
  const [startInstall, setStartInstall] = useResumableJob(brain.installJob?.id);
  // A job that is gone may have changed things too: read them again.
  const installJob = useJob(startInstall, (job) => job?.state !== "failed" && onChanged(), brain.installJob);
  const [startUpgrade, setStartUpgrade] = useResumableJob(brain.upgradeJob?.id);
  const upgradeJob = useJob(
    startUpgrade,
    (job) => {
      if (job?.state === "failed") return;
      recheck();
      onChanged();
    },
    brain.upgradeJob,
  );
  const installing = installJob?.state === "running";
  const updating = upgradeJob?.state === "running";
  const busy = installing || updating;
  const active = busy || installJob?.state === "failed" || upgradeJob?.state === "failed";
  useEffect(() => {
    if (!onActiveChange) return;
    onActiveChange(brain.id, active);
    return () => {
      if (active) onActiveChange(brain.id, false);
    };
  }, [brain.id, active, onActiveChange]);
  const expanded = open || installing || installJob?.state === "failed";
  const signedOut = brain.installed && state?.kind === "signed_out" && brain.canSignIn;
  const status = installing
    ? t("brain.installing", { name: brain.name })
    : updating
      ? t("brain.updating", { name: brain.name })
      : !brain.installed
        ? brain.unsupported
          ? t("brain.notHere")
          : t("brain.notInstalled")
        : state === null
          ? (brain.version ?? "")
          : state.kind === "signed_in"
            ? [brain.version, state.account, state.plan].filter(Boolean).join(" · ")
            : state.kind === "signed_out"
              ? t("brain.signedOutShort")
              : (brain.version ?? "");
  const action =
    installing || installJob?.state === "failed"
      ? "install"
      : !brain.installed
        ? brain.canInstall && !brain.unsupported
          ? "install"
          : null
        : signedOut
          ? "signIn"
          : null;
  const latest = !action && !updating && update?.kind === "available" ? update.latest : null;
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <HarnessIcon harness={brain} size={28} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{brain.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-caption text-ink2">
            {brain.installed && !busy ? (
              <StatusDot state={state?.kind === "signed_out" ? "awaiting_approval" : "connected"} />
            ) : null}
            <span className={busy ? "selectable whitespace-normal wrap-anywhere" : "selectable truncate"}>
              {status}
            </span>
          </span>
          {busy ? null : <UsageLine usage={usage} />}
        </span>
        {action && !expanded ? (
          <Button small onClick={() => setOpen(true)}>
            {t(action === "install" ? "brain.install" : "brain.signIn")}
          </Button>
        ) : latest ? (
          <Button small onClick={() => setStartUpgrade(() => () => api.upgrade(brain.id))}>
            {t("brain.updateTo", { version: latest })}
          </Button>
        ) : null}
      </div>
      {upgradeJob?.state === "failed" && !action ? (
        <div className="pl-10">
          <Problem title={t("brain.updateFailed")} tone="red">
            <span className="selectable font-mono text-caption whitespace-pre-wrap wrap-anywhere">
              {upgradeJob.detail}
            </span>
          </Problem>
        </div>
      ) : null}
      {expanded && action === "install" ? (
        <div className="pl-10">
          <InstallBrain
            brain={brain}
            job={installJob}
            onInstall={() => setStartInstall(() => () => api.install(brain.id))}
          />
        </div>
      ) : null}
      {open && action === "signIn" ? (
        <div className="pl-10">
          <SignInBrain
            brain={brain}
            onDone={() => {
              reread();
              onChanged();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

export const brainHint = (t: (key: MessageKey) => string, brain: BrainStatus) =>
  brain.installed ? (brain.version ?? "") : t("brain.notInstalled");

/**
 * Rounded card of harnesses that stays compact when there are many: shows installed harnesses
 * first (capped, with in-use ones at the top) and folds the rest behind a disclosure footer row.
 */
export function BrainList({
  brains,
  used,
  onChanged,
  onCollapse,
  className = "",
}: {
  brains: readonly BrainStatus[];
  /** Harness ids currently used by local agents. */
  used?: ReadonlySet<string>;
  onChanged: () => void;
  /** Optional parent-owned collapse handler (shows a collapse footer when the list is already open). */
  onCollapse?: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const onActiveChange = useCallback((id: string, active: boolean) => {
    setPinned((current) => {
      if (current.has(id) === active) return current;
      const next = new Set(current);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const { visible, hiddenCount, collapsible } = selectBrains(brains, {
    ...(used ? { used } : {}),
    pinned,
    expanded: onCollapse ? true : expanded,
  });

  if (brains.length === 0) return null;
  const hasRunning = brains.some(
    (b) => b.installJob?.state === "running" || b.upgradeJob?.state === "running" || pinned.has(b.id),
  );
  const showFooter = onCollapse ? !hasRunning : collapsible;
  const isExpanded = onCollapse ? true : expanded;

  return (
    <div className={`overflow-hidden rounded-card border border-line bg-card ${className}`}>
      <div className="divide-y divide-line">
        {visible.map((brain) => (
          <BrainRow key={brain.id} brain={brain} onChanged={onChanged} onActiveChange={onActiveChange} />
        ))}
        {showFooter ? (
          <button
            type="button"
            aria-expanded={isExpanded}
            onClick={() => (onCollapse ? onCollapse() : setExpanded((current) => !current))}
            className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-small font-medium text-ink2 transition-colors duration-[120ms] hover:bg-bg2 hover:text-ink"
          >
            <span>{isExpanded ? t("brain.showLess") : t("brain.showMore", { count: String(hiddenCount) })}</span>
            <ChevronIcon
              className={`text-ink3 transition-transform duration-[180ms] ${isExpanded ? "rotate-180" : ""}`}
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}
