import { describe, expect, it } from "vitest";
import { translator } from "../web/src/i18n.ts";
import { checkErrorText, checkFailureSummary, reminderStatus, taskStatus } from "../web/src/work.ts";

describe("taskStatus", () => {
  it("maps concurrent line states to status dots", () => {
    expect(taskStatus({ status: "in_progress", line: "running" })).toEqual({ dot: "working", labelKey: "line.now" });
    expect(taskStatus({ status: "in_progress", line: "waiting" })).toEqual({
      dot: "reconnecting",
      labelKey: "line.waiting",
    });
    expect(taskStatus({ status: "done", line: "done" })).toEqual({ dot: "connected", labelKey: "line.done" });
    expect(taskStatus({ status: "in_progress", line: "error" })).toEqual({ dot: "error", labelKey: "line.error" });
    expect(taskStatus({ status: "in_progress", line: "queued" })).toEqual({ dot: "offline", labelKey: "line.queued" });
    expect(taskStatus({ status: "closed", line: "stopped" })).toEqual({ dot: "offline", labelKey: "line.stopped" });
  });

  it("maps plain task states to status dots", () => {
    expect(taskStatus({ status: "in_progress", line: null })).toEqual({
      dot: "connected",
      labelKey: "task.in_progress",
    });
    expect(taskStatus({ status: "done", line: null })).toEqual({ dot: "connected", labelKey: "task.done" });
    expect(taskStatus({ status: "todo", line: null })).toEqual({ dot: "offline", labelKey: "task.todo" });
  });
});

describe("reminderStatus", () => {
  it("distinguishes healthy, warning, failing, and pending check reminders", () => {
    expect(
      reminderStatus({
        lastFiredAt: null,
        check: { command: "true", once: false, failures: 0, error: null, lastCheckedAt: 1000 },
      }),
    ).toEqual({ dot: "connected", labelKey: "agent.reminderCheckOk", problem: null });

    expect(
      reminderStatus({
        lastFiredAt: null,
        check: { command: "true", once: false, failures: 0, error: null, lastCheckedAt: null },
      }),
    ).toEqual({ dot: "offline", labelKey: "agent.reminderCheckPending", problem: null });

    expect(
      reminderStatus({
        lastFiredAt: null,
        check: { command: "false", once: false, failures: 1, error: "exited with 1", lastCheckedAt: 1000 },
      }),
    ).toEqual({ dot: "reconnecting", labelKey: "agent.reminderCheckWarning", problem: "warning" });

    expect(
      reminderStatus({
        lastFiredAt: null,
        check: { command: "false", once: false, failures: 2, error: "exited with 1", lastCheckedAt: 1000 },
      }),
    ).toEqual({ dot: "reconnecting", labelKey: "agent.reminderCheckWarning", problem: "warning" });

    expect(
      reminderStatus({
        lastFiredAt: null,
        check: { command: "false", once: false, failures: 3, error: "exited with 1", lastCheckedAt: 1000 },
      }),
    ).toEqual({ dot: "error", labelKey: "agent.reminderCheckFailing", problem: "failing" });
  });

  it("maps plain reminders based on whether they have fired", () => {
    expect(reminderStatus({ lastFiredAt: 1000, check: null })).toEqual({
      dot: "connected",
      labelKey: "agent.reminderActive",
      problem: null,
    });
    expect(reminderStatus({ lastFiredAt: null, check: null })).toEqual({
      dot: "offline",
      labelKey: "agent.reminderScheduled",
      problem: null,
    });
  });
});

describe("checkErrorText and checkFailureSummary", () => {
  it("translates known check.ts failure strings in Chinese and English, keeping unknown strings verbatim", () => {
    const zh = translator("zh-CN");
    const en = translator("en");

    expect(checkErrorText(zh, "timed out after 60s")).toBe("超时（60 秒）");
    expect(checkErrorText(en, "timed out after 60s")).toBe("timed out after 60s");
    expect(checkErrorText(zh, "printed more than 1 MiB")).toBe("输出超过 1 MiB");
    expect(checkErrorText(en, "printed more than 1 MiB")).toBe("output over 1 MiB");
    expect(checkErrorText(zh, "was cancelled")).toBe("已取消");
    expect(checkErrorText(zh, "could not run")).toBe("无法运行命令");
    expect(checkErrorText(zh, "exited with 6")).toBe("退出码 6");
    expect(checkErrorText(en, "exited with 6")).toBe("exited with 6");
    expect(checkErrorText(zh, "custom error detail")).toBe("custom error detail");
    expect(checkErrorText(zh, null)).toBeNull();
    expect(checkErrorText(zh, "   ")).toBeNull();
  });

  it("formats failure summaries for single, repeated, and reason-less failures", () => {
    const zh = translator("zh-CN");
    const en = translator("en");

    expect(checkFailureSummary(zh, 0, "exited with 1")).toBeNull();
    expect(checkFailureSummary(zh, 1, "timed out after 60s")).toBe("上次检查失败：超时（60 秒）");
    expect(checkFailureSummary(en, 1, "timed out after 60s")).toBe("Last check failed: timed out after 60s");
    expect(checkFailureSummary(zh, 1, null)).toBe("上次检查失败");
    expect(checkFailureSummary(zh, 2, "exited with 1")).toBe("连续失败 2 次：退出码 1");
    expect(checkFailureSummary(zh, 4, "exited with 6")).toBe("连续失败 4 次：退出码 6");
    expect(checkFailureSummary(en, 4, "exited with 6")).toBe("Failed 4 times: exited with 6");
    expect(checkFailureSummary(zh, 3, null)).toBe("连续失败 3 次");
    expect(checkFailureSummary(en, 3, null)).toBe("Failed 3 times in a row");
  });
});
