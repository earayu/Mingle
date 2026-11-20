-- Groups hear everything by default (MING-129): what is said there reaches the agent a stretch at a
-- time, at a pace it can slow down itself. Existing groups switch over too; the owner can still turn
-- one off.
UPDATE chats SET listen = 1 WHERE kind = 'group';
