# cftwit

A Twitter-style app running entirely on Cloudflare: Workers (Hono) for the API, static assets for the frontend, D1 for data, R2 for images, Workers AI for generated content, Email Sending for sign-in links, and the Rate Limiting binding for abuse control.

Features: posts with images, links, @mentions and #hashtags; replies, likes and follows; an algorithmic "For you" feed plus a chronological "Following" feed; trending hashtags and who-to-follow on Explore; automatic news; AI persona accounts; direct messages; and notifications.

## Local development

```bash
npm install
npm run db:migrate:local
npm run dev
```

Open http://localhost:8787. Local D1 and R2 data live in `.wrangler/`.

## Deploy to cftwit.hwmnbn.me

The `hwmnbn.me` zone must be on the same Cloudflare account as `wrangler login`.

```bash
npx wrangler d1 create cftwit
```

Copy the printed `database_id` into `wrangler.jsonc`, then:

```bash
npx wrangler r2 bucket create cftwit-media
npm run db:migrate:remote
npm run deploy
```

The `routes` entry in `wrangler.jsonc` attaches the custom domain and creates its DNS record on deploy.

## Adding users

People can sign up themselves. To create an account for someone (or reset a password), run:

```bash
node scripts/invite.mjs <username> [email] --remote
```

It prints a one-time link (valid 48 hours) where they choose their own password. Drop `--remote` to target the local database. Users can log in with their username or email; emails are never shown publicly.

## 8hues and shade members

Every 15 minutes a cron ([src/sync.ts](src/sync.ts)) copies in members of 8hues (`hue_green_db`) and shade (`social_rpg_db`) who don't have an account here yet, matched by email. It only reads those databases.

- Members log in with the email and password they use there. Password changes there carry over until they set a password here.
- Imported accounts stay hidden (no public profile) until the person first logs in.
- Skipped: banned 8hues members, shade bots, and shade accounts that shade itself copied from 8hues.
- A member who leaves or is banned at the source is removed here if they never logged in. Accounts that have been used are kept.
- Passkey-only 8hues members and shade members without a password (Google/phone sign-in) use "Email me a sign-in link" on the login page (or you can send them a link from `scripts/invite.mjs`).

Locally, `npm run dev` exposes http://localhost:8787/__scheduled to run the sync against the local copies of those databases.

## Generated content

A cron runs every 5 minutes (offset from shade's quarter-hour cron):

- **News** ([src/news.ts](src/news.ts)): six headline accounts (@worldnews, @usnews, @technews, @sciencenews, @biznews, @sportsnews) pull BBC News and NPR RSS feeds every 15 minutes and post each new story once, with a short Workers AI summary and a link card.
- **AI personas** ([src/bots.ts](src/bots.ts)): twelve fictional accounts post in character, reply to recent posts (people first), like posts, follow back anyone who follows them, and answer DMs. They're labelled "AI" everywhere and say they're AI if asked.
- **For you** ranks the latest 400 posts by likes, replies, whether you follow the author and whether people you follow liked it, decayed by age and with repeat authors pushed down.

## Email sign-in links

"Email me a sign-in link" on the login page sends a one-time link (valid one hour) from `MAIL_FROM` (cftwit@hwmnbn.me). This covers forgotten passwords and members imported without one. **hwmnbn.me must be onboarded under Email → Email Sending in the Cloudflare dashboard** before these emails deliver; until then sends fail and are logged.

## Layout

- `src/index.ts` — API routes and the cron entry point
- `src/social.ts` — shared writes: posts, likes, follows, tags, notifications
- `src/ai.ts` — Workers AI text generation
- `src/news.ts`, `src/bots.ts` — generated content
- `src/sync.ts` — 8hues and shade member sync
- `src/mail.ts` — sign-in emails
- `src/auth.ts` — PBKDF2 password hashing and session tokens
- `src/media.ts` — image type detection for uploads
- `migrations/` — D1 schema
- `public/` — frontend (vanilla JS single-page app, no build step)

## Not included yet

Signup bot protection (Turnstile), search, real-time push (DMs and notifications poll), and fan-out timelines.
