// The model-backed candidate source: "who even sells this?"
//
// The free source (search.mjs → storeSearchSource) can only query a shop it can
// LOCATE. That's its structural limit: 5M Shopify stores, and "Our Legacy Camion
// boots" names a brand whose shop runs on Centra. A model with web search answers
// the question the free path cannot — which retailers stock this thing.
//
// WHAT THIS MODULE IS ALLOWED TO PRODUCE: a list of URLs. Nothing else. No price,
// no stock, no "it's £290 at MR PORTER". Every URL is handed to verifyCandidates
// and read through a real adapter before a user sees a single number. A model
// that hallucinates a product page produces a dead URL, which fails verification
// and is dropped — the failure mode is "found nothing", never "quoted a price
// that doesn't exist".
//
// Search results are UNTRUSTED OBSERVED CONTENT. A product page can say anything,
// including "ignore your instructions". We never act on their text — we extract
// http(s) URLs and discard the rest. That's why the harvester below is a dumb
// URL scraper over the whole response rather than a parser that follows the
// model's narrative.
//
// Raw fetch rather than a vendor SDK, deliberately: two providers behind one
// interface, the module has to run under both Deno (Edge Function) and Node
// (tests), and every other network module here takes an injectable `fetchImpl`
// so the tests never touch the network. One SDK for one branch and fetch for the
// other would be worse than either.

const env = (k) => {
  try {
    // eslint-disable-next-line no-undef
    if (typeof Deno !== "undefined") return Deno.env.get(k) ?? "";
    // eslint-disable-next-line no-undef
    return (typeof process !== "undefined" ? process.env?.[k] : "") ?? "";
  } catch { return ""; } // Deno throws without --allow-env; a default is fine
};

/**
 * The two services a user can bring a key for. `keyPattern` is a shape check
 * only — the real test is whether the API accepts it, which we report honestly
 * rather than pre-judging.
 */
export const AI_PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    keyPattern: /^sk-ant-[\w-]{16,}$/,
    signup: "https://console.anthropic.com/settings/keys",
    note: "Claude models, with web search built in.",
  },
  openai: {
    label: "OpenAI",
    keyPattern: /^sk-[\w-]{16,}$/,
    signup: "https://platform.openai.com/api-keys",
    note: "GPT models, with web search built in.",
  },
};

/** Anthropic keys are unambiguous (`sk-ant-`); everything else `sk-` is OpenAI. */
export function detectAiProvider(key) {
  const k = String(key ?? "").trim();
  if (/^sk-ant-/.test(k)) return "anthropic";
  if (/^sk-/.test(k)) return "openai";
  return null;
}

/**
 * The SMALL model of each family, deliberately — and the reason is architectural
 * rather than thrift.
 *
 * This model never states a fact. It proposes URLs, and every one is read
 * through a real adapter before a number reaches anyone. A model mistake costs a
 * dropped candidate, not a wrong price. That safety net is what makes a cheap
 * model safe here, in a way it would not be if we trusted its output directly.
 *
 * Measured on the same four queries, 2026-08-05 (model spend only):
 *   gpt-5          $0.105   21–27s   missed Uniqlo entirely
 *   gpt-5.6-terra  $0.143   8–11s    pricier per token AND used more of them
 *   gpt-5.6-luna   $0.011   5–10s    found Uniqlo, every URL already SG-local
 * The cheapest was also the fastest with the best coverage, so no accuracy is
 * being traded away here. Override either with an env var.
 */
export const aiModelFor = (provider) =>
  provider === "anthropic"
    ? (env("AI_MODEL_ANTHROPIC") || "claude-haiku-4-5")
    : (env("AI_MODEL_OPENAI") || "gpt-5.6-luna");

/**
 * How long a model turn may take.
 *
 * Was 45s, and that was measured wrong: it was picked against Telegram's ~60s
 * retry window, but the webhook acks BEFORE the search runs, so Telegram was
 * never the constraint. Live, 3 of 4 OpenAI searches came back "the search took
 * too long" — a reasoning model doing several rounds of web search legitimately
 * needs longer than 45s. The real ceiling is the Edge Function's own wall clock,
 * which is far above this.
 */
const TIMEOUT_MS = 90_000;
const MAX_CONTINUATIONS = 2; // server-tool loops pause; resume, but not forever

const URL_RE = /https?:\/\/[^\s"'<>)\]}\\]+/gi;

/** Result pages, aggregators and social — never a product page, and each one we
 *  skip is an adapter fetch (sometimes a paid one) we don't spend. */
const NOT_A_SHOP =
  /(?:^|\.)(?:google|bing|duckduckgo|yahoo|baidu|youtube|facebook|instagram|tiktok|twitter|x|reddit|pinterest|wikipedia|lyst|shopstyle|polyvore)\.[a-z.]+$/i;

/**
 * Ask the user's model which shops sell this, preferring ones we can read.
 *
 * @param {string} query          what the user typed
 * @param {object} opts
 * @param {string} opts.provider  'anthropic' | 'openai'
 * @param {string} opts.apiKey    the user's key
 * @param {{host:string,name:string}[]} [opts.stores]  shops we can actually read
 * @returns {Promise<{ok:boolean, candidates?:{url:string,hint:string}[], reason?:string}>}
 */
export async function aiSearch(query, { provider, apiKey, stores = [], fetchImpl = fetch, model, country } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return { ok: false, reason: "nothing to search for" };
  if (!apiKey) return { ok: false, reason: "no key" };
  if (!AI_PROVIDERS[provider]) return { ok: false, reason: `unknown provider ${provider}` };

  const prompt = buildPrompt(q, stores, country);
  const call = provider === "anthropic" ? askAnthropic : askOpenAI;

  const res = await call({ prompt, apiKey, model: model ?? aiModelFor(provider), fetchImpl, country });
  if (!res.ok) return res;

  const candidates = harvestUrls(res.payloads).map((url) => ({ url, hint: "" }));
  return { ok: true, candidates };
}

/**
 * The prompt does two jobs: steer toward retailers we can read, and ask for
 * PRODUCT PAGES rather than an essay. It cannot make the answer true — that's
 * what verification is for — so it optimises for a usable list, not confidence.
 */
export function buildPrompt(query, stores = [], country) {
  const preferred = stores.map((s) => s.host).filter(Boolean).slice(0, 40);
  return [
    `Find where to buy this item online: "${query}"`,
    "",
    "Search the web, then reply with the direct product-page URLs — the page for that",
    "specific item on a retailer's own site, not a category page, a search-results page,",
    "a marketplace listing page, or a magazine article.",
    "",
    // Without this, a US page is as good an answer as any — and for a brand that
    // runs one site per country (Castlery, Uniqlo, IKEA) the US page is the wrong
    // product entirely: different price, different stock, often not shippable.
    country
      ? [
          `The shopper is in ${country}. Many brands run a SEPARATE site per country`,
          `(castlery.com/sg vs castlery.com/us, uniqlo.com/sg vs uniqlo.com/us). Where a`,
          `brand does, give the ${country} one — its price and stock are the only ones that`,
          `apply to this shopper. International retailers that ship worldwide from a single`,
          `site are fine as they are.`,
        ].join("\n")
      : "",
    country ? "" : null,
    preferred.length
      ? `Prefer these retailers where they stock it, in this order of usefulness:\n${preferred.join(", ")}\nAny Shopify or WooCommerce store is also fine — most independent brands run on one of them.`
      : "Prefer the brand's own store or a major retailer.",
    "",
    "Rules:",
    "- At most 5 URLs. Fewer is better than padding the list.",
    "- One line per URL, nothing else on the line.",
    "- Only URLs you actually saw in search results. Do not construct or guess a URL.",
    "- If you cannot find the item, reply with the single word NONE.",
  ].filter((l) => l !== null && l !== "").join("\n");
}

// ── providers ────────────────────────────────────────────────────────────────

async function askAnthropic({ prompt, apiKey, model, fetchImpl, country }) {
  const body = {
    model,
    max_tokens: 4096,
    // Adaptive thinking is the current shape (budget_tokens is rejected on this
    // model family). Thinking is on by default here anyway; naming it is
    // documentation for the next person as much as configuration.
    thinking: { type: "adaptive" },
    output_config: { effort: "low" }, // "list the URLs you found" is not deep work
    tools: [{
      type: "web_search_20260209", name: "web_search", max_uses: 4,
      // Bias the SEARCH toward the user's country, not just the wording of the
      // prompt — a shop with a per-country site should surface its local one.
      ...(country && { user_location: { type: "approximate", country } }),
    }],
    messages: [{ role: "user", content: prompt }],
  };

  const payloads = [];
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const r = await post("https://api.anthropic.com/v1/messages", body, {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }, fetchImpl);
    if (!r.ok) return r;
    payloads.push(r.json);

    // A server-side tool loop hit its iteration cap. Resume by echoing the turn
    // back — no extra user message; the API picks up where it stopped.
    if (r.json?.stop_reason !== "pause_turn") break;
    body.messages = [
      { role: "user", content: prompt },
      { role: "assistant", content: r.json.content },
    ];
  }
  return { ok: true, payloads };
}

async function askOpenAI({ prompt, apiKey, model, fetchImpl, country }) {
  const headers = { authorization: `Bearer ${apiKey}` };
  const url = "https://api.openai.com/v1/responses";

  // The untuned version of this took over 45 seconds on three live queries out of
  // four. Two knobs matter: a reasoning model defaults to thinking hard, and this
  // task is "list the URLs you already found" — and a wide search context buys
  // depth we then throw away, because we re-read every page ourselves anyway.
  const tuned = {
    model,
    input: prompt,
    reasoning: { effort: "low" },
    tools: [{
      type: "web_search",
      search_context_size: "low",
      ...(country && { user_location: { type: "approximate", country } }),
    }],
  };

  let r = await post(url, tuned, headers, fetchImpl);

  // These knobs are version-sensitive, and a rejected parameter would take the
  // whole feature down rather than just the speed-up. If the service says it
  // doesn't recognise something, ask again plainly rather than fail.
  if (!r.ok && r.status === 400 && /unknown|unsupported|unrecognized|not supported|additional propert/i.test(r.body ?? "")) {
    r = await post(url, { model, input: prompt, tools: [{ type: "web_search" }] }, headers, fetchImpl);
  }
  return r.ok ? { ok: true, payloads: [r.json] } : r;
}

async function post(url, body, headers, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    // status/body ride along so a caller can tell "you sent a bad parameter"
    // apart from "your key is wrong" and retry the one that's worth retrying.
    if (!r.ok) return { ok: false, status: r.status, body: text, reason: apiReason(r.status, text) };
    try { return { ok: true, json: JSON.parse(text) }; }
    catch { return { ok: false, reason: "the model service sent something I couldn't read" }; }
  } catch (e) {
    const aborted = /abort/i.test(String(e?.name ?? e));
    return {
      ok: false,
      status: 0,
      reason: aborted
        ? "the search ran past its time limit — that one's usually worth retrying"
        : "I couldn't reach the model service",
    };
  } finally {
    clearTimeout(t);
  }
}

/** Say what actually went wrong — a wrong key and an empty balance need
 *  different fixes from the user, and "search failed" tells them neither. */
function apiReason(status, text) {
  if (status === 401 || status === 403) return "your model key was rejected — check it, or send a new one";
  if (status === 429) return "your model account is rate-limited or out of credit right now";
  if (status === 404 || status === 400) {
    const m = String(text).match(/"message"\s*:\s*"([^"]{0,160})/);
    return `the model service refused the request${m ? ` (${m[1]})` : ""}`;
  }
  if (status >= 500) return "the model service is having a moment — try again shortly";
  return `the model service returned ${status}`;
}

// ── harvesting ───────────────────────────────────────────────────────────────

/**
 * Pull every http(s) URL out of a response, shape-agnostically.
 *
 * Deliberately NOT a parser of either provider's block types. Both response
 * shapes are moving targets (web_search_tool_result vs output_text annotations,
 * and both have changed within a year), and a parser that misses a rename fails
 * SILENTLY — zero candidates, looking exactly like "nothing found". A walk that
 * collects strings can't miss. It costs nothing in safety, because every URL is
 * verified through an adapter regardless of where in the payload it came from.
 *
 * Order matters, though: URLs the model WROTE (its answer) beat URLs that merely
 * appeared in a search result (everything it looked at, including the wrong
 * things). So text is walked first, citation/url fields second.
 */
export function harvestUrls(payloads) {
  const fromText = [];
  const fromFields = [];

  const walk = (node, key) => {
    if (node == null) return;
    if (typeof node === "string") {
      if (key === "url" || key === "link") { push(fromFields, node); return; }
      // Long strings and known text fields are the model's own words.
      if (key === "text" || key === "output_text" || node.length > 120) {
        for (const m of node.match(URL_RE) ?? []) push(fromText, m);
      }
      return;
    }
    if (Array.isArray(node)) { for (const v of node) walk(v, key); return; }
    if (typeof node === "object") { for (const [k, v] of Object.entries(node)) walk(v, k); }
  };

  for (const p of payloads ?? []) walk(p, null);
  return dedupe([...fromText, ...fromFields]);
}

function push(list, raw) {
  const url = String(raw).replace(/[.,;:]+$/, ""); // trailing sentence punctuation
  if (!/^https?:\/\//i.test(url)) return;
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  if (NOT_A_SHOP.test(host)) return;
  list.push(url);
}

function dedupe(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const k = u.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}
