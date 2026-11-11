// Copy non-TypeScript files the code reads at run time (migrations, the agent guide, the console) into dist/.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const assets = [
  ["src/store/migrations", "dist/store/migrations"],
  ["src/cli/manual.md", "dist/cli/manual.md"],
];
for (const [from, to] of assets) {
  mkdirSync(to.endsWith(".md") ? "dist/cli" : to, { recursive: true });
  cpSync(from, to, { recursive: true });
}

if (existsSync("web/dist/index.html")) cpSync("web/dist", "dist/web", { recursive: true });
