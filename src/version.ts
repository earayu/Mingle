import { readFileSync } from "node:fs";

/** From package.json, one level above both src/ and dist/ (also in the desktop app's copy). */
export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
      .version;
  } catch {
    return "0.0.0";
  }
})();
