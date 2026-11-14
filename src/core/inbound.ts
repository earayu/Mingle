import type { InboundState } from "../store/store.ts";

/**
 * The life of one inbound chat message, as an explicit state machine (docs/spec.md 4.10).
 *
 * Every change of an inbound message's state is one of these events, and goes through
 * `Store.moveInbound`, which applies it only to messages in one of the event's source
 * states. Anything else is a late or repeated result and leaves the message as it is:
 * a failure arriving after the reply, a retry of a message already answered, a reply
 * to a message the owner already ignored.
 *
 *   deliver: received ──▶ delivered
 *   give_up: delivered ──▶ unanswered
 *   fail:    received, delivered ──▶ failed
 *   hold:    received, delivered ──▶ waiting
 *   resume:  waiting ──▶ received
 *   reply:   received, delivered, waiting, unanswered, failed ──▶ replied
 *   send:    delivered, unanswered ──▶ replied
 *   retry:   waiting, failed, unanswered ──▶ received
 *   ignore:  waiting, failed, unanswered ──▶ ignored
 *   pause:   received, delivered, waiting ──▶ ignored
 *
 * `replied` and `ignored` are final. `failed` and `unanswered` wait for the owner (retry or
 * ignore in the console) or for the agent to answer later; `received` and `delivered` move
 * on by themselves (delivery, the end of the turn); `waiting` moves on by itself at its
 * retry time (or sooner, when the owner retries or ignores it).
 */
export type InboundEvent =
  /** Handed to the agent's session. */
  | "deliver"
  /** Could not be handed over, or the turn it was in failed. */
  | "fail"
  /** As `fail`, but the failure passes (a usage limit, a busy provider): try again at a set time. */
  | "hold"
  /** Its retry time came: back to the inbox. */
  | "resume"
  /** The turn ended, the agent was nudged once, and it still did not answer. */
  | "give_up"
  /** Answered by quoting it (`mingle message reply`, or Mingle answering `/stop`). */
  | "reply"
  /** A plain `mingle message send` to its chat: answers what the agent has seen there. */
  | "send"
  /** The owner asks the agent to try again: back to the inbox, nudge cleared. */
  | "retry"
  /** The owner dismisses it. */
  | "ignore"
  /** The owner paused the agent: what it had not answered yet will not be answered (docs/spec.md 4.11). */
  | "pause";

export const INBOUND: Readonly<
  Record<InboundEvent, { readonly from: readonly InboundState[]; readonly to: InboundState }>
> = {
  deliver: { from: ["received"], to: "delivered" },
  fail: { from: ["received", "delivered"], to: "failed" },
  hold: { from: ["received", "delivered"], to: "waiting" },
  resume: { from: ["waiting"], to: "received" },
  give_up: { from: ["delivered"], to: "unanswered" },
  // A failed message the agent answers by quoting it was answered: the person has the reply,
  // so it must leave the console's "failed" list.
  reply: { from: ["received", "delivered", "waiting", "unanswered", "failed"], to: "replied" },
  // A plain send only answers what the agent has seen and not settled otherwise. A failed
  // message may never have reached the agent; an unrelated message must not hide it.
  send: { from: ["delivered", "unanswered"], to: "replied" },
  retry: { from: ["waiting", "failed", "unanswered"], to: "received" },
  ignore: { from: ["waiting", "failed", "unanswered"], to: "ignored" },
  // Failed and unanswered messages stay for the owner to retry or ignore after resuming.
  // Waiting ones were in hand when the owner paused; like received ones, they are not answered later.
  pause: { from: ["received", "delivered", "waiting"], to: "ignored" },
};

export const FINAL_INBOUND: readonly InboundState[] = ["replied", "ignored"];

/** The state `event` moves a message in `state` to, or undefined when it does not apply. */
export function nextInbound(state: InboundState, event: InboundEvent): InboundState | undefined {
  const rule = INBOUND[event];
  return rule.from.includes(state) ? rule.to : undefined;
}
