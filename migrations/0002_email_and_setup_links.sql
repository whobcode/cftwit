-- Optional, private email address; usable for login. Stored lowercased.
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX users_email ON users(email);

-- One-time links that let a user choose (or reset) their password.
CREATE TABLE password_setups (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX password_setups_user ON password_setups(user_id);
