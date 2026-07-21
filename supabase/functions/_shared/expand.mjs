// Share links.
//
// The blind spot: every store's share button hands out a SHORT link, and that is
// how people actually send products to each other. Ours refused them outright —
// "I can't track amzn.asia yet" for a store we fully support.
//
// Two flavours seen in the wild, both required:
//   amzn.asia/d/xxxx    -> HTTP 301 to /dp/{ASIN}
//   s.lazada.sg/s.xxxx  -> HTTP 200 with a <meta http-equiv="refresh"> hop
//
// Every hop is SSRF-checked, exactly like the fetcher: a shortener is an
// arbitrary redirect by definition, so it's the last place to trust a target.

import { assertSafeUrl } from "./urlguard.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Hosts whose whole job is to point somewhere else. */
const SHORTENERS = /(^|\.)(amzn\.asia|amzn\.to|a\.co|s\.lazada\.[a-z.]+|shope\.ee|shp\.ee|invol\.co|bit\.ly|tinyurl\.com|t\.co|goo\.gl|rb\.gy|cutt\.ly|lnk\.to|spoo\.me|s\.click\.aliexpress\.com|zlnk\.co)$/i;

export function isShortLink(url) {
  try { return SHORTENERS.test(new URL(url).hostname); } catch { return false; }
}

/** Pull the destination out of <meta http-equiv="refresh" content="0; url=..."> */
function metaRefreshTarget(html, base) {
  const m = String(html).match(
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"'\s>]+)/i,
  );
  if (!m) return null;
  try { return new URL(m[1].replace(/&amp;/g, "&"), base).toString(); } catch { return null; }
}

/**
 * Follow a share link to the real product URL.
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, maxHops?: number }} [opts]
 * @returns {Promise<{ ok: true, url: string, hops: number } | { ok: false, reason: string }>}
 */
export async function expandUrl(url, { fetchImpl = fetch, maxHops = 5 } = {}) {
  let current = url;

  for (let hop = 0; hop <= maxHops; hop++) {
    const guard = assertSafeUrl(current);
    if (!guard.ok) return { ok: false, reason: `redirect target refused: ${guard.reason}` };

    let res;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        headers: { "user-agent": UA, accept: "text/html" },
      });
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e) };
    }

    if (REDIRECTS.has(res.status)) {
      const loc = res.headers?.get?.("location");
      if (!loc) return { ok: true, url: current, hops: hop };
      current = new URL(loc, current).toString();
      continue;
    }

    // A 200 can still be a doorway. Only chase the meta refresh when it leads to
    // a DIFFERENT host — otherwise an ordinary page with a refresh tag (a cart
    // timeout, say) would drag us somewhere we never meant to go.
    const body = typeof res.text === "function" ? await res.text() : "";
    const target = metaRefreshTarget(body, current);
    if (target) {
      try {
        if (new URL(target).hostname !== new URL(current).hostname) {
          current = target;
          continue;
        }
      } catch { /* unparseable target: stop here */ }
    }
    return { ok: true, url: current, hops: hop };
  }
  return { ok: false, reason: "too many redirects" };
}
