import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface RemoteRequest {
  method: string;
  path: string;
  body?: unknown;
  binary?: string;
  contentType?: string;
  fileName?: string;
}
export interface RemoteResponse {
  status: number;
  body: unknown;
  contentType?: string;
  disposition?: string;
  binary?: string;
}

/** One control channel; closing it never stops the independently running remote service. */
export class RpcClient {
  private next = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: RemoteResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly output: Writable;
  constructor(input: Readable, output: Writable) {
    this.output = output;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id: number; response?: RemoteResponse; error?: string };
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(message.id);
        if (message.response) waiting.resolve(message.response);
        else waiting.reject(new Error(message.error ?? "remote request failed"));
      } catch {
        this.close(new Error("invalid SSH control response"));
      }
    });
    lines.on("close", () => this.close(new Error("SSH control connection closed")));
    input.on("error", (error) => this.close(error));
    output.on("error", (error) => this.close(error));
  }
  request(request: RemoteRequest, timeoutMs = 30_000): Promise<RemoteResponse> {
    if (this.closed) return Promise.reject(new Error("SSH control connection closed"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("SSH control request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.output.write(`${JSON.stringify({ id, request })}\n`, (error) => {
        if (error) this.close(error);
      });
    });
  }
  close(error = new Error("SSH control connection closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.output.end();
  }
}

export function serveRpc(
  input: Readable,
  output: Writable,
  handler: (request: RemoteRequest) => Promise<RemoteResponse>,
): void {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    void (async () => {
      let id: number | undefined;
      try {
        if (line.length > 4 * 1024 * 1024) throw new Error("control request too large");
        const message = JSON.parse(line) as { id: number; request: RemoteRequest };
        id = message.id;
        const response = await handler(message.request);
        output.write(`${JSON.stringify({ id, response })}\n`);
      } catch {
        output.write(`${JSON.stringify({ id, error: "remote service request failed" })}\n`);
      }
    })();
  });
}
