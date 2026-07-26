import { test } from "node:test";
import assert from "node:assert/strict";
import { STORES, groupedStores, storesMessage, isFree } from "../supabase/functions/_shared/stores.mjs";
import { SUPPORTED_ADAPTERS } from "../supabase/functions/_shared/adapters/index.mjs";
import { parseCommand } from "../supabase/functions/_shared/commands.mjs";

// The store list lived in four places — the README, /help, /providers and
// /prefs — and had already drifted: /prefs still read "Zara, Amazon, ASOS…"
// months after eBay, Farfetch and MR PORTER shipped. These tests bind the one
// remaining list to the code that actually does the work.
test("every listed store maps to a real, dispatchable adapter", () => {
  for (const s of STORES) {
    assert.ok(SUPPORTED_ADAPTERS.includes(s.adapter), `${s.name} → unknown adapter "${s.adapter}"`);
  }
});

test("every adapter the bot can dispatch is listed for users", () => {
  const listed = new Set(STORES.map((s) => s.adapter));
  const missing = SUPPORTED_ADAPTERS.filter((a) => !listed.has(a));
  assert.deepEqual(missing, [], "an adapter users can't discover may as well not exist");
});

// free/keyed is DERIVED from the router, so a store cannot be advertised as
// free after being moved into DEFENDED.
test("free vs needs-a-key follows the router, not a hand-written label", async () => {
  const { strategyFor } = await import("../supabase/functions/_shared/router.mjs");
  for (const s of STORES) {
    assert.equal(isFree(s.adapter), strategyFor(s.adapter) !== "unblocker", s.name);
  }
  const { free, keyed } = groupedStores();
  assert.ok(free.length && keyed.length);
  assert.ok(free.some((s) => s.adapter === "end"), "END answers a direct fetch — it must show as free");
  assert.ok(keyed.some((s) => s.adapter === "cettire"));
});

test("the message names every store and states the cost of the paid ones", () => {
  const msg = storesMessage();
  for (const s of STORES) assert.ok(msg.includes(s.name), `${s.name} missing from /stores`);
  for (const s of groupedStores().keyed) {
    assert.match(msg, new RegExp(`${s.credits} credits? a check`), `${s.name} should state its cost`);
  }
});

test("/stores is routable, with the obvious aliases", () => {
  assert.equal(parseCommand("/stores").cmd, "stores");
  assert.equal(parseCommand("/shops").cmd, "stores");
  assert.equal(parseCommand("/sites").cmd, "stores");
});
