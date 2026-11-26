// Writes shared by the API and the bots, so every post, like and follow
// produces the same tags and notifications no matter who makes it.

export const MAX_TWEET_CHARS = 280;
/** Links count as 23 characters, like t.co, so a long URL doesn't eat the post. */
const URL_WEIGHT = 23;
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const MENTION_RE = /(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,15})(?![A-Za-z0-9_])/g;
const TAG_RE = /(?:^|[^A-Za-z0-9_&])#([A-Za-z][A-Za-z0-9_]{1,49})(?![A-Za-z0-9_])/g;

export function tweetLength(body: string): number {
  return [...body.replace(URL_RE, "x".repeat(URL_WEIGHT))].length;
}

function uniqueMatches(re: RegExp, body: string, limit: number): string[] {
  const seen = new Map<string, string>();
  for (const m of body.matchAll(re)) {
    const key = m[1].toLowerCase();
    if (!seen.has(key)) seen.set(key, m[1]);
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

export const extractMentions = (body: string) => uniqueMatches(MENTION_RE, body, 10);
export const extractTags = (body: string) => uniqueMatches(TAG_RE, body, 10);

export type NewTweet = {
  userId: string;
  body: string;
  replyTo?: number | null;
  mediaKey?: string | null;
  linkUrl?: string | null;
  linkTitle?: string | null;
};

// Notifications only go to people: bots and news accounts have no one to read them.
const NOTIFY_REPLY = `
  INSERT OR IGNORE INTO notifications (user_id, actor_id, type, tweet_id)
  SELECT p.user_id, ?1, 'reply', ?2 FROM tweets p JOIN users u ON u.id = p.user_id
  WHERE p.id = ?3 AND p.user_id != ?1 AND u.kind = 'human'`;
const NOTIFY_MENTIONS = `
  INSERT OR IGNORE INTO notifications (user_id, actor_id, type, tweet_id)
  SELECT id, ?1, 'mention', ?2 FROM users
  WHERE username IN (SELECT value FROM json_each(?3)) AND id != ?1 AND kind = 'human' AND activated = 1`;
const NOTIFY_LIKE = `
  INSERT OR IGNORE INTO notifications (user_id, actor_id, type, tweet_id)
  SELECT t.user_id, ?1, 'like', t.id FROM tweets t JOIN users u ON u.id = t.user_id
  WHERE t.id = ?2 AND t.user_id != ?1 AND u.kind = 'human'`;
const NOTIFY_FOLLOW = `
  INSERT OR IGNORE INTO notifications (user_id, actor_id, type, tweet_id)
  SELECT id, ?1, 'follow', NULL FROM users WHERE id = ?2 AND id != ?1 AND kind = 'human'`;

export async function createTweet(db: D1Database, t: NewTweet): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO tweets (user_id, body, media_key, reply_to, link_url, link_title)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id, created_at`,
    )
    .bind(t.userId, t.body, t.mediaKey ?? null, t.replyTo ?? null, t.linkUrl ?? null, t.linkTitle ?? null)
    .first<{ id: number; created_at: number }>();
  const id = row!.id;

  const follow: D1PreparedStatement[] = [];
  const tags = extractTags(t.body);
  if (tags.length) {
    follow.push(
      db
        .prepare(`INSERT OR IGNORE INTO tweet_tags (tweet_id, tag, created_at) SELECT ?1, value, ?2 FROM json_each(?3)`)
        .bind(id, row!.created_at, JSON.stringify(tags)),
    );
  }
  if (t.replyTo) follow.push(db.prepare(NOTIFY_REPLY).bind(t.userId, id, t.replyTo));
  const mentions = extractMentions(t.body);
  if (mentions.length) follow.push(db.prepare(NOTIFY_MENTIONS).bind(t.userId, id, JSON.stringify(mentions)));
  if (follow.length) await db.batch(follow);
  return id;
}

export async function setLike(db: D1Database, userId: string, tweetId: number, liked: boolean) {
  if (!liked) {
    await db.prepare(`DELETE FROM likes WHERE user_id = ?1 AND tweet_id = ?2`).bind(userId, tweetId).run();
    return;
  }
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO likes (user_id, tweet_id) SELECT ?1, id FROM tweets WHERE id = ?2`).bind(userId, tweetId),
    db.prepare(NOTIFY_LIKE).bind(userId, tweetId),
  ]);
}

export async function setFollow(db: D1Database, followerId: string, followeeId: string, following: boolean) {
  if (!following) {
    await db
      .prepare(`DELETE FROM follows WHERE follower_id = ?1 AND followee_id = ?2`)
      .bind(followerId, followeeId)
      .run();
    return;
  }
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?1, ?2)`).bind(followerId, followeeId),
    db.prepare(NOTIFY_FOLLOW).bind(followerId, followeeId),
  ]);
}

/** Someone may message you if you follow them, or once you've messaged them. */
export async function canMessage(db: D1Database, senderId: string, recipient: { id: string; kind: string }) {
  if (recipient.kind === "news" || recipient.id === senderId) return false;
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM follows WHERE follower_id = ?2 AND followee_id = ?1)
           OR EXISTS (SELECT 1 FROM messages WHERE sender_id = ?2 AND recipient_id = ?1) AS ok`,
    )
    .bind(senderId, recipient.id)
    .first<{ ok: number }>();
  return Boolean(row?.ok);
}
