/**
 * Lone-surrogate sanitization (watcher copy of the disc-server helper, #29/#56).
 *
 * The watcher pushes message previews (`author.username` + content) into the
 * receiving agent's transcript. A lone unpaired UTF-16 surrogate in pulled
 * content cannot be encoded as valid JSON and makes every subsequent API
 * request 400 (`no low surrogate in string`), hard-jamming the session
 * (incident 2026-06-19). Strip lone surrogates here — the watcher is a second
 * ingestion boundary alongside `disc_read`.
 *
 * Valid surrogate pairs (emoji / astral chars) are preserved; only unpaired
 * halves become U+FFFD.
 */
export function sanitizeSurrogates(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else {
        out += "�";
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += "�";
    } else {
      out += s[i];
    }
  }
  return out;
}
