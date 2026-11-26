-- Unify user identity with shade: users.id becomes TEXT, matching the id space
-- of social_rpg_db.users, so one person is one id across both apps and the game
-- character attached to that id stays attached.
--
-- Why TEXT and not shade adopting INTEGER: shade's users.id is what every
-- characters.user_id points at. Those rows are the players. Retyping shade's
-- side would mean rewriting the live game's foreign keys; retyping this side
-- costs nothing that matters, because there is no human content here yet
-- (0 human tweets, 0 human likes, 0 human follows at the time of writing).
--
-- What is carried and what is not:
--   * Accounts with source IS NULL are kept — the AI persona and news accounts
--     from src/bots.ts and src/news.ts, which authored everything here, plus
--     native signups. They exist nowhere else, so they are minted ids in
--     shade's shape (32 hex chars) rather than borrowed ones.
--   * Accounts with source IS NOT NULL are dropped. They are imported members
--     who have never logged in, and src/sync.ts re-imports them on its next
--     tick (:07/:22/:37/:52) keyed to the source's own id. Re-importing them is
--     how they acquire shade's real id instead of a local one.
--   * tweets, likes and follows are carried for surviving accounts. tweet ids
--     are preserved, because tweet_tags, news_items, likes and notifications
--     reference them and those tables are not rebuilt.
--   * sessions and password_setups are dropped. Both are short-lived tokens
--     keyed to ids that are changing, so everyone signs in again once.
--
-- password_hash and password_salt become nullable. They were NOT NULL, which
-- no shade account signing in through Google or phone can satisfy — those
-- users have no password at all, and under one id space they have to be
-- representable here.

PRAGMA defer_foreign_keys = on;

-- Old INTEGER id -> newly minted TEXT id, for the accounts being carried.
-- Materialised once so every table below translates through the same values.
CREATE TABLE _id_map (
  old_id INTEGER PRIMARY KEY,
  new_id TEXT NOT NULL
);
INSERT INTO _id_map (old_id, new_id)
SELECT id, lower(hex(randomblob(16))) FROM users WHERE source IS NULL;

-- Stage the rows to keep, already translated. Staging rather than renaming
-- avoids depending on SQLite rewriting other tables' REFERENCES clauses when a
-- table is renamed.
CREATE TABLE _s_users AS
SELECT m.new_id AS id, u.username, u.display_name, u.bio,
       u.password_hash, u.password_salt, u.created_at, u.email,
       u.source, u.source_id, u.pw_synced, u.activated, u.kind
FROM users u JOIN _id_map m ON m.old_id = u.id;

CREATE TABLE _s_tweets AS
SELECT t.id, m.new_id AS user_id, t.body, t.media_key, t.reply_to,
       t.created_at, t.link_url, t.link_title
FROM tweets t JOIN _id_map m ON m.old_id = t.user_id;

-- Both ends must survive, or the edge is meaningless.
CREATE TABLE _s_follows AS
SELECT mf.new_id AS follower_id, mg.new_id AS followee_id, f.created_at
FROM follows f
JOIN _id_map mf ON mf.old_id = f.follower_id
JOIN _id_map mg ON mg.old_id = f.followee_id;

CREATE TABLE _s_likes AS
SELECT m.new_id AS user_id, l.tweet_id, l.created_at
FROM likes l
JOIN _id_map m ON m.old_id = l.user_id
JOIN _s_tweets t ON t.id = l.tweet_id;

CREATE TABLE _s_notifications AS
SELECT n.id, mu.new_id AS user_id, ma.new_id AS actor_id, n.type,
       n.tweet_id, n.created_at, n.read
FROM notifications n
JOIN _id_map mu ON mu.old_id = n.user_id
JOIN _id_map ma ON ma.old_id = n.actor_id;

CREATE TABLE _s_messages AS
SELECT g.id, ms.new_id AS sender_id, mr.new_id AS recipient_id, g.body,
       g.created_at, g.read_at
FROM messages g
JOIN _id_map ms ON ms.old_id = g.sender_id
JOIN _id_map mr ON mr.old_id = g.recipient_id;

-- tweet_tags and news_items carry no user id and are not being retyped, but
-- they still have to be staged. DROP TABLE performs an implicit DELETE FROM,
-- and that fires ON DELETE actions — PRAGMA defer_foreign_keys does not
-- suppress them. So dropping tweets empties tweet_tags (ON DELETE CASCADE) and
-- nulls news_items.tweet_id (ON DELETE SET NULL) purely as a side effect,
-- taking the hashtag index behind trending with it. Both are restored below,
-- once tweets exists again.
CREATE TABLE _s_tweet_tags AS
SELECT tt.tweet_id, tt.tag, tt.created_at
FROM tweet_tags tt JOIN _s_tweets t ON t.id = tt.tweet_id;

CREATE TABLE _s_news_items AS
SELECT n.url, n.feed, n.tweet_id, n.created_at FROM news_items n;

-- Children first: ON DELETE CASCADE still fires while foreign keys are
-- deferred, so dropping users ahead of them would take their rows with it.
DROP TABLE messages;
DROP TABLE notifications;
DROP TABLE likes;
DROP TABLE follows;
DROP TABLE password_setups;
DROP TABLE sessions;
DROP TABLE tweets;
DROP TABLE users;

CREATE TABLE users (
  id            TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  bio           TEXT    NOT NULL DEFAULT '',
  password_hash TEXT,
  password_salt TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  email         TEXT,
  source        TEXT,
  source_id     TEXT,
  pw_synced     INTEGER NOT NULL DEFAULT 0,
  activated     INTEGER NOT NULL DEFAULT 1,
  kind          TEXT    NOT NULL DEFAULT 'human'
);
CREATE UNIQUE INDEX users_email  ON users(email);
CREATE UNIQUE INDEX users_source ON users(source, source_id) WHERE source IS NOT NULL;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE tweets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  media_key  TEXT,
  reply_to   INTEGER REFERENCES tweets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  link_url   TEXT,
  link_title TEXT
);
CREATE INDEX tweets_user   ON tweets(user_id, id DESC);
CREATE INDEX tweets_reply  ON tweets(reply_to, id);
CREATE INDEX tweets_recent ON tweets(created_at);

CREATE TABLE follows (
  follower_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (follower_id, followee_id)
) WITHOUT ROWID;
CREATE INDEX follows_followee ON follows(followee_id);

CREATE TABLE likes (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tweet_id   INTEGER NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, tweet_id)
) WITHOUT ROWID;
CREATE INDEX likes_tweet ON likes(tweet_id);

CREATE TABLE password_setups (
  token_hash TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX password_setups_user ON password_setups(user_id);

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  tweet_id   INTEGER REFERENCES tweets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  read       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX notifications_user ON notifications(user_id, id DESC);
CREATE UNIQUE INDEX notifications_dedupe
  ON notifications(user_id, actor_id, type, coalesce(tweet_id, 0));

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT    NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  read_at      INTEGER
);
CREATE INDEX messages_sender    ON messages(sender_id, recipient_id, id);
CREATE INDEX messages_recipient ON messages(recipient_id, sender_id, id);

-- Users before the rows that reference them.
INSERT INTO users (id, username, display_name, bio, password_hash, password_salt,
                   created_at, email, source, source_id, pw_synced, activated, kind)
SELECT id, username, display_name, bio, password_hash, password_salt,
       created_at, email, source, source_id, pw_synced, activated, kind
FROM _s_users;

INSERT INTO tweets (id, user_id, body, media_key, reply_to, created_at, link_url, link_title)
SELECT id, user_id, body, media_key, reply_to, created_at, link_url, link_title FROM _s_tweets;

INSERT INTO follows (follower_id, followee_id, created_at)
SELECT follower_id, followee_id, created_at FROM _s_follows;

INSERT INTO likes (user_id, tweet_id, created_at)
SELECT user_id, tweet_id, created_at FROM _s_likes;

INSERT INTO notifications (id, user_id, actor_id, type, tweet_id, created_at, read)
SELECT id, user_id, actor_id, type, tweet_id, created_at, read FROM _s_notifications;

INSERT INTO messages (id, sender_id, recipient_id, body, created_at, read_at)
SELECT id, sender_id, recipient_id, body, created_at, read_at FROM _s_messages;

-- Undo the collateral damage from dropping tweets. Cleared first so this is
-- correct whether or not the cascade actually fired.
DELETE FROM tweet_tags;
INSERT INTO tweet_tags (tweet_id, tag, created_at)
SELECT tweet_id, tag, created_at FROM _s_tweet_tags;

DELETE FROM news_items;
INSERT INTO news_items (url, feed, tweet_id, created_at)
SELECT url, feed, tweet_id, created_at FROM _s_news_items;

DROP TABLE _s_news_items;
DROP TABLE _s_tweet_tags;
DROP TABLE _s_messages;
DROP TABLE _s_notifications;
DROP TABLE _s_likes;
DROP TABLE _s_follows;
DROP TABLE _s_tweets;
DROP TABLE _s_users;
DROP TABLE _id_map;
