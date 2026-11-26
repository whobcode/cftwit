import { tweetLength } from "./social";

// Mixture-of-experts with ~4B active parameters: cheap enough to run on every cron tick.
const TEXT_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const TIMEOUT_MS = 25_000;

/** Returns the model's text, or null on any failure so callers can skip or fall back. */
export async function generate(env: Env, messages: ChatMessage[], maxTokens = 160): Promise<string | null> {
  try {
    const run = env.AI.run as unknown as (model: string, input: unknown) => Promise<unknown>;
    const call = run.call(env.AI, TEXT_MODEL, {
      messages,
      max_tokens: maxTokens,
      temperature: 0.9,
      // Gemma 4 reasons before answering by default, which spends the whole token budget on short posts.
      chat_template_kwargs: { enable_thinking: false },
    });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS));
    const res = (await Promise.race([call, timeout])) as {
      response?: unknown;
      choices?: { message?: { content?: unknown } }[];
    };
    const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.trim()) return text;
    console.warn("ai: empty response", JSON.stringify(res).slice(0, 300));
    return null;
  } catch (err) {
    console.error("ai: generation failed", String(err));
    return null;
  }
}

/** Tidies model output into a postable string, or null if nothing usable is left. */
export function cleanPost(text: string | null, max = 280): string | null {
  if (!text) return null;
  let out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*(post|tweet|reply|summary|response)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“'](.*)["”']$/s, "$1")
    .trim();
  if (!out) return null;
  while (tweetLength(out) > max) {
    const cut = out.slice(0, out.length - 10);
    out = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd() + "…";
  }
  return out.length >= 2 ? out : null;
}
