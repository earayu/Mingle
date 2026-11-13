import { randomBytes } from "node:crypto";
import type { Harness, SignInInteraction } from "../harness/harness.ts";
import { MingleError } from "./errors.ts";

/**
 * Installing a harness or signing it in takes minutes and may need the person: a link to
 * open, a code to type back. Each runs as a job the console polls, like a QR onboarding.
 */
export type JobEvent =
  | { readonly kind: "url"; readonly url: string; readonly instructions?: string }
  | { readonly kind: "code"; readonly code: string; readonly url: string }
  | { readonly kind: "info"; readonly message: string };

export interface JobView {
  readonly id: string;
  readonly kind: "install" | "sign_in";
  readonly harness: string;
  readonly state: "running" | "done" | "failed" | "cancelled";
  readonly events: readonly JobEvent[];
  /** Set while the harness waits for the person to answer. */
  readonly prompt?: {
    readonly message: string;
    readonly secret: boolean;
    readonly options?: readonly { readonly id: string; readonly label: string }[];
  };
  readonly detail?: string;
}

interface Job {
  view: JobView;
  readonly abort: AbortController;
  answer?: ((value: string) => void) | undefined;
}

export class Brains {
  private readonly jobs = new Map<string, Job>();
  private readonly harness: Harness;
  private readonly changed: () => void;

  /** `changed` runs when a job may have changed what is installed or signed in. */
  constructor(harness: Harness, changed: () => void) {
    this.harness = harness;
    this.changed = changed;
  }

  install(harness: string): JobView {
    const install = this.harness.install;
    if (!install) throw new MingleError("unsupported", "this Mingle cannot install harnesses");
    return this.start("install", harness, async () => install.call(this.harness, harness));
  }

  signIn(harness: string): JobView {
    const signIn = this.harness.signIn;
    if (!signIn) throw new MingleError("unsupported", "this Mingle cannot sign harnesses in");
    return this.start("sign_in", harness, (job) => {
      const interaction: SignInInteraction = {
        signal: job.abort.signal,
        onEvent: (event) => this.update(job, { events: [...job.view.events, event] }),
        prompt: (question) =>
          new Promise<string>((resolve, reject) => {
            this.update(job, { prompt: question });
            job.answer = (value) => {
              job.answer = undefined;
              const { prompt: _, ...rest } = job.view;
              job.view = rest;
              resolve(value);
            };
            job.abort.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
      };
      return signIn.call(this.harness, harness, interaction);
    });
  }

  /** Recover an installation after the console has been closed or navigated away. */
  activeInstall(harness: string): JobView | undefined {
    for (const { view } of this.jobs.values()) {
      if (view.harness === harness && view.kind === "install" && view.state === "running") return view;
    }
    return undefined;
  }

  get(id: string): JobView {
    const job = this.jobs.get(id);
    if (!job) throw new MingleError("job_not_found", "start the install or sign-in again", 404);
    return job.view;
  }

  answer(id: string, value: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new MingleError("job_not_found", "start the install or sign-in again", 404);
    if (!job.answer) throw new MingleError("no_question", "the harness is not waiting for an answer", 409);
    job.answer(value);
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job?.view.state !== "running") return;
    job.abort.abort();
    this.update(job, { state: "cancelled" });
  }

  dispose(): void {
    for (const id of this.jobs.keys()) this.cancel(id);
  }

  private start(
    kind: JobView["kind"],
    harness: string,
    run: (job: Job) => Promise<{ ok: boolean; detail?: string }>,
  ): JobView {
    // One job per harness and kind: a second click shows the first.
    for (const job of this.jobs.values()) {
      if (job.view.harness === harness && job.view.kind === kind && job.view.state === "running") return job.view;
    }
    const job: Job = {
      view: { id: `j${randomBytes(6).toString("hex")}`, kind, harness, state: "running", events: [] },
      abort: new AbortController(),
    };
    this.jobs.set(job.view.id, job);
    run(job)
      .then((result) => {
        if (job.view.state !== "running") return;
        this.update(job, {
          state: result.ok ? "done" : "failed",
          ...(result.detail ? { detail: result.detail } : {}),
        });
      })
      .catch((error: Error) => {
        if (job.view.state === "running") this.update(job, { state: "failed", detail: error.message });
      })
      .finally(() => {
        this.changed();
        // Keep the outcome around long enough for the console to read it.
        setTimeout(() => this.jobs.delete(job.view.id), 30 * 60_000).unref();
      });
    return job.view;
  }

  private update(job: Job, patch: Partial<JobView>): void {
    job.view = { ...job.view, ...patch };
  }
}
