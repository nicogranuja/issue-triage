/*
 * Issue text, model output, and even URLs and colors come from outside (GitHub payloads and the
 * model). React escapes text, so everything is rendered as plain text; these helpers cover the
 * two places where a string becomes something other than text: a link and a style.
 */

/** The URL, if it is an absolute http(s) URL; null otherwise (`javascript:`, relative, junk). */
export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A GitHub label color (six hex digits) as a CSS color, or null if it isn't one. */
export function safeLabelColor(value: string | undefined): string | null {
  return value !== undefined && /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : null;
}
