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
//   aiSearch     — the user's own model key, with web search. Answers "who even
//                  stocks this?", which the free path structurally cannot. Costs
//                  the user a few cents a query, so it runs SECOND — only when
//                  the free path came back empty.

import { detectAdapter } from "./router.mjs";
import { selectAdapter } from "./adapters/index.mjs";
import { normalizeUrl, assertSafeUrl } from "./urlguard.mjs";
import { isBuyable } from "./stock.mjs";
import { aiSearch } from "./ai.mjs";
import { searchableStores, isFree } from "./stores.mjs";
import { localeFromUrl } from "./locale.mjs";
import { resolveSelector, resolveFromPage } from "./resolve.mjs";

/** Present at most this many. More is a menu, not an answer. */
export const MAX_CANDIDATES = 3;

/** Per-request cap for a guessed shop, and a budget for guessing as a whole.
 *  Most guessed domains don't exist, and the free path is the thing standing
 *  between the user and the paid one — it has to fail FAST, not thoroughly. */
const SHOP_TIMEOUT_MS = 5_000;
const GUESS_BUDGET_MS = 12_000;
/** How long a confident answer waits on a MORE confident guess still in flight. */
const GUESS_GRACE_MS = 2_000;
/** Enough for "…from Brand" + opening + closing words; beyond it is noise. */
const MAX_GUESSES = 9;
/** A title matching this share of the best title's words counts as equally relevant. */
const RELEVANCE_TIER = 0.75;

/**
 * How many BOT-PROTECTED pages one search may read.
 *
 * Free stores are unlimited — they cost nothing and answer in a second. Defended
 * ones spend the user's own unblocker credits (1–10 each), and a search that
 * quietly burned thirty credits looking for something it didn't find would be a
 * nasty surprise. Three is enough to compare the retailers that matter for a
 * given item without the search becoming the expensive part of using the bot.
 */
const MAX_DEFENDED_READS = 3;

/**
 * ...and how many FREE pages. Free of credits is not free of work: every read
 * parses a full product page, and doing ten at once in an Edge Function with a
 * CPU budget is a lot of parsing to produce a list of three. Six leaves spares
 * for candidates that turn out not to verify.
 */
const MAX_FREE_READS = 6;

/** Shops whose search we can query for free, by platform. */
/** searchStore's marker for "the host gave no HTTP answer at all". */
const UNREACHABLE = Symbol("unreachable");

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
export async function searchStore(origin, query, { fetchImpl = fetch, timeoutMs = SHOP_TIMEOUT_MS } = {}) {
  const get = async (u) => {
    // A guessed domain usually doesn't exist, and an unanswered TCP connect can
    // hang far longer than the whole search is worth. Measured: without this, a
    // miss on "Our Legacy Camion boots" spent 26 seconds failing.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(u, { headers: { accept: "application/json" }, signal: ctrl.signal });
      return r.ok ? await r.text() : null;
    } catch { return UNREACHABLE; } finally { clearTimeout(timer); }
  };

  // Shopify
  const sug = await get(SHOPIFY_SUGGEST(origin, query));
  // A host that gave no answer at all — no DNS, refused, or a connect that hangs
  // until our timeout — won't answer the next three questions either. A 404 is
  // an ANSWER, and still falls through to WooCommerce below. Measured:
  // bmagazine.com hangs on connect, and asking it Shopify's route and then three
  // WooCommerce terms turned one 5-second timeout into twenty.
  if (sug === UNREACHABLE) return [];
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
    if (woo === UNREACHABLE) break;
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
 * Words that stitch a sentence together. "from", "by" and "at" do more than
 * stitch: whatever follows them names who MAKES the thing ("Saria silk midi from
 * Nol Collective"), which is the strongest brand signal a sentence gives.
 */
const MAKER_MARKERS = new Set(["from", "by", "at"]);
const STOPWORDS = new Set(["in", "on", "of", "for", "with", "and", "to", "a", "an", "the"]);

/**
 * The words of a query that could name a brand or a product.
 *
 * A SIZE is stripped. "size S" chooses a variant once the item is tracked — it
 * never chooses the product — and left in, a lone "s" becomes a domain guess.
 *
 * A COLOUR is kept, deliberately. Nol Collective lists "Saria midi skirt (natural
 * linen)" and "(scarlet linen)" as separate products, and its search puts the
 * scarlet one first for "saria midi scarlet" and the natural one first for
 * "saria midi natural". Dropping the colour would hand back the wrong product.
 */
export function queryWords(query) {
  return String(query).toLowerCase()
    .replace(/\b(?:size|sz)(?:\s*[:=]\s*|\s+)[a-z0-9./-]+\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/).filter(Boolean);
}

/**
 * Domain guesses paired with WHAT'S LEFT of the query once the brand words are
 * removed. Passing the whole phrase to the shop's own search is a mistake: the
 * brand name is in the domain, not the product titles, so "goshopia scarlett
 * dress" matched nothing on goshopia.com while "scarlett dress" matches exactly.
 *
 * WHERE THE BRAND SITS IN THE SENTENCE MUST NOT MATTER. This used to try only the
 * opening words, so "Nol Collective Saria silk midi" found the skirt while "Saria
 * silk midi from Nol Collective, size S" — the same words, brand last — guessed
 * sariasilkmidi.com, sariasilk.com and saria.com, spent 10.9 seconds on them, and
 * never asked nolcollective.com at all. The shop's own search was never the
 * problem: it returns the Saria skirts for every one of those phrasings.
 *
 * So guesses come from three places, most confident first:
 *   maker   whatever follows "from" / "by" / "at"
 *   prefix  the opening words — how most people start, and exactly the old order
 *   suffix  the closing words — "Saria silk midi Nol Collective", brand last
 * The order is a RANKING, not a schedule: storeSearchSource asks them all at once
 * and prefers the most confident guess that answers.
 */
export function guessesWithRemainder(query) {
  const words = queryWords(query);
  const out = [];
  const seen = new Set();

  const add = (start, n, basis) => {
    if (start < 0 || start + n > words.length) return;
    const slice = words.slice(start, start + n);
    // A clause boundary inside a name means two things glued together.
    if (slice.some((w) => MAKER_MARKERS.has(w))) return;
    // "…bag in" is never a brand. A LEADING small word can be — The Row, On
    // Running — so it is allowed where people start a name, and always for "the".
    if (STOPWORDS.has(slice[slice.length - 1])) return;
    if (STOPWORDS.has(slice[0]) && basis !== "prefix" && slice[0] !== "the") return;
    const name = slice.join("");
    if (name.length < 3 || seen.has(name)) return;
    seen.add(name);
    const rest = words.filter((w, i) => (i < start || i >= start + n) && !MAKER_MARKERS.has(w));
    out.push({
      name,
      basis,
      // Keep the whole phrase as a fallback when stripping leaves nothing.
      remainder: rest.join(" ") || slice.join(" "),
      origins: [`https://www.${name}.com`, `https://${name}.com`, `https://${name}.co`],
    });
  };

  words.forEach((w, i) => { if (MAKER_MARKERS.has(w)) for (const n of [3, 2, 1]) add(i + 1, n, "maker"); });
  for (const n of [3, 2, 1]) add(0, n, "prefix");
  for (const n of [3, 2, 1]) add(words.length - n, n, "suffix");
  return out.slice(0, MAX_GUESSES);
}

/**
 * The same product page on the shopper's own country site.
 *
 * Retailers split into two kinds, and the split is the whole problem. END,
 * Farfetch, SSENSE ship worldwide from ONE site — their URL is already right.
 * Castlery, Uniqlo, IKEA, Zara run a SEPARATE site per country, where the US page
 * is a different price, different stock, and often not shippable to you at all.
 * A search that answers with the US page has technically found the product and
 * practically found nothing.
 *
 * So: when a URL names a country and it isn't yours, propose the same path under
 * yours as an EXTRA candidate. This is a guess — and it's allowed to be, because
 * it goes through exactly the same verification as everything else. If the SG page
 * doesn't exist, it fails to read and is dropped; the US one is still there.
 * Nobody is shown a page we didn't fetch.
 *
 * @returns {{url:string, hint:string}[]} zero or one twin
 */
export function localeTwins(url, country) {
  if (!country) return [];
  const want = String(country).toLowerCase();
  const found = localeFromUrl(url).country?.toLowerCase();
  if (!found || found === want) return [];

  let u;
  try { u = new URL(url); } catch { return []; }

  // The two shapes localeFromUrl recognises, rewritten in place:
  //   /us/...     → /sg/...     (END, Castlery, Uniqlo)
  //   /en-us/...  → /en-sg/...  (SSENSE, MR PORTER, NET-A-PORTER — language is
  //                              kept, only the country changes)
  const swapped = u.pathname
    .replace(new RegExp(`^/([a-z]{2})-${found}(?=/|$)`, "i"), `/$1-${want}`)
    .replace(new RegExp(`^/${found}(?=/|$)`, "i"), `/${want}`);
  if (swapped === u.pathname) return [];
  u.pathname = swapped;
  return [{ url: u.toString(), hint: "" }];
}

/**
 * Read every candidate through the REAL adapter and keep the ones that are
 * genuinely readable. This is the step that makes the feature safe: a URL that
 * doesn't resolve, isn't a product, or can't be parsed never reaches the user.
 *
 * @returns {Promise<{url:string, reading:object, adapter:string}[]>}
 */
export async function verifyCandidates(candidates, ctx = {}, acc = null) {
  // `acc` lets a caller verify in waves without re-reading a page it already
  // read — findProduct uses it to check the free source's hits BEFORE deciding
  // whether the paid one is worth running.
  const { seen, out } = acc ?? { seen: new Set(), out: [] };

  // Try the shopper's own country site as well as anything naming a different
  // one. The twin goes first so that if we ever cap the list, the local page is
  // the one that survives.
  const withTwins = ctx.country
    ? candidates.flatMap((c) => [...localeTwins(c.url, ctx.country).map((t) => ({ ...t, hint: c.hint })), c])
    : candidates;

  // ── 1. cheap, synchronous filtering ──────────────────────────────────────
  const prepared = [];
  for (const c of withTwins) {
    let url;
    try { url = normalizeUrl(c.url); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    // A candidate URL is untrusted input like any other — same SSRF guard as /add.
    if (!assertSafeUrl(url).ok) continue;
    prepared.push({ url, hint: c.hint ?? "" });
  }
  if (!prepared.length) return out;

  // ── 2. which adapter reads each, in parallel ─────────────────────────────
  // Free for a known host (a regex); a probe or two for the long tail.
  const detected = (await Promise.all(prepared.map(async (p) => {
    const det = await detectAdapter(p.url, ctx).catch(() => null);
    return det?.adapter && selectAdapter(det.adapter) ? { ...p, adapter: det.adapter } : null;
  }))).filter(Boolean);

  // ── 3. read them — free ones all, paid ones capped ───────────────────────
  // Measured 2026-08-05: reading six defended pages one after another took 5–8
  // MINUTES per search, of which the model was 25s. They're independent reads,
  // so they go together. The cap is the other half: parallel removes the
  // latency reason to stop early, but each defended read still spends the
  // user's credits, so the number of them is bounded explicitly rather than
  // falling out of whatever order the sources happened to return.
  // Free reads cost no credits, but they are not free of CPU and memory: each
  // one parses a full product page, and an Edge Function that does ten at once
  // is doing far more work than a result list of three can justify. Cap them
  // too — generously, since spares cover candidates that fail to verify.
  const free = detected.filter((d) => isFree(d.adapter))
    .slice(0, ctx.maxFreeReads ?? MAX_FREE_READS);
  const paid = detected.filter((d) => !isFree(d.adapter))
    .slice(0, ctx.maxDefendedReads ?? MAX_DEFENDED_READS);

  const readings = await Promise.all([...free, ...paid].map(async (d) => {
    // ONE CANDIDATE MUST NEVER BE ABLE TO FAIL THE WHOLE SEARCH.
    //
    // Promise.all rejects the moment any entry does, so an unguarded throw
    // anywhere in here took down every other candidate with it — and since a
    // model returns different URLs every run, that presented as a search failing
    // at random. Live: "Jacquemus Bastide jacket" worked, "Jacquemus Bastide
    // jacket black" a minute later did not. resolveSelector was the unguarded
    // step; the catch is deliberately around ALL of it rather than that one
    // call, because the next unguarded step shouldn't get to repeat this.
    try {
      // Resolve the ids the adapter needs FROM THE URL, exactly as /add does.
      // Skipping this was a silent, whole-category failure: Uniqlo wants a
      // productCode, the Inditex brands want store/catalog/product ids, and
      // without them their readers refuse with "missing variantSelector".
      const item = await resolveItem(d, ctx);
      if (!item) return null;

      const reading = await selectAdapter(d.adapter)(item, ctx);
      if (!reading?.ok) return null;

      // A PRICE TRACKER RESULT WITHOUT A PRICE IS NOT A RESULT.
      // Live: a hallucinated URL — cetaphil.com/sg/vitamin-c-serum/987654321.html,
      // an invented id — resolved to *a* readable page and came back with
      // price: undefined. It would have been offered as "undefined USD". The
      // adapters are right to report a page they could partly read; search is
      // the layer that must decide such a reading is not worth showing.
      if (reading.price == null || !Number.isFinite(Number(reading.price))) return null;
      return {
        url: d.url, adapter: d.adapter, reading, hint: d.hint,
        free: isFree(d.adapter),
        // What country's site this is, when the URL says. Drives both ranking
        // and the warning on the result line — a price we can't act on should
        // never look like a price we can.
        country: localeFromUrl(d.url).country,
      };
    } catch (e) {
      console.warn(`search: dropped ${d.url} (${d.adapter}): ${e?.message ?? e}`);
      return null;
    }
  }));

  out.push(...readings.filter(Boolean));
  return out;
}

/**
 * Turn a candidate URL into the Item an adapter actually expects — the same
 * two-step /add performs: read what the URL alone can tell us, and fetch the
 * page for the rest when the adapter says it needs to.
 *
 * Returns null when the ids can't be resolved, which is a real "can't track
 * this" and not a reading we should invent around.
 */
async function resolveItem(d, ctx) {
  const res = resolveSelector(d.url, d.adapter);
  if (!res?.ok) return null;

  let selector = res.selector;
  if (res.needsPage) {
    const page = await resolveFromPage(d.url).catch(() => null);
    if (!page?.ok) return null;
    selector = { ...selector, ...page.patch };
  }
  return {
    url: d.url,
    label: d.hint,
    variantSelector: selector,
    // A variant named in the URL is a deliberate choice by whoever wrote it.
    ...(res.variantId != null && { variantId: res.variantId }),
  };
}

/**
 * Rank what survived verification.
 *
 * Deliberately NOT by price. Comparing GBP 290, USD 495 and SGD 690 needs an FX
 * rate and a view on duties and shipping, and this project has already been
 * caught out three times by a store's own currency claims. Availability is
 * unambiguous and needs no conversion, so it decides — and the user sees every
 * price in its native currency and picks.
 *
 * The ONE thing that outranks availability is whether the page is even for the
 * shopper's country: an in-stock bed on castlery.com/us is worth less to someone
 * in Singapore than an out-of-stock one on castlery.com/sg, because only one of
 * them is a thing they can buy. A page that names no country isn't penalised —
 * that's every international retailer, and their single site is the right one.
 *
 * PRICE does decide, but only between candidates that are otherwise equal AND
 * quoted in the SAME currency. That's the honest half of "show me the cheapest":
 * SGD 839 vs SGD 650 is a real comparison a shopper can act on; SGD 650 vs GBP
 * 455 is not — it needs an FX rate, and a view on duties and shipping that we
 * don't have. So same-currency candidates sort by price, and the rest keep their
 * order and let the shopper compare the native prices we print for them.
 *
 * AND BEFORE AVAILABILITY: is this even the thing they asked for? Availability
 * first was designed for one product at several shops — keep the copy you can
 * buy. It was never meant to choose between DIFFERENT products, and one shop's
 * search returns exactly that. Live: Mutimer's own search put "Funnel Neck
 * Blouson" first for "Mutimer Funnel Neck Blouson in Size XS"; it was sold out,
 * so an in-stock Flight Jacket and Mad. Avenue Coat outranked it and the blouson
 * was cut from a list of three. Nol Collective's Talia silk top led ahead of the
 * two Saria skirts someone had named.
 *
 * Relevance is a TIER, not a count, so it can't undo what availability is for.
 * The same bag reads "LEMAIRE Small Croissant Bag In Leather" on Farfetch and
 * "Small Croissant Bag" on lemaire.fr — one word apart only because one repeats
 * the brand. Anything within RELEVANCE_TIER of the best match is equally
 * relevant, stock decides inside that, and the raw count breaks what's left
 * ("…in scarlet" puts the scarlet skirt ahead of the natural one).
 */
export function rankCandidates(verified, { size, country, query } = {}) {
  const want = country ? String(country).toUpperCase() : null;

  const productWords = query
    ? queryWords(query).filter((w) => !MAKER_MARKERS.has(w) && !STOPWORDS.has(w))
    : [];
  const matched = new Map();
  for (const v of verified) {
    const title = new Set(queryWords(v.reading?.title || v.hint || ""));
    matched.set(v, productWords.filter((w) => title.has(w)).length);
  }
  const bestMatch = Math.max(0, ...matched.values());
  // No query, or nothing matched anything: every candidate is equally relevant,
  // which leaves the ranking exactly as it always was.
  const relevant = (v) => (bestMatch === 0 || matched.get(v) / bestMatch >= RELEVANCE_TIER ? 1 : 0);

  // Only currencies that appear more than once are comparable — a lone GBP
  // result has nothing to be cheaper than.
  const counts = new Map();
  for (const v of verified) {
    const c = v.reading?.currency;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }

  const score = (v) => {
    const r = v.reading;
    const variants = r.variants ?? [];
    const wanted = size
      ? variants.find((x) => String(x.label).toLowerCase() === String(size).toLowerCase())
      : null;
    return [
      want && v.country && v.country !== want ? 0 : 1,           // buyable where you are
      relevant(v),                                                // the thing you named
      wanted ? (wanted.available ? 2 : 0) : (r.available ? 1 : 0), // your size, else anything
      variants.some((x) => isBuyable(x.state)) ? 1 : 0,
      -(variants.length ? 0 : 1), // a reading with real per-size data beats one without
      matched.get(v) ?? 0,        // closer to your words, among the equally relevant
      // Cheapest first among like-for-like. Negated because the comparator sorts
      // descending, and left out entirely when there's nothing to compare with.
      r.price != null && counts.get(r.currency) > 1 ? -Number(r.price) : 0,
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
/**
 * The cache key. Case, punctuation and word order are all noise: someone
 * retyping after a typo shouldn't pay twice because they capitalised
 * differently. Sorting the words means "camion boots our legacy" and "our legacy
 * camion boots" are one query, which they plainly are.
 */
export function cacheKeyFor(query) {
  // So are "Saria silk midi from Nol Collective, size S" and "Nol Collective
  // Saria silk midi": the cache remembers WHERE something was found, and neither
  // "from" nor a size changes where that is. A colour does, so it stays — see
  // queryWords.
  return queryWords(query).filter((w) => !MAKER_MARKERS.has(w)).sort().join(" ");
}

export async function findProduct(query, ctx = {}) {
  const sources = ctx.sources ?? sourcesFor(ctx);
  const want = ctx.max ?? MAX_CANDIDATES;
  const acc = { seen: new Set(), out: [] };
  const notes = [];

  // A remembered search skips the FINDING, never the reading. Every URL below
  // still goes through the adapters — see the migration for why storing a price
  // here would be the one unacceptable shortcut.
  const cached = ctx.cache ? await ctx.cache.get(cacheKeyFor(query), ctx.country).catch(() => null) : null;
  if (cached?.length) {
    await verifyCandidates(cached, ctx, acc);
    if (acc.out.length) {
      const hit = dedupeByProduct(rankCandidates(acc.out, { ...ctx, query })).slice(0, want);
      hit.notes = [];
      hit.cached = true;
      return hit;
    }
    // Everything we remembered has since gone. Fall through and search properly.
  }

  // Verify after EACH source, not once at the end. The stopping condition that
  // matters is "do we have enough readable results yet" — not "did a source
  // return something", because a source can hand back a URL that turns out to be
  // dead. Checking as we go means the free path stops the paid one only when it
  // genuinely delivered, and a free hit that fails verification still falls
  // through to the model the user is paying for.
  for (const src of sources) {
    let hits = [];
    try {
      hits = await src(query, ctx);
      if (hits.note) notes.push(hits.note);
      await verifyCandidates(hits, ctx, acc);
    } catch { /* a dead source is not fatal */ }
    // One line per source. An empty search used to leave no trace at all, so
    // "the model said NONE", "the model pointed at shops we can't read" and "the
    // model never ran" looked identical afterwards — and the only way to tell
    // them apart was to spend the user's key again.
    if (ctx.logSearch) {
      const hosts = [...new Set((hits ?? []).map((h) => {
        try { return new URL(h.url).hostname; } catch { return "?"; }
      }))].slice(0, 5);
      console.log(`search source ${src.name || "custom"}: ${hits?.length ?? 0} candidate(s)`
        + (hosts.length ? ` [${hosts.join(", ")}]` : "")
        + `, ${acc.out.length} verified so far`
        + (hits?.note ? `; note: ${hits.note}` : ""));
    }
    if (acc.out.length >= want) break;
  }

  const ranked = dedupeByProduct(rankCandidates(acc.out, { ...ctx, query })).slice(0, want);
  ranked.notes = notes;

  // Remember what we FOUND, not what we read — and only when we found something.
  // Caching an empty result would turn one bad day at a retailer into a week of
  // "I couldn't find it" for everybody.
  if (ctx.cache && ranked.length) {
    // try/catch, NOT `.catch()` on the returned value.
    //
    // This line took down every successful search for weeks. The webhook's
    // put() handed back a supabase-js PostgREST builder, which is a THENABLE —
    // it has .then(), so `await` works fine — but it has no .catch(). Calling
    // .catch() on it threw a TypeError synchronously, before the await, so the
    // "a cache that won't write is not a failed search" intent was defeated by
    // the very expression meant to express it.
    //
    // The `ranked.length` guard above made it perverse: a search that found
    // NOTHING skipped this block and reported honestly, while a search that
    // found something died on its last line. The feature failed if and only if
    // it worked, which is why it read as random.
    //
    // Every test stubbed `put: async () => {}` — a real Promise — so the suite
    // was green throughout. Don't assume a collaborator's promise-shaped return
    // is a Promise; await it inside a try.
    try {
      await ctx.cache.put(
        cacheKeyFor(query),
        ctx.country,
        ranked.map((c) => ({ url: c.url, hint: c.hint ?? "" })),
      );
    } catch (e) {
      // Say so. Silence is what let this run for weeks: the only symptom was a
      // cache that stayed empty, and nobody reads an empty table.
      console.warn("search cache write failed (results still delivered):", e);
    }
  }
  return ranked;
}

/**
 * One product per retailer, not one per country site.
 *
 * Live: "Our Legacy Camion boots" came back as endclothing.com/sg AND
 * endclothing.com/us — the same boot, the same shop, offered twice, with one of
 * them marked as the wrong country. Two of three slots spent on one product.
 *
 * The identity is host + path-with-the-country-segment-removed, so /sg/x and
 * /us/x collapse. Ranking has already put the shopper's own country first, so
 * keeping the first occurrence keeps the right one.
 */
export function dedupeByProduct(ranked) {
  const seen = new Set();
  const out = [];
  for (const c of ranked) {
    let key = c.url;
    try {
      const u = new URL(c.url);
      const country = (c.country ?? localeFromUrl(c.url).country ?? "").toLowerCase();
      const path = country
        ? u.pathname.replace(new RegExp(`^/${country}(?=/|$)`, "i"), "")
        : u.pathname;
      key = `${u.hostname.replace(/^www\./, "")}${path.replace(/\/+$/, "")}`.toLowerCase();
    } catch { /* unparseable: fall back to the whole string */ }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Cheapest source first, always. The free one costs a couple of HTTP requests;
 * the model costs the user real money, so it only runs when the free path found
 * nothing — which is exactly the case it exists for.
 */
export function sourcesFor(ctx = {}) {
  return ctx.ai?.apiKey ? [storeSearchSource, aiSearchSource] : [storeSearchSource];
}

/**
 * Does a shop's own name say it IS the brand we guessed?
 *
 * A guess from the closing words is the least confident kind — "…in black"
 * guesses black.com, "…vitamin c serum" guesses serum.com — and "first shop that
 * answers wins" would hand a stranger's catalogue to someone who asked for Nol
 * Collective. Checked against real shops: Shopify's /meta.json names them exactly
 * ("Nol Collective", "Mutimer", "Simuero", "Dr. Martens™ SG Official Site"), and
 * WooCommerce's /wp-json does the same ("Goshopia").
 *
 * A short guess must match the whole name: "black" is not vouched for by a shop
 * called "Black Tee Co", while "drmartens" is by "Dr. Martens™ SG Official Site".
 */
export async function shopNameOf(origin, { fetchImpl = fetch, timeoutMs = SHOP_TIMEOUT_MS } = {}) {
  for (const path of ["/meta.json", "/wp-json"]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${origin}${path}`, { headers: { accept: "application/json" }, signal: ctrl.signal });
      if (!r.ok) continue;
      const name = JSON.parse(await r.text())?.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch { /* not this platform */ } finally { clearTimeout(timer); }
  }
  return undefined;
}

export async function shopIsBrand(origin, guessName, ctx = {}) {
  const shop = String((await shopNameOf(origin, ctx)) ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!shop) return false;
  return shop === guessName || (guessName.length >= 6 && shop.startsWith(guessName));
}

/** One guessed origin: its shop search, plus the brand check for weak guesses. */
async function askGuess(job, ctx) {
  const hits = await searchStore(job.origin, job.guess.remainder, ctx);
  if (!hits.length || job.guess.basis !== "suffix") return hits;
  return (await shopIsBrand(job.origin, job.guess.name, ctx)) ? hits : [];
}

/**
 * The free source: guess the brand's shop, ask its own search engine — with the
 * brand words STRIPPED, since they name the domain, not the product.
 *
 * Every guess is asked AT ONCE, and the most confident one that answers wins.
 * One at a time, a brand at the end of the sentence was reached only after the
 * opening-word guesses had failed: "Saria silk midi Nol Collective" took 12.3
 * seconds against a 12-second budget. All at once and simply awaited, the slowest
 * dead domain decides instead — 6.1 seconds for a query the sequential version
 * answered in 375 ms. So everything starts together, and the search finishes the
 * moment nothing MORE confident than the best answer is still running. A more
 * confident guess still in flight gets a grace period, not a veto: a hanging
 * domain must not hold a real answer hostage. Measured in that shape, the two
 * cases above took well under a second and 2.2 seconds.
 */
export async function storeSearchSource(query, ctx = {}) {
  const jobs = guessesWithRemainder(query).flatMap((guess, gi) =>
    guess.origins.map((origin, oi) => ({ guess, origin, rank: gi * 10 + oi, done: false, hits: [] })));
  if (!jobs.length) return [];

  const best = () => jobs.reduce((b, j) => (j.hits.length && (!b || j.rank < b.rank) ? j : b), null);

  return new Promise((resolve) => {
    let over = false;
    let grace = null;
    let budget = null;
    const finish = () => {
      if (over) return;
      over = true;
      clearTimeout(budget);
      clearTimeout(grace);
      resolve(best()?.hits ?? []);
    };
    const settle = () => {
      if (over) return;
      const top = best();
      if (!top) {
        if (jobs.every((j) => j.done)) finish();
        return;
      }
      if (jobs.every((j) => j.done || j.rank > top.rank)) {
        finish();
        return;
      }
      if (!grace) grace = setTimeout(finish, ctx.guessGraceMs ?? GUESS_GRACE_MS);
    };
    budget = setTimeout(finish, ctx.guessBudgetMs ?? GUESS_BUDGET_MS);
    for (const job of jobs) {
      askGuess(job, ctx)
        .then((hits) => { job.hits = hits; }, () => {})
        .finally(() => { job.done = true; settle(); });
    }
  });
}

/**
 * The paid source: the user's own model, with web search, told which shops we
 * can read. It returns URLs and nothing else — see ai.mjs for why that limit is
 * the whole safety story.
 *
 * A failure here is REPORTED rather than swallowed: "your key was rejected" and
 * "I couldn't find it" are different facts, and a user who can't tell them apart
 * will keep retyping a query that was never the problem. The note rides on the
 * returned array so the pipeline stays a plain list of candidates.
 */
export async function aiSearchSource(query, ctx = {}) {
  const { provider, apiKey } = ctx.ai ?? {};
  if (!apiKey) return [];

  const res = await aiSearch(query, {
    provider,
    apiKey,
    stores: searchableStores({ hasKey: Boolean(ctx.userHasUnblockerKey) }),
    fetchImpl: ctx.aiFetchImpl ?? ctx.fetchImpl ?? fetch,
    model: ctx.ai.model,
  });

  const hits = res.ok ? (res.candidates ?? []) : [];
  if (!res.ok) hits.note = res.reason;
  return hits;
}

/**
 * Did this query identify a PRODUCT, or just a product category?
 *
 * "vitamin c serum" names no brand, so the honest results are three unrelated
 * serums from three unrelated brands — technically found, practically a shrug.
 * Rather than judge the words (which needs an ever-growing list of generic
 * terms), judge the ANSWER.
 *
 * The subtlety that a first attempt got wrong: those three titles DO share a
 * word — "serum" — so naive overlap says "same product". But that word came
 * from the query; it is what they all matched ON, not evidence they are the
 * same thing. So the query's own words are discounted, and what remains is
 * asked to overlap:
 *
 *   "Our Legacy Camion boots"  -> titles are almost entirely query words, so
 *                                 little remains and nothing disagrees -> specific
 *   "vitamin c serum"          -> Cetaphil / Ordinary / Joseon remain, sharing
 *                                 nothing -> broad
 *
 * Takes the titles AS DISPLAYED, not the raw readings. The Shopify adapter
 * returns no title at all, so a Shopify result contributed an empty set, got
 * filtered out, and left too few to compare — the check quietly gave up on
 * exactly the searches it was written for. What the shopper sees is what should
 * be judged.
 */
export function looksBroad(titles, query = "") {
  if ((titles?.length ?? 0) < 2) return false;

  const tokens = (s) =>
    String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
      .filter((w) => w.length >= 5);

  const asked = new Set(tokens(query));
  const sets = titles
    .map((t) => new Set(tokens(t).filter((w) => !asked.has(w))))
    .filter((s) => s.size);

  // Fewer than two titles have anything left to compare: everything they say is
  // what was asked for, which is what a precise query looks like.
  if (sets.length < 2) return false;

  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const w of sets[i]) if (sets[j].has(w)) return false;
    }
  }
  return true;
}
