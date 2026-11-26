/**
 * Writes into shade's database (social_rpg_db) so a person who signs up here
 * also exists in the game.
 *
 * Until now SHADE_DB has been read-only — src/sync.ts only ever copied members
 * out of it. This is the first write, and it exists because cftwit is taking
 * over the hwmnbn.me apex: once it is the front door, a signup that creates no
 * shade account would mean the game stops gaining players entirely.
 *
 * Deliberately NOT done here: rolling the character. Its stats, class and
 * gamertag come from shade's own buildInitialCharacter/rollInitialCharacter,
 * and reimplementing those would put the game's balance in two places that
 * drift apart. Shade creates the character itself the first time the person
 * opens the game. All this module has to get right is the users row.
 */

/** shade's users.email is NOT NULL UNIQUE, so a signup with no email needs one. */
const SYNTHETIC_EMAIL_DOMAIN = "cftwit.local";

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** shade's usernames are [A-Za-z0-9_], 3–20. Ours allow more, so narrow them. */
function shadeUsername(raw: string): string {
  let t = (raw || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 20);
  while (t.length < 3) t += "0";
  return t;
}

/** The id of the shade account on this email, if there already is one. */
export async function findShadeUserIdByEmail(env: Env, email: string): Promise<string | null> {
  if (!email) return null;
  try {
    const row = await env.SHADE_DB.prepare(
      `SELECT id FROM users WHERE lower(trim(email)) = ?1 LIMIT 1`,
    )
      .bind(email.trim().toLowerCase())
      .first<{ id: string }>();
    return row ? String(row.id) : null;
  } catch (err) {
    console.error("shade lookup failed", String(err));
    return null;
  }
}

/**
 * Creates a shade account and returns its users.id, or null if it could not be
 * written. Null is not fatal to a signup: a social account without a game
 * account is worth more than no account at all, and sync reconciles later.
 */
export async function createShadeUser(
  env: Env,
  input: { username: string; email: string | null; displayName: string },
): Promise<string | null> {
  const id = randomId();

  // No email means no row, because the column is NOT NULL UNIQUE. The address
  // is deliberately undeliverable and on a reserved-style domain: it exists to
  // satisfy the constraint, and shade's own password-reset and magic-link
  // flows will never reach it. Those people sign in here, not there.
  const email = input.email?.trim().toLowerCase() || `${shadeUsername(input.username)}.${id.slice(0, 8)}@${SYNTHETIC_EMAIL_DOMAIN}`;

  // shade's username is UNIQUE and case-sensitive while ours is NOCASE, so a
  // name free here can still collide there.
  let username = shadeUsername(input.username);
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await env.SHADE_DB.prepare(
        `INSERT INTO users (id, email, username, email_verified) VALUES (?1, ?2, ?3, 0)`,
      )
        .bind(id, email, username)
        .run();
      return id;
    } catch (err) {
      const message = String(err);
      if (!message.includes("UNIQUE")) {
        console.error("shade user insert failed", message);
        return null;
      }
      if (message.includes("users.email")) {
        // Someone already holds this email there; that is the same person.
        return await findShadeUserIdByEmail(env, email);
      }
      username = `${shadeUsername(input.username).slice(0, 16)}${Math.floor(Math.random() * 10000)}`;
    }
  }
  console.error("shade user insert: could not find a free username");
  return null;
}
