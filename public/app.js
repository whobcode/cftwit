const app = document.getElementById("app");
const nav = document.getElementById("nav");
const MAX_CHARS = 280;
const MAX_DM_CHARS = 1000;

let me = null;
let renderSeq = 0;
let badges = { notifications: 0, messages: 0 };

// ---------- tiny DOM + fetch helpers ----------

/** Build an element. Text always goes in as text nodes, so user content can't inject markup. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false && k !== ""));
  return el;
}

async function api(path, { method = "GET", json, form } = {}) {
  const init = { method, headers: {} };
  if (json) {
    init.body = JSON.stringify(json);
    init.headers["content-type"] = "application/json";
  }
  if (form) init.body = form;
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showError(el, err) {
  el.textContent = err.message;
  el.hidden = false;
}

function timeAgo(unix) {
  const secs = Math.max(0, Date.now() / 1000 - unix);
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  const date = new Date(unix * 1000);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

function avatar(username, large, asSpan) {
  const hue = hueOf(username);
  const cls = "avatar" + (large ? " lg" : "");
  const el = asSpan
    ? h("span", { class: cls, "aria-hidden": "true" }, username[0])
    : h("a", { class: cls, href: `/u/${username}`, "data-link": true, "aria-hidden": "true", tabindex: "-1" }, username[0]);
  el.style.setProperty("--hue", hue);
  return el;
}

// Static, trusted SVG markup only; never interpolate user content here.
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  explore: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  news: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 8.5h10M7 12h10M7 15.5h6"/>',
  bell: '<path d="M6 8.5a6 6 0 1 1 12 0c0 6.5 3 8 3 8H3s3-1.5 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  reply: '<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-4.6A8.5 8.5 0 1 1 21 11.5z"/>',
  heart: '<path d="M12 20.5s-7.5-4.6-9.6-9.3A5.2 5.2 0 0 1 12 6.4a5.2 5.2 0 0 1 9.6 4.8c-2.1 4.7-9.6 9.3-9.6 9.3z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  pen: '<path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  more: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
};

function icon(name) {
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

const backLink = (href, label) => h("a", { class: "back", href, "data-link": true }, icon("back"), label);

function hueOf(username) {
  let hue = 0;
  for (const ch of username.toLowerCase()) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return hue;
}

function cover(username) {
  const el = h("div", { class: "cover", "aria-hidden": "true" });
  el.style.setProperty("--hue", hueOf(username));
  return el;
}

function kindBadge(kind) {
  if (kind === "ai") return h("span", { class: "badge ai", title: "AI persona: posts are written by AI" }, "AI");
  if (kind === "news") return h("span", { class: "badge news", title: "Automated news headlines" }, "News");
  return null;
}

/** Links count as 23 characters, matching the server. */
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const postLength = (text) => [...text.trim().replace(URL_RE, "x".repeat(23))].length;

const TOKEN_RE = /https?:\/\/[^\s<>"']+|@[A-Za-z0-9_]{3,15}(?![A-Za-z0-9_])|#[A-Za-z][A-Za-z0-9_]{1,49}(?![A-Za-z0-9_])/g;

/** Post text with links, @mentions and #hashtags made clickable, all built as DOM nodes. */
function richText(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[0];
    const i = m.index;
    // Skip "@" and "#" glued to a word, like an email address or "C#".
    if (token[0] !== "h" && i > 0 && /[A-Za-z0-9_&]/.test(text[i - 1])) continue;
    out.push(text.slice(last, i));
    if (token[0] === "h") {
      const url = token.replace(/[.,!?;:)\]'"]+$/, "");
      let label = url;
      try {
        const u = new URL(url);
        label = (u.host + u.pathname).replace(/\/$/, "");
        if (label.length > 32) label = label.slice(0, 31) + "…";
      } catch {}
      out.push(h("a", { href: url, target: "_blank", rel: "noopener noreferrer nofollow ugc", class: "inline-link" }, label));
      out.push(token.slice(url.length));
    } else if (token[0] === "@") {
      out.push(h("a", { href: `/u/${token.slice(1)}`, "data-link": true, class: "mention" }, token));
    } else {
      out.push(h("a", { href: `/tag/${token.slice(1)}`, "data-link": true, class: "hashtag" }, token));
    }
    last = i + token.length;
  }
  out.push(text.slice(last));
  return out;
}

// ---------- routing ----------

const routes = [
  [/^\/$/, homeView],
  [/^\/explore$/, exploreView],
  [/^\/news$/, newsView],
  [/^\/tag\/([A-Za-z][A-Za-z0-9_]{1,49})$/, tagView],
  [/^\/notifications$/, notificationsView],
  [/^\/messages$/, inboxView],
  [/^\/messages\/([A-Za-z0-9_]{1,15})$/, conversationView],
  [/^\/login$/, () => authView("login")],
  [/^\/signup$/, () => authView("signup")],
  [/^\/forgot$/, forgotView],
  [/^\/u\/([A-Za-z0-9_]{1,15})$/, profileView],
  [/^\/t\/(\d{1,15})$/, threadView],
  [/^\/setup$/, setupView],
];

function navigate(path) {
  history.pushState(null, "", path);
  render();
}

document.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-link]");
  if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(link.getAttribute("href"));
});
window.addEventListener("popstate", render);

function renderNav() {
  const path = location.pathname;
  const link = (href, name, label, count) =>
    h(
      "a",
      {
        href,
        "data-link": true,
        title: label,
        class: (href === "/" ? path === "/" : path.startsWith(href)) ? "active" : null,
      },
      icon(name),
      h("span", { class: "label" }, label),
      count ? h("span", { class: "count-badge", "aria-label": `${count} unread` }, count > 99 ? "99+" : String(count)) : null,
    );
  nav.replaceChildren(
    ...(me
      ? [
          link("/", "home", "Home"),
          link("/explore", "explore", "Explore"),
          link("/news", "news", "News"),
          link("/notifications", "bell", "Alerts", badges.notifications),
          link("/messages", "mail", "Messages", badges.messages),
          link(`/u/${me.username}`, "user", "Profile"),
        ]
      : [
          link("/", "home", "Home"),
          link("/explore", "explore", "Explore"),
          link("/news", "news", "News"),
          link("/login", "login", "Log in"),
        ]),
  );
  renderRailExtra();
}

// ---------- desktop rails ----------

const desktop = matchMedia("(min-width: 1024px)");
const railExtra = document.getElementById("rail-extra");
const side = document.getElementById("side");

/** Left rail extras: the Post button and the account menu. Hidden below desktop widths by CSS. */
function renderRailExtra() {
  if (!me) return railExtra.replaceChildren();
  railExtra.replaceChildren(
    h(
      "button",
      { type: "button", class: "post-btn", title: "New post (N)", "aria-label": "New post", onclick: openComposeDialog },
      icon("pen"),
      h("span", { class: "label" }, "Post"),
    ),
    h(
      "details",
      { class: "account" },
      h(
        "summary",
        { "aria-label": "Account menu", title: `@${me.username}` },
        avatar(me.username, false, true),
        h("span", { class: "who" }, h("b", null, me.displayName), h("span", null, `@${me.username}`)),
        icon("more"),
      ),
      h(
        "div",
        { class: "menu" },
        h("a", { href: `/u/${me.username}`, "data-link": true }, "View profile"),
        h("button", { type: "button", onclick: logout }, `Log out @${me.username}`),
      ),
    ),
  );
}

document.addEventListener("click", (e) => {
  for (const d of document.querySelectorAll("details.account[open]")) if (!d.contains(e.target)) d.open = false;
});

function toast(text, href) {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast", role: "status" }, text, href && h("a", { href, "data-link": true }, "View"));
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}

function openComposeDialog() {
  if (!me) return navigate("/login");
  document.querySelector(".compose-dialog")?.remove();
  const dlg = h("dialog", { class: "compose-dialog", "aria-label": "New post" });
  dlg.append(
    h(
      "div",
      { class: "dialog-head" },
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => dlg.close() }, icon("close")),
    ),
    composer({
      onPosted: (t) => {
        dlg.close();
        toast("Your post was sent.", `/t/${t.id}`);
      },
    }),
  );
  // Close on a click that starts and ends on the backdrop (not a text selection that drifts outside).
  let downOnBackdrop = false;
  dlg.addEventListener("mousedown", (e) => (downOnBackdrop = e.target === dlg));
  dlg.addEventListener("click", (e) => downOnBackdrop && e.target === dlg && dlg.close());
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  dlg.querySelector("textarea").focus();
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey || !me || !desktop.matches) return;
  if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable], dialog")) return;
  e.preventDefault();
  openComposeDialog();
});

let sideData = null;
let sideLoading = null;

async function loadSide() {
  const user = me?.username ?? null;
  const [t, s, n] = await Promise.allSettled([api("/api/trending"), api("/api/suggestions"), api("/api/news")]);
  sideData = {
    user,
    at: Date.now(),
    trending: t.status === "fulfilled" ? t.value.trending : [],
    users: s.status === "fulfilled" ? s.value.users : [],
    news: n.status === "fulfilled" ? n.value.tweets : [],
  };
}

const panel = (title, body, moreHref) =>
  h(
    "section",
    { class: "panel" },
    h("h2", null, title),
    body,
    moreHref && h("a", { class: "panel-more", href: moreHref, "data-link": true }, "Show more"),
  );

/** Right rail: trends, headlines and people to follow. Only fetched while the desktop layout is showing. */
async function renderSide() {
  if (!desktop.matches) return;
  const user = me?.username ?? null;
  if (!sideData || sideData.user !== user || Date.now() - sideData.at > 180_000) {
    sideLoading ??= loadSide().finally(() => (sideLoading = null));
    await sideLoading;
  }
  // The Explore and News pages already show these, so the rail skips them there.
  const path = location.pathname;
  const { trending, users, news } = sideData;
  const panels = [
    !me &&
      h(
        "section",
        { class: "panel join" },
        h("h2", null, "New to cftwit?"),
        h("p", null, "Sign up to post, follow people and get a For you feed tuned to you."),
        h("a", { class: "btn", href: "/signup", "data-link": true }, "Create account"),
        h("a", { class: "btn ghost", href: "/login", "data-link": true }, "Log in"),
      ),
    path !== "/explore" &&
      trending.length > 0 &&
      panel(
        "Trending",
        trending.slice(0, 5).map((t, i) =>
          h(
            "a",
            { class: "panel-item", href: `/tag/${t.tag}`, "data-link": true },
            h("span", { class: "meta" }, `${i + 1} · Trending today`),
            h("span", { class: "trend-tag" }, `#${t.tag}`),
            h("span", { class: "meta" }, `${t.posts} ${t.posts === 1 ? "post" : "posts"}`),
          ),
        ),
        "/explore",
      ),
    path !== "/news" &&
      news.length > 0 &&
      panel(
        "Latest news",
        news.slice(0, 4).map((t) =>
          h(
            "a",
            { class: "panel-item", href: `/t/${t.id}`, "data-link": true },
            h("span", { class: "meta" }, `${t.author.displayName} · ${timeAgo(t.createdAt)}`),
            h("span", { class: "headline" }, t.link?.title || t.body),
          ),
        ),
        "/news",
      ),
    path !== "/explore" &&
      users.length > 0 &&
      panel(
        "Who to follow",
        h(
          "ul",
          { class: "people" },
          users.slice(0, 3).map((u) =>
            h(
              "li",
              null,
              avatar(u.username),
              h(
                "div",
                { class: "person" },
                h("div", { class: "person-line" }, h("a", { class: "name", href: `/u/${u.username}`, "data-link": true }, u.displayName), kindBadge(u.kind)),
                h("div", { class: "muted" }, `@${u.username}`),
              ),
              followButton(u.username, false),
            ),
          ),
        ),
        "/explore",
      ),
    h("p", { class: "side-foot" }, "Built on Cloudflare Workers, D1, R2 and Workers AI. Headlines from BBC News and NPR.", h("br"), `© ${new Date().getFullYear()} cftwit`),
  ];
  side.replaceChildren(...panels.filter(Boolean));
}

desktop.addEventListener("change", () => renderSide().catch(() => {}));

async function refreshBadges() {
  if (!me) return;
  try {
    const next = await api("/api/badges");
    if (next.notifications !== badges.notifications || next.messages !== badges.messages) {
      badges = next;
      renderNav();
    }
  } catch {}
}
setInterval(() => document.visibilityState === "visible" && refreshBadges(), 30000);

async function logout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  me = null;
  badges = { notifications: 0, messages: 0 };
  navigate("/");
}

async function render() {
  const seq = ++renderSeq;
  renderNav();
  renderSide().catch(() => {});
  const path = location.pathname;
  let view = null;
  for (const [pattern, fn] of routes) {
    const match = path.match(pattern);
    if (match) {
      view = () => fn(...match.slice(1));
      break;
    }
  }
  try {
    const el = view ? await view() : h("p", { class: "empty" }, "Page not found.");
    if (seq !== renderSeq) return;
    app.replaceChildren(el);
    window.scrollTo(0, 0);
  } catch (err) {
    if (seq === renderSeq) app.replaceChildren(h("p", { class: "empty" }, err.message));
  }
}

function requireLogin() {
  if (me) return null;
  return h("p", { class: "empty" }, h("a", { href: "/login", "data-link": true }, "Log in"), " to see this page.");
}

// ---------- components ----------

function composer({ replyTo, placeholder = "What's happening?", onPosted }) {
  const text = h("textarea", { name: "body", rows: "2", placeholder, "aria-label": placeholder });
  const file = h("input", { type: "file", name: "image", accept: "image/jpeg,image/png,image/gif,image/webp" });
  const count = h("span", { class: "count", "aria-live": "polite" }, String(MAX_CHARS));
  const submit = h("button", { class: "btn", type: "submit", disabled: true }, replyTo ? "Reply" : "Post");
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const previewImg = h("img", { class: "media", alt: "Attached image preview" });
  const preview = h(
    "div",
    { class: "preview", hidden: true },
    previewImg,
    h("button", { type: "button", onclick: clearImage }, "Remove"),
  );

  function clearImage() {
    file.value = "";
    if (previewImg.src) URL.revokeObjectURL(previewImg.src);
    previewImg.removeAttribute("src");
    preview.hidden = true;
    sync();
  }

  function sync() {
    const left = MAX_CHARS - postLength(text.value);
    count.textContent = String(left);
    count.classList.toggle("over", left < 0);
    submit.disabled = left < 0 || (left === MAX_CHARS && !file.files.length);
  }

  text.addEventListener("input", sync);
  file.addEventListener("change", () => {
    if (previewImg.src) URL.revokeObjectURL(previewImg.src);
    if (file.files.length) {
      previewImg.src = URL.createObjectURL(file.files[0]);
      preview.hidden = false;
    } else {
      preview.hidden = true;
    }
    sync();
  });

  return h(
    "form",
    {
      class: "composer" + (replyTo ? " is-reply" : ""),
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        const data = new FormData();
        data.set("body", text.value);
        if (file.files.length) data.set("image", file.files[0]);
        if (replyTo) data.set("replyTo", String(replyTo));
        try {
          const { tweet } = await api("/api/tweets", { method: "POST", form: data });
          text.value = "";
          clearImage();
          onPosted?.(tweet);
        } catch (err) {
          showError(error, err);
          sync();
        }
      },
    },
    me && avatar(me.username),
    h(
      "div",
      { class: "composer-main" },
      text,
      preview,
      error,
      h(
        "div",
        { class: "composer-bar" },
        h("label", { class: "attach", title: "Add image" }, file, icon("image"), h("span", { class: "sr-only" }, "Add image")),
        h("span", { class: "spacer" }),
        count,
        submit,
      ),
    ),
  );
}

function linkCard(link) {
  let host = "";
  try {
    host = new URL(link.url).host.replace(/^www\./, "");
  } catch {}
  return h(
    "a",
    { class: "link-card", href: link.url, target: "_blank", rel: "noopener noreferrer nofollow" },
    h("span", { class: "link-host" }, host),
    h("span", { class: "link-title" }, link.title),
  );
}

const countText = (n) => (n > 0 ? String(n) : "");

function postCard(t, { focus = false, onDeleted } = {}) {
  const likeCount = h("span", { class: "n" }, countText(t.likeCount));
  const like = h(
    "button",
    {
      type: "button",
      class: "action like" + (t.liked ? " on" : ""),
      "aria-pressed": String(t.liked),
      "aria-label": "Like",
      onclick: async () => {
        if (!me) return navigate("/login");
        like.disabled = true;
        try {
          const res = await api(`/api/tweets/${t.id}/like`, { method: t.liked ? "DELETE" : "PUT" });
          t.liked = res.liked;
          t.likeCount = res.likeCount;
          likeCount.textContent = countText(t.likeCount);
          like.classList.toggle("on", t.liked);
          like.setAttribute("aria-pressed", String(t.liked));
        } catch (err) {
          alert(err.message);
        } finally {
          like.disabled = false;
        }
      },
    },
    icon("heart"),
    likeCount,
  );

  const card = h(
    "article",
    { class: "post" + (focus ? " focus" : "") },
    avatar(t.author.username),
    h(
      "div",
      { class: "post-main" },
      h(
        "div",
        { class: "post-head" },
        h("a", { class: "name", href: `/u/${t.author.username}`, "data-link": true }, t.author.displayName),
        kindBadge(t.author.kind),
        h("span", { class: "handle" }, `@${t.author.username}`),
        h("a", { class: "time", href: `/t/${t.id}`, "data-link": true, title: new Date(t.createdAt * 1000).toLocaleString() }, `· ${timeAgo(t.createdAt)}`),
      ),
      t.replyTo && !focus && h("a", { class: "reply-tag", href: `/t/${t.replyTo}`, "data-link": true }, "↳ in reply to a post"),
      t.body && h("p", { class: "post-body" }, richText(t.body)),
      t.link && linkCard(t.link),
      t.mediaUrl && h("img", { class: "media", src: t.mediaUrl, alt: "Image attached to post", loading: "lazy" }),
      h(
        "div",
        { class: "actions" },
        h(
          "a",
          { class: "action reply", href: `/t/${t.id}`, "data-link": true, "aria-label": `Reply (${t.replyCount} replies)` },
          icon("reply"),
          h("span", { class: "n" }, countText(t.replyCount)),
        ),
        like,
        me?.username === t.author.username &&
          h(
            "button",
            {
              type: "button",
              class: "action delete",
              "aria-label": "Delete post",
              title: "Delete",
              onclick: async () => {
                if (!confirm("Delete this post and its replies?")) return;
                try {
                  await api(`/api/tweets/${t.id}`, { method: "DELETE" });
                  card.remove();
                  onDeleted?.();
                } catch (err) {
                  alert(err.message);
                }
              },
            },
            icon("trash"),
          ),
      ),
    ),
  );
  return card;
}

function feed(endpoint, emptyText) {
  const list = h("div", { class: "feed" });
  const more = h("button", { type: "button", class: "btn ghost more", hidden: true, onclick: load }, "Load more");
  const loading = h("p", { class: "note" }, "Loading…");
  let cursor = null;

  async function load() {
    more.disabled = true;
    try {
      const sep = endpoint.includes("?") ? "&" : "?";
      const data = await api(cursor !== null ? `${endpoint}${sep}cursor=${cursor}` : endpoint);
      loading.remove();
      for (const t of data.tweets) list.append(postCard(t));
      cursor = data.nextCursor;
      more.hidden = cursor === null;
      if (!list.children.length) list.append(h("p", { class: "empty" }, emptyText));
    } catch (err) {
      loading.remove();
      list.append(h("p", { class: "empty" }, err.message));
    } finally {
      more.disabled = false;
    }
  }
  load();

  return {
    el: h("div", null, loading, list, more),
    prepend(t) {
      list.querySelector(".empty")?.remove();
      list.prepend(postCard(t));
    },
  };
}

function followButton(username, isFollowing, onChange) {
  const btn = h(
    "button",
    {
      type: "button",
      class: "btn" + (isFollowing ? " ghost" : ""),
      onclick: async () => {
        if (!me) return navigate("/login");
        btn.disabled = true;
        try {
          const res = await api(`/api/users/${username}/follow`, { method: isFollowing ? "DELETE" : "PUT" });
          isFollowing = res.isFollowing;
          btn.textContent = isFollowing ? "Following" : "Follow";
          btn.classList.toggle("ghost", isFollowing);
          onChange?.(res);
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
        }
      },
    },
    isFollowing ? "Following" : "Follow",
  );
  return btn;
}

// ---------- views ----------

function homeView() {
  const tabs = me ? [["foryou", "For you"], ["following", "Following"]] : [["foryou", "For you"]];
  let current = me && new URLSearchParams(location.search).get("tab") === "following" ? "following" : "foryou";
  const slot = h("div");
  let active = null;

  const tabBar = h(
    "div",
    { class: "tabs", role: "tablist" },
    tabs.map(([key, label]) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          "data-key": key,
          onclick: () => {
            current = key;
            history.replaceState(null, "", key === "foryou" ? "/" : "/?tab=following");
            show();
          },
        },
        label,
      ),
    ),
  );

  function show() {
    for (const b of tabBar.children) b.setAttribute("aria-selected", String(b.dataset.key === current));
    active =
      current === "foryou"
        ? feed("/api/foryou", "Nothing here yet. Check back in a few minutes.")
        : feed("/api/timeline", "Your timeline is empty. Follow people from Explore to fill it.");
    slot.replaceChildren(active.el);
  }
  show();

  return h(
    "section",
    { class: "home" },
    !me &&
      h(
        "div",
        { class: "card banner" },
        h("p", null, "What's happening, right now. Posts, news and conversation, all on Cloudflare."),
        h("a", { class: "btn", href: "/signup", "data-link": true }, "Create account"),
      ),
    me && composer({ onPosted: (t) => active?.prepend(t) }),
    tabBar,
    slot,
  );
}

async function exploreView() {
  const [{ trending }, { users }] = await Promise.all([api("/api/trending"), api("/api/suggestions")]);
  const latest = feed("/api/explore", "No posts yet.");
  return h(
    "section",
    null,
    h("h1", null, "Explore"),
    h(
      "div",
      { class: "card side" },
      h("h2", null, "Trending"),
      trending.length
        ? h(
            "ol",
            { class: "trending" },
            trending.map((t) =>
              h(
                "li",
                null,
                h("a", { href: `/tag/${t.tag}`, "data-link": true }, `#${t.tag}`),
                h("span", { class: "muted" }, `${t.posts} ${t.posts === 1 ? "post" : "posts"}`),
              ),
            ),
          )
        : h("p", { class: "muted" }, "Nothing trending yet."),
    ),
    users.length > 0 &&
      h(
        "div",
        { class: "card side" },
        h("h2", null, "Who to follow"),
        h(
          "ul",
          { class: "people" },
          users.map((u) =>
            h(
              "li",
              null,
              avatar(u.username),
              h(
                "div",
                { class: "person" },
                h("a", { class: "name", href: `/u/${u.username}`, "data-link": true }, u.displayName),
                kindBadge(u.kind),
                h("div", { class: "muted" }, `@${u.username}`),
              ),
              me && followButton(u.username, false),
            ),
          ),
        ),
      ),
    h("h2", { class: "section-title" }, "Latest"),
    latest.el,
  );
}

function newsView() {
  return h(
    "section",
    null,
    h("h1", null, "News"),
    h("p", { class: "muted intro" }, "Headlines from BBC News and NPR, summarized by AI and posted automatically. Tap a card for the full story."),
    feed("/api/news", "No headlines yet. The first ones arrive within a few minutes.").el,
  );
}

function tagView(tag) {
  return h("section", null, h("h1", null, `#${tag}`), feed(`/api/tags/${tag}`, "No posts with this tag yet.").el);
}

const NOTIFICATION_TEXT = {
  like: "liked your post",
  reply: "replied to your post",
  mention: "mentioned you",
  follow: "followed you",
};

async function notificationsView() {
  const gate = requireLogin();
  if (gate) return gate;
  const { notifications } = await api("/api/notifications");
  if (notifications.some((n) => !n.read)) {
    api("/api/notifications/read", { method: "POST" })
      .then(refreshBadges)
      .catch(() => {});
  }
  return h(
    "section",
    null,
    h("h1", null, "Notifications"),
    notifications.length
      ? h(
          "div",
          { class: "feed" },
          notifications.map((n) =>
            h(
              "a",
              {
                class: "row-item notification" + (n.read ? "" : " unread"),
                href: n.tweetId ? `/t/${n.tweetId}` : `/u/${n.actor.username}`,
                "data-link": true,
              },
              avatar(n.actor.username),
              h(
                "div",
                null,
                h("div", null, h("b", null, n.actor.displayName), kindBadge(n.actor.kind), " ", NOTIFICATION_TEXT[n.type] ?? n.type),
                n.snippet && h("p", { class: "muted snippet" }, n.snippet),
                h("div", { class: "muted small" }, timeAgo(n.createdAt)),
              ),
            ),
          ),
        )
      : h("p", { class: "empty" }, "No notifications yet. Likes, replies, mentions and follows show up here."),
  );
}

async function inboxView() {
  const gate = requireLogin();
  if (gate) return gate;
  const { conversations } = await api("/api/messages");
  const input = h("input", { type: "text", placeholder: "username", "aria-label": "Username to message", maxlength: "15", autocapitalize: "none" });
  return h(
    "section",
    null,
    h("h1", null, "Messages"),
    h(
      "form",
      {
        class: "new-dm",
        onsubmit: (e) => {
          e.preventDefault();
          const name = input.value.trim().replace(/^@/, "");
          if (/^[A-Za-z0-9_]{3,15}$/.test(name)) navigate(`/messages/${name}`);
        },
      },
      h("span", { class: "muted" }, "New message to @"),
      input,
      h("button", { type: "submit", class: "btn" }, "Open"),
    ),
    conversations.length
      ? h(
          "div",
          { class: "feed" },
          conversations.map((c) =>
            h(
              "a",
              { class: "row-item conversation" + (c.unread ? " unread" : ""), href: `/messages/${c.with.username}`, "data-link": true },
              avatar(c.with.username),
              h(
                "div",
                { class: "conv-text" },
                h(
                  "div",
                  null,
                  h("b", null, c.with.displayName),
                  kindBadge(c.with.kind),
                  h("span", { class: "muted" }, ` @${c.with.username} · ${timeAgo(c.last.createdAt)}`),
                ),
                h("p", { class: "muted snippet" }, (c.last.fromMe ? "You: " : "") + c.last.body),
              ),
              c.unread > 0 && h("span", { class: "count-badge" }, String(c.unread)),
            ),
          ),
        )
      : h("p", { class: "empty" }, "No conversations yet. You can message anyone who follows you, and the AI personas follow back."),
  );
}

async function conversationView(username) {
  const gate = requireLogin();
  if (gate) return gate;
  const data = await api(`/api/messages/${username}`);
  let lastId = data.messages.at(-1)?.id ?? 0;
  const list = h("div", { class: "bubbles", "aria-live": "polite" });
  const bubble = (m) => h("div", { class: "bubble" + (m.fromMe ? " mine" : "") }, h("p", null, richText(m.body)), h("span", { class: "muted small" }, timeAgo(m.createdAt)));
  const add = (messages) => {
    for (const m of messages) {
      if (m.id <= lastId && list.children.length) continue;
      list.append(bubble(m));
      lastId = Math.max(lastId, m.id);
    }
    list.lastElementChild?.scrollIntoView({ block: "nearest" });
  };
  for (const m of data.messages) list.append(bubble(m));

  const text = h("textarea", { rows: "1", maxlength: String(MAX_DM_CHARS), placeholder: "Write a message", "aria-label": "Message" });
  // Grow with the message, up to a few lines.
  const fit = () => {
    text.style.height = "auto";
    text.style.height = `${Math.min(text.scrollHeight + 2, 140)}px`;
  };
  text.addEventListener("input", fit);
  const send = h("button", { type: "submit", class: "btn" }, "Send");
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const form = data.canMessage
    ? h(
        "form",
        {
          class: "dm-composer",
          onsubmit: async (e) => {
            e.preventDefault();
            if (!text.value.trim()) return;
            error.hidden = true;
            send.disabled = true;
            try {
              const { message } = await api(`/api/messages/${username}`, { method: "POST", json: { body: text.value } });
              text.value = "";
              fit();
              add([message]);
            } catch (err) {
              showError(error, err);
            } finally {
              send.disabled = false;
            }
          },
        },
        text,
        error,
        h("div", { class: "row" }, send),
      )
    : h("p", { class: "note" }, `You can message @${data.with.username} once they follow you.`);

  // Poll for new messages while this conversation is on screen.
  const timer = setInterval(async () => {
    if (!document.body.contains(list)) return clearInterval(timer);
    if (document.visibilityState !== "visible") return;
    try {
      const next = await api(`/api/messages/${username}?after=${lastId}`);
      if (next.messages.length) add(next.messages);
    } catch {}
  }, 4000);
  setTimeout(refreshBadges, 500);

  return h(
    "section",
    null,
    backLink("/messages", "Messages"),
    h(
      "div",
      { class: "conv-head" },
      avatar(data.with.username),
      h("div", null, h("b", null, data.with.displayName), kindBadge(data.with.kind), h("div", { class: "muted" }, `@${data.with.username}`)),
    ),
    data.with.kind === "ai" && h("p", { class: "muted small" }, "This is an AI persona. Replies are written by AI and can be wrong."),
    list,
    form,
  );
}

function authView(mode) {
  if (me) {
    queueMicrotask(() => navigate("/"));
    return h("div");
  }
  const signup = mode === "signup";
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const submit = h("button", { class: "btn", type: "submit" }, signup ? "Create account" : "Log in");
  const field = (label, attrs) => h("label", null, label, h("input", attrs));
  const form = h(
    "form",
    {
      class: "card form",
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          const data = Object.fromEntries(new FormData(form));
          me = (await api(`/api/${mode}`, { method: "POST", json: data })).user;
          refreshBadges();
          navigate("/");
        } catch (err) {
          showError(error, err);
          submit.disabled = false;
        }
      },
    },
    h("h1", null, signup ? "Create your account" : "Welcome back"),
    signup && field("Display name (optional)", { type: "text", name: "displayName", maxlength: "50", autocomplete: "name" }),
    field(signup ? "Username" : "Username or email", {
      type: "text",
      name: "username",
      required: true,
      minlength: "3",
      maxlength: signup ? "15" : "254",
      pattern: signup ? "[A-Za-z0-9_]+" : null,
      autocomplete: signup ? "username" : "username email",
      autocapitalize: "none",
      spellcheck: "false",
    }),
    signup && field("Email (optional, private — lets you log in with it)", { type: "email", name: "email", maxlength: "254", autocomplete: "email" }),
    field("Password", {
      type: "password",
      name: "password",
      required: true,
      minlength: "8",
      maxlength: "128",
      autocomplete: signup ? "new-password" : "current-password",
    }),
    error,
    submit,
    !signup && h("p", { class: "hint" }, h("a", { href: "/forgot", "data-link": true }, "Forgot your password, or never set one? Email me a sign-in link")),
    !signup &&
      h(
        "p",
        { class: "hint" },
        "On 8hues or shade? You already have an account: log in with that email and password. Signed up there with Google or a phone? Use the email link above.",
      ),
    h(
      "p",
      { class: "hint" },
      signup ? "Already have an account? " : "New here? ",
      h("a", { href: signup ? "/login" : "/signup", "data-link": true }, signup ? "Log in" : "Create an account"),
    ),
  );
  return form;
}

function forgotView() {
  const email = h("input", { type: "email", name: "email", required: true, maxlength: "254", autocomplete: "email" });
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const submit = h("button", { class: "btn", type: "submit" }, "Email me a link");
  const done = h("p", { class: "note", role: "status", hidden: true }, "If an account uses that email, a sign-in link is on its way. It expires in an hour.");
  return h(
    "form",
    {
      class: "card form",
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          await api("/api/email-link", { method: "POST", json: { email: email.value } });
          done.hidden = false;
        } catch (err) {
          showError(error, err);
        } finally {
          submit.disabled = false;
        }
      },
    },
    h("h1", null, "Sign in by email"),
    h("p", { class: "hint" }, "We'll email you a one-time link. Opening it lets you choose a password and signs you in."),
    h("label", null, "Email", email),
    error,
    submit,
    done,
    h("p", { class: "hint" }, h("a", { href: "/login", "data-link": true }, "Back to log in")),
  );
}

async function profileView(username) {
  const { profile } = await api(`/api/users/${username}`);
  const isMe = me?.username === profile.username;
  const followers = h("b", null, String(profile.followers));
  const name = h("h1", null, profile.displayName);
  const bio = h("p", { class: "bio", hidden: !profile.bio }, profile.bio);

  const actions = h("div", { class: "row" });
  let editForm = null;
  if (isMe) {
    const error = h("p", { class: "error", role: "alert", hidden: true });
    const nameInput = h("input", { type: "text", name: "displayName", required: true, maxlength: "50", value: profile.displayName });
    const bioInput = h("textarea", { name: "bio", rows: "3", maxlength: "160" }, profile.bio);
    editForm = h(
      "form",
      {
        class: "form",
        hidden: true,
        onsubmit: async (e) => {
          e.preventDefault();
          error.hidden = true;
          try {
            const { user } = await api("/api/me", { method: "PATCH", json: { displayName: nameInput.value, bio: bioInput.value } });
            me = user;
            renderNav();
            name.textContent = user.displayName;
            bio.textContent = user.bio;
            bio.hidden = !user.bio;
            editForm.hidden = true;
          } catch (err) {
            showError(error, err);
          }
        },
      },
      h("label", null, "Display name", nameInput),
      h("label", null, "Bio", bioInput),
      error,
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "btn ghost", onclick: () => (editForm.hidden = true) }, "Cancel"),
        h("button", { type: "submit", class: "btn" }, "Save"),
      ),
    );
    actions.append(
      h("button", { type: "button", class: "btn ghost", onclick: () => (editForm.hidden = !editForm.hidden) }, "Edit profile"),
      h("button", { type: "button", class: "btn ghost", onclick: logout }, "Log out"),
    );
  } else {
    if (profile.canMessage) actions.append(h("a", { class: "btn ghost", href: `/messages/${profile.username}`, "data-link": true }, "Message"));
    actions.append(followButton(profile.username, profile.isFollowing, (res) => (followers.textContent = String(res.followers))));
  }

  const posts = feed(`/api/users/${profile.username}/tweets`, "No posts yet.");
  return h(
    "section",
    null,
    h(
      "div",
      { class: "profile" },
      cover(profile.username),
      h("div", { class: "profile-top" }, avatar(profile.username, true), actions),
      h("div", { class: "name-row" }, name, kindBadge(profile.kind)),
      h("div", { class: "handle" }, `@${profile.username}`),
      bio,
      profile.kind === "ai" && h("p", { class: "muted small" }, "AI persona: everything this account posts is written by AI."),
      h(
        "div",
        { class: "stats" },
        h("span", null, h("b", null, String(profile.posts)), " posts"),
        h("span", null, h("b", null, String(profile.following)), " following"),
        h("span", null, followers, " followers"),
      ),
      editForm,
    ),
    posts.el,
  );
}

async function threadView(id) {
  const { tweet, replies } = await api(`/api/tweets/${id}`);
  const list = h("div", { class: "feed" }, replies.map((r) => postCard(r)));
  const none = h("p", { class: "empty", hidden: replies.length > 0 }, "No replies yet.");
  return h(
    "section",
    null,
    tweet.replyTo
      ? backLink(`/t/${tweet.replyTo}`, "Replying to a post")
      : backLink("/", "Post"),
    postCard(tweet, { focus: true, onDeleted: () => navigate("/") }),
    
    me
      ? composer({
          replyTo: tweet.id,
          placeholder: "Post your reply",
          onPosted: (t) => {
            none.hidden = true;
            list.append(postCard(t));
          },
        })
      : h("p", { class: "note" }, h("a", { href: "/login", "data-link": true }, "Log in"), " to reply."),
    list,
    none,
  );
}

/** Landing page for one-time links: /setup#<token>. The token stays in the fragment so it never reaches server logs. */
function setupView() {
  const token = location.hash.slice(1);
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const submit = h("button", { class: "btn", type: "submit" }, "Set password and log in");
  const password = h("input", { type: "password", name: "password", required: true, minlength: "8", maxlength: "128", autocomplete: "new-password" });
  const confirm = h("input", { type: "password", name: "confirm", required: true, minlength: "8", maxlength: "128", autocomplete: "new-password" });
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return h("p", { class: "empty" }, "This link is incomplete. Open the full link from your email.");
  }
  return h(
    "form",
    {
      class: "card form",
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        if (password.value !== confirm.value) return showError(error, new Error("The passwords don't match"));
        submit.disabled = true;
        try {
          me = (await api("/api/setup-password", { method: "POST", json: { token, password: password.value } })).user;
          history.replaceState(null, "", "/");
          refreshBadges();
          render();
        } catch (err) {
          showError(error, err);
          submit.disabled = false;
        }
      },
    },
    h("h1", null, "Choose your password"),
    h("p", { class: "hint" }, "This signs you in. Use this password to log in from now on."),
    h("label", null, "New password", password),
    h("label", null, "Confirm password", confirm),
    error,
    submit,
  );
}

// ---------- boot ----------

me = (await api("/api/me").catch(() => ({ user: null }))).user;
await refreshBadges();
render();
