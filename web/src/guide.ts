import type { AgentView, CredentialField } from "./api.ts";

/**
 * What the connect guides fill in for the person: the names to type on the platform, and the
 * tokens picked out of whatever they paste. No React here, so it is tested on its own.
 */

/** How each platform's tokens look, keyed by their field's label. */
const TOKEN_SHAPES: Readonly<Record<string, RegExp>> = {
  "telegram.token": /\d{5,}:[A-Za-z0-9_-]{30,}/,
  "slack.botToken": /xoxb-[A-Za-z0-9-]+/,
  "slack.appToken": /xapp-[A-Za-z0-9-]+/,
  "discord.token": /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/,
  // Classic personal access tokens and OAuth tokens; fine-grained ones cannot read notifications.
  "github.token": /gh[po]_[A-Za-z0-9]{36,}/,
};

/** True when every field's token has a shape Mingle knows, so a full form can connect without a click. */
export function recognizable(fields: readonly CredentialField[]): boolean {
  return fields.length > 0 && fields.every((f) => TOKEN_SHAPES[f.labelKey]);
}

/** A field with a known token shape holds exactly one such token; any other field just has to be filled. */
export function looksRight(field: CredentialField, value: string): boolean {
  const shape = TOKEN_SHAPES[field.labelKey];
  if (!shape) return Boolean(value.trim());
  return shape.exec(value)?.[0] === value.trim();
}

/**
 * The form's values after `raw` was typed or pasted into `key`. A whole BotFather message yields
 * its token; a Slack app-level token pasted into the bot-token box lands in its own box.
 */
export function pickTokens(
  fields: readonly CredentialField[],
  values: Readonly<Record<string, string>>,
  key: string,
  raw: string,
): Record<string, string> {
  const next: Record<string, string> = { ...values, [key]: raw };
  const found = fields.filter((f) => TOKEN_SHAPES[f.labelKey]?.test(raw));
  if (found.length === 0) return next;
  // The text was some token: it goes where it belongs, and this box keeps what it had unless that was it.
  if (!found.some((f) => f.key === key)) next[key] = values[key] ?? "";
  for (const f of found) next[f.key] = TOKEN_SHAPES[f.labelKey]?.exec(raw)?.[0] ?? "";
  return next;
}

/** What a guide's text can name: the agent, and the usernames made from it for Telegram and GitHub. */
export function guideVars(agent: Pick<AgentView, "id" | "slug" | "name">): Record<string, string> {
  return { name: agent.name.trim(), username: telegramUsername(agent), handle: githubUsername(agent) };
}

/**
 * GitHub usernames are up to 39 letters, digits and single hyphens, not at either end. The agent's
 * own name is likely taken, and the suffix says what the account is.
 */
export function githubUsername(agent: Pick<AgentView, "slug">): string {
  const base = agent.slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return `${base || "mingle"}-agent`;
}

/**
 * Telegram usernames are 5–32 letters, digits and underscores, start with a letter and end in "bot".
 * Plain "alex_bot" is long taken, so three digits from the agent's ID make a free one likely.
 */
export function telegramUsername(agent: Pick<AgentView, "id" | "slug">): string {
  const base = agent.slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const head = (/^[a-z]/.test(base) ? base : `mingle_${base}`).slice(0, 22).replace(/_+$/, "");
  let hash = 0;
  for (const ch of agent.id) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `${head}_${String(hash % 1000).padStart(3, "0")}_bot`;
}
