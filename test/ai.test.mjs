import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAiProvider, harvestUrls, buildPrompt, aiSearch, AI_PROVIDERS,
} from "../supabase/functions/_shared/ai.mjs";

// A fake fetch — none of this touches a model API.
const fakeApi = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

test("Anthropic keys are unambiguous; everything else sk- is OpenAI", () => {
  assert.equal(detectAiProvider("sk-ant-api03-abcdefghijklmnop"), "anthropic");
  assert.equal(detectAiProvider("sk-proj-abcdefghijklmnopqrst"), "openai");
  assert.equal(detectAiProvider("hunter2"), null);
  // The shape check has to accept what it detects, or /setaikey rejects its own answer.
  assert.ok(AI_PROVIDERS.anthropic.keyPattern.test("sk-ant-api03-abcdefghijklmnop"));
  assert.ok(AI_PROVIDERS.openai.keyPattern.test("sk-proj-abcdefghijklmnopqrst"));
});

// The response shapes below are the two providers' documented block layouts.
// The harvester is deliberately shape-AGNOSTIC — see ai.mjs for why — so these
// double as a check that a future rename can't silently return zero candidates.
const ANTHROPIC = {
  stop_reason: "end_turn",
  content: [
    {
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", url: "https://www.mrporter.com/en-sg/mens/product/our-legacy/camion", title: "Camion Boots" },
        { type: "web_search_result", url: "https://www.google.com/search?q=camion+boots", title: "camion boots - Google" },
      ],
    },
    {
      type: "text",
      text: "The best places to buy these are https://www.mrporter.com/en-sg/mens/product/our-legacy/camion and https://www.ssense.com/en-sg/men/product/our-legacy/camion-boots/1234567 — both currently list them.",
    },
  ],
};

const OPENAI = {
  output: [
    { type: "web_search_call", status: "completed" },
    {
      type: "message",
      content: [{
        type: "output_text",
        text: "You can buy it at https://www.ssense.com/en-sg/men/product/our-legacy/camion-boots/1234567",
        annotations: [{ type: "url_citation", url: "https://www.endclothing.com/sg/our-legacy-camion-boot.html", title: "END." }],
      }],
    },
  ],
};

test("URLs are harvested from either provider's shape, without a per-provider parser", () => {
  const a = harvestUrls([ANTHROPIC]);
  assert.ok(a.some((u) => u.includes("mrporter.com")));
  assert.ok(a.some((u) => u.includes("ssense.com")));

  const o = harvestUrls([OPENAI]);
  assert.ok(o.some((u) => u.includes("ssense.com")));
  assert.ok(o.some((u) => u.includes("endclothing.com")), "a citation is as good a lead as the prose");
});

test("search-engine and social links are dropped before they cost an adapter fetch", () => {
  assert.ok(!harvestUrls([ANTHROPIC]).some((u) => u.includes("google.com")));
  assert.ok(!harvestUrls([{ text: "see https://www.reddit.com/r/malefashion/x and https://shop.example.com/p/1 " .repeat(3) }])
    .some((u) => u.includes("reddit.com")));
});

test("what the model WROTE outranks what it merely looked at", () => {
  const urls = harvestUrls([ANTHROPIC]);
  // mrporter appears in both the tool result and the prose; ssense only in the
  // prose. The prose pass runs first, so ssense must beat any search-result-only
  // URL that came before it in the payload.
  assert.ok(urls.indexOf("https://www.ssense.com/en-sg/men/product/our-legacy/camion-boots/1234567") < urls.length);
  assert.equal(new Set(urls).size, urls.length, "no duplicates across the two passes");
});

test("the same product page twice is one candidate, tracking params and all", () => {
  const urls = harvestUrls([{
    text: ("x".repeat(130)) + " https://shop.test/p/1?utm_source=a https://shop.test/p/1 https://shop.test/p/1/",
  }]);
  assert.equal(urls.length, 1);
});

test("the prompt names the shops we can actually read", () => {
  const p = buildPrompt("camion boots", [{ host: "endclothing.com" }, { host: "ssense.com" }]);
  assert.match(p, /camion boots/);
  assert.match(p, /endclothing\.com/);
  assert.match(p, /Do not construct or guess a URL/);
});

// A failed search must say WHICH failure it was. "No results" and "your key was
// rejected" need different things from the user; one message for both is how a
// feature earns distrust.
test("an API failure is reported as itself, not as 'found nothing'", async () => {
  const rejected = await aiSearch("camion boots", {
    provider: "anthropic", apiKey: "sk-ant-x", fetchImpl: fakeApi(401, { error: { message: "invalid x-api-key" } }),
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /key was rejected/);

  const broke = await aiSearch("camion boots", {
    provider: "openai", apiKey: "sk-x", fetchImpl: fakeApi(429, {}),
  });
  assert.match(broke.reason, /rate-limited or out of credit/);

  const badModel = await aiSearch("camion boots", {
    provider: "openai", apiKey: "sk-x",
    fetchImpl: fakeApi(404, { error: { message: "The model `gpt-9` does not exist" } }),
  });
  assert.match(badModel.reason, /does not exist/, "quote the service, so the fix is obvious");
});

test("a successful search returns URLs and nothing else — no price, no stock", async () => {
  const res = await aiSearch("our legacy camion boots", {
    provider: "anthropic", apiKey: "sk-ant-x", fetchImpl: fakeApi(200, ANTHROPIC),
  });
  assert.equal(res.ok, true);
  assert.ok(res.candidates.length >= 2);
  for (const c of res.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ["hint", "url"],
      "a candidate is a lead to verify, never a claim about the product");
  }
});

test("a paused server-tool turn is resumed, not abandoned mid-search", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const first = bodies.length === 1;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify(first
        ? { stop_reason: "pause_turn", content: [{ type: "text", text: "still searching" }] }
        : ANTHROPIC),
    };
  };
  const res = await aiSearch("camion boots", { provider: "anthropic", apiKey: "sk-ant-x", fetchImpl });
  assert.equal(bodies.length, 2, "a pause is a continuation, not a failure");
  assert.equal(bodies[1].messages.at(-1).role, "assistant", "resume by echoing the turn back");
  assert.ok(res.candidates.some((c) => c.url.includes("mrporter.com")));
});

// ── locale steering ─────────────────────────────────────────────────────────
test("the prompt tells the model where the shopper is, and why it matters", () => {
  const withCountry = buildPrompt("Castlery Joseph bed", [], "SG");
  assert.match(withCountry, /shopper is in SG/);
  assert.match(withCountry, /SEPARATE site per country/);
  assert.match(withCountry, /ship worldwide from a single/i, "international retailers must NOT be rewritten");
  // Not knowing where they are is a valid state, not a blank to fill in.
  assert.doesNotMatch(buildPrompt("Castlery Joseph bed", []), /shopper is in/);
});

test("the country reaches the search TOOL, not just the prose", async () => {
  const seen = [];
  const fetchImpl = async (_u, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify(ANTHROPIC) };
  };
  await aiSearch("joseph bed", { provider: "anthropic", apiKey: "sk-ant-x", country: "SG", fetchImpl });
  assert.deepEqual(seen[0].tools[0].user_location, { type: "approximate", country: "SG" },
    "biasing the actual search beats asking the model nicely");
});

// These tuning knobs are version-sensitive and can't be tested against a live
// key here. A rejected parameter must cost us the speed-up, never the feature.
test("if the service rejects a tuning parameter, ask again plainly", async () => {
  const bodies = [];
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? { ok: false, status: 400, text: async () => '{"error":{"message":"Unknown parameter: reasoning.effort"}}' }
      : { ok: true, status: 200, text: async () => JSON.stringify(OPENAI) };
  };
  const res = await aiSearch("joseph bed", { provider: "openai", apiKey: "sk-x", country: "SG", fetchImpl });
  assert.equal(res.ok, true, "the retry rescued the search");
  assert.ok(bodies[0].reasoning, "first attempt is the tuned one");
  assert.ok(!bodies[1].reasoning, "second drops the knobs rather than the feature");
});

test("a rejected KEY is not retried — only a rejected parameter is", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 401, text: async () => "{}" }; };
  const res = await aiSearch("x", { provider: "openai", apiKey: "sk-x", fetchImpl });
  assert.equal(calls, 1, "retrying a bad key just spends another request to fail again");
  assert.match(res.reason, /key was rejected/);
});

test("a timeout says it's worth retrying, because it is", async () => {
  const fetchImpl = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  const res = await aiSearch("x", { provider: "openai", apiKey: "sk-x", fetchImpl });
  assert.match(res.reason, /past its time limit/);
  assert.match(res.reason, /worth retrying/);
});
