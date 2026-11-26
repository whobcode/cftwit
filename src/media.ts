export const MEDIA_KEY_RE = /^[0-9a-f-]{36}\.(jpg|png|gif|webp)$/;

/** Identify an image from its leading bytes; the client-supplied type is never trusted. */
export function sniffImage(bytes: Uint8Array): { ext: string; type: string } | null {
  const has = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (has([0xff, 0xd8, 0xff])) return { ext: "jpg", type: "image/jpeg" };
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", type: "image/png" };
  if (has([0x47, 0x49, 0x46, 0x38])) return { ext: "gif", type: "image/gif" };
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) return { ext: "webp", type: "image/webp" };
  return null;
}
