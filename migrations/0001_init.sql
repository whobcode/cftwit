CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  bio           TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE tweets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  media_key  TEXT,
  reply_to   INTEGER REFERENCES tweets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX tweets_user  ON tweets(user_id, id DESC);
CREATE INDEX tweets_reply ON tweets(reply_to, id);

CREATE TABLE follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (follower_id, followee_id)
) WITHOUT ROWID;
CREATE INDEX follows_followee ON follows(followee_id);

CREATE TABLE likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tweet_id   INTEGER NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, tweet_id)
) WITHOUT ROWID;
CREATE INDEX likes_tweet ON likes(tweet_id);
