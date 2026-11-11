import { randomBytes } from "node:crypto";

// No 0/o/1/l/i: IDs are read and retyped by models and people.
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function shortId(prefix: string, length = 5): string {
  const bytes = randomBytes(length);
  let out = prefix;
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || shortId("agent-", 4);
}
