/** An error meant for an agent or a user: a stable code and the next step to take. */
export class MingleError extends Error {
  readonly code: string;
  readonly next: string;
  readonly status: number;
  constructor(code: string, next: string, status = 400) {
    super(`${code}: ${next}`);
    this.name = "MingleError";
    this.code = code;
    this.next = next;
    this.status = status;
  }
}

export const notFound = (
  what: "message" | "chat" | "file" | "task" | "reminder" | "agent" | "connection" | "contact",
  id: string,
) => {
  const list: Record<typeof what, string> = {
    message: `no message ${id}. Use "mingle message read <chat>" or "mingle message search" to find message IDs`,
    chat: `no chat ${id}. Run "mingle chat list" to see the chats you are in`,
    file: `no file ${id}. File IDs appear in message headers as file=<id>`,
    task: `no task ${id}. Run "mingle task list --all"`,
    reminder: `no reminder ${id}. Run "mingle reminder list"`,
    agent: `no agent ${id}. Run "mingle agent list"`,
    contact: `no contact ${id}. Contact IDs appear in message headers as user=<id>; run "mingle contact list"`,
    connection: `no connection ${id}. "mingle status" shows connection IDs in brackets`,
  };
  return new MingleError(`${what}_not_found`, list[what], 404);
};

/** A name the owner or an agent gives a contact: one line, trimmed, at most 64 characters. Empty clears it. */
export function contactAlias(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MingleError("name_invalid", "pass the name as text");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) return null;
  if ([...name].length > 64) throw new MingleError("name_too_long", "keep the name to 64 characters or fewer");
  return name;
}
