import { createHash } from 'node:crypto';

/** Run only embedded report scripts, in an opaque-origin, network-free sandbox.
 * Do not add allow-same-origin: artifacts must not inherit Hub cookies/storage.
 * External scripts, event handlers, eval, frames and all network requests stay blocked.
 */
export function htmlPreviewPolicy(content) {
  const hashes = new Set();
  for (const match of content.toString('utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    hashes.add("'sha256-" + createHash('sha256').update(match[2], 'utf8').digest('base64') + "'");
    // Bound HTTP header size. Very script-heavy reports retain static fallback.
    if (hashes.size > 64) { hashes.clear(); break; }
  }
  return ["sandbox allow-scripts allow-downloads", "default-src 'none'",
    "script-src " + ([...hashes].join(' ') || "'none'"),
    "connect-src 'none'", "img-src data: blob:", "style-src 'unsafe-inline'",
    "font-src data:", "frame-src 'none'", "object-src 'none'", "base-uri 'none'",
    "form-action 'none'"].join('; ');
}
