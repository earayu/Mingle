import type { ConnectionState } from "../channels/channel.ts";

/**
 * The life of one bot connection, as an explicit state machine (docs/spec.md 7.1).
 *
 * Every way a connection can change goes through `step`: Mingle starting, the computer
 * waking, the person pressing "Reconnect", a connect attempt ending, the adapter reporting,
 * the retry timer firing, the bot being removed. `step` is pure; Mingle carries out the
 * effect it returns and persists `stored(state)`. Keeping the rules in one table is what
 * makes "offline with nothing to do" impossible: every state either recovers by itself
 * (`waiting` has a timer) or names what the person must do (`stopped`).
 */

/** Problems Mingle cannot fix by trying again: the person has to act. */
export type StopCode = "credentials_revoked" | "permission_missing" | "credentials_missing";
/** Problems that may pass: Mingle tries again on its own. */
export type WaitCode = "network" | "unknown";

export type LinkState =
  /** A connect attempt is running, or the adapter is reconnecting by itself. */
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "connected" }
  | { readonly kind: "awaiting_approval" }
  /** Offline; the next attempt starts at `retryAt`. */
  | { readonly kind: "waiting"; readonly attempt: number; readonly code: WaitCode; readonly retryAt: number }
  /** Offline until the person acts (reconnect, or connect the bot again). */
  | { readonly kind: "stopped"; readonly code: StopCode }
  | { readonly kind: "removed" };

export type LinkEvent =
  /** Start, wake from sleep, or the person's "Reconnect": a fresh attempt now. */
  | { readonly kind: "connect" }
  /** The connect attempt resolved with a live connection. */
  | { readonly kind: "opened" }
  /** The connect attempt threw. `code` is what the adapter reported, if anything. */
  | { readonly kind: "failed"; readonly code?: StopCode | WaitCode }
  /** The adapter reported a state of its live connection. */
  | { readonly kind: "reported"; readonly state: ConnectionState }
  /** The retry timer fired. */
  | { readonly kind: "timer" }
  | { readonly kind: "remove" };

export type LinkEffect =
  /** Close the current live connection (if any) and start a connect attempt. */
  | "connect"
  /** Close the current live connection and arm the retry timer. */
  | "retry_later"
  /** Close the current live connection; nothing runs until the person acts. */
  | "close"
  /** The attempt resolved too late (the state moved on): close the connection it returned. */
  | "discard"
  | "none";

/** Waits between automatic attempts; the last one repeats. */
export const BACKOFF_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

export function backoff(attempt: number, delays: readonly number[] = BACKOFF_MS): number {
  return delays[Math.min(attempt, delays.length - 1)] ?? 300_000;
}

const STOPS: readonly string[] = ["credentials_revoked", "permission_missing", "credentials_missing"];

function offline(
  attempt: number,
  code: StopCode | WaitCode | undefined,
  now: number,
  delays: readonly number[],
): LinkState {
  if (code && STOPS.includes(code)) return { kind: "stopped", code: code as StopCode };
  return {
    kind: "waiting",
    attempt: attempt + 1,
    code: (code as WaitCode) ?? "network",
    retryAt: now + backoff(attempt, delays),
  };
}

export function step(
  state: LinkState,
  event: LinkEvent,
  now: number,
  delays: readonly number[] = BACKOFF_MS,
): { state: LinkState; effect: LinkEffect } {
  if (state.kind === "removed") return { state, effect: event.kind === "opened" ? "discard" : "none" };
  switch (event.kind) {
    case "remove":
      return { state: { kind: "removed" }, effect: "close" };
    case "connect":
      return { state: { kind: "connecting", attempt: 0 }, effect: "connect" };
    case "timer":
      return state.kind === "waiting"
        ? { state: { kind: "connecting", attempt: state.attempt }, effect: "connect" }
        : { state, effect: "none" };
    case "opened":
      // The adapter may have reported while connecting (Feishu waits for an admin): keep that.
      if (state.kind === "connecting") return { state: { kind: "connected" }, effect: "none" };
      if (state.kind === "connected" || state.kind === "awaiting_approval") return { state, effect: "none" };
      return { state, effect: "discard" };
    case "failed":
      // Already settled by a report during the attempt (for example, credentials refused).
      if (state.kind === "waiting" || state.kind === "stopped") return { state, effect: "none" };
      return settle(offline(attemptOf(state), event.code, now, delays));
    case "reported": {
      const reported = event.state;
      if (reported.kind === "connected") return { state: { kind: "connected" }, effect: "none" };
      if (reported.kind === "awaiting_approval") return { state: { kind: "awaiting_approval" }, effect: "none" };
      if (reported.kind === "connecting" || reported.kind === "reconnecting") {
        // The adapter is retrying by itself; nothing for Mingle to start.
        return { state: { kind: "connecting", attempt: attemptOf(state) }, effect: "none" };
      }
      // A report from an attempt already given up on changes nothing.
      if (state.kind === "waiting" || state.kind === "stopped") return { state, effect: "none" };
      // The adapter gave up. Closing its connection and starting over is the one recovery
      // that works for every platform; problems only the person can fix wait for them.
      return settle(offline(attemptOf(state), reported.code, now, delays));
    }
  }
}

function settle(next: LinkState): { state: LinkState; effect: LinkEffect } {
  return { state: next, effect: next.kind === "waiting" ? "retry_later" : "close" };
}

function attemptOf(state: LinkState): number {
  return state.kind === "connecting" || state.kind === "waiting" ? state.attempt : 0;
}

/** How a link state is kept in the connections table and shown in the console. */
export function stored(state: LinkState): {
  state: "reconnecting" | "connected" | "awaiting_approval" | "error";
  stateDetail: string | null;
} {
  switch (state.kind) {
    case "connecting":
    case "removed":
      return { state: "reconnecting", stateDetail: null };
    case "connected":
      return { state: "connected", stateDetail: null };
    case "awaiting_approval":
      return { state: "awaiting_approval", stateDetail: null };
    case "waiting":
    case "stopped":
      return { state: "error", stateDetail: state.code };
  }
}
