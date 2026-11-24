import type { BrainStatus } from "./api.ts";

/** Maximum rows shown before collapsing when a harness list grows long. */
export const COLLAPSED_BRAINS_LIMIT = 4;

export interface BrainListSelection {
  /** All harnesses in display order: installed (in-use first), then installable, then unsupported. */
  readonly ordered: readonly BrainStatus[];
  /** Rows to render right now. */
  readonly visible: readonly BrainStatus[];
  /** How many rows stay hidden while collapsed (0 when not collapsible). */
  readonly hiddenCount: number;
  /** Whether a show-more / show-less toggle should be rendered. */
  readonly collapsible: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Order harnesses for Settings (installed and in-use first, unsupported last) and decide which
 * rows stay visible while collapsed. Any harness with an active or pinned job stays visible so
 * progress and failures are never hidden behind the fold.
 */
export function selectBrains(
  brains: readonly BrainStatus[],
  options: {
    used?: ReadonlySet<string>;
    pinned?: ReadonlySet<string>;
    expanded?: boolean;
    limit?: number;
  } = {},
): BrainListSelection {
  const used = options.used ?? EMPTY_SET;
  const pinned = options.pinned ?? EMPTY_SET;
  const expanded = options.expanded ?? false;
  const limit = options.limit ?? COLLAPSED_BRAINS_LIMIT;

  const rank = (brain: BrainStatus): number => {
    if (brain.installed) return used.has(brain.id) ? 0 : 1;
    return brain.unsupported ? 3 : 2;
  };
  const ordered = brains
    .map((brain, index) => ({ brain, index, rank: rank(brain) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.brain);

  if (ordered.length <= limit) {
    return { ordered, visible: ordered, hiddenCount: 0, collapsible: false };
  }

  const installed = ordered.filter((brain) => brain.installed);
  const primary = installed.length > 0 ? installed.slice(0, limit) : ordered.slice(0, limit);
  const kept = new Set(primary.map((brain) => brain.id));
  for (const brain of ordered) {
    if (brain.installJob?.state === "running" || brain.upgradeJob?.state === "running" || pinned.has(brain.id)) {
      kept.add(brain.id);
    }
  }

  const collapsed = ordered.filter((brain) => kept.has(brain.id));
  const hiddenCount = ordered.length - collapsed.length;
  // Never hide a single row behind a toggle row that takes nearly the same height.
  if (hiddenCount <= 1) {
    return { ordered, visible: ordered, hiddenCount: 0, collapsible: false };
  }

  return {
    ordered,
    visible: expanded ? ordered : collapsed,
    hiddenCount,
    collapsible: true,
  };
}
