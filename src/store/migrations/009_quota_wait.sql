-- A provider quota applies to new messages and reminders too, including after a restart.
ALTER TABLE agents ADD COLUMN quota_wait_until INTEGER;
ALTER TABLE agents ADD COLUMN quota_resets_at INTEGER;
