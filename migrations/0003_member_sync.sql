-- Accounts copied in from 8hues (hue_green_db) and shade (social_rpg_db) by src/sync.ts.
ALTER TABLE users ADD COLUMN source TEXT;      -- '8hues' | 'shade' | NULL for native signups
ALTER TABLE users ADD COLUMN source_id TEXT;   -- the member's id in that source
-- 1 while the password hash mirrors the source's, so password changes there carry over.
ALTER TABLE users ADD COLUMN pw_synced INTEGER NOT NULL DEFAULT 0;
-- Imported accounts stay hidden (activated = 0) until the person first logs in.
ALTER TABLE users ADD COLUMN activated INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX users_source ON users(source, source_id) WHERE source IS NOT NULL;
