// Mirrors members of 8hues (hue_green_db) and shade (social_rpg_db) into cftwit.
//
// Runs on the cron. Each tick does a full diff rather than tracking a watermark,
// so a failed tick is simply caught up by the next one. The source databases are
// only ever read: every query against HUES_DB and SHADE_DB below is a SELECT.
//
// Imported accounts start dormant (activated = 0): they can log in, but have no
// public profile until they do. Both sources hash passwords with PBKDF2-SHA256 at
// 100k iterations, the same as cftwit, so only the encoding is converted and
// members sign in with the password they already use.

type Source = "8hues" | "shade";

type Member = {
  source: Source;
  sourceId: string;
  email: string;
  handle: string;
  hash: string | null; // hex; null when the member has no usable password
  salt: string | null;
  createdAt: number;
};

type LocalUser = {
  id: number;
  email: string | null;
  username: string;
  source: Source | null;
  source_id: string | null;
  pw_synced: number;
  password_hash: string;
  password_salt: string;
  activated: number;
};

const MAX_IMPORTS_PER_TICK = 500;

// ---------- hash encodings ----------

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function b64ToHex(s: string): string | null {
  try {
    return toHex(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** shade's native format: "salt.bytes:hash.bytes" as dot-separated decimals. */
function decimalsToHex(s: string): string | null {
  const parts = s.split(".").map(Number);
  if (!parts.length || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return toHex(Uint8Array.from(parts));
}

function validPair(hash: string | null, salt: string | null) {
  // PBKDF2 output is 32 bytes; salts are 16 in both sources.
  return hash && salt && hash.length === 64 && salt.length >= 16 ? { hash, salt } : { hash: null, salt: null };
}

function shadeCredentials(stored: string | null) {
  if (!stored) return { hash: null, salt: null };
  const [salt, hash] = stored.split(":");
  return validPair(hash ? decimalsToHex(hash) : null, salt ? decimalsToHex(salt) : null);
}

// ---------- names & dates ----------

/** cftwit usernames are 3–15 of [A-Za-z0-9_]; source handles are free text. */
function usernameBase(handle: string, email: string): string {
  const clean = (s: string) => s.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_]/g, "").replace(/_+/g, "_");
  let base = (clean(handle) || clean(email.split("@")[0]) || "member").slice(0, 12);
  while (base.length < 3) base += "0";
  return base;
}

function uniqueUsername(base: string, taken: Set<string>): string {
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? base : `${base}${n}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  const fallback = `m${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
  taken.add(fallback.toLowerCase());
  return fallback;
}

/** 8hues stores epoch seconds or ms; shade stores SQLite "YYYY-MM-DD HH:MM:SS" (UTC). */
function toEpochSeconds(value: unknown): number {
  const now = Math.floor(Date.now() / 1000);
  if (typeof value === "number" && value > 0) return Math.floor(value > 1e11 ? value / 1000 : value);
  if (typeof value === "string" && value) {
    const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return now;
}

// ---------- sources ----------

async function huesMembers(env: Env): Promise<Member[]> {
  const { results } = await env.HUES_DB.prepare(
    `SELECT id, lower(trim(email)) AS email, handle, pass_hash, pass_salt,
            coalesce(passkey_only, 0) AS passkey_only, created_at
     FROM users
     WHERE coalesce(banned, 0) = 0`,
  ).all<{
    id: string;
    email: string;
    handle: string;
    pass_hash: string;
    pass_salt: string;
    passkey_only: number;
    created_at: number | null;
  }>();
  return results.map((m) => ({
    source: "8hues",
    sourceId: String(m.id),
    email: m.email,
    handle: m.handle ?? "",
    // Passkey-only members have password login switched off on 8hues; keep it off here too.
    ...(m.passkey_only ? { hash: null, salt: null } : validPair(b64ToHex(m.pass_hash), b64ToHex(m.pass_salt))),
    createdAt: toEpochSeconds(m.created_at),
  }));
}

async function shadeMembers(env: Env): Promise<Member[]> {
  // Skip bots, and skip accounts shade itself copied from 8hues ("8hues:" hashes):
  // those come from 8hues directly, and a stale copy must not revive a deleted 8hues account.
  const { results } = await env.SHADE_DB.prepare(
    `SELECT id, lower(trim(email)) AS email, username, password_hash, created_at
     FROM users
     WHERE coalesce(is_bot, 0) = 0
       AND email NOT LIKE '%@bots.shade'
       AND (password_hash IS NULL OR password_hash NOT LIKE '8hues:%')`,
  ).all<{ id: string; email: string; username: string; password_hash: string | null; created_at: string | null }>();
  return results.map((m) => ({
    source: "shade",
    sourceId: String(m.id),
    email: m.email,
    handle: m.username ?? "",
    ...shadeCredentials(m.password_hash),
    createdAt: toEpochSeconds(m.created_at),
  }));
}

// ---------- sync ----------

/** Source databases are busy with their own crons; a read can hit "D1 DB ... was reset". Retry briefly. */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.warn(`member sync: ${label} read failed (attempt ${attempt}), retrying`, String(err));
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
}

export async function syncMembers(env: Env) {
  // Each source is read independently: one failing must not stop the other from syncing.
  const [huesResult, shadeResult, local] = await Promise.all([
    withRetry("8hues", () => huesMembers(env)).then(
      (members) => members,
      (err) => (console.error("member sync: 8hues read failed", String(err)), null),
    ),
    withRetry("shade", () => shadeMembers(env)).then(
      (members) => members,
      (err) => (console.error("member sync: shade read failed", String(err)), null),
    ),
    env.DB.prepare(
      `SELECT id, email, username, source, source_id, pw_synced, password_hash, password_salt, activated FROM users`,
    ).all<LocalUser>(),
  ]);
  if (!huesResult && !shadeResult) throw new Error("member sync: both sources failed");
  const hues = huesResult ?? [];
  const shade = shadeResult ?? [];
  const loadedSources = new Set<Source>([...(huesResult?.length ? ["8hues" as const] : []), ...(shadeResult?.length ? ["shade" as const] : [])]);

  const takenEmails = new Set(local.results.map((u) => u.email).filter(Boolean) as string[]);
  const takenUsernames = new Set(local.results.map((u) => u.username.toLowerCase()));
  const linked = new Map(local.results.filter((u) => u.source).map((u) => [`${u.source}:${u.source_id}`, u]));

  // 8hues first, so a person in both is imported once, as their 8hues account.
  const sources = [...hues, ...shade].filter((m) => m.email && m.email.includes("@"));
  const present = new Set(sources.map((m) => `${m.source}:${m.sourceId}`));

  const inserts: unknown[] = [];
  const passwordUpdates: { id: number; hash: string; salt: string }[] = [];

  for (const m of sources) {
    const existing = linked.get(`${m.source}:${m.sourceId}`);
    if (existing) {
      if (existing.pw_synced && m.hash && m.salt && (existing.password_hash !== m.hash || existing.password_salt !== m.salt)) {
        passwordUpdates.push({ id: existing.id, hash: m.hash, salt: m.salt });
      }
      continue;
    }
    // Someone already holds this email here (a native signup, or the other source).
    if (takenEmails.has(m.email) || inserts.length >= MAX_IMPORTS_PER_TICK) continue;
    takenEmails.add(m.email);

    const usable = Boolean(m.hash && m.salt);
    inserts.push({
      username: uniqueUsername(usernameBase(m.handle, m.email), takenUsernames),
      display_name: [...(m.handle.trim() || m.email.split("@")[0])].slice(0, 50).join(""),
      email: m.email,
      // Members without a usable password get credentials nobody knows; an invite link fixes that.
      hash: usable ? m.hash : toHex(crypto.getRandomValues(new Uint8Array(32))),
      salt: usable ? m.salt : toHex(crypto.getRandomValues(new Uint8Array(16))),
      pw_synced: usable ? 1 : 0,
      created_at: m.createdAt,
      source: m.source,
      source_id: m.sourceId,
    });
  }

  // Members who left or were banned at the source: remove their copy here if it was never used.
  // Guarded per source so a failed or empty source read can never wipe its imports.
  const removals = local.results
    .filter((u) => u.source && !u.activated && !present.has(`${u.source}:${u.source_id}`))
    .filter((u) => loadedSources.has(u.source!))
    .map((u) => u.id);

  const statements: D1PreparedStatement[] = [];
  if (inserts.length) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO users
           (username, display_name, email, password_hash, password_salt, pw_synced, created_at, source, source_id, activated)
         SELECT j.value ->> 'username', j.value ->> 'display_name', j.value ->> 'email', j.value ->> 'hash',
                j.value ->> 'salt', j.value ->> 'pw_synced', j.value ->> 'created_at', j.value ->> 'source',
                j.value ->> 'source_id', 0
         FROM json_each(?1) AS j`,
      ).bind(JSON.stringify(inserts)),
    );
  }
  if (passwordUpdates.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE users SET password_hash = j.value ->> 'hash', password_salt = j.value ->> 'salt'
         FROM json_each(?1) AS j
         WHERE users.id = j.value ->> 'id' AND users.pw_synced = 1`,
      ).bind(JSON.stringify(passwordUpdates)),
    );
  }
  if (removals.length) {
    statements.push(
      env.DB.prepare(`DELETE FROM users WHERE activated = 0 AND id IN (SELECT value FROM json_each(?1))`).bind(
        JSON.stringify(removals),
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);

  return {
    imported: inserts.length,
    passwordsUpdated: passwordUpdates.length,
    removed: removals.length,
    failedSources: [!huesResult && "8hues", !shadeResult && "shade"].filter(Boolean),
  };
}
