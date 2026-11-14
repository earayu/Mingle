-- When Mingle last told the agent its MEMORY.md had grown too large, and how large it was then
-- (docs/spec.md 4.5), so the hint comes at most once a day unless the file keeps growing.
ALTER TABLE agents ADD COLUMN memory_hint_at INTEGER;
ALTER TABLE agents ADD COLUMN memory_hint_size INTEGER;
