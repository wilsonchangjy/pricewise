import { test } from "node:test";
import assert from "node:assert/strict";
import { keySetupGuide, detectProvider, PROVIDERS } from "../supabase/functions/_shared/providers.mjs";
import { parseCommand } from "../supabase/functions/_shared/commands.mjs";

// The first time someone needs a key is usually when their items are already
// held — so this is written for a person who has never heard of an unblocker.

test("bare /setkey shows the guide, not a usage line that assumes you have a key", () => {
  assert.deepEqual(parseCommand("/setkey"), { cmd: "keyhelp" });
});

test("the guide's command names the provider — a bare Scrape.do key is ambiguous", () => {
  const key = "a".repeat(32); // the shape both Scrape.do and ScraperAPI use
  assert.equal(detectProvider(key), null, "so a bare /setkey <key> would be answered 'which service?'");
  assert.match(keySetupGuide(), /\/setkey scrapedo YOUR_TOKEN/);
  assert.deepEqual(parseCommand(`/setkey scrapedo ${key}`).providerWord, "scrapedo");
});

test("it points at the recommended, renewing service and says what it costs", () => {
  const g = keySetupGuide();
  assert.ok(g.includes(PROVIDERS.scrapedo.signup));
  assert.match(g, /1,000 credits a month and renews/);
  assert.match(g, /delete that message/);
});

test("held items are promised a retry only when there are some", () => {
  assert.match(keySetupGuide({ heldCount: 2 }), /retry your 2 held items straight away/);
  assert.match(keySetupGuide({ heldCount: 1 }), /retry your 1 held item straight away/);
  assert.ok(!/held item/.test(keySetupGuide({ heldCount: 0 })));
});

test("it fits in one Telegram message", () => {
  assert.ok(keySetupGuide({ heldCount: 99 }).length < 4000);
});
