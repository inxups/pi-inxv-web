/**
 * Resolve a login `next` parameter only when it stays on the current origin.
 * This rejects protocol-relative paths and browser backslash normalization
 * such as `/\evil.example`, which WHATWG URL parsing treats as another origin.
 */
export function safeLoginDestination(destination: string | null, origin: string): string {
  if (!destination || !destination.startsWith("/")) return "/";

  try {
    const base = new URL(origin);
    const target = new URL(destination, base);
    if (target.origin !== base.origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}
