// /add URL → adapter router. Given a product URL a user pastes/shares to the
// bot, decide which adapter reads it (and whether it needs the unblocker). This
// is the heart of self-serve: it turns "here's a link" into a tracked product.
//
// Detection order: known-brand host map (free, no network) → URL patterns → a
// cheap Shopify `.js` probe → a page-signal sniff. Portable (Node + Deno: uses
// global fetch only, no deps).

// Known brands, matched on hostname. (itxrest brands still need store/catalog/
// productId resolved from the page — see resolveHints below.)
const HOST_MAP = [
  [/(?:^|\.)uniqlo\.com$/i, "uniqlo"],
  [/(?:^|\.)mango\.com$/i, "mango"],
  [/(?:^|\.)cos\.com$/i, "cos"],
  [/(?:^|\.)stories\.com$/i, "stories"],
  [/(?:^|\.)zara\.com$/i, "zara"],
  [/(?:^|\.)massimodutti\.com$/i, "inditex"],
  [/(?:^|\.)oysho\.com$/i, "inditex"],
  [/(?:^|\.)stradivarius\.com$/i, "stradivarius"],
  [/(?:^|\.)bershka\.com$/i, "bershka"],
  [/(?:^|\.)asos\.com$/i, "asos"],
  [/(?:^|\.)amazon\.[a-z.]{2,6}$/i, "amazon"],
  [/(?:^|\.)farfetch\.com$/i, "farfetch"],
];

// Adapters that must go through the unblocker (credits). Everything else is free.
//
// Bershka and Stradivarius were verified FREE during development — from a home
// connection. From a datacentre IP every Inditex endpoint returns 403 "Service
// Unavailable", API paths included: they block the address, not the route. The
// adapters still try direct first (a self-hoster on a residential IP gets it for
// nothing), but /add must tell cloud users the truth about needing a key.
const DEFENDED = new Set(["inditex", "zara", "asos", "stories", "bershka", "stradivarius", "amazon", "farfetch"]);

export const strategyFor = (adapter) => (DEFENDED.has(adapter) ? "unblocker" : "direct");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) AppleWebKit/537.36 Chrome/124 Safari/537.36";
async function get(url, fetchImpl, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: ctrl.signal });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ adapter: string|null, strategy?: string, via: string, hints?: object, message?: string }>}
 */
export async function detectAdapter(url, { fetchImpl = fetch } = {}) {
  let u;
  try { u = new URL(url); } catch { return { adapter: null, via: "invalid-url", message: "not a URL" }; }
  const host = u.hostname;

  // 1) Known brand by host (free, no network).
  for (const [re, adapter] of HOST_MAP) {
    if (re.test(host)) {
      const hints = itxrestHints(adapter, u);
      return { adapter, strategy: strategyFor(adapter), via: "host", ...(hints && { hints }) };
    }
  }

  // 2) Wix by URL pattern.
  if (/\/product-page\//.test(u.pathname)) {
    return { adapter: "wix", strategy: "direct", via: "url-pattern" };
  }

  // 3) Shopify probe — the biggest long tail. {origin}/products/{handle}.js
  const handle = (u.pathname.match(/\/products\/([^/?#]+)/) || [])[1];
  if (handle) {
    const r = await get(`${u.origin}/products/${handle}.js`, fetchImpl);
    if (r.ok) {
      try {
        if (Array.isArray(JSON.parse(r.text).variants)) {
          return { adapter: "shopify", strategy: "direct", via: "shopify-js-probe" };
        }
      } catch { /* not shopify */ }
    }
  }

  // 4) Page-signal sniff (last resort).
  const pg = await get(url, fetchImpl);
  if (pg.ok) {
    if (pg.text.includes('"catalog":{"product":{')) return { adapter: "wix", strategy: "direct", via: "page-signal" };
    if (/"@type"\s*:\s*"ProductGroup"/.test(pg.text)) return { adapter: "jsonld", strategy: "direct", via: "page-signal" };
    if (pg.text.includes("application/ld+json")) return { adapter: "jsonld", strategy: "direct", via: "page-signal" };
  }

  return { adapter: null, via: "unknown", message: `unsupported site (${host}) — no adapter matched` };
}

// itxrest brands need storeId/catalogId/productId. productId is derivable from
// the page URL (Stradivarius pelement=, Bershka c0p{ID}); store/catalog are
// per-store constants resolved once. We surface what we can parse from the URL.
function itxrestHints(adapter, u) {
  if (adapter === "stradivarius") {
    const productId = (u.search.match(/[?&]pelement=(\d+)/) || u.pathname.match(/l0*(\d+)/) || [])[1];
    return productId ? { productId, needs: ["storeId", "catalogId"] } : { needs: ["storeId", "catalogId", "productId"] };
  }
  if (adapter === "bershka") {
    const productId = (u.pathname.match(/c\d+p(\d+)\.html/) || [])[1];
    return productId ? { productId, needs: ["storeId", "catalogId"] } : { needs: ["storeId", "catalogId", "productId"] };
  }
  return null;
}
