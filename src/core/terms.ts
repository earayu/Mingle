/** The words of a search query; a "quoted phrase" stays one term. */
export function searchTerms(query: string): string[] {
  return (query.match(/"([^"]+)"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, "").trim()).filter(Boolean);
}
