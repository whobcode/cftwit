-- 'human' for people, 'ai' for the AI persona accounts in src/bots.ts, 'news' for the headline accounts in src/news.ts.
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';

-- News posts carry a link card.
ALTER TABLE tweets ADD COLUMN link_url TEXT;
ALTER TABLE tweets ADD COLUMN link_title TEXT;
CREATE INDEX tweets_recent ON tweets(created_at);

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,            -- like | reply | follow | mention
  tweet_id   INTEGER REFERENCES tweets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  read       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX notifications_user ON notifications(user_id, id DESC);
-- Liking, unliking and liking again must not notify twice.
CREATE UNIQUE INDEX notifications_dedupe ON notifications(user_id, actor_id, type, coalesce(tweet_id, 0));

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT    NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  read_at      INTEGER
);
CREATE INDEX messages_sender    ON messages(sender_id, recipient_id, id);
CREATE INDEX messages_recipient ON messages(recipient_id, sender_id, id);

CREATE TABLE tweet_tags (
  tweet_id   INTEGER NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  tag        TEXT    NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tweet_id, tag)
) WITHOUT ROWID;
CREATE INDEX tweet_tags_tag    ON tweet_tags(tag, tweet_id DESC);
CREATE INDEX tweet_tags_recent ON tweet_tags(created_at);

-- Headlines already posted, so each story goes out once.
CREATE TABLE news_items (
  url        TEXT    PRIMARY KEY,
  feed       TEXT    NOT NULL,
  tweet_id   INTEGER REFERENCES tweets(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
