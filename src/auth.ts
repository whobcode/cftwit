const encoder = new TextEncoder();

// Workers' WebCrypto rejects PBKDF2 iteration counts above 100,000.
const PBKDF2_ITERATIONS = 100_000;

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hashPassword(password: string, saltHex?: string) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: toHex(bits), salt: toHex(salt) };
}

export async function verifyPassword(password: string, hashHex: string, saltHex: string) {
  const candidate = await hashPassword(password, saltHex);
  const a = fromHex(candidate.hash);
  const b = fromHex(hashHex);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export function newToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}
