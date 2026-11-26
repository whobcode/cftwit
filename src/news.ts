// Headline accounts: each pulls a public RSS feed and posts new stories with a
// short summary written by Workers AI and a link card back to the source.

import { cleanPost, generate } from "./ai";
import { createTweet } from "./social";

export type NewsFeed = { username: string; name: string; url: string; source: string; tag: string };

export const NEWS_FEEDS: NewsFeed[] = [
  { username: "worldnews", name: "World News", url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC News", tag: "World" },
  { username: "usnews", name: "US News", url: "https://feeds.npr.org/1001/rss.xml", source: "NPR", tag: "News" },
  { username: "technews", name: "Tech News", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", source: "BBC News", tag: "Tech" },
  { username: "sciencenews", name: "Science News", url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", source: "BBC News", tag: "Science" },
  { username: "biznews", name: "Business News", url: "https://feeds.bbci.co.uk/news/business/rss.xml", source: "BBC News", tag: "Business" },
  { username: "sportsnews", name: "Sports News", url: "https://feeds.bbci.co.uk/sport/rss.xml", source: "BBC Sport", tag: "Sports" },
];

export const newsBio = (f: NewsFeed) =>
  `${f.tag} headlines from ${f.source}, summarized automatically by AI. Not affiliated with ${f.source}.`;

type Item = { title: string; link: string; description: string; published: number | null };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

/** Canonical form for de-duplication: tracking parameters dropped. */
function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    for (const key of [...u.searchParams.keys()]) {
      if (/^(at_|utm_)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function parseRss(xml: string): Item[] {
  const items: Item[] = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const link = canonicalUrl(tag(block, "link") || tag(block, "guid"));
    const title = tag(block, "title");
    if (!link || !title) continue;
    const date = Date.parse(tag(block, "pubDate"));
    items.push({ title, link, description: tag(block, "description"), published: Number.isNaN(date) ? null : date / 1000 });
  }
  return items;
}

async function summarize(env: Env, feed: NewsFeed, item: Item): Promise<string> {
  const text = await generate(
    env,
    [
      {
        role: "system",
        content:
          "You write the text of a social media post for a news headline account. Write one or two plain sentences, " +
          "under 200 characters, factual and neutral, in your own words. Use only the facts given. No hashtags, no emoji, no links, no quotes.",
      },
      { role: "user", content: `Headline: ${item.title}\nDetails: ${item.description || "(none)"}` },
    ],
    120,
  );
  const summary = cleanPost(text, 240) ?? item.title;
  return `${summary} #${feed.tag}`;
}

/** Posts up to `perFeed` new stories per feed. Returns how many were posted. */
export async function postNews(env: Env, accounts: Map<string, string>, perFeed: number): Promise<number> {
  const maxAge = 24 * 60 * 60;
  const now = Date.now() / 1000;
  let posted = 0;

  await Promise.all(
    NEWS_FEEDS.map(async (feed) => {
      const userId = accounts.get(feed.username);
      if (!userId) return;
      let items: Item[];
      try {
        const res = await fetch(feed.url, {
          headers: { "user-agent": "cftwit-news/1.0", accept: "application/rss+xml, application/xml" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        items = parseRss(await res.text());
      } catch (err) {
        console.error(`news: ${feed.username} fetch failed`, String(err));
        return;
      }

      const fresh = items.filter((i) => i.published === null || now - i.published < maxAge).slice(0, 15);
      if (!fresh.length) return;
      const { results: seen } = await env.DB.prepare(`SELECT url FROM news_items WHERE url IN (SELECT value FROM json_each(?1))`)
        .bind(JSON.stringify(fresh.map((i) => i.link)))
        .all<{ url: string }>();
      const seenUrls = new Set(seen.map((r) => r.url));

      // Oldest first, so the newest story ends up on top of the feed.
      const toPost = fresh.filter((i) => !seenUrls.has(i.link)).slice(0, perFeed).reverse();
      for (const item of toPost) {
        // Claim the story first so overlapping runs can't post it twice.
        const claim = await env.DB.prepare(`INSERT OR IGNORE INTO news_items (url, feed) VALUES (?1, ?2)`)
          .bind(item.link, feed.username)
          .run();
        if (!claim.meta.changes) continue;
        const body = await summarize(env, feed, item);
        const tweetId = await createTweet(env.DB, {
          userId,
          body,
          linkUrl: item.link,
          linkTitle: item.title.slice(0, 200),
        });
        await env.DB.prepare(`UPDATE news_items SET tweet_id = ?1 WHERE url = ?2`).bind(tweetId, item.link).run();
        posted++;
      }
    }),
  );
  return posted;
}
