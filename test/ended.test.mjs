import { test } from "node:test";
import assert from "node:assert/strict";
import { followRelist, endedMessage, MAX_RELIST_HOPS } from "../supabase/functions/_shared/ended.mjs";

// LIVE, 2026-09-16: 318509998125 sold Jul 21 and was relisted as 318619824336,
// which then sold Aug 10 with no further relist. That chain is the first case.

const ORIGINAL = "https://www.ebay.com/itm/318509998125";
const RELIST = "https://www.ebay.com/itm/318619824336";
const JACKET = { title: "Vtg Carhartt Brown Detroit Blanket Lined Jacket J97 Size Small Corduroy Collar", url: ORIGINAL };
const SOLD_JUL = { sold: true, when: "Tue, Jul 21", message: "This listing sold on Tue, Jul 21 at 2:52 PM.", relistUrl: RELIST };

const reader = (pages) => {
  const calls = [];
  const read = async (url) => { calls.push(url); if (!(url in pages)) throw new Error("unreachable"); return pages[url]; };
  return { read, calls };
};

// ── following the relist ─────────────────────────────────────────────────────

test("a relist that also sold is reported as such — the real chain", async () => {
  const { read } = reader({ [RELIST]: { ok: true, available: false, ended: { sold: true, when: "Mon, Aug 10", relistUrl: null } } });
  const r = await followRelist(RELIST, read);
  assert.deepEqual(r, { url: RELIST, itemId: "318619824336", ended: true, sold: true, when: "Mon, Aug 10" });
});

test("a live relist comes back with its price, read through the adapter", async () => {
  const { read } = reader({ [RELIST]: { ok: true, available: true, price: 275, currency: "USD" } });
  const r = await followRelist(RELIST, read);
  assert.equal(r.live, true);
  assert.equal(r.price, 275);
  assert.equal(r.itemId, "318619824336");
});

test("a relist of a relist is followed to the listing you can act on", async () => {
  const SECOND = "https://www.ebay.com/itm/318700000001";
  const { read } = reader({
    [RELIST]: { ok: true, available: false, ended: { sold: true, when: "Mon, Aug 10", relistUrl: SECOND } },
    [SECOND]: { ok: true, available: true, price: 260, currency: "USD" },
  });
  const r = await followRelist(RELIST, read);
  assert.equal(r.url, SECOND);
  assert.equal(r.live, true);
});

test("the walk is capped, because every hop spends the watcher's credits", async () => {
  const urls = Array.from({ length: 6 }, (_, i) => `https://www.ebay.com/itm/31870000000${i}`);
  const pages = Object.fromEntries(urls.map((u, i) => [u, { ok: true, available: false, ended: { sold: true, when: null, relistUrl: urls[i + 1] ?? null } }]));
  const { read, calls } = reader(pages);
  await followRelist(urls[0], read);
  assert.equal(calls.length, MAX_RELIST_HOPS);
});

test("a relist loop is not walked twice", async () => {
  const A = "https://www.ebay.com/itm/318700000010";
  const B = "https://www.ebay.com/itm/318700000011";
  const { read, calls } = reader({
    [A]: { ok: true, available: false, ended: { sold: true, relistUrl: B } },
    [B]: { ok: true, available: false, ended: { sold: true, relistUrl: A } },
  });
  await followRelist(A, read, { maxHops: 10 });
  assert.deepEqual(calls, [A, B]);
});

test("an unreadable relist says there IS one, without claiming anything about it", async () => {
  const { read } = reader({});
  assert.deepEqual(await followRelist(RELIST, read), { url: RELIST, itemId: "318619824336", unread: true });
});

// ── the message ──────────────────────────────────────────────────────────────

test("the real case: sold, relisted, and the relist sold too — no button to tap", () => {
  const { text, keyboard } = endedMessage(JACKET, SOLD_JUL,
    { url: RELIST, itemId: "318619824336", ended: true, sold: true, when: "Mon, Aug 10" });
  assert.match(text, /^🏁 SOLD: Vtg Carhartt/);
  assert.match(text, /This listing sold on Tue, Jul 21\./);
  assert.match(text, /stopped watching it and taken it off your list/);
  assert.match(text, /that one has sold too \(Mon, Aug 10\)/);
  assert.equal(keyboard, undefined, "nothing live to offer");
});

test("a live relist is OFFERED, never switched to — with eBay's own caveat", () => {
  const { text, keyboard } = endedMessage(JACKET, SOLD_JUL,
    { url: RELIST, itemId: "318619824336", live: true, available: true, price: 275, currency: "USD" });
  assert.match(text, /The seller relisted it: USD 275\.00, available now\./);
  assert.match(text, /this item or one like this/);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "rl:_:318619824336");
});

test("an out-of-stock relist is still worth offering — tracking it would catch the restock", () => {
  const { text, keyboard } = endedMessage(JACKET, SOLD_JUL,
    { url: RELIST, itemId: "318619824336", live: false, available: false });
  assert.match(text, /out of stock right now/);
  assert.ok(keyboard);
});

test("an unreadable relist gets the link and the button, but no claims", () => {
  const { text, keyboard } = endedMessage(JACKET, SOLD_JUL, { url: RELIST, itemId: "318619824336", unread: true });
  assert.match(text, /couldn't read the new listing/);
  assert.ok(!/available now|USD/.test(text));
  assert.ok(keyboard);
});

test("ended by the seller, not sold, says so", () => {
  const { text } = endedMessage(JACKET, { sold: false, when: "Fri, Sep 4", relistUrl: null }, null);
  assert.match(text, /^🏁 LISTING ENDED:/);
  assert.match(text, /The seller ended this listing on Fri, Sep 4/);
});

test("the button fits Telegram's 64-byte callback cap", () => {
  const { keyboard } = endedMessage(JACKET, SOLD_JUL, { url: RELIST, itemId: "318619824336999", live: true, price: 1, currency: "USD" });
  assert.ok(new TextEncoder().encode(keyboard.inline_keyboard[0][0].callback_data).length <= 64);
});
