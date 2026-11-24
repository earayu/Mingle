import { describe, expect, it } from "vitest";
import type { BrainStatus, Job } from "../web/src/api.ts";
import { COLLAPSED_BRAINS_LIMIT, selectBrains } from "../web/src/brains-list.ts";

const brain = (id: string, patch: Partial<BrainStatus> = {}): BrainStatus => ({
  id,
  name: id,
  installed: false,
  canInstall: true,
  canSignIn: false,
  canUpdate: false,
  ...patch,
});

const runningJob = (id: string, kind: Job["kind"] = "install"): Job => ({
  id: `j-${id}`,
  kind,
  harness: id,
  state: "running",
  events: [],
});

describe("selectBrains", () => {
  it("shows everything without a toggle when the list fits within the limit", () => {
    const list = [
      brain("install-test", { installed: false }),
      brain("other-test", { installed: false }),
      brain("update-test", { installed: true }),
    ];
    const result = selectBrains(list);
    expect(result.collapsible).toBe(false);
    expect(result.hiddenCount).toBe(0);
    expect(result.visible.map((b) => b.id)).toEqual(["update-test", "install-test", "other-test"]);
  });

  it("orders installed (in-use first), then installable, then unsupported while preserving catalog order", () => {
    const list = [
      brain("claude", { installed: true }),
      brain("codex", { installed: false, unsupported: "macOS only" }),
      brain("cursor", { installed: false }),
      brain("opencode", { installed: true }),
      brain("pi", { installed: true }),
      brain("devin", { installed: false }),
    ];
    const result = selectBrains(list, { used: new Set(["pi"]), expanded: true });
    expect(result.ordered.map((b) => b.id)).toEqual(["pi", "claude", "opencode", "cursor", "devin", "codex"]);
    expect(result.visible.map((b) => b.id)).toEqual(["pi", "claude", "opencode", "cursor", "devin", "codex"]);
  });

  it("shows only installed harnesses when collapsed and collapses the rest", () => {
    const list = [
      brain("claude", { installed: true }),
      brain("codex"),
      brain("cursor"),
      brain("opencode"),
      brain("kimi"),
      brain("pi", { installed: true }),
    ];
    const collapsed = selectBrains(list);
    expect(collapsed.collapsible).toBe(true);
    expect(collapsed.hiddenCount).toBe(4);
    expect(collapsed.visible.map((b) => b.id)).toEqual(["claude", "pi"]);

    const expanded = selectBrains(list, { expanded: true });
    expect(expanded.collapsible).toBe(true);
    expect(expanded.visible.map((b) => b.id)).toEqual(["claude", "pi", "codex", "cursor", "opencode", "kimi"]);
  });

  it("caps installed harnesses at the collapsed limit while keeping in-use harnesses first", () => {
    const list = [
      brain("claude", { installed: true }),
      brain("codex", { installed: true }),
      brain("cursor", { installed: true }),
      brain("opencode", { installed: true }),
      brain("kimi", { installed: true }),
      brain("pi", { installed: true }),
      brain("devin"),
    ];
    const result = selectBrains(list, { used: new Set(["pi", "kimi"]) });
    expect(result.collapsible).toBe(true);
    expect(result.visible).toHaveLength(COLLAPSED_BRAINS_LIMIT);
    expect(result.visible.map((b) => b.id)).toEqual(["kimi", "pi", "claude", "codex"]);
    expect(result.hiddenCount).toBe(3);
  });

  it("shows the top installable harnesses when none are installed", () => {
    const list = [
      brain("claude"),
      brain("codex"),
      brain("cursor"),
      brain("opencode"),
      brain("kimi"),
      brain("grok"),
      brain("devin", { unsupported: "unsupported" }),
    ];
    const result = selectBrains(list);
    expect(result.collapsible).toBe(true);
    expect(result.visible.map((b) => b.id)).toEqual(["claude", "codex", "cursor", "opencode"]);
    expect(result.hiddenCount).toBe(3);
  });

  it("keeps harnesses with active or pinned jobs visible even when collapsed", () => {
    const list = [
      brain("claude", { installed: true }),
      brain("codex"),
      brain("cursor", { installJob: runningJob("cursor", "install") }),
      brain("opencode"),
      brain("kimi"),
      brain("grok"),
    ];
    const result = selectBrains(list, { pinned: new Set(["kimi"]) });
    expect(result.collapsible).toBe(true);
    expect(result.visible.map((b) => b.id)).toEqual(["claude", "cursor", "kimi"]);
    expect(result.hiddenCount).toBe(3);
  });

  it("does not collapse when only a single row would be hidden", () => {
    const list = [
      brain("claude", { installed: true }),
      brain("codex", { installed: true }),
      brain("cursor", { installed: true }),
      brain("opencode", { installed: true }),
      brain("kimi", { installed: true }),
    ];
    const result = selectBrains(list);
    expect(result.collapsible).toBe(false);
    expect(result.hiddenCount).toBe(0);
    expect(result.visible).toHaveLength(5);
  });
});
