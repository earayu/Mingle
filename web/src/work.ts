import type { Reminder, Task } from "./api.ts";
import type { MessageKey, Translate } from "./i18n.ts";

/** Failed checks in a row before a reminder shows it as failing, as many as it takes to tell the agent (docs/spec.md 4.6). */
export const CHECK_FAILING = 3;

export type WorkDot = "connected" | "working" | "reconnecting" | "error" | "offline";

export interface WorkStatus {
  dot: WorkDot;
  labelKey: MessageKey;
}

/** What status dot a task row shows beside its title. */
export function taskStatus(task: Pick<Task, "status" | "line">): WorkStatus {
  if (task.line) {
    switch (task.line) {
      case "running":
        return { dot: "working", labelKey: "line.now" };
      case "waiting":
        return { dot: "reconnecting", labelKey: "line.waiting" };
      case "done":
        return { dot: "connected", labelKey: "line.done" };
      case "error":
        return { dot: "error", labelKey: "line.error" };
      case "queued":
        return { dot: "offline", labelKey: "line.queued" };
      case "stopped":
        return { dot: "offline", labelKey: "line.stopped" };
    }
  }
  if (task.status === "in_progress") return { dot: "connected", labelKey: "task.in_progress" };
  if (task.status === "done") return { dot: "connected", labelKey: "task.done" };
  return { dot: "offline", labelKey: "task.todo" };
}

export interface ReminderStatus extends WorkStatus {
  /** Severity of the latest check failure, when any. */
  problem: "failing" | "warning" | null;
}

/** What status dot and failure severity a reminder row shows. */
export function reminderStatus(reminder: Pick<Reminder, "lastFiredAt" | "check">): ReminderStatus {
  const check = reminder.check;
  if (check) {
    if (check.failures >= CHECK_FAILING) {
      return { dot: "error", labelKey: "agent.reminderCheckFailing", problem: "failing" };
    }
    if (check.failures > 0) {
      return { dot: "reconnecting", labelKey: "agent.reminderCheckWarning", problem: "warning" };
    }
    if (check.lastCheckedAt != null) {
      return { dot: "connected", labelKey: "agent.reminderCheckOk", problem: null };
    }
    return { dot: "offline", labelKey: "agent.reminderCheckPending", problem: null };
  }
  if (reminder.lastFiredAt != null) {
    return { dot: "connected", labelKey: "agent.reminderActive", problem: null };
  }
  return { dot: "offline", labelKey: "agent.reminderScheduled", problem: null };
}

/**
 * Known fixed failure reasons from src/core/check.ts (`outcome`), translated into the UI language;
 * anything unrecognized (e.g. from an older host) shows verbatim.
 */
export function checkErrorText(t: Translate, error: string | null | undefined): string | null {
  const text = error?.trim();
  if (!text) return null;
  const timeout = /^timed out after (\d+)s$/.exec(text);
  if (timeout?.[1]) return t("agent.reminderCheckErrTimeout", { seconds: timeout[1] });
  if (text === "printed more than 1 MiB") return t("agent.reminderCheckErrTooLarge");
  if (text === "was cancelled") return t("agent.reminderCheckErrCancelled");
  if (text === "could not run") return t("agent.reminderCheckErrSpawn");
  const exit = /^exited with (-?\d+)$/.exec(text);
  if (exit?.[1]) return t("agent.reminderCheckErrExit", { code: exit[1] });
  return text;
}

/** One-line failure summary shown directly under a failing check reminder's command. */
export function checkFailureSummary(t: Translate, failures: number, error: string | null | undefined): string | null {
  if (failures <= 0) return null;
  const reason = checkErrorText(t, error);
  if (failures === 1) {
    return reason ? t("agent.reminderCheckFailedOnceReason", { reason }) : t("agent.reminderCheckFailedOnce");
  }
  const count = String(failures);
  return reason
    ? t("agent.reminderCheckFailedManyReason", { count, reason })
    : t("agent.reminderCheckFailedMany", { count });
}
