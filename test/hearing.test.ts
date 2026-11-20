import { describe, expect, it } from "vitest";
import { cueIn, defaultTier, ENGAGE, HearingBook, type HearTier, nameIn, type Stretch } from "../src/core/hearing.ts";

/** The pace of a group that hears everything, on a fake clock (docs/spec.md 4.2, RFC 0001). */
const pace = { quietMs: 20_000, maxWaitMs: 60_000, gapMs: 120_000 };
const book = () => new HearingBook(() => pace);
const at = (s: number) => s * 1000;

function say(
  b: HearingBook,
  who: string,
  t: number,
  o: { named?: boolean; chat?: string; tier?: HearTier; handling?: boolean } = {},
) {
  return b.observe({
    chatId: o.chat ?? "c1",
    groupId: "c1",
    senderId: who,
    at: t,
    now: t,
    named: o.named ?? false,
    owner: false,
    tier: o.tier ?? "fast",
    ...(o.handling !== undefined ? { handling: o.handling } : {}),
  });
}

function handOver(b: HearingBook, t: number, chat = "c1"): Stretch {
  const r = b.handOver(chat, t);
  if (!r || !("stretch" in r)) throw new Error(`nothing handed over at ${t}`);
  return r.stretch;
}

describe("the pace of a group that hears everything", () => {
  it("keeps Mingle's own pace while nobody is in a conversation", () => {
    const b = book();
    expect(say(b, "u1", at(0))).toEqual({ lane: "slow", dueAt: at(20), reset: true });
    const s = handOver(b, at(20));
    b.settle(s, false, at(50));
    // The gap counts from the last stretch handed over.
    expect(say(b, "u1", at(60)).dueAt).toBe(at(140));
  });

  it("goes fast for someone the agent answered, without the gap, and ends their turn at their rhythm", () => {
    const b = book();
    say(b, "u1", at(0));
    b.settle(handOver(b, at(20)), true, at(50));
    b.spoke("c1", "c1", ["u1"], at(50));
    const plan = say(b, "u1", at(60));
    expect(plan.lane).toBe("fast");
    // E is a little under 1 ten seconds on: about the 8 s default turn end, well before the 2 min gap.
    expect(plan.dueAt).toBeGreaterThan(at(68));
    expect(plan.dueAt).toBeLessThan(at(69));
    // Their lines 3 s apart teach it their rhythm: the window shrinks toward 3 s (mixed with the
    // usual 20 s by how much E has faded since the answer).
    for (const t of [63, 66, 69, 72]) say(b, "u1", at(t));
    const last = say(b, "u1", at(75));
    expect(last.dueAt - at(75)).toBeLessThan(at(6));
  });

  it("never waits more than the fast lane's longest wait while someone keeps typing", () => {
    const b = book();
    b.spoke("c1", "c1", ["u1"], 0);
    say(b, "u1", at(0));
    let plan = say(b, "u1", at(0));
    for (let t = 1; t <= 30; t += 1) plan = say(b, "u1", at(t));
    // The longest wait is 15 s at E = 1, mixed toward 60 s as E fades: E is 0.84 by 30 s.
    expect(plan.dueAt).toBeLessThanOrEqual(at(23));
  });

  it("lets others ride along while someone is in a conversation, at most four minutes", () => {
    const b = book();
    say(b, "u1", at(0));
    b.settle(handOver(b, at(20)), true, at(40));
    b.spoke("c1", "c1", ["u1"], at(40));
    // Chatter first, with nobody else's stretch waiting: held, not handed over at the usual pace.
    const chatter = say(b, "u2", at(45));
    expect(chatter.lane).toBe("ride");
    expect(chatter.dueAt).toBe(at(20 + 240));
    // The person in the conversation moves the clock; chatter after that leaves it be.
    const fast = say(b, "u1", at(50));
    expect(fast.lane).toBe("fast");
    expect(say(b, "u2", at(51))).toEqual({ lane: "ride", dueAt: fast.dueAt, reset: false });
    const s = handOver(b, fast.dueAt);
    expect([...s.engaged]).toEqual(["u1"]);
    expect([...s.heard].sort()).toEqual(["u1", "u2"]);
  });

  it("takes a name as a call, and less so each time it went unanswered", () => {
    const b = book();
    for (let n = 0; n < 2; n++) {
      const t = at(n * 30);
      expect(say(b, "joker", t, { named: true }).lane).toBe("fast");
      b.settle(handOver(b, t + at(10)), false, t + at(20));
    }
    // Ignored twice: the name no longer makes them a conversation.
    expect(say(b, "joker", at(60), { named: true }).lane).toBe("slow");
    // Answered once, and it counts again.
    b.drop("c1");
    b.spoke("c1", "c1", ["joker"], at(70));
    expect(say(b, "joker", at(71), { named: true }).lane).toBe("fast");
  });

  it("caps what one person can spend with their own bucket, and leaves the rest of the group's", () => {
    const b = book();
    let t = 0;
    let fast = 0;
    for (let n = 0; n < 6; n++) {
      t += at(30);
      // Answered somewhere each time, so only their bucket can stop them.
      b.spoke("c1", "c1", ["joker"], t);
      if (say(b, "joker", t).lane === "fast") fast++;
      const r = b.handOver("c1", t + at(10));
      if (r && "stretch" in r) b.settle(r.stretch, false, t + at(12));
    }
    // Three tokens, a tenth of one back in each 30 s: three fast stretches, then no more.
    expect(fast).toBe(3);
    // Someone the agent answers still goes fast: the group's bucket is not spent.
    b.spoke("c1", "c1", ["bryce"], t + at(20));
    expect(say(b, "bryce", t + at(21)).lane).toBe("fast");
  });

  it("holds the tokens of a fast stretch from hand-over, so stretches on the way cannot overdraw", () => {
    const b = new HearingBook(() => pace, { tiers: { ...ENGAGE.tiers, save: { cap: 2, refillMs: 1e12 } } });
    for (const who of ["a", "b", "c"]) b.spoke("c1", "c1", [who], 0);
    const handed: Stretch[] = [];
    // Three threads of one group, each with a fast stretch, none settled yet.
    for (const [i, who] of ["a", "b", "c"].entries()) {
      say(b, who, at(1), { chat: `t${i}`, tier: "save" });
      const r = b.handOver(`t${i}`, at(10));
      if (r && "stretch" in r) handed.push(r.stretch);
    }
    expect(handed.filter((s) => s.reserved)).toHaveLength(2);
    // Answered: the tokens come back.
    b.settle(handed[0] as Stretch, true, at(20));
    expect(say(b, "a", at(21), { chat: "t0", tier: "save" }).lane).toBe("fast");
  });

  it("holds one person to their own bucket across threads of the group, checked at hand-over", () => {
    const b = book();
    b.spoke("c1", "c1", ["joker"], 0);
    const handed: Stretch[] = [];
    const later: number[] = [];
    // The same person, four threads at once: each saw their tokens when it was planned.
    for (let i = 0; i < 4; i++) expect(say(b, "joker", at(1), { chat: `t${i}` }).lane).toBe("fast");
    for (let i = 0; i < 4; i++) {
      const r = b.handOver(`t${i}`, at(10));
      if (r && "stretch" in r) handed.push(r.stretch);
      else if (r) later.push(r.dueAt);
    }
    // Three tokens of their own: the fourth goes at the slow pace instead.
    expect(handed.filter((s) => s.reserved)).toHaveLength(3);
    expect(handed.filter((s) => s.reserved && s.lane === "fast")).toHaveLength(3);
    expect(handed.length + later.length).toBe(4);
  });

  it("holds stretches already waiting to a tier the owner just lowered", () => {
    const b = book();
    for (const who of ["a", "b", "c", "d"]) b.spoke("c1", "c1", [who], 0);
    // Four fast stretches waiting in four threads, planned under the fast tier (8 tokens).
    for (const [i, who] of ["a", "b", "c", "d"].entries()) say(b, who, at(1), { chat: `t${i}` });
    // The owner picks "save" (2 tokens) before any of them is due, and nobody speaks again.
    b.setTier("c1", "save", at(2));
    let reserved = 0;
    for (let i = 0; i < 4; i++) {
      const r = b.handOver(`t${i}`, at(10));
      if (r && "stretch" in r && r.stretch.reserved) reserved++;
    }
    expect(reserved).toBe(2);
  });

  it("never wastes more fast stretches than the group's bucket allows (property)", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const tier = ENGAGE.tiers.balanced;
    const b = book();
    const wasted: number[] = [];
    let t = 0;
    let open: Stretch | undefined;
    let openAt = 0;
    let due: number | undefined;
    const chats = ["c1", "t1", "t2"];
    for (let n = 0; n < 10_000; n++) {
      // Time only moves forward: nothing happens before the last hand-over.
      t = Math.max(t, openAt) + random() * at(20);
      if (open && random() < 0.7) {
        const spoke = random() < 0.2;
        // Counted when its tokens were taken: at hand-over.
        if (!spoke && open.lane === "fast") wasted.push(openAt);
        if (spoke) b.spoke(open.chatId, "c1", [...open.heard], t);
        b.settle(open, spoke, t);
        open = undefined;
      }
      const chat = chats[Math.floor(random() * chats.length)] as string;
      const plan = say(b, `p${Math.floor(random() * 12)}`, t, { chat, named: random() < 0.3, tier: "balanced" });
      due = plan.dueAt;
      // A timer already past fires now, as setTimeout would.
      due = Math.max(due, t);
      if (!open && due <= t + at(20)) {
        const r = b.handOver(chat, due);
        if (r && "stretch" in r) {
          open = r.stretch;
          openAt = due;
        }
      }
    }
    // In any window of length T: at most cap + T / refill wasted fast stretches.
    for (let i = 0; i < wasted.length; i++) {
      for (let j = i; j < wasted.length; j++) {
        const span = (wasted[j] as number) - (wasted[i] as number);
        expect(j - i + 1).toBeLessThanOrEqual(tier.cap + span / tier.refillMs + 1e-9);
      }
    }
    expect(wasted.length).toBeGreaterThan(10);
  });

  it("backs off a chat whose slow stretches go unanswered, and an answer brings the gap back", () => {
    const b = book();
    for (let n = 0; n < 4; n++) {
      say(b, "u1", at(n * 1000));
      b.settle(handOver(b, at(n * 1000 + 20)), false, at(n * 1000 + 30));
    }
    // Four in a row: past the three that keep the usual gap, doubled twice.
    expect(b.gap("c1")).toBe(8 * 60_000);
    b.spoke("c1", "c1", ["u1"], at(5000));
    expect(b.gap("c1")).toBe(120_000);
    expect(b.gap("c1", 3_600_000)).toBe(3_600_000);
  });

  it("holds a stretch already waiting to a pace the agent set since, fast or slow", () => {
    const b = book();
    // A stretch handed over, answered; the next one is planned fast.
    say(b, "u1", at(0));
    const first = handOver(b, at(20));
    b.settle(first, true, at(30));
    b.spoke("c1", "c1", ["u1"], at(30));
    expect(say(b, "u1", at(31)).lane).toBe("fast");
    // Then the agent sets `--every 1h`: the waiting stretch neither goes fast nor holds a token, and
    // it waits out the hour from the last hand-over.
    const late = b.handOver("c1", at(40), 3_600_000);
    expect(late).toEqual({ dueAt: at(20) + 3_600_000 });
    const s = b.handOver("c1", at(20) + 3_600_000, 3_600_000);
    expect(s && "stretch" in s ? { lane: s.stretch.lane, reserved: s.stretch.reserved } : s).toEqual({
      lane: "slow",
      reserved: false,
    });
    // A slow one whose timer was set before the new gap waits for it too.
    say(b, "u2", at(20) + 3_600_000 + at(1));
    expect(b.handOver("c1", at(20) + 3_600_000 + at(21), 7_200_000)).toEqual({
      dueAt: at(20) + 3_600_000 + 7_200_000,
    });
  });

  it("times a waiting stretch again when the pace gets shorter", () => {
    const b = book();
    say(b, "u1", at(0));
    b.settle(handOver(b, at(20)), false, at(30));
    // Planned under `--every 1h`.
    say(b, "u1", at(40));
    expect(b.handOver("c1", at(60), 3_600_000)).toEqual({ dueAt: at(20) + 3_600_000 });
    // Back to the usual pace: due by the usual gap, not the hour.
    expect(b.retime("c1")).toBe(at(20) + 120_000);
    // Or `--every 2m`: the same.
    expect(b.retime("c1", 120_000)).toBe(at(20) + 120_000);
  });

  it("has no fast lane where the agent chose its own pace", () => {
    const b = book();
    b.spoke("c1", "c1", ["u1"], 0);
    const plan = b.observe({
      chatId: "c1",
      groupId: "c1",
      senderId: "u1",
      at: at(1),
      now: at(1),
      named: true,
      owner: false,
      tier: "fast",
      everyMs: 3_600_000,
    });
    expect(plan.lane).toBe("slow");
  });

  it("answers the quoted person, or those in a conversation in the stretch it was handed", () => {
    const b = book();
    b.spoke("c1", "c1", ["u1"], 0);
    say(b, "u1", at(1));
    say(b, "u2", at(2));
    handOver(b, at(10));
    expect(b.answered("c1", "u3")).toEqual(["u3"]);
    expect(b.answered("c1", null)).toEqual(["u1"]);
    expect(b.answered("c9", null)).toEqual([]);
  });
});

describe("telling who is meant", () => {
  it("steers a follow-up from the person the running turn is handling into it, for free", () => {
    const b = book();
    b.addressed("c1", "c1", "u1", at(0));
    const plan = say(b, "u1", at(5), { handling: true });
    expect(plan).toEqual({ lane: "steer", dueAt: at(7), reset: true });
    // Still handling them when it is due: it goes into that turn, holding no token and keeping no gap.
    const r = b.handOver("c1", at(7), undefined, (id) => id === "u1");
    if (!r || !("stretch" in r)) throw new Error("not handed over");
    expect(r.stretch).toMatchObject({ lane: "steer", reserved: false });
    // Not answered: like an unanswered fast stretch, the person counts it.
    b.settle(r.stretch, false, at(30));
    b.settle(handOver(b, say(b, "u1", at(31)).dueAt), false, at(50));
    expect(say(b, "u1", at(51)).lane).toBe("slow");
  });

  it("does not steer in what anyone else says, and takes the follow-up out of the turn once they do", () => {
    const b = book();
    b.addressed("c1", "c1", "u1", at(0));
    // Someone the turn is not handling: never steered, they ride along with u1's next stretch.
    expect(say(b, "u2", at(1), { handling: false }).lane).toBe("ride");
    b.drop("c1");
    expect(say(b, "u1", at(5), { handling: true }).lane).toBe("steer");
    // Someone else joins the follow-up before it goes: it all waits for a turn of its own.
    expect(say(b, "u2", at(6), { handling: false }).lane).toBe("ride");
    const s = handOver(b, at(7));
    expect(s).toMatchObject({ lane: "fast", reserved: true });
  });

  it("starts a turn of its own for a follow-up whose turn ended before it was due", () => {
    const b = book();
    b.addressed("c1", "c1", "u1", at(0));
    say(b, "u1", at(5), { handling: true });
    const r = b.handOver("c1", at(7), undefined, () => false);
    if (!r || !("stretch" in r)) throw new Error("not handed over");
    expect(r.stretch).toMatchObject({ lane: "fast", reserved: true });
  });

  it("hands a follow-up steered in too late over again once, holding tokens like a fast stretch", () => {
    const b = book();
    b.addressed("c1", "c1", "u1", at(0));
    say(b, "u1", at(5), { handling: true });
    const r = b.handOver("c1", at(7), undefined, () => true);
    if (!r || !("stretch" in r)) throw new Error("not handed over");
    expect(b.late(at(7), at(9))).toBe(true);
    expect(b.late(at(7), at(30))).toBe(false);
    expect(b.resend(r.stretch, at(9))).toBe(at(9));
    const again = handOver(b, at(9));
    expect(again).toMatchObject({ lane: "fast", reserved: true, from: at(5) });
    // Only a steered stretch is handed over again: the fast one is settled as usual.
    expect(b.resend(again, at(12))).toBeUndefined();
  });

  it("does not hand a late follow-up over at once when the group's tokens ran out", () => {
    const b = new HearingBook(() => pace, { tiers: { ...ENGAGE.tiers, fast: { cap: 1, refillMs: 3_600_000 } } });
    b.addressed("c1", "c1", "u1", at(0));
    say(b, "u1", at(5), { handling: true });
    const r = b.handOver("c1", at(7), undefined, () => true);
    if (!r || !("stretch" in r)) throw new Error("not handed over");
    // Someone else's fast stretch spent the one token meanwhile.
    b.spoke("c2", "c1", ["u2"], at(7));
    say(b, "u2", at(7), { chat: "c2" });
    handOver(b, at(9), "c2");
    b.resend(r.stretch, at(9));
    const later = b.handOver("c1", at(9));
    expect(later).toEqual({ dueAt: expect.any(Number) });
    expect((later as { dueAt: number }).dueAt).toBeGreaterThan(at(9));
  });

  it("finds a name as a word in Latin script and anywhere in others", () => {
    expect(nameIn("Alex, which way?", ["Alex"])).toBe(true);
    expect(nameIn("alexander said so", ["Alex"])).toBe(false);
    expect(nameIn("小跟班你看下", ["小跟班"])).toBe(true);
    expect(nameIn("hey bot", ["a", null, "bot"])).toBe(true);
    expect(nameIn("x", ["x"])).toBe(false);
  });

  it("counts a question to you, or a line just after the agent spoke, as a cue", () => {
    expect(cueIn("你觉得呢", { at: 0, quotes: false })).toBe(true);
    expect(cueIn("can you check?", { at: 0, quotes: false })).toBe(true);
    expect(cueIn("lunch at 12", { at: 0, quotes: false })).toBe(false);
    expect(cueIn("thanks", { at: 30_000, agentSpokeAt: 0, quotes: false })).toBe(true);
    expect(cueIn("thanks", { at: 30_000, agentSpokeAt: 0, quotes: true })).toBe(false);
  });

  it("picks the fast tier for small groups and groups it knows nothing about", () => {
    expect(defaultTier(undefined)).toBe("fast");
    expect(defaultTier(5)).toBe("fast");
    expect(defaultTier(6)).toBe("balanced");
  });
});
