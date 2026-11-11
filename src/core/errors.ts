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
  what: "message" | "chat" | "file" | "task" | "reminder" | "agent" | "connection",
  id: string,
) => {
  const list: Record<typeof what, string> = {
    message: `no message ${id}. Use "mingle message read <chat>" or "mingle message search" to find message IDs`,
    chat: `no chat ${id}. Run "mingle chat list" to see the chats you are in`,
    file: `no file ${id}. File IDs appear in message headers as file=<id>`,
    task: `no task ${id}. Run "mingle task list --all"`,
    reminder: `no reminder ${id}. Run "mingle reminder list"`,
    agent: `no agent ${id}. Run "mingle agent list"`,
    connection: `no connection ${id}. "mingle status" shows connection IDs in brackets`,
  };
  return new MingleError(`${what}_not_found`, list[what], 404);
};
