import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  readonly home: string;
  readonly db: string;
  readonly agents: string;
  readonly bin: string;
  readonly logs: string;
  readonly runtime: string;
}

export function resolvePaths(home = process.env.MINGLE_HOME ?? join(homedir(), ".mingle")): Paths {
  return {
    home,
    db: join(home, "mingle.db"),
    agents: join(home, "agents"),
    bin: join(home, "bin"),
    logs: join(home, "logs"),
    runtime: join(home, "runtime.json"),
  };
}
