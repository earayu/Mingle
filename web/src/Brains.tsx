import { type FormEvent, useEffect, useState } from "react";
import { api, type BrainStatus, type InstallPlan, type Job, type SignInState } from "./api.ts";
import { type MessageKey, useI18n } from "./i18n.ts";
import { Button, HarnessIcon, Input, LinkButton, Problem, StatusDot, Waiting } from "./ui.tsx";

/**
 * Every harness OAR drives, installed or not. One that is missing can be installed from here
 * with its vendor's own installer, and one that is signed out signed in with its own login.
 */

/** Poll a job until it ends. */
function useJob(start: (() => Promise<Job>) | null, onEnd: (job: Job) => void, initialJob?: Job) {
  const [job, setJob] = useState<Job | null>(initialJob ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new start function starts a new job
  useEffect(() => {
    if (!start) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (id: string) => {
      const next = await api.job(id).catch(() => null);
      if (!live || !next) return;
      setJob(next);
      if (next.state === "running") timer = setTimeout(() => poll(id), 1000);
      else onEnd(next);
    };
    start()
      .then((first) => {
        if (!live) return;
        setJob(first);
        poll(first.id);
      })
      .catch(
        (e: Error) =>
          live && setJob({ id: "", kind: "install", harness: "", state: "failed", events: [], detail: e.message }),
      );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [start]);
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
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  useEffect(() => {
    api
      .installPlan(brain.id)
      .then(setPlan)
      .catch(() => setPlan({ kind: "unsupported", detail: "" }));
  }, [brain.id]);

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
  const job = useJob(start, (j) => j.state === "done" && onDone());
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

/** Whether an installed harness is signed in, read once when shown. */
export function useSignIn(brain: BrainStatus | undefined) {
  const [state, setState] = useState<SignInState | null>(null);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce re-reads after a sign-in
  useEffect(() => {
    setState(null);
    if (!brain?.installed) return;
    let live = true;
    api
      .signInState(brain.id)
      .then((s) => live && setState(s))
      .catch(() => live && setState({ kind: "unknown" }));
    return () => {
      live = false;
    };
  }, [brain?.id, brain?.installed, nonce]);
  return { state, reread: () => setNonce((n) => n + 1) };
}

/** One harness as a settings row: installed or not, signed in or not, and what to do about it. */
export function BrainRow({ brain, onChanged }: { brain: BrainStatus; onChanged: () => void }) {
  const { t } = useI18n();
  const { state, reread } = useSignIn(brain);
  const [open, setOpen] = useState(false);
  const resumeId = brain.installJob?.id;
  // Set once: a finished install refreshes the catalog, which drops installJob; the
  // remembered start function must keep polling, not POST again or forget the outcome.
  const [startInstall, setStartInstall] = useState<(() => Promise<Job>) | null>(() =>
    resumeId ? () => api.job(resumeId) : null,
  );
  const installJob = useJob(startInstall, (job) => job.state === "done" && onChanged(), brain.installJob);
  const installing = installJob?.state === "running";
  const expanded = open || installing || installJob?.state === "failed";
  const signedOut = brain.installed && state?.kind === "signed_out" && brain.canSignIn;
  const status = installing
    ? t("brain.installing", { name: brain.name })
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
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <HarnessIcon harness={brain} size={28} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{brain.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-caption text-ink2">
            {brain.installed && !installing ? (
              <StatusDot state={state?.kind === "signed_out" ? "awaiting_approval" : "connected"} />
            ) : null}
            <span className={installing ? "selectable whitespace-normal wrap-anywhere" : "selectable truncate"}>
              {status}
            </span>
          </span>
        </span>
        {action && !expanded ? (
          <Button small onClick={() => setOpen(true)}>
            {t(action === "install" ? "brain.install" : "brain.signIn")}
          </Button>
        ) : null}
      </div>
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
