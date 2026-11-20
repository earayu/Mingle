/**
 * The pace of a group that hears everything (docs/spec.md 4.2, docs/rfc/0001-group-hearing-v2.md):
 * when what people said there reaches the agent, and what an unanswered stretch costs. Pure: it
 * takes the time and the facts it needs, and keeps no timers, store or runtime of its own, so every
 * rule here can be tested with a fake clock.
 *
 * Each person in a group has an engagement E (0–1) that halves every two minutes: the agent
 * answering them sets it to 1, calling it by name to at least 0.8, a stretch it left unanswered
 * cuts it to 0.6×. Only someone engaged ("in a conversation") moves the clock, at their own typing
 * rhythm and without the gap between stretches; others ride along with the next stretch. What an
 * engaged stretch the agent leaves unanswered costs is capped twice: by the person's own bucket and
 * by the group's, which is the owner's one knob (the tier).
 */

/** Mingle's own pace for a stretch nobody is in a conversation in (V1). */
export const HEAR_QUIET_MS = 20_000;
export const HEAR_MAX_WAIT_MS = 60_000;
export const HEAR_GAP_MS = 120_000;
/**
 * Left to Mingle's own pace, a chat whose stretches the agent keeps leaving unanswered is heard less
 * often: after `HEAR_BACKOFF_AFTER` in a row, each further one doubles the gap, up to
 * `HEAR_BACKOFF_MAX_MS`. The agent speaking there, someone addressing it or the owner speaking
 * brings the usual gap back. Only later, never lost: what was said waits for the next stretch.
 */
export const HEAR_BACKOFF_AFTER = 3;
export const HEAR_BACKOFF_MAX_MS = 30 * 60_000;

export type HearTier = "save" | "balanced" | "fast";
/** A group with at most this many people speaking in a week gets the `fast` tier by default. */
export const SMALL_GROUP = 5;

export function defaultTier(activePeople: number | undefined): HearTier {
  return activePeople === undefined || activePeople <= SMALL_GROUP ? "fast" : "balanced";
}

export interface Pace {
  readonly quietMs: number;
  readonly maxWaitMs: number;
  readonly gapMs: number;
}

export interface Bucket {
  readonly cap: number;
  readonly refillMs: number;
}

export interface Engage {
  readonly halfLifeMs: number;
  /** An unanswered stretch multiplies the E of everyone in it by this. */
  readonly damp: number;
  /** E from which a person is in a conversation. */
  readonly min: number;
  /** Calling the agent by name lifts E to at least this, halved per unanswered call in a row. */
  readonly nameBoost: number;
  /** A person's turn has ended after mean + k·sd of their gaps, within bounds; `defaultMs` until 3 gaps. */
  readonly turnEnd: {
    readonly k: number;
    readonly minMs: number;
    readonly maxMs: number;
    readonly defaultMs: number;
    readonly samples: number;
    readonly gapCapMs: number;
  };
  readonly fastMaxWaitMs: number;
  /** While someone is in a conversation, other lines wait at most this long for the next stretch. */
  readonly rideHoldMs: number;
  /** Unanswered calls in a row after which a person no longer counts as in a conversation. */
  readonly ignoredMax: number;
  /** A follow-up steered into the turn handling its sender waits at most this long for more. */
  readonly steerQuietMs: number;
  /** A turn that ends this soon after a follow-up was steered in may not have read it: handed over again once. */
  readonly steerLateMs: number;
  readonly person: Bucket;
  readonly tiers: Readonly<Record<HearTier, Bucket>>;
}

export const ENGAGE: Engage = {
  halfLifeMs: 120_000,
  damp: 0.6,
  min: 0.25,
  nameBoost: 0.8,
  turnEnd: { k: 2, minMs: 3_000, maxMs: 12_000, defaultMs: 8_000, samples: 20, gapCapMs: 30_000 },
  fastMaxWaitMs: 15_000,
  rideHoldMs: 240_000,
  ignoredMax: 2,
  steerQuietMs: 2_000,
  steerLateMs: 10_000,
  person: { cap: 3, refillMs: 600_000 },
  tiers: {
    save: { cap: 2, refillMs: 1_200_000 },
    balanced: { cap: 4, refillMs: 600_000 },
    fast: { cap: 8, refillMs: 300_000 },
  },
};

/**
 * How a stretch travels: `fast` someone in a conversation moves the clock; `steer` someone the
 * running turn is handling adds to it, and it goes into that turn; `ride` waits for the next
 * stretch while someone else is in one; `slow` Mingle's own pace (V1).
 */
export type Lane = "fast" | "steer" | "ride" | "slow";

export interface Plan {
  readonly lane: Lane;
  /** When the stretch should be handed over. */
  readonly dueAt: number;
  /** The timer must be set (again): false when the line rides along and the due time stands. */
  readonly reset: boolean;
}

/** A stretch handed to the agent, until its turn ends. */
export interface Stretch {
  readonly chatId: string;
  readonly groupId: string;
  /** The first message of the stretch. */
  readonly from: number;
  readonly lane: Lane;
  /** People who made it fast. */
  readonly engaged: ReadonlySet<string>;
  /** Everyone who spoke in it. */
  readonly heard: ReadonlySet<string>;
  /** Tokens held for it: given back if the agent speaks. */
  readonly reserved: boolean;
}

interface Person {
  e: number;
  eAt: number;
  ignored: number;
  tokens: number;
  tokensAt: number;
  gaps: number[];
  lastAt?: number;
}

interface Group {
  readonly people: Map<string, Person>;
  tier: HearTier;
  tokens: number;
  tokensAt: number;
}

interface Pending {
  readonly from: number;
  readonly since: number;
  fastSince?: number;
  lane: Lane;
  dueAt: number;
  readonly engaged: Set<string>;
  readonly heard: Set<string>;
  last: string;
  /** When its latest line came. */
  lastAt: number;
}

interface ChatHearing {
  readonly id: string;
  readonly groupId: string;
  pending?: Pending | undefined;
  heardAt?: number;
  /** Slow stretches in a row the agent has not spoken after: the backoff. */
  unanswered: number;
  /** Who the stretch now with the agent was from, for an answer that quotes nobody. */
  handed?: { readonly engaged: ReadonlySet<string>; readonly last: string } | undefined;
}

export class HearingBook {
  private readonly groups = new Map<string, Group>();
  private readonly chats = new Map<string, ChatHearing>();
  private readonly engage: Engage;
  private readonly pace: () => Pace;

  constructor(pace: () => Pace, engage: Partial<Engage> = {}) {
    this.pace = pace;
    this.engage = { ...ENGAGE, ...engage };
  }

  /**
   * A person spoke in a chat that hears everything, past the gate and not muted. Returns when the
   * stretch it belongs to should be handed over, and how.
   */
  observe(o: {
    chatId: string;
    groupId: string;
    senderId: string;
    /** When the message was said. */
    at: number;
    now: number;
    /** It calls the agent by its name or an alias. */
    named: boolean;
    owner: boolean;
    tier: HearTier;
    /** The gap the agent set with `chat hear --every`: no fast lane then, only slower. */
    everyMs?: number;
    /** The running turn is handling what this person said in this chat (docs/rfc/0001 3.5). */
    handling?: boolean;
  }): Plan {
    const { now } = o;
    const chat = this.chat(o.chatId, o.groupId);
    const group = this.group(o.groupId, o.tier, now);
    const person = this.person(group, o.senderId, now);
    const t = this.engage.turnEnd;
    if (person.lastAt !== undefined && o.at - person.lastAt < t.gapCapMs && o.at >= person.lastAt) {
      person.gaps.push(o.at - person.lastAt);
      if (person.gaps.length > t.samples) person.gaps.shift();
    }
    person.lastAt = o.at;
    // The owner speaking there is a sign the group matters: heard at the usual pace again.
    if (o.owner) chat.unanswered = 0;
    if (o.named) {
      const boost = this.engage.nameBoost * 0.5 ** person.ignored;
      if (boost > this.e(person, now)) this.setE(person, boost, now);
    }
    chat.pending ??= {
      from: o.at,
      since: now,
      lane: "slow",
      dueAt: Number.POSITIVE_INFINITY,
      engaged: new Set(),
      heard: new Set(),
      last: o.senderId,
      lastAt: now,
    };
    const pending = chat.pending;
    pending.heard.add(o.senderId);
    pending.last = o.senderId;
    pending.lastAt = now;
    const every = o.everyMs !== undefined;
    // Someone else spoke into a follow-up waiting to go into the running turn: theirs is not
    // steered in, so the stretch goes as a stretch of its own, after the turn.
    if (pending.lane === "steer" && [...pending.heard].some((id) => id !== o.senderId)) pending.lane = "fast";
    const live = !every && this.inConversation(group, person, now);
    // Adding to what the running turn is handling, and nothing else waits: it goes into that turn.
    if (live && o.handling && pending.heard.size === 1 && (pending.lane === "steer" || pending.lane === "slow")) {
      pending.fastSince ??= now;
      pending.engaged.add(o.senderId);
      pending.lane = "steer";
      pending.dueAt = Math.min(now + this.engage.steerQuietMs, pending.fastSince + this.engage.fastMaxWaitMs);
      return { lane: "steer", dueAt: pending.dueAt, reset: true };
    }
    if (live) {
      const e = this.e(person, now);
      pending.fastSince ??= now;
      pending.engaged.add(o.senderId);
      pending.lane = "fast";
      const p = this.pace();
      const quiet = e * this.turnEnd(person) + (1 - e) * p.quietMs;
      const maxWait = e * this.engage.fastMaxWaitMs + (1 - e) * p.maxWaitMs;
      pending.dueAt = Math.min(now + quiet, pending.fastSince + maxWait);
      return { lane: "fast", dueAt: pending.dueAt, reset: true };
    }
    // Someone is in a conversation: this line goes with their next stretch and does not push it back.
    if (pending.lane !== "slow") {
      return { lane: "ride", dueAt: pending.dueAt, reset: false };
    }
    const slow = this.slowDue(chat, pending, now, o.everyMs);
    if (!every && this.anyLive(group, now)) {
      pending.lane = "ride";
      pending.dueAt = Math.max(slow, (chat.heardAt ?? pending.since) + this.engage.rideHoldMs);
      return { lane: "ride", dueAt: pending.dueAt, reset: true };
    }
    pending.dueAt = slow;
    return { lane: "slow", dueAt: slow, reset: true };
  }

  /**
   * The timer is up: the stretch goes to the agent. A fast one holds a token of the group and of each
   * person who made it fast; when the group has none left meanwhile, it waits at the slow pace instead.
   */
  handOver(
    chatId: string,
    now: number,
    everyMs?: number,
    handling?: (senderId: string) => boolean,
  ): { stretch: Stretch } | { dueAt: number } | undefined {
    const chat = this.chats.get(chatId);
    const pending = chat?.pending;
    if (!chat || !pending) return undefined;
    const group = this.groups.get(chat.groupId);
    if (pending.lane === "steer") {
      // Steered into a turn already running, it costs no turn: no token, and the gap stands.
      if (everyMs === undefined && [...pending.engaged].every((id) => handling?.(id))) {
        chat.pending = undefined;
        chat.handed = {
          engaged: new Set([...(chat.handed?.engaged ?? []), ...pending.engaged]),
          last: pending.last,
        };
        return { stretch: this.stretchOf(chat, pending, false) };
      }
      // That turn ended meanwhile: this one starts a turn of its own.
      pending.lane = "fast";
    }
    if (everyMs !== undefined) {
      // The agent set its own pace (`chat hear --every`) after this stretch was planned: no fast lane
      // any more, and the gap it chose holds for what is already waiting.
      if (pending.lane !== "slow") {
        pending.lane = "slow";
        pending.engaged.clear();
      }
      const gapDue = chat.heardAt === undefined ? now : chat.heardAt + this.gap(chat.id, everyMs);
      if (gapDue > now) {
        pending.dueAt = gapDue;
        return { dueAt: gapDue };
      }
    }
    let reserved = false;
    if (pending.lane === "fast" && group) {
      // Checked again now, the person's bucket as well as the group's: the same person may have fast
      // stretches waiting in several threads of the group, and each saw a token when it was planned.
      const able = [...pending.engaged].filter((id) => {
        const person = group.people.get(id);
        return person !== undefined && this.personTokens(person, now) >= 1;
      });
      pending.engaged.clear();
      if (this.groupTokens(group, now) < 1 || able.length === 0) {
        pending.lane = "slow";
        pending.dueAt = this.slowDue(chat, pending, now, everyMs);
        if (pending.dueAt > now) return { dueAt: pending.dueAt };
      } else {
        group.tokens -= 1;
        for (const id of able) {
          pending.engaged.add(id);
          const person = group.people.get(id);
          if (person) person.tokens -= 1;
        }
        reserved = true;
      }
    }
    chat.pending = undefined;
    chat.heardAt = now;
    if (pending.lane === "slow" || pending.lane === "ride") chat.unanswered += 1;
    chat.handed = { engaged: new Set(pending.engaged), last: pending.last };
    return { stretch: this.stretchOf(chat, pending, reserved) };
  }

  /**
   * A follow-up steered in so late that its turn ended before it could have been read (within
   * `steerLateMs`), and the agent did not speak there since: handed over once more, at once, as a
   * fast stretch that holds tokens like any other. Nothing to settle for the steered one.
   */
  resend(stretch: Stretch, now: number): number | undefined {
    const chat = this.chats.get(stretch.chatId);
    if (!chat || stretch.lane !== "steer") return undefined;
    chat.handed = undefined;
    const pending: Pending = chat.pending ?? {
      from: stretch.from,
      since: now,
      lane: "fast",
      dueAt: now,
      engaged: new Set(),
      heard: new Set(),
      last: [...stretch.engaged].at(-1) ?? "",
      lastAt: now,
    };
    chat.pending = {
      ...pending,
      from: Math.min(pending.from, stretch.from),
      fastSince: now,
      lane: "fast",
      dueAt: now,
      engaged: new Set([...pending.engaged, ...stretch.engaged]),
      heard: new Set([...pending.heard, ...stretch.heard]),
    };
    return now;
  }

  /** Whether the turn a steered stretch went into ended too soon after it to have read it. */
  late(deliveredAt: number, endedAt: number): boolean {
    return endedAt - deliveredAt < this.engage.steerLateMs;
  }

  /** A stretch handed over that turned out to hold nothing to hear: as if it never went. */
  cancel(stretch: Stretch, now: number): void {
    const chat = this.chats.get(stretch.chatId);
    if (chat && (stretch.lane === "slow" || stretch.lane === "ride"))
      chat.unanswered = Math.max(0, chat.unanswered - 1);
    this.refund(stretch, now);
  }

  /** The turn a stretch went into ended. `spoke`: the agent said something in that chat since it was handed over. */
  settle(stretch: Stretch, spoke: boolean, now: number): void {
    const chat = this.chats.get(stretch.chatId);
    const group = this.groups.get(stretch.groupId);
    if (chat) chat.handed = undefined;
    if (spoke) {
      this.refund(stretch, now);
      if (chat) chat.unanswered = 0;
      return;
    }
    if (!group) return;
    for (const id of stretch.heard) {
      const person = group.people.get(id);
      if (person) this.setE(person, this.e(person, now) * this.engage.damp, now);
    }
    if (stretch.lane === "fast" || stretch.lane === "steer") {
      for (const id of stretch.engaged) {
        const person = group.people.get(id);
        if (person) person.ignored += 1;
      }
    }
  }

  /**
   * Who the agent answered with what it said in a chat: the person it quoted, or else the people in
   * a conversation in the stretch it was handed there (the last speaker when nobody was); nobody when
   * it spoke there unprompted.
   */
  answered(chatId: string, quoted: string | null): string[] {
    if (quoted) return [quoted];
    const handed = this.chats.get(chatId)?.handed;
    if (!handed) return [];
    return handed.engaged.size > 0 ? [...handed.engaged] : [handed.last];
  }

  /** The agent spoke in a chat: those it answered are in a conversation with it, and the backoff ends. */
  spoke(chatId: string, groupId: string, to: readonly string[], now: number): void {
    const chat = this.chats.get(chatId);
    if (chat) chat.unanswered = 0;
    if (to.length === 0) return;
    // Answered before anyone there was overheard (an @): the group starts here.
    const group = this.group(groupId, undefined, now);
    for (const id of to) {
      const person = this.person(group, id, now);
      this.setE(person, 1, now);
      person.ignored = 0;
    }
  }

  /** Someone addressed the agent (@ or reply): they are in a conversation with it, and the backoff ends. */
  addressed(chatId: string, groupId: string, senderId: string | null, now: number): void {
    const chat = this.chats.get(chatId);
    if (chat) chat.unanswered = 0;
    if (senderId) this.spoke(chatId, groupId, [senderId], now);
  }

  /** The least time between two slow stretches from this chat: the agent's `--every`, or the backoff. */
  gap(chatId: string, everyMs?: number): number {
    const base = this.pace().gapMs;
    if (everyMs !== undefined) return Math.max(base, everyMs);
    const unanswered = this.chats.get(chatId)?.unanswered ?? 0;
    if (unanswered < HEAR_BACKOFF_AFTER) return base;
    return Math.min(base * 2 ** (unanswered - HEAR_BACKOFF_AFTER + 1), HEAR_BACKOFF_MAX_MS);
  }

  /** The people in a conversation with the agent in this group now, most engaged first. */
  live(groupId: string, now: number): string[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    return [...group.people.entries()]
      .filter(([, p]) => this.inConversation(group, p, now))
      .sort(([, a], [, b]) => this.e(b, now) - this.e(a, now))
      .map(([id]) => id);
  }

  /** The pace changed or hearing was turned off: the backoff ends; `drop` forgets what waits. */
  forget(chatIds: readonly string[], drop: boolean): void {
    for (const id of chatIds) {
      const chat = this.chats.get(id);
      if (!chat) continue;
      chat.unanswered = 0;
      if (drop) chat.pending = undefined;
    }
  }

  /**
   * The pace changed (the agent's `--every`, or the owner put it back): when a stretch waiting at
   * the slow pace is due now, by the quiet window and the gap in force. One planned under a longer
   * gap is not held to it any more. Fast, steered and riding stretches keep their own time; `--every`
   * reaches those at hand-over.
   */
  retime(chatId: string, everyMs?: number): number | undefined {
    const chat = this.chats.get(chatId);
    const pending = chat?.pending;
    if (!chat || !pending) return undefined;
    if (pending.lane !== "slow") return pending.dueAt;
    const p = this.pace();
    const quiet = Math.min(pending.lastAt + p.quietMs, pending.since + p.maxWaitMs);
    pending.dueAt = chat.heardAt === undefined ? quiet : Math.max(quiet, chat.heardAt + this.gap(chatId, everyMs));
    return pending.dueAt;
  }

  /** Drop what a chat was waiting to hand over (someone addressed the agent meanwhile). */
  drop(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (chat) chat.pending = undefined;
  }

  /**
   * The owner picked another tier: the group's bucket follows at once, so stretches already waiting
   * are held to it. Tokens are cut to the new size, never refilled.
   */
  setTier(groupId: string, tier: HearTier, now: number): void {
    if (this.groups.has(groupId)) this.group(groupId, tier, now);
  }

  // ------------------------------------------------------------------ internals

  private stretchOf(chat: ChatHearing, pending: Pending, reserved: boolean): Stretch {
    return {
      chatId: chat.id,
      groupId: chat.groupId,
      from: pending.from,
      lane: pending.lane,
      engaged: new Set(pending.engaged),
      heard: new Set(pending.heard),
      reserved,
    };
  }

  private slowDue(chat: ChatHearing, pending: Pending, now: number, everyMs?: number): number {
    const p = this.pace();
    const quiet = Math.min(now + p.quietMs, pending.since + p.maxWaitMs);
    // Nothing handed over from this chat yet: no gap to keep.
    return chat.heardAt === undefined ? quiet : Math.max(quiet, chat.heardAt + this.gap(chat.id, everyMs));
  }

  private anyLive(group: Group, now: number): boolean {
    for (const person of group.people.values()) if (this.inConversation(group, person, now)) return true;
    return false;
  }

  private inConversation(group: Group, person: Person, now: number): boolean {
    return (
      person.ignored < this.engage.ignoredMax &&
      this.e(person, now) >= this.engage.min &&
      this.personTokens(person, now) >= 1 &&
      this.groupTokens(group, now) >= 1
    );
  }

  private turnEnd(person: Person): number {
    const t = this.engage.turnEnd;
    const gaps = person.gaps;
    if (gaps.length < 3) return t.defaultMs;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    return Math.min(Math.max(mean + t.k * sd, t.minMs), t.maxMs);
  }

  private e(person: Person, now: number): number {
    return person.e * 0.5 ** (Math.max(0, now - person.eAt) / this.engage.halfLifeMs);
  }

  private setE(person: Person, e: number, now: number): void {
    person.e = e;
    person.eAt = now;
  }

  private personTokens(person: Person, now: number): number {
    const b = this.engage.person;
    person.tokens = Math.min(b.cap, person.tokens + Math.max(0, now - person.tokensAt) / b.refillMs);
    person.tokensAt = now;
    return person.tokens;
  }

  private groupTokens(group: Group, now: number): number {
    const b = this.engage.tiers[group.tier];
    group.tokens = Math.min(b.cap, group.tokens + Math.max(0, now - group.tokensAt) / b.refillMs);
    group.tokensAt = now;
    return group.tokens;
  }

  private refund(stretch: Stretch, now: number): void {
    if (!stretch.reserved) return;
    const group = this.groups.get(stretch.groupId);
    if (!group) return;
    this.groupTokens(group, now);
    group.tokens = Math.min(this.engage.tiers[group.tier].cap, group.tokens + 1);
    for (const id of stretch.engaged) {
      const person = group.people.get(id);
      if (person) person.tokens = Math.min(this.engage.person.cap, this.personTokens(person, now) + 1);
    }
  }

  private chat(chatId: string, groupId: string): ChatHearing {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { id: chatId, groupId, unanswered: 0 };
      this.chats.set(chatId, chat);
    }
    return chat;
  }

  /** A group's state; `tier` as it is now, or unknown yet (fast, the tier of a group nobody was counted in). */
  private group(groupId: string, tier: HearTier | undefined, now: number): Group {
    let group = this.groups.get(groupId);
    if (!group) {
      const first = tier ?? "fast";
      group = { people: new Map(), tier: first, tokens: this.engage.tiers[first].cap, tokensAt: now };
      this.groups.set(groupId, group);
    } else if (tier !== undefined && group.tier !== tier) {
      this.groupTokens(group, now);
      group.tier = tier;
      group.tokens = Math.min(group.tokens, this.engage.tiers[tier].cap);
    }
    return group;
  }

  private person(group: Group, id: string, now: number): Person {
    let person = group.people.get(id);
    if (!person) {
      person = { e: 0, eAt: now, ignored: 0, tokens: this.engage.person.cap, tokensAt: now, gaps: [] };
      group.people.set(id, person);
    }
    return person;
  }
}

/**
 * Whether a message calls the agent by one of its names (docs/spec.md 4.2): case-insensitive, Latin
 * names as whole words, other scripts anywhere. Names shorter than 2 characters are ignored.
 */
export function nameIn(body: string, names: readonly (string | null | undefined)[]): boolean {
  const text = body.toLowerCase();
  for (const raw of new Set(names)) {
    const name = raw?.trim().toLowerCase();
    if (!name || [...name].length < 2) continue;
    if (/^[\p{Script=Latin}\d\s._-]+$/u.test(name)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(text)) return true;
    } else if (text.includes(name)) return true;
  }
  return false;
}

/**
 * A content cue that a line may be meant for the agent (docs/rfc/0001 3.8): a question to "you", or
 * a line soon after the agent spoke that quotes nobody. Only counted in the log for now.
 */
export function cueIn(body: string, opts: { at: number; agentSpokeAt?: number; quotes: boolean }): boolean {
  const text = body.trim();
  const question = /[?？]$|[吗呢嘛][?？。!！~～]*$/.test(text);
  if (question && /你|您|\byou\b/i.test(text)) return true;
  return (
    !opts.quotes &&
    opts.agentSpokeAt !== undefined &&
    opts.at - opts.agentSpokeAt >= 0 &&
    opts.at - opts.agentSpokeAt < 60_000
  );
}
