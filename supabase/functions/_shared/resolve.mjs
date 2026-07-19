// URL → variantSelector resolution. This is what makes /add self-serve.
//
// Phase 0 hand-wrote a `variantSelector` per item in config.mjs. A public bot
// gets a bare URL, so every id an adapter needs must come from the link itself
// (or an explicit, honest refusal — never "Tracking this!" followed by silence).
//
// Every value below was verified against a working Phase 0 config entry:
//   uniqlo  /products/E485737-000/00?colorDisplayCode=69&sizeDisplayCode=032
//   mango   /p/men/shirts/linen/{slug}/27009215/07/00
//   cos     /en-sg/.../product/seersucker-resort-shirt-black-1326785001
//   bershka /sg/volcom-skater-bermuda-shorts-c0p235801198.html
//
// resolveSelector() is PURE (no network) so it is fully unit-tested.

// Inditex store/catalog ids are per-market constants, not per-product. Only
// markets we've actually verified are listed; an unknown market is refused
// rather than guessed (a wrong catalogId reads someone else's stock).
const ITX_MARKETS = {
  bershka: { sg: { storeId: "45109561", catalogId: "40259531" } },
  stradivarius: { ww: { storeId: "58009550", catalogId: "50331075" } },
};

// Mango ships numeric size codes; this is the published ladder.
const MANGO_SIZE_LABELS = { 19: "XS", 20: "S", 21: "M", 22: "L", 23: "XL", 24: "XXL" };

/**
 * @param {string} url
 * @param {string} adapter
 * @returns {{ ok: true, selector: object, watching: string }
 *          |{ ok: false, reason: string }}
 *   `watching` is a human sentence echoed back to the user so they can see
 *   exactly what we understood before they walk away trusting it.
 */
export function resolveSelector(url, adapter) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, reason: "that isn't a valid link" }; }
  const q = u.searchParams;
  const market = (u.pathname.match(/^\/([a-z]{2})(?:\/|$)/i) || [])[1]?.toLowerCase();

  switch (adapter) {
    // ── nothing to resolve: these adapters read the page/handle directly ──────
    case "shopify":
    case "wix":
    case "jsonld":
    case "zara":
    case "inditex":
    case "stories":
      return { ok: true, selector: {}, watching: "every size on the page" };

    case "asos": {
      const productId = (u.pathname.match(/\/prd\/(\d+)/) || [])[1];
      if (!productId) return { ok: false, reason: "that ASOS link has no /prd/<id> in it — open the product page and copy the URL from the address bar" };
      return { ok: true, selector: { productId }, watching: "every size" };
    }

    case "uniqlo": {
      const productCode = (u.pathname.match(/\/products\/([A-Za-z]?\d+-\d+)/) || [])[1];
      if (!productCode) return { ok: false, reason: "that Uniqlo link has no product code (expected .../products/E485737-000/...)" };
      const colorDisplayCode = q.get("colorDisplayCode") ?? undefined;
      const sizeDisplayCode = q.get("sizeDisplayCode") ?? undefined;
      const selector = { productCode, ...(colorDisplayCode && { colorDisplayCode }), ...(sizeDisplayCode && { sizeDisplayCode }) };
      // Uniqlo only puts colour/size in the URL once you pick them on the page.
      const watching = colorDisplayCode && sizeDisplayCode
        ? `colour ${colorDisplayCode} / size ${sizeDisplayCode} (Uniqlo's own codes)`
        : "every colour and size — pick your size on the site and re-send the link to narrow it";
      return { ok: true, selector, watching };
    }

    case "mango": {
      // .../p/{gender}/{cat}/{slug}/{productId}/{colour}/{...}
      const m = u.pathname.match(/\/(\d{6,})\/(\d{2,3})(?:\/|$)/);
      if (!m) return { ok: false, reason: "that Mango link is missing the product/colour ids (expected .../{productId}/{colour}/...)" };
      return {
        ok: true,
        selector: { productId: m[1], color: m[2], sizeLabels: MANGO_SIZE_LABELS },
        watching: "every size in that colour",
      };
    }

    case "cos": {
      const code = (u.pathname.match(/-(\d{8,})\/?$/) || [])[1];
      if (!code) return { ok: false, reason: "that COS link has no product code at the end (expected ...-1326785001)" };
      const locale = (u.pathname.match(/\/([a-z]{2}-[a-z]{2})\//i) || [])[1]?.toLowerCase() ?? "en-sg";
      return {
        ok: true,
        selector: { code, locale, storeId: "250", merchantId: "100000072" },
        watching: "every size in that colour",
      };
    }

    case "bershka": {
      const productId = (u.pathname.match(/c\d+p(\d+)\.html/) || [])[1];
      if (!productId) return { ok: false, reason: "that Bershka link has no product id (expected ...c0p235801198.html)" };
      const ids = ITX_MARKETS.bershka[market];
      if (!ids) return { ok: false, reason: `I've only got Bershka's Singapore store mapped so far${market ? ` (yours is /${market}/)` : ""} — noted as a request` };
      return { ok: true, selector: { ...ids, productId }, watching: "every size" };
    }

    case "stradivarius": {
      // The id in the URL (l04522175) is NOT the API's productId (526627527);
      // it only appears on the page as pelement=. Needs resolveFromPage().
      const ids = ITX_MARKETS.stradivarius[market];
      if (!ids) return { ok: false, reason: `I've only got Stradivarius's international store mapped so far${market ? ` (yours is /${market}/)` : ""} — noted as a request` };
      return { ok: true, selector: { ...ids }, needsPage: "productId", watching: "every size" };
    }

    default:
      return { ok: true, selector: {}, watching: "price and availability" };
  }
}

/**
 * The one id no URL carries: Stradivarius's API productId, which only appears in
 * the page as pelement=. Best-effort — a miss is reported, never guessed.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function resolveFromPage(url, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(url, { headers: { accept: "text/html", "user-agent": UA } });
    if (!r.ok) return { ok: false, reason: `couldn't open the product page (HTTP ${r.status})` };
    const html = await r.text();
    const productId =
      (html.match(/pelement=(\d+)/) || [])[1] ??
      (html.match(/"productId"\s*:\s*"?(\d{6,})"?/) || [])[1];
    if (!productId) return { ok: false, reason: "couldn't find the product id on that page" };
    return { ok: true, patch: { productId } };
  } catch (e) {
    return { ok: false, reason: `couldn't open the product page (${String(e?.message ?? e)})` };
  }
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Best-effort product title from the page (og:title / <title>). One fetch at
 * /add time only — never on the check path. Falls back to the URL slug.
 */
export async function fetchTitle(url, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(url, { headers: { accept: "text/html", "user-agent": UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const og = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1];
    const title = og ?? (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
    if (!title) return null;
    // Strip the "| BRAND" tail sites append.
    return title.trim().split(/\s*[|–]\s*/)[0].slice(0, 120) || null;
  } catch {
    return null;
  }
}
