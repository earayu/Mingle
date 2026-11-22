import { memo, type ReactNode } from "react";

const MAX_RENDER_CACHE = 256;
const renderCache = new Map<string, ReactNode[]>();

function cachedBlocks(text: string): ReactNode[] {
  const hit = renderCache.get(text);
  if (hit) {
    renderCache.delete(text);
    renderCache.set(text, hit);
    return hit;
  }
  const built = blocks(text);
  if (renderCache.size >= MAX_RENDER_CACHE) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  renderCache.set(text, built);
  return built;
}

/**
 * What agents write, rendered for the private chat (docs/spec.md 6.9): paragraphs, headings,
 * lists, quotes, code, tables, emphasis and links. Built as React elements, never as HTML, so
 * nothing in a message can run or restyle the console. Anything it does not know stays plain text.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown flex flex-col gap-2.5">{cachedBlocks(text.replace(/\r\n?/g, "\n"))}</div>;
});

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function fenceOpen(line: string): { marker: string; lang: string } | undefined {
  const m = FENCE.exec(line);
  if (!m) return undefined;
  const marker = m[1] as string;
  const info = (m[2] ?? "").trim();
  // CommonMark: backtick fence info strings may not contain backticks (otherwise it's inline code).
  if (marker[0] === "`" && info.includes("`")) return undefined;
  return { marker, lang: info.split(/\s+/, 1)[0] ?? "" };
}

function isFenceClose(line: string, open: string): boolean {
  const m = FENCE_CLOSE.exec(line);
  if (!m) return false;
  const close = m[1] as string;
  return close[0] === open[0] && close.length >= open.length;
}

function parse(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let i = 0;
  const starts = (line: string) =>
    Boolean(fenceOpen(line)) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || QUOTE.test(line);
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i] as string, fence.marker)) body.push(lines[i++] as string);
      i++;
      out.push({ kind: "code", lang: fence.lang, text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: "h", level: (heading[1] as string).length, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) body.push(QUOTE.exec(lines[i++] as string)?.[1] ?? "");
      out.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const bullet = BULLET.test(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const pattern = bullet ? BULLET : NUMBERED;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] as string;
        const item = pattern.exec(current);
        if (item) {
          items.push((bullet ? item[1] : item[2]) ?? "");
          i++;
        } else if (current.trim() && /^\s{2,}/.test(current) && items.length) {
          // A wrapped or nested line belongs to the item above it.
          items[items.length - 1] += `\n${current.trim()}`;
          i++;
        } else break;
      }
      out.push({ kind: "list", ordered: !bullet, start: numbered ? Number(numbered[1]) : 1, items });
      continue;
    }
    if (line.includes("|") && TABLE_DIVIDER.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] as string).includes("|") && (lines[i] as string).trim())
        rows.push(cells(lines[i++] as string));
      out.push({ kind: "table", head, rows });
      continue;
    }
    const body: string[] = [line];
    i++;
    while (i < lines.length && (lines[i] as string).trim() && !starts(lines[i] as string))
      body.push(lines[i++] as string);
    out.push({ kind: "p", text: body.join("\n") });
  }
  return out;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function blocks(text: string): ReactNode[] {
  return parse(text).map((b, n) => {
    const key = `${b.kind}${n}`;
    switch (b.kind) {
      case "h":
        return (
          <p key={key} className={b.level <= 2 ? "text-headline font-semibold" : "font-semibold"}>
            {inline(b.text)}
          </p>
        );
      case "code":
        return (
          <pre
            key={key}
            className="selectable overflow-x-auto rounded-control border border-line bg-bg2 px-3 py-2 font-mono text-small"
          >
            <code>{b.text}</code>
          </pre>
        );
      case "quote":
        return (
          <blockquote key={key} className="border-l-2 border-line2 pl-3 text-ink2">
            {blocks(b.text)}
          </blockquote>
        );
      case "list": {
        const items = b.items.map((item, k) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond their place
          <li key={k} className="pl-0.5">
            {inline(item)}
          </li>
        ));
        return b.ordered ? (
          <ol key={key} start={b.start} className="flex list-decimal flex-col gap-1 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={key} className="flex list-disc flex-col gap-1 pl-5">
            {items}
          </ul>
        );
      }
      case "table":
        return (
          <div key={key} className="overflow-x-auto">
            <table className="border-collapse text-small">
              <thead>
                <tr>
                  {b.head.map((c, k) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity beyond their place
                    <th key={k} className="border-b border-line2 px-2.5 py-1.5 text-left font-semibold">
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their place
                  <tr key={r}>
                    {row.map((c, k) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity beyond their place
                      <td key={k} className="border-b border-line px-2.5 py-1.5 align-top">
                        {inline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "hr":
        return <hr key={key} className="border-line" />;
      default:
        return (
          <p key={key} className="whitespace-pre-wrap">
            {inline(b.text)}
          </p>
        );
    }
  });
}

/** Code spans, links, bold, italic and strikethrough, in one pass from left to right. */
const INLINE =
  /(`+)([\s\S]+?)\1|\[([^\]\n]+)\]\((\S+?)(?:\s+"[^"]*")?\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*(?!\s)([^*\n]+?)\*|(?<![\w])_(?!\s)([^_\n]+?)_(?![\w])/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `i${n++}`;
    if (m[2] !== undefined) {
      out.push(
        <code key={key} className="rounded-[5px] border border-line bg-bg2 px-1 font-mono text-[0.9em]">
          {m[2].replace(/^ (.*) $/, "$1")}
        </code>,
      );
    } else if (m[3] !== undefined) {
      out.push(link(key, m[4] ?? "", inline(m[3])));
    } else if (m[5] !== undefined || m[6] !== undefined) {
      const url = (m[5] ?? m[6]) as string;
      out.push(link(key, url, url));
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out.push(
        <strong key={key} className="font-semibold">
          {inline((m[7] ?? m[8]) as string)}
        </strong>,
      );
    } else if (m[9] !== undefined) {
      out.push(<s key={key}>{inline(m[9])}</s>);
    } else {
      out.push(<em key={key}>{inline((m[10] ?? m[11]) as string)}</em>);
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Only web and mail links open; anything else (javascript:, file:) stays text. */
function link(key: string, url: string, children: ReactNode): ReactNode {
  if (!/^(https?:|mailto:)/i.test(url)) return <span key={key}>{children}</span>;
  return (
    <a
      key={key}
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}
