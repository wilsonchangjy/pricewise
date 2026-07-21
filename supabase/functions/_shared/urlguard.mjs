// URL hygiene for /add. Two jobs, both mandatory before we ever fetch a link a
// stranger sent us:
//
//   normalizeUrl() — strip campaign junk so the SAME product is the SAME row.
//     Without it, two people sharing one item via different channels create two
//     tracked_products, and we pay for two fetches of the same page.
//
//   assertSafeUrl() — SSRF guard. A public /add means strangers choose what our
//     backend fetches. Anything that isn't a plain public http(s) web address is
//     refused: no internal ranges, no odd ports, no credentials, no IP tricks.
//
// Both are pure and heavily tested.

// Click/campaign identifiers. Deliberately a DENYLIST, not an allowlist: real
// product params live in the query too (Uniqlo's colorDisplayCode, Inditex's
// colorId), and dropping those would silently change which variant we watch.
const TRACKING_PARAMS = [
  /^utm_/i,
  /^(fbclid|gclid|gclsrc|dclid|msclkid|yclid|twclid|ttclid|igshid|epik|li_fat_id)$/i,
  /^(mc_cid|mc_eid|srsltid|_gl|cmpid|s_kwcid|irclickid|rtid)$/i,
  // Shopify search context — two people finding the same item different ways
  // would otherwise create two product rows. `variant` is NOT junk: it names a size.
  /^(_pos|_fid|_ss|_sid|pr_prod_strat|pr_rec_id|pr_ref_pid|pr_seq)$/i,
];

/**
 * Amazon links arrive carrying pd_rd_i, pf_rd_r, content-id, th, psc and a
 * session path segment. Two people sharing one product would otherwise create
 * two tracked rows and pay twice, so collapse to the canonical /dp/{ASIN}.
 */
function canonicalAmazon(u) {
  const asin = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})/i);
  if (!asin) return null;
  return `${u.origin}/dp/${asin[1].toUpperCase()}`;
}

/**
 * Lazada share links carry ~1KB of per-share tracking (laz_token, pvid, a
 * timestamped priceCompare blob), so every share of one product would be a
 * different URL and therefore a different tracked row. The path already
 * identifies item and sku: /products/pdp-i{item}-s{sku}.html
 */
function canonicalLazada(u) {
  return /\/products\/pdp-i\d+/.test(u.pathname) ? `${u.origin}${u.pathname}` : null;
}

/**
 * eBay links arrive with _skw, itmmeta, hash, itmprp, keyword and more — often
 * longer than the page title. Item ids are global, and regional hosts can't be
 * reached through the unblocker, so everything collapses to the .com listing.
 */
function canonicalEbay(u) {
  const m = u.pathname.match(/\/itm\/(?:[^/]*\/)?(\d{9,})/);
  return m ? `https://www.ebay.com/itm/${m[1]}` : null;
}

/** @param {string} raw @returns {string} */
export function normalizeUrl(raw) {
  const u = new URL(raw);
  if (/(^|\.)ebay\.[a-z.]{2,6}$/i.test(u.hostname)) {
    const canon = canonicalEbay(u);
    if (canon) return canon;
  }
  if (/(^|\.)lazada\.[a-z.]{2,6}$/i.test(u.hostname)) {
    const canon = canonicalLazada(u);
    if (canon) return canon;
  }
  if (/(^|\.)amazon\.[a-z.]{2,6}$/i.test(u.hostname)) {
    const canon = canonicalAmazon(u);
    if (canon) return canon;
  }
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  // Stable ordering, so ?a=1&b=2 and ?b=2&a=1 dedupe to one product row.
  u.searchParams.sort();
  return u.toString();
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,               // link-local, incl. cloud metadata 169.254.169.254
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^19[28]\.0\.0\./,
  /^(22[4-9]|23\d|24\d|25[0-5])\./, // multicast + reserved
];

const BLOCKED_HOST_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i;

/**
 * @param {string} raw
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: "that isn't a valid web address" }; }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "I only follow http(s) links" };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "I don't follow links that carry credentials" };
  }
  if (u.port && u.port !== "80" && u.port !== "443") {
    return { ok: false, reason: "I only follow links on the standard web ports" };
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || BLOCKED_HOST_SUFFIX.test(host)) {
    return { ok: false, reason: "that address isn't a public website" };
  }
  // IPv6 literals: no legitimate storefront uses one, and ::1 / fc00:: / fe80::
  // are exactly what an SSRF probe reaches for.
  if (host.includes(":")) return { ok: false, reason: "that address isn't a public website" };

  // Numeric hostnames hide private addresses: 2130706433 and 0x7f000001 are both
  // 127.0.0.1. Anything that isn't dotted-quad-with-a-real-TLD is refused.
  if (/^\d+$/.test(host) || /^0x/i.test(host)) {
    return { ok: false, reason: "that address isn't a public website" };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (PRIVATE_V4.some((re) => re.test(host))) {
      return { ok: false, reason: "that address isn't a public website" };
    }
  } else if (!host.includes(".")) {
    return { ok: false, reason: "that address isn't a public website" };
  }

  return { ok: true, url: raw };
}

/** Guard + normalize in the order /add needs them. */
export function cleanUrl(raw) {
  const safe = assertSafeUrl(raw);
  if (!safe.ok) return safe;
  try {
    return { ok: true, url: normalizeUrl(safe.url) };
  } catch {
    return { ok: false, reason: "I couldn't read that link" };
  }
}
