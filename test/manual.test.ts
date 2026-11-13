import { describe, expect, it } from "vitest";
import { renderManual } from "../src/core/manual.ts";

describe("manual", () => {
  it("adds PowerShell instructions only on Windows", () => {
    expect(renderManual("Alex", "", "darwin")).not.toContain("PowerShell");
    const windows = renderManual("Alex", "", "win32");
    expect(windows).toContain("& $env:MINGLE_CLI message reply");
    expect(windows).toContain("Alex");
  });
});
