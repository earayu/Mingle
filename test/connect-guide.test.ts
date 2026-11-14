import { describe, expect, it } from "vitest";
import type { CredentialField } from "../web/src/api.ts";
import { guideVars, looksRight, pickTokens, recognizable, telegramUsername } from "../web/src/guide.ts";

const TELEGRAM: CredentialField[] = [{ key: "token", labelKey: "telegram.token", secret: true }];
const SLACK: CredentialField[] = [
  { key: "botToken", labelKey: "slack.botToken", secret: true },
  { key: "appToken", labelKey: "slack.appToken", secret: true },
];
const TG_TOKEN = "1234567890:AAH9xYz-abcdefghijklmnopqrstuvwxyz12";

describe("connect guides", () => {
  it("picks the token out of BotFather's whole reply", () => {
    const reply = `Done! Congratulations on your new bot.\nUse this token to access the HTTP API:\n${TG_TOKEN}\nKeep your token secure`;
    const values = pickTokens(TELEGRAM, {}, "token", reply);
    expect(values).toEqual({ token: TG_TOKEN });
    expect(looksRight(TELEGRAM[0] as CredentialField, values.token ?? "")).toBe(true);
  });

  it("leaves text that is not a token as typed, and says it does not look right", () => {
    expect(pickTokens(TELEGRAM, {}, "token", "12345")).toEqual({ token: "12345" });
    expect(looksRight(TELEGRAM[0] as CredentialField, "12345")).toBe(false);
  });

  it("puts each Slack token in its own box, whichever box it was pasted into", () => {
    const first = pickTokens(SLACK, {}, "botToken", "xapp-1-A0B-123-abc");
    expect(first).toEqual({ botToken: "", appToken: "xapp-1-A0B-123-abc" });
    const both = pickTokens(SLACK, first, "botToken", "xoxb-111-222-abc");
    expect(both).toEqual({ botToken: "xoxb-111-222-abc", appToken: "xapp-1-A0B-123-abc" });
  });

  it("checks fields without a known shape only for being filled", () => {
    const field = { key: "appId", labelKey: "feishu.appId", secret: false };
    expect(looksRight(field, "cli_a1")).toBe(true);
    expect(looksRight(field, " ")).toBe(false);
    // Only forms of recognizable tokens connect on their own; a half-typed secret must not.
    expect(recognizable([field])).toBe(false);
    expect(recognizable(SLACK)).toBe(true);
  });

  it("suggests a valid Telegram username from the agent, also for names in other scripts", () => {
    for (const agent of [
      { id: "a1", slug: "alex" },
      { id: "a2", slug: "agent-x7k2" },
      { id: "a3", slug: "9lives" },
      { id: "a4", slug: "a-very-long-agent-name-that-goes-on-and-on" },
    ]) {
      const name = telegramUsername(agent);
      expect(name).toMatch(/^[a-z][a-z0-9_]{4,31}$/);
      expect(name.endsWith("_bot")).toBe(true);
      expect(telegramUsername(agent)).toBe(name);
    }
    expect(telegramUsername({ id: "a1", slug: "alex" })).toMatch(/^alex_\d{3}_bot$/);
    expect(guideVars({ id: "a1", slug: "alex", name: " Alex " }).name).toBe("Alex");
  });
});
