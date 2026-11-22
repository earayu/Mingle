import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// Loaded by path: the root typecheck does not compile the console's JSX (web/tsconfig.json does).
const source = "../web/src/markdown.tsx";
const { Markdown } = (await import(source)) as { Markdown: FunctionComponent<{ text: string }> };

/** The private chat renders what agents write (docs/spec.md 6.9): the usual Markdown, never HTML. */
const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("private chat Markdown", () => {
  it("renders what agents write", () => {
    const out = html(
      "## Plan\n\nThree **things** and `code`:\n\n- one\n- two\n\n1. first\n2. second\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n> quoted\n\nSee [docs](https://example.com) or https://mingle.build.",
    );
    expect(out).toContain("<strong");
    expect(out).toContain("<code");
    expect(out).toContain("<ul");
    expect(out).toContain('<ol start="1"');
    expect(out).toContain("<table");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("<blockquote");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="https://mingle.build"');
    expect(out).not.toContain("**");
  });

  it("never lets a message run or inject anything", () => {
    const out = html('<img src=x onerror="alert(1)"> [click](javascript:alert(1)) <script>alert(2)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("href=");
    expect(out).toContain("&lt;img");
  });

  it("keeps line breaks inside a paragraph and snake_case words as they are", () => {
    const out = html("first line\nsecond line with my_var_name");
    expect(out).toContain("first line\nsecond line with my_var_name");
    expect(out).not.toContain("<em");
  });

  it("renders fenced code blocks with extended info strings and nested fences", () => {
    const csharp = html("```c#\nConsole.WriteLine(1);\n```");
    expect(csharp).toContain("<pre");
    expect(csharp).toContain("Console.WriteLine(1);");

    const titled = html('```ts title="app.ts"\nexport const ok = true;\n```');
    expect(titled).toContain("<pre");
    expect(titled).toContain("export const ok = true;");

    const nested = html("````markdown\n```ts\nconst a = 1;\n```\n````");
    expect(nested).toContain("<pre");
    expect(nested).toContain("```ts\nconst a = 1;\n```");
  });
});
