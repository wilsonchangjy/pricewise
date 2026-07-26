import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnd, hasProductState, nextDataOf } from "../supabase/functions/_shared/adapters/endclothing.mjs";
import { STATE } from "../supabase/functions/_shared/stock.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/end-product.html", import.meta.url), "utf8");
const ITEM = { url: "https://www.endclothing.com/sg/new-balance-abzorb-1890-sneaker-u18907ng.html" };

// Captured live 2026-07-27. END answers a plain direct fetch (HTTP 200, no
// unblocker) and prices in the LOCAL currency — SGD on /sg/, unlike MR PORTER
// and NET-A-PORTER, which bill in GBP and USD from the same locale.
test("parses a free, direct page: SGD price and the full size run", () => {
  const r = parseEnd(FIXTURE, ITEM);
  assert.equal(r.ok, true);
  assert.equal(r.price, 249);
  assert.equal(r.currency, "SGD");
  assert.equal(r.available, true);
  assert.equal(r.variants.length, 12);
  assert.match(r.title, /New Balance/);
});

// ⚠️ END OMITS SOLD-OUT SIZES. There is no in_stock:false anywhere — an
// unbuyable size simply isn't in the payload. The captured run reads
// "UK 4, UK 6, UK 7…": UK 5, 5.5 and 6.5 are absent, not flagged, and the page
// carries no "sold out" or "notify me" text at all. So PRESENCE is the signal.
test("sizes END lists are the buyable ones; the gaps are what's sold out", () => {
  const r = parseEnd(FIXTURE, ITEM);
  const labels = r.variants.map((v) => v.label);
  assert.ok(labels.includes("UK 4") && labels.includes("UK 6"));
  assert.ok(!labels.includes("UK 5"), "UK 5 is absent from END's data — that IS the sold-out signal");
  assert.ok(r.variants.every((v) => v.available), "everything listed is buyable");
});

// The alert this store can still deliver, and the reason the adapter is worth
// having: a size you're watching that DISAPPEARS is sold out — not a broken
// page — and one that reappears is the restock.
test("a tracked size that vanished reads as sold out, not as a parse failure", () => {
  const gone = parseEnd(FIXTURE, { ...ITEM, variantSelector: { size: "UK 5" } });
  assert.equal(gone.ok, true, "must not fail — this is a real, reportable state");
  assert.equal(gone.variants[0].available, false);
  assert.equal(gone.variants[0].state, STATE.OUT_OF_STOCK);
  assert.equal(gone.available, false);

  const there = parseEnd(FIXTURE, { ...ITEM, variantSelector: { size: "UK 9" } });
  assert.equal(there.variants[0].available, true);
});

test("a page without the product payload is refused, not guessed at", () => {
  assert.equal(hasProductState("<html><body>nothing</body></html>"), false);
  const r = parseEnd("<html><body>nothing</body></html>", ITEM);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "parse");
  assert.equal(nextDataOf("<html></html>"), null);
});

test("END is FREE — no unblocker key, so it must not be in the defended set", async () => {
  const { strategyFor } = await import("../supabase/functions/_shared/router.mjs");
  assert.equal(strategyFor("end"), "direct");
});
