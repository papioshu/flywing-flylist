// X / Twitter handle parsing. The handle is SELF-REPORTED — this only checks
// that it is a syntactically valid X username, not that the registrant owns it.

// X usernames: 1-15 characters, letters, digits and underscore only.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

export type TwitterHandle = {
  /** As the user typed it, minus a leading "@". Used for display. */
  display: string;
  /** Lowercase form, used for search/comparison (X handles are case-insensitive). */
  normalized: string;
};

export type TwitterHandleResult =
  | { ok: true; handle: TwitterHandle }
  | { ok: false; error: string };

export function parseTwitterHandle(input: unknown): TwitterHandleResult {
  if (typeof input !== "string") return { ok: false, error: "X username is required." };
  let value = input.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (value.length === 0) return { ok: false, error: "X username is required." };
  if (value.length > 15) return { ok: false, error: "X usernames are at most 15 characters." };
  if (!HANDLE_RE.test(value)) {
    return { ok: false, error: "X usernames can only contain letters, numbers and underscores." };
  }
  return { ok: true, handle: { display: value, normalized: value.toLowerCase() } };
}

export function twitterProfileUrl(normalized: string): string {
  return `https://x.com/${normalized}`;
}
