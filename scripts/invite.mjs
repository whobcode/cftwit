#!/usr/bin/env node
// Create a user (if needed) and print a one-time link for them to choose their password.
// Also works as an admin-issued password reset for an existing user.
//
//   node scripts/invite.mjs <username> [email] [--remote]
//
// Without --remote it targets the local dev database.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const LINK_TTL_SECONDS = 48 * 60 * 60;
const DB = "cftwit";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const [username, rawEmail] = args.filter((a) => !a.startsWith("--"));
const email = rawEmail?.toLowerCase();

if (!username || !/^[A-Za-z0-9_]{3,15}$/.test(username)) {
  console.error("Usage: node scripts/invite.mjs <username> [email] [--remote]");
  console.error("Username must be 3–15 letters, numbers or underscores.");
  process.exit(1);
}
// Values below are interpolated into SQL, so only allow characters that can't break out of a quoted string.
if (email && !/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
  console.error(`Not a supported email address: ${rawEmail}`);
  process.exit(1);
}

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, remote ? "--remote" : "--local", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, CI: "1" } },
  );
  return JSON.parse(out).flatMap((r) => r.results ?? []);
}

const existing = d1(`SELECT id, username, email FROM users WHERE username = '${username}' COLLATE NOCASE`)[0];
if (existing) {
  if (email && existing.email !== email) {
    console.error(`User @${existing.username} already exists with a different email. Not changing it.`);
    process.exit(1);
  }
  console.log(`User @${existing.username} exists; issuing a new password link.`);
} else {
  if (email && d1(`SELECT 1 FROM users WHERE email = '${email}'`).length) {
    console.error(`${email} is already registered to another username.`);
    process.exit(1);
  }
  // Placeholder credentials nobody knows; the user replaces them via the link.
  const hash = randomBytes(32).toString("hex");
  const salt = randomBytes(16).toString("hex");
  d1(
    `INSERT INTO users (username, display_name, email, password_hash, password_salt)
     VALUES ('${username}', '${username}', ${email ? `'${email}'` : "NULL"}, '${hash}', '${salt}')`,
  );
  console.log(`Created @${username}${email ? ` <${email}>` : ""}.`);
}

const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
d1(
  `INSERT INTO password_setups (token_hash, user_id, expires_at)
   SELECT '${tokenHash}', id, unixepoch() + ${LINK_TTL_SECONDS} FROM users WHERE username = '${username}' COLLATE NOCASE`,
);

const origin = remote ? "https://cftwit.hwmnbn.me" : "http://localhost:8787";
console.log(`\nOne-time password link (expires in 48 hours):\n${origin}/setup#${token}`);
