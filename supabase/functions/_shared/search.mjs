// Finding a product from a DESCRIPTION rather than a URL.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a candidate URL may come from anywhere
// — a shop's own search, a web search, eventually a model — but NOTHING is ever
// reported to the user until OUR adapter has read it. Prices and stock come
// from the adapters, exactly as they do for a pasted link. A search source
// suggests where to look; it never says what's true.
//
// That keeps every honesty guarantee already built: the fetch gates, the
// "unknown is never in stock" rule, the refusals. A hallucinated or dead URL
// simply fails verification and is dropped before anyone sees it.
//
// Sources are pluggable because they differ in cost and reach:
//   storeSearch  — free. A shop's own search endpoint. Needs to know WHICH shop,
//                  which is the whole limitation: 5M Shopify stores, and a
//                  description rarely names the domain.
//   (later) web  — a model with web search. Handles "who even stocks this?",
//                  which the free path structurally cannot answer.

import { detectAdapter } from "./router.mjs";
import { selectAdapter } from "./adapters/index.mjs";
import { normalizeUrl, assertSafeUrl } from "./urlguard.mjs";
import { isBuyable } from "./stock.mjs";

/** Present at most this many. More is a menu, not an answer. */
export const MAX_CANDIDATES = 3;

/** Shops whose search we can query for free, by platform. */
const SHOPIFY_SUGGEST = (origin, q) =>
  `${origin}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=6`;
const WOO_SEARCH = (origin, q) =>
  `${origin}/wp-json/wc/store/v1/products?search=${encodeURIComponent(q)}&per_page=6`;

/**
 * Longest words first — the most distinctive term makes the best single-word
 * fallback for a search engine that won't take a phrase.
 */
export function longestWordsOf(query, max = 2) {
  return String(query).split(/\s+/).filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length).slice(0, max);
}

/**
 * Ask ONE shop's own search engine. Their relevance ranking does the fuzzy
 * matching — we are federating a search engine, not writing one, which is why
 * word order and partial names work without any language model.
 *
 * @returns {Promise<{url:string, hint:string}[]>}
 */
export async function searchStore(origin, query, { fetchImpl = fetch } = {}) {
  const get = async (u) => {
    try {
      const r = await fetchImpl(u, { headers: { accept: "application/json" } });
      return r.ok ? await r.text() : null;
    } catch { return null; }
  };

  // Shopify
  const sug = await get(SHOPIFY_SUGGEST(origin, query));
  if (sug) {
    try {
      const products = JSON.parse(sug)?.resources?.results?.products ?? [];
      if (products.length) {
        return products.map((p) => ({
          url: p.url ? new URL(p.url, origin).toString() : `${origin}/products/${p.handle}`,
          hint: String(p.title ?? ""),
        }));
      }
    } catch { /* not shopify-shaped */ }
  }

  // WooCommerce. Its search is STRICT where Shopify's suggest is fuzzy:
  // "scarlett dress" returns nothing on a store where "scarlett" returns
  // "Scarlett White Dress" and "dress" returns it too. So fall back from the
  // phrase to its most distinctive single word rather than concluding the shop
  // doesn't stock it.
  const terms = [query, ...longestWordsOf(query)];
  for (const term of terms) {
    const woo = await get(WOO_SEARCH(origin, term));
    if (!woo) continue;
    try {
      const list = JSON.parse(woo);
      if (Array.isArray(list) && list.length) {
        return list.filter((p) => p?.permalink).map((p) => ({
          url: p.permalink,
          hint: String(p.name ?? ""),
        }));
      }
    } catch { /* not woo-shaped — stop guessing */ break; }
  }
  return [];
}

/**
 * Guess a brand's own shop from the words in the query, then see whether it is a
 * platform we can search. Deliberately cheap and deliberately fallible — it is
 * one source among several, and everything it returns is verified downstream.
 *
 * Measured limitation: it finds DTC brands on Shopify/Woo, and misses brands on
 * platforms we don't support (Our Legacy runs on Centra, so this returns
 * nothing for it — the honest outcome, rather than a wrong guess).
 */
export function domainGuesses(query) {
  return guessesWithRemainder(query).flatMap((g) => g.origins);
}

/**
 * Domain guesses paired with WHAT'S LEFT of the query after the brand words are
 * removed. Passing the whole phrase to the shop's own search is a mistake: the
 * brand name is in the domain, not the product titles, so "goshopia scarlett
 * dress" matched nothing on goshopia.com while "scarlett dress" matches exactly.
 */
export function guessesWithRemainder(query) {
  const words = String(query).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  const seen = new Set();
  // Longest brand-ish prefix first: "our legacy camion boots" → ourlegacycamion,
  // ourlegacy, our — the middle one is usually the brand.
  for (const n of [3, 2, 1]) {
    if (words.length < n) continue;
    const name = words.slice(0, n).join("");
    if (name.length < 3 || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      // Keep the whole phrase as a fallback when stripping leaves nothing.
      remainder: words.slice(n).join(" ") || words.join(" "),
      origins: [`https://www.${name}.com`, `https://${name}.com`, `https://${name}.co`],
    });
  }
  return out;
}

/**
 * Read every candidate through the REAL adapter and keep the ones that are
 * genuinely readable. This is the step that makes the feature safe: a URL that
 * doesn't resolve, isn't a product, or can't be parsed never reaches the user.
 *
 * @returns {Promise<{url:string, reading:object, adapter:string}[]>}
 */
export async function verifyCandidates(candidates, ctx = {}) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (out.length >= (ctx.max ?? MAX_CANDIDATES) * 2) break; // verify a few spare
    let url;
    try { url = normalizeUrl(c.url); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);

    // A candidate URL is untrusted input like any other — same SSRF guard as /add.
    const guard = assertSafeUrl(url);
    if (!guard.ok) continue;

    const det = await detectAdapter(url, ctx).catch(() => ({ adapter: null }));
    if (!det?.adapter) continue;

    const read = selectAdapter(det.adapter);
    if (!read) continue;
    const reading = await read({ url, label: c.hint ?? "" }, ctx).catch(() => null);
    if (!reading?.ok) continue;

    out.push({ url, adapter: det.adapter, reading, hint: c.hint ?? "" });
  }
  return out;
}

/**
 * Rank what survived verification.
 *
 * Deliberately NOT by price. Comparing GBP 290, USD 495 and SGD 690 needs an FX
 * rate and a view on duties and shipping, and this project has already been
 * caught out three times by a store's own currency claims. Availability is
 * unambiguous and needs no conversion, so it decides — and the user sees every
 * price in its native currency and picks.
 */
export function rankCandidates(verified, { size } = {}) {
  const score = (v) => {
    const r = v.reading;
    const variants = r.variants ?? [];
    const wanted = size
      ? variants.find((x) => String(x.label).toLowerCase() === String(size).toLowerCase())
      : null;
    return [
      wanted ? (wanted.available ? 2 : 0) : (r.available ? 1 : 0), // your size, else anything
      variants.some((x) => isBuyable(x.state)) ? 1 : 0,
      -(variants.length ? 0 : 1), // a reading with real per-size data beats one without
    ];
  };
  return [...verified].sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sb[i] !== sa[i]) return sb[i] - sa[i];
    return 0;
  });
}

/**
 * The whole pipeline: description in, verified and ranked candidates out.
 * `sources` is injectable so a web/LLM source can be added without touching
 * anything here — and so the tests never hit the network.
 */
export async function findProduct(query, ctx = {}) {
  const sources = ctx.sources ?? [storeSearchSource];
  const found = [];
  for (const src of sources) {
    try { found.push(...await src(query, ctx)); } catch { /* a dead source is not fatal */ }
    if (found.length >= MAX_CANDIDATES * 2) break;
  }
  const verified = await verifyCandidates(found, ctx);
  return rankCandidates(verified, ctx).slice(0, ctx.max ?? MAX_CANDIDATES);
}

/** The free source: guess the brand's shop, ask its own search engine — with the
 *  brand words STRIPPED, since they name the domain, not the product. */
export async function storeSearchSource(query, ctx = {}) {
  for (const guess of guessesWithRemainder(query)) {
    for (const origin of guess.origins) {
      const hits = await searchStore(origin, guess.remainder, ctx);
      if (hits.length) return hits; // first shop that answers wins
    }
  }
  return [];
}
