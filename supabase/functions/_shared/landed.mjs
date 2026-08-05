// Did we actually land on the page we asked for?
//
// THE BUG THIS EXISTS FOR: the search offered an SSENSE /en-us/ product URL to a
// shopper in Singapore. SSENSE geo-redirected, we ended up on a brand LISTING
// page, and the reader — which only asked "is there a product here?" — answered
// with the first tile in the grid. The bot printed "OUR LEGACY Black Mini
// Jacket, USD 720" for a page that is Black Camion Boots at USD 760. A real
// product, a real price, from a page nobody asked about.
//
// WHY NOT COMPARE THE FINAL URL: because for the shops where this matters most
// we don't have one. Defended stores are fetched through an unblocker, which
// follows redirects inside the proxy and hands back only HTML — httpGet's
// `res.url` doesn't exist on that path. So the check has to work off something
// in the response body, which means the page's OWN statement of what it is:
// <link rel="canonical"> or og:url. That works identically for a direct fetch
// and a proxied one, which is the only reason it's worth having.
//
// CONSERVATIVE BY CONSTRUCTION. It answers "away" only when the page names
// itself and that name shares no distinctive token with what we asked for.
// No canonical, or no distinctive token to test → it says nothing and the read
// proceeds. A geo-swap (/sg/ ↔ /us/), a dropped query string, a trailing slash,
// an added locale prefix all keep the product slug and so all pass. What fails
// is landing on a listing, a category, or a different product — which is
// exactly the set we want to fail.

/**
 * The parts of a URL that identify WHICH product, as opposed to which country,
 * language or campaign. A long slug and a long numeric id are the two things
 * retailers actually key products on.
 */
export function identityTokens(url) {
  let path;
  try { path = new URL(String(url)).pathname; } catch { path = String(url); }
  const tokens = new Set();

  // Long digit runs: SSENSE's 18122381, NET-A-PORTER's 6-digit ids.
  for (const m of path.matchAll(/\d{5,}/g)) tokens.add(m[0].toLowerCase());

  // The last TWO meaningful segments, extension stripped. Two, not one, because
  // retailers disagree about the order: END ends with the slug
  // ("our-legacy-camion-boot-cocbb.html") while SSENSE ends with the id and puts
  // the slug before it (".../black-camion-boots/18122381"). Taking only the last
  // would reduce SSENSE to its id and lose the more legible half of the evidence.
  const segs = path.split("/").filter(Boolean);
  for (const seg of segs.slice(-2)) {
    const clean = seg.replace(/\.(html?|aspx|php)$/i, "");
    // Short segments are worthless as evidence — "men", "sg", "p" match anything.
    if (clean.length >= 6) tokens.add(clean.toLowerCase());
  }

  return [...tokens];
}

/** Does `other` still refer to the product `requested` named? */
export function sameProductPage(requested, other) {
  const tokens = identityTokens(requested);
  if (!tokens.length) return true; // nothing distinctive to test — don't guess
  const hay = String(other).toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

/**
 * What page does this HTML say it is? Attribute order is not fixed in the wild,
 * so both orders are matched rather than assuming rel-then-href.
 */
export function canonicalOf(html) {
  const s = String(html);
  const link =
    s.match(/<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i) ??
    s.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']?canonical["']?/i);
  if (link) return link[1];
  const og = s.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i) ??
             s.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:url["']/i);
  return og?.[1];
}

/**
 * The guard itself.
 *
 * @param {{requestedUrl:string, html?:string, finalUrl?:string}} args
 *   `finalUrl` is the transport's post-redirect URL where we have one (direct
 *   fetches); it's absent on the unblocker path, which is precisely why the
 *   canonical is checked too.
 * @returns {{away:boolean, landedOn?:string}}
 */
export function landedElsewhere({ requestedUrl, html, finalUrl }) {
  if (!requestedUrl) return { away: false };

  // The page's own claim first — it's the signal that works on both transports.
  const canonical = html ? canonicalOf(html) : undefined;
  if (canonical && !sameProductPage(requestedUrl, canonical)) {
    return { away: true, landedOn: canonical };
  }

  // A direct fetch also tells us where it ended up. Only trust this to CONVICT,
  // never to acquit: a proxy that reports the requested URL back verbatim
  // proves nothing about what it fetched.
  if (finalUrl && !sameProductPage(requestedUrl, finalUrl)) {
    return { away: true, landedOn: finalUrl };
  }

  return { away: false };
}

/** The soft refusal every caller should return, worded the same way. */
export function landedElsewhereResult(prefix, landedOn, checkedAt) {
  return {
    ok: false,
    kind: "soft",
    message: `${prefix}: the site redirected to a different page (${landedOn}) — that's a listing or another product, not the item asked for`,
    checkedAt,
  };
}
