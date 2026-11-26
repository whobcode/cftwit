import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { hashPassword, newToken, sha256Hex, verifyPassword } from "./auth";
import { ensureAccounts, replyToDirectMessage, runBots } from "./bots";
import { sendSignInLink } from "./mail";
import { MEDIA_KEY_RE, sniffImage } from "./media";
import { postNews } from "./news";
import { canMessage, createTweet, MAX_TWEET_CHARS, setFollow, setLike, tweetLength } from "./social";
import { syncMembers } from "./sync";

type User = { id: number; username: string; display_name: string; bio: string };
type AppEnv = { Bindings: Env; Variables: { user: User | null } };
type Ctx = Context<AppEnv>;

type TweetRow = {
  id: number;
  user_id: number;
  body: string;
  media_key: string | null;
  reply_to: number | null;
  link_url: string | null;
  link_title: string | null;
  created_at: number;
  username: string;
  display_name: string;
  kind: string;
  like_count: number;
  reply_count: number;
  liked: number;
};

const SESSION_COOKIE = "session";
const SESSION_TTL = 60 * 60 * 24 * 30;
const PAGE_SIZE = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DM_CHARS = 1000;
const EMAIL_LINK_TTL = 60 * 60;
const USERNAME_RE = /^[A-Za-z0-9_]{3,15}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

// ?1 is always the viewer's user id (0 when logged out).
const TWEET_COLUMNS = `
  t.id, t.user_id, t.body, t.media_key, t.reply_to, t.link_url, t.link_title, t.created_at,
  u.username, u.display_name, u.kind,
  (SELECT COUNT(*) FROM likes l WHERE l.tweet_id = t.id) AS like_count,
  (SELECT COUNT(*) FROM tweets r WHERE r.reply_to = t.id) AS reply_count,
  EXISTS (SELECT 1 FROM likes l WHERE l.tweet_id = t.id AND l.user_id = ?1) AS liked`;
const TWEET_SELECT = `SELECT ${TWEET_COLUMNS} FROM tweets t JOIN users u ON u.id = t.user_id`;

// ---------- helpers ----------

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429;

function fail(status: ErrorStatus, message: string): never {
  throw new HTTPException(status, { message });
}

function requireUser(c: Ctx): User {
  return c.get("user") ?? fail(401, "Log in first");
}

const viewerId = (c: Ctx) => c.get("user")?.id ?? 0;

function parseId(raw: string | undefined): number {
  if (!raw || !/^\d{1,15}$/.test(raw)) fail(404, "Not found");
  return Number(raw);
}

function parseCursor(raw: string | undefined): number | null {
  return raw && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const charCount = (s: string) => [...s].length;

function validatePassword(password: string) {
  if (password.length < 8 || password.length > 128) fail(400, "Password must be 8–128 characters");
}

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Invalid JSON body");
  return body as Record<string, unknown>;
}

async function rateLimit(c: Ctx, limiter: RateLimit, scope: string) {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const { success } = await limiter.limit({ key: `${scope}:${ip}` });
  if (!success) fail(429, "Too many requests, slow down");
}

const publicUser = (u: User) => ({ username: u.username, displayName: u.display_name, bio: u.bio });

function toTweet(r: TweetRow) {
  return {
    id: r.id,
    body: r.body,
    mediaUrl: r.media_key ? `/media/${r.media_key}` : null,
    link: r.link_url ? { url: r.link_url, title: r.link_title ?? r.link_url } : null,
    replyTo: r.reply_to,
    createdAt: r.created_at,
    author: { username: r.username, displayName: r.display_name, kind: r.kind },
    likeCount: r.like_count,
    replyCount: r.reply_count,
    liked: Boolean(r.liked),
  };
}

/** One page of tweets, newest first. `where` may reference ?2.. for `params`. */
async function listTweets(c: Ctx, where: string, params: unknown[] = []) {
  const binds: unknown[] = [viewerId(c), ...params];
  let sql = `${TWEET_SELECT} WHERE ${where}`;
  const before = parseCursor(c.req.query("cursor"));
  if (before !== null) {
    binds.push(before);
    sql += ` AND t.id < ?${binds.length}`;
  }
  sql += ` ORDER BY t.id DESC LIMIT ${PAGE_SIZE + 1}`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<TweetRow>();
  const page = results.slice(0, PAGE_SIZE);
  return {
    tweets: page.map(toTweet),
    nextCursor: results.length > PAGE_SIZE ? page[page.length - 1].id : null,
  };
}

async function getTweet(c: Ctx, id: number) {
  const row = await c.env.DB.prepare(`${TWEET_SELECT} WHERE t.id = ?2`).bind(viewerId(c), id).first<TweetRow>();
  return row ? toTweet(row) : null;
}

type Account = { id: number; username: string; display_name: string; kind: string };

async function findUser(c: Ctx, username: string | undefined): Promise<Account> {
  const row = await c.env.DB.prepare(
    `SELECT id, username, display_name, kind FROM users WHERE username = ?1 AND activated = 1`,
  )
    .bind(username ?? "")
    .first<Account>();
  return row ?? fail(404, "User not found");
}

async function startSession(c: Ctx, userId: number) {
  const token = newToken();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, unixepoch() + ?3)`).bind(
      await sha256Hex(token),
      userId,
      SESSION_TTL,
    ),
    // An imported account becomes public the first time its owner signs in.
    c.env.DB.prepare(`UPDATE users SET activated = 1 WHERE id = ?1 AND activated = 0`).bind(userId),
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
  c.executionCtx.waitUntil(c.env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= unixepoch()`).run());
}

// ---------- app ----------

const app = new Hono<AppEnv>();

app.use(secureHeaders());
app.use(csrf());

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message || "Request not allowed" }, err.status);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));

app.use("/api/*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  let user: User | null = null;
  if (token) {
    user = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.bio
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?1 AND s.expires_at > unixepoch() AND u.kind = 'human'`,
    )
      .bind(await sha256Hex(token))
      .first<User>();
  }
  c.set("user", user);
  await next();
});

// ---------- auth ----------

app.post("/api/signup", async (c) => {
  await rateLimit(c, c.env.AUTH_LIMITER, "auth");
  const body = await readJson(c);
  const username = str(body.username).trim();
  const password = str(body.password);
  const displayName = str(body.displayName).trim() || username;
  const email = str(body.email).trim().toLowerCase() || null;
  if (!USERNAME_RE.test(username)) fail(400, "Username must be 3–15 letters, numbers or underscores");
  validatePassword(password);
  if (charCount(displayName) > 50) fail(400, "Display name must be 50 characters or fewer");
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) fail(400, "That email address doesn't look right");

  const { hash, salt } = await hashPassword(password);
  let user: User | null;
  try {
    user = await c.env.DB.prepare(
      `INSERT INTO users (username, display_name, email, password_hash, password_salt)
       VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id, username, display_name, bio`,
    )
      .bind(username, displayName, email, hash, salt)
      .first<User>();
  } catch (err) {
    const msg = String(err);
    if (msg.includes("users.email")) fail(409, "That email is already registered");
    if (msg.includes("UNIQUE")) fail(409, "That username is taken");
    throw err;
  }
  await startSession(c, user!.id);
  return c.json({ user: publicUser(user!) }, 201);
});

app.post("/api/login", async (c) => {
  await rateLimit(c, c.env.AUTH_LIMITER, "auth");
  const body = await readJson(c);
  // The login field accepts either a username or an email address.
  const login = str(body.username).trim();
  const byEmail = login.includes("@");
  const password = str(body.password).slice(0, 128);
  const row = await c.env.DB.prepare(
    `SELECT id, username, display_name, bio, password_hash, password_salt FROM users
     WHERE ${byEmail ? "email" : "username"} = ?1 AND kind = 'human'`,
  )
    .bind(byEmail ? login.toLowerCase() : login)
    .first<User & { password_hash: string; password_salt: string }>();
  // Hash even when the user doesn't exist so response time doesn't reveal which usernames are registered.
  const ok = await verifyPassword(password, row?.password_hash ?? "0".repeat(64), row?.password_salt ?? "0".repeat(32));
  if (!row || !ok) fail(401, "Wrong username, email or password");
  await startSession(c, row.id);
  return c.json({ user: publicUser(row) });
});

// Emails a one-time link to /setup, where the person signs in by choosing a password.
// Covers forgotten passwords and members imported without one (Google or phone sign-ups).
app.post("/api/email-link", async (c) => {
  await rateLimit(c, c.env.AUTH_LIMITER, "auth");
  const body = await readJson(c);
  const email = str(body.email).trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) fail(400, "Enter the email address on your account");
  await rateLimit(c, c.env.AUTH_LIMITER, `email:${email}`);

  const user = await c.env.DB.prepare(
    `SELECT id,
            EXISTS (SELECT 1 FROM password_setups p WHERE p.user_id = users.id AND p.expires_at > unixepoch() + ?2 - 120) AS recent
     FROM users WHERE email = ?1 AND kind = 'human'`,
  )
    .bind(email, EMAIL_LINK_TTL)
    .first<{ id: number; recent: number }>();
  // At most one email every two minutes per account, so this can't be used to flood an inbox.
  if (user && !user.recent) {
    const token = newToken();
    await c.env.DB.prepare(`INSERT INTO password_setups (token_hash, user_id, expires_at) VALUES (?1, ?2, unixepoch() + ?3)`)
      .bind(await sha256Hex(token), user.id, EMAIL_LINK_TTL)
      .run();
    c.executionCtx.waitUntil(sendSignInLink(c.env, email, `${new URL(c.req.url).origin}/setup#${token}`));
  }
  // Same answer either way, so this doesn't reveal which emails have accounts.
  return c.json({ ok: true });
});

// Consumes a one-time link (emailed, or from scripts/invite.mjs) and sets the user's password.
app.post("/api/setup-password", async (c) => {
  await rateLimit(c, c.env.AUTH_LIMITER, "auth");
  const body = await readJson(c);
  const token = str(body.token);
  const password = str(body.password);
  validatePassword(password);
  const invalid = "This link is invalid or has expired";
  if (!/^[0-9a-f]{64}$/.test(token)) fail(400, invalid);

  // Deleting with RETURNING claims the token atomically, so a link can only be used once.
  const claimed = await c.env.DB.prepare(
    `DELETE FROM password_setups WHERE token_hash = ?1 AND expires_at > unixepoch() RETURNING user_id`,
  )
    .bind(await sha256Hex(token))
    .first<{ user_id: number }>();
  if (!claimed) fail(400, invalid);

  const { hash, salt } = await hashPassword(password);
  const [, , , userResult] = await c.env.DB.batch<User>([
    // A password chosen here stops following the 8hues/shade password.
    c.env.DB.prepare(`UPDATE users SET password_hash = ?1, password_salt = ?2, pw_synced = 0 WHERE id = ?3`).bind(
      hash,
      salt,
      claimed.user_id,
    ),
    c.env.DB.prepare(`DELETE FROM password_setups WHERE user_id = ?1`).bind(claimed.user_id),
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(claimed.user_id),
    c.env.DB.prepare(`SELECT id, username, display_name, bio FROM users WHERE id = ?1`).bind(claimed.user_id),
  ]);
  const user = userResult.results[0] ?? fail(400, invalid);
  await startSession(c, user.id);
  return c.json({ user: publicUser(user) });
});

app.post("/api/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(await sha256Hex(token)).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", (c) => {
  const user = c.get("user");
  return c.json({ user: user ? publicUser(user) : null });
});

app.patch("/api/me", async (c) => {
  const user = requireUser(c);
  const body = await readJson(c);
  const displayName = str(body.displayName).trim();
  const bio = str(body.bio).trim();
  if (!displayName || charCount(displayName) > 50) fail(400, "Display name must be 1–50 characters");
  if (charCount(bio) > 160) fail(400, "Bio must be 160 characters or fewer");
  await c.env.DB.prepare(`UPDATE users SET display_name = ?1, bio = ?2 WHERE id = ?3`)
    .bind(displayName, bio, user.id)
    .run();
  return c.json({ user: { username: user.username, displayName, bio } });
});

// ---------- timelines ----------

app.get("/api/timeline", async (c) => {
  const user = requireUser(c);
  return c.json(
    await listTweets(
      c,
      `t.reply_to IS NULL AND (t.user_id = ?2 OR t.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?2))`,
      [user.id],
    ),
  );
});

app.get("/api/explore", async (c) => c.json(await listTweets(c, `t.reply_to IS NULL`)));
app.get("/api/news", async (c) => c.json(await listTweets(c, `t.reply_to IS NULL AND u.kind = 'news'`)));

app.get("/api/tags/:tag", async (c) => {
  const tag = c.req.param("tag");
  if (!/^[A-Za-z][A-Za-z0-9_]{1,49}$/.test(tag)) fail(404, "Not found");
  return c.json(await listTweets(c, `t.id IN (SELECT tweet_id FROM tweet_tags WHERE tag = ?2)`, [tag]));
});

/**
 * "For you": recent posts ranked by engagement and by the viewer's follow graph,
 * decayed by age, with repeat authors pushed down so one account can't fill the page.
 */
app.get("/api/foryou", async (c) => {
  const viewer = viewerId(c);
  const offset = Math.min(parseCursor(c.req.query("cursor")) ?? 0, 200);
  const { results } = await c.env.DB.prepare(
    `SELECT ${TWEET_COLUMNS},
            EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.followee_id = t.user_id) AS followed,
            (SELECT COUNT(*) FROM likes l JOIN follows f ON f.followee_id = l.user_id AND f.follower_id = ?1
              WHERE l.tweet_id = t.id) AS social_likes
     FROM tweets t JOIN users u ON u.id = t.user_id
     WHERE t.reply_to IS NULL
     ORDER BY t.id DESC LIMIT 400`,
  )
    .bind(viewer)
    .all<TweetRow & { followed: number; social_likes: number }>();

  const now = Date.now() / 1000;
  const kindWeight: Record<string, number> = { human: 1.4, ai: 1, news: 0.9 };
  const scored = results.map((r) => {
    const ageHours = Math.max(0, now - r.created_at) / 3600;
    const engagement = 1 + r.like_count + 2 * r.reply_count + 4 * r.followed + 2 * r.social_likes;
    const own = r.user_id === viewer ? 0.5 : 1;
    return { row: r, score: (engagement * (kindWeight[r.kind] ?? 1) * own) / Math.pow(ageHours + 2, 1.4) };
  });

  // Greedy pick with a per-author penalty for diversity.
  const ranked: TweetRow[] = [];
  const perAuthor = new Map<number, number>();
  const pool = [...scored];
  while (pool.length && ranked.length < offset + PAGE_SIZE) {
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i].score * Math.pow(0.3, perAuthor.get(pool[i].row.user_id) ?? 0);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    const [chosen] = pool.splice(best, 1);
    perAuthor.set(chosen.row.user_id, (perAuthor.get(chosen.row.user_id) ?? 0) + 1);
    ranked.push(chosen.row);
  }
  const page = ranked.slice(offset, offset + PAGE_SIZE);
  const hasMore = pool.length > 0 && offset + PAGE_SIZE < 200;
  return c.json({ tweets: page.map(toTweet), nextCursor: hasMore ? offset + PAGE_SIZE : null });
});

app.get("/api/trending", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT max(tag) AS tag, COUNT(*) AS posts FROM tweet_tags
     WHERE created_at > unixepoch() - 86400 GROUP BY tag ORDER BY posts DESC, max(created_at) DESC LIMIT 10`,
  ).all<{ tag: string; posts: number }>();
  return c.json({ trending: results });
});

app.get("/api/suggestions", async (c) => {
  const viewer = viewerId(c);
  const { results } = await c.env.DB.prepare(
    `SELECT u.username, u.display_name, u.bio, u.kind,
            (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) AS followers
     FROM users u
     WHERE u.activated = 1 AND u.id != ?1
       AND NOT EXISTS (SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = u.id)
       AND EXISTS (SELECT 1 FROM tweets WHERE user_id = u.id)
     ORDER BY random() LIMIT 6`,
  )
    .bind(viewer)
    .all<{ username: string; display_name: string; bio: string; kind: string; followers: number }>();
  return c.json({
    users: results.map((u) => ({ username: u.username, displayName: u.display_name, bio: u.bio, kind: u.kind })),
  });
});

// ---------- tweets ----------

app.post(
  "/api/tweets",
  bodyLimit({ maxSize: MAX_IMAGE_BYTES + 64 * 1024, onError: (c) => c.json({ error: "Upload is too large" }, 413) }),
  async (c) => {
    const user = requireUser(c);
    await rateLimit(c, c.env.WRITE_LIMITER, `write:${user.id}`);
    const form = await c.req.parseBody();
    const body = str(form.body).trim();
    const image = form.image instanceof File && form.image.size > 0 ? form.image : null;
    const replyTo = str(form.replyTo) ? parseId(str(form.replyTo)) : null;

    if (!body && !image) fail(400, "Write something or attach an image");
    if (tweetLength(body) > MAX_TWEET_CHARS) fail(400, `Posts are limited to ${MAX_TWEET_CHARS} characters`);
    if (replyTo !== null) {
      const parent = await c.env.DB.prepare(`SELECT 1 FROM tweets WHERE id = ?1`).bind(replyTo).first();
      if (!parent) fail(404, "The post you're replying to no longer exists");
    }

    let mediaKey: string | null = null;
    if (image) {
      if (image.size > MAX_IMAGE_BYTES) fail(413, "Images are limited to 5 MB");
      const bytes = new Uint8Array(await image.arrayBuffer());
      const kind = sniffImage(bytes);
      if (!kind) fail(400, "Only JPEG, PNG, GIF and WebP images are supported");
      mediaKey = `${crypto.randomUUID()}.${kind.ext}`;
      await c.env.MEDIA.put(mediaKey, bytes, { httpMetadata: { contentType: kind.type } });
    }

    try {
      const id = await createTweet(c.env.DB, { userId: user.id, body, mediaKey, replyTo });
      return c.json({ tweet: await getTweet(c, id) }, 201);
    } catch (err) {
      if (mediaKey) c.executionCtx.waitUntil(c.env.MEDIA.delete(mediaKey));
      throw err;
    }
  },
);

app.get("/api/tweets/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  const tweet = (await getTweet(c, id)) ?? fail(404, "Post not found");
  const { results } = await c.env.DB.prepare(`${TWEET_SELECT} WHERE t.reply_to = ?2 ORDER BY t.id ASC LIMIT 100`)
    .bind(viewerId(c), id)
    .all<TweetRow>();
  return c.json({ tweet, replies: results.map(toTweet) });
});

app.delete("/api/tweets/:id", async (c) => {
  const user = requireUser(c);
  const id = parseId(c.req.param("id"));
  const tweet = await c.env.DB.prepare(`SELECT user_id FROM tweets WHERE id = ?1`).bind(id).first<{ user_id: number }>();
  if (!tweet) fail(404, "Post not found");
  if (tweet.user_id !== user.id) fail(403, "You can only delete your own posts");

  // Replies are removed by ON DELETE CASCADE, so collect the whole thread's media first.
  const media = await c.env.DB.prepare(
    `WITH RECURSIVE thread(id) AS (
       SELECT ?1 UNION ALL SELECT t.id FROM tweets t JOIN thread ON t.reply_to = thread.id
     )
     SELECT media_key FROM tweets WHERE id IN (SELECT id FROM thread) AND media_key IS NOT NULL`,
  )
    .bind(id)
    .all<{ media_key: string }>();
  await c.env.DB.prepare(`DELETE FROM tweets WHERE id = ?1`).bind(id).run();
  if (media.results.length) {
    c.executionCtx.waitUntil(c.env.MEDIA.delete(media.results.map((r) => r.media_key)));
  }
  return c.json({ ok: true });
});

async function likeRoute(c: Ctx, liked: boolean) {
  const user = requireUser(c);
  const id = parseId(c.req.param("id"));
  await rateLimit(c, c.env.WRITE_LIMITER, `write:${user.id}`);
  await setLike(c.env.DB, user.id, id, liked);
  const tweet = (await getTweet(c, id)) ?? fail(404, "Post not found");
  return c.json({ liked: tweet.liked, likeCount: tweet.likeCount });
}
app.put("/api/tweets/:id/like", (c) => likeRoute(c, true));
app.delete("/api/tweets/:id/like", (c) => likeRoute(c, false));

// ---------- users ----------

app.get("/api/users/:username", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.bio, u.kind, u.created_at,
            (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) AS followers,
            (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following,
            (SELECT COUNT(*) FROM tweets  WHERE user_id = u.id)     AS posts,
            EXISTS (SELECT 1 FROM follows WHERE follower_id = ?2 AND followee_id = u.id) AS is_following
     FROM users u WHERE u.username = ?1 AND u.activated = 1`,
  )
    .bind(c.req.param("username"), viewerId(c))
    .first<{
      id: number;
      username: string;
      display_name: string;
      bio: string;
      kind: string;
      created_at: number;
      followers: number;
      following: number;
      posts: number;
      is_following: number;
    }>();
  if (!row) fail(404, "User not found");
  const user = c.get("user");
  return c.json({
    profile: {
      username: row.username,
      displayName: row.display_name,
      bio: row.bio,
      kind: row.kind,
      createdAt: row.created_at,
      followers: row.followers,
      following: row.following,
      posts: row.posts,
      isFollowing: Boolean(row.is_following),
      canMessage: user ? await canMessage(c.env.DB, user.id, row) : false,
    },
  });
});

app.get("/api/users/:username/tweets", async (c) => {
  const { id } = await findUser(c, c.req.param("username"));
  return c.json(await listTweets(c, `t.user_id = ?2`, [id]));
});

async function followRoute(c: Ctx, following: boolean) {
  const user = requireUser(c);
  await rateLimit(c, c.env.WRITE_LIMITER, `write:${user.id}`);
  const target = await findUser(c, c.req.param("username"));
  if (target.id === user.id) fail(400, "You can't follow yourself");
  await setFollow(c.env.DB, user.id, target.id, following);
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?1`)
    .bind(target.id)
    .first<{ n: number }>();
  return c.json({ isFollowing: following, followers: count?.n ?? 0 });
}
app.put("/api/users/:username/follow", (c) => followRoute(c, true));
app.delete("/api/users/:username/follow", (c) => followRoute(c, false));

// ---------- notifications ----------

app.get("/api/badges", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ notifications: 0, messages: 0 });
  const row = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM notifications WHERE user_id = ?1 AND read = 0) AS notifications,
            (SELECT COUNT(*) FROM messages WHERE recipient_id = ?1 AND read_at IS NULL) AS messages`,
  )
    .bind(user.id)
    .first<{ notifications: number; messages: number }>();
  return c.json(row ?? { notifications: 0, messages: 0 });
});

app.get("/api/notifications", async (c) => {
  const user = requireUser(c);
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.type, n.created_at, n.read, n.tweet_id, a.username, a.display_name, a.kind,
            substr(t.body, 1, 160) AS snippet
     FROM notifications n JOIN users a ON a.id = n.actor_id LEFT JOIN tweets t ON t.id = n.tweet_id
     WHERE n.user_id = ?1 ORDER BY n.id DESC LIMIT 60`,
  )
    .bind(user.id)
    .all<{
      id: number;
      type: string;
      created_at: number;
      read: number;
      tweet_id: number | null;
      username: string;
      display_name: string;
      kind: string;
      snippet: string | null;
    }>();
  return c.json({
    notifications: results.map((n) => ({
      id: n.id,
      type: n.type,
      createdAt: n.created_at,
      read: Boolean(n.read),
      tweetId: n.tweet_id,
      snippet: n.snippet,
      actor: { username: n.username, displayName: n.display_name, kind: n.kind },
    })),
  });
});

app.post("/api/notifications/read", async (c) => {
  const user = requireUser(c);
  await c.env.DB.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ?1 AND read = 0`).bind(user.id).run();
  return c.json({ ok: true });
});

// ---------- direct messages ----------

app.get("/api/messages", async (c) => {
  const user = requireUser(c);
  const { results } = await c.env.DB.prepare(
    `WITH mine AS (
       SELECT id, body, created_at, sender_id,
              CASE WHEN sender_id = ?1 THEN recipient_id ELSE sender_id END AS other
       FROM messages WHERE sender_id = ?1 OR recipient_id = ?1
     ),
     latest AS (SELECT other, max(id) AS id FROM mine GROUP BY other)
     SELECT m.body, m.created_at, m.sender_id = ?1 AS from_me, u.username, u.display_name, u.kind,
            (SELECT COUNT(*) FROM messages x WHERE x.sender_id = m.other AND x.recipient_id = ?1 AND x.read_at IS NULL) AS unread
     FROM latest l JOIN mine m ON m.id = l.id JOIN users u ON u.id = m.other
     ORDER BY m.id DESC LIMIT 50`,
  )
    .bind(user.id)
    .all<{
      body: string;
      created_at: number;
      from_me: number;
      username: string;
      display_name: string;
      kind: string;
      unread: number;
    }>();
  return c.json({
    conversations: results.map((r) => ({
      with: { username: r.username, displayName: r.display_name, kind: r.kind },
      last: { body: r.body, createdAt: r.created_at, fromMe: Boolean(r.from_me) },
      unread: r.unread,
    })),
  });
});

app.get("/api/messages/:username", async (c) => {
  const user = requireUser(c);
  const other = await findUser(c, c.req.param("username"));
  const after = parseCursor(c.req.query("after")) ?? 0;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT id, sender_id, body, created_at FROM messages
       WHERE ((sender_id = ?1 AND recipient_id = ?2) OR (sender_id = ?2 AND recipient_id = ?1)) AND id > ?3
       ORDER BY id DESC LIMIT 100
     ) ORDER BY id ASC`,
  )
    .bind(user.id, other.id, after)
    .all<{ id: number; sender_id: number; body: string; created_at: number }>();
  if (results.some((m) => m.sender_id === other.id)) {
    await c.env.DB.prepare(
      `UPDATE messages SET read_at = unixepoch() WHERE sender_id = ?1 AND recipient_id = ?2 AND read_at IS NULL`,
    )
      .bind(other.id, user.id)
      .run();
  }
  return c.json({
    with: { username: other.username, displayName: other.display_name, kind: other.kind },
    canMessage: await canMessage(c.env.DB, user.id, other),
    messages: results.map((m) => ({ id: m.id, body: m.body, createdAt: m.created_at, fromMe: m.sender_id === user.id })),
  });
});

app.post("/api/messages/:username", async (c) => {
  const user = requireUser(c);
  await rateLimit(c, c.env.WRITE_LIMITER, `write:${user.id}`);
  const other = await findUser(c, c.req.param("username"));
  const body = str((await readJson(c)).body).trim();
  if (!body) fail(400, "Write a message first");
  if (charCount(body) > MAX_DM_CHARS) fail(400, `Messages are limited to ${MAX_DM_CHARS} characters`);
  if (!(await canMessage(c.env.DB, user.id, other))) {
    fail(403, `You can message @${other.username} once they follow you`);
  }
  const row = await c.env.DB.prepare(
    `INSERT INTO messages (sender_id, recipient_id, body) VALUES (?1, ?2, ?3) RETURNING id, created_at`,
  )
    .bind(user.id, other.id, body)
    .first<{ id: number; created_at: number }>();
  if (other.kind === "ai") c.executionCtx.waitUntil(replyToDirectMessage(c.env, other.id, user.id));
  return c.json({ message: { id: row!.id, body, createdAt: row!.created_at, fromMe: true } }, 201);
});

// ---------- media ----------

app.get("/media/:key", async (c) => {
  const key = c.req.param("key");
  if (!MEDIA_KEY_RE.test(key)) fail(404, "Not found");
  const object = await c.env.MEDIA.get(key);
  if (!object) fail(404, "Not found");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});

// ---------- cron ----------
// Fires every 5 minutes, offset from shade's quarter-hour cron (see wrangler.jsonc).

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    if (result) console.log(name, result);
  } catch (err) {
    console.error(`${name} failed`, err);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    const minute = new Date(controller.scheduledTime).getUTCMinutes();
    const accounts = await ensureAccounts(env);
    const firstNews = !(await env.DB.prepare(`SELECT 1 FROM news_items LIMIT 1`).first());

    if (minute % 15 === 7) {
      await step("member sync", async () => {
        const r = await syncMembers(env);
        return r.imported || r.passwordsUpdated || r.removed || r.failedSources.length ? r : null;
      });
    }
    if (minute % 15 === 2 || firstNews) {
      await step("news", async () => ({ posted: await postNews(env, accounts, firstNews ? 3 : 1) }));
    }
    await step("bots", () => runBots(env, accounts));
  },
} satisfies ExportedHandler<Env>;
