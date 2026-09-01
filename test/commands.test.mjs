import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../supabase/functions/_shared/commands.mjs";

test("a bare shared URL is shorthand for /add", () => {
  const r = parseCommand("https://anane.co/products/x?variant=1");
  assert.equal(r.cmd, "add");
  assert.equal(r.url, "https://anane.co/products/x?variant=1");
});

test("/add with a URL, and /add@botname stripped", () => {
  assert.equal(parseCommand("/add https://x.com/p").cmd, "add");
  assert.equal(parseCommand("/add@pricewisebot https://x.com/p").url, "https://x.com/p");
});

test("/setprice parses ref + price, rejects bad input", () => {
  assert.deepEqual(parseCommand("/setprice 3 250"), { cmd: "setprice", ref: "3", price: 250 });
  assert.match(parseCommand("/setprice 3").message, /Usage/);
});

test("/setkey flags the message for deletion (it's a secret)", () => {
  const r = parseCommand("/setkey ABC123KEY");
  assert.equal(r.cmd, "setkey");
  assert.equal(r.key, "ABC123KEY");
  assert.equal(r.redactMessage, true);
});

test("list/remove/help/unknown", () => {
  assert.equal(parseCommand("/list").cmd, "list");
  assert.equal(parseCommand("/remove 2").ref, "2");
  assert.equal(parseCommand("/start").cmd, "help");
  assert.equal(parseCommand("/nope").cmd, "unknown");
});

// Plain text used to be "unknown". It now owns the unprefixed fallback — the
// only other unprefixed input is a URL, which is caught above it.
test("typing a description is a search, not an unknown command", () => {
  const i = parseCommand("Our Legacy Camion boots in black");
  assert.equal(i.cmd, "find");
  assert.equal(i.query, "Our Legacy Camion boots in black");
  assert.equal(parseCommand("/find camion boots").query, "camion boots");
});

test("a stray keystroke or a paragraph is not a search", () => {
  assert.equal(parseCommand("ok").cmd, "unknown", "two characters is a typo, not a product");
  assert.equal(parseCommand("a".repeat(200)).cmd, "unknown", "that's someone talking, not shopping");
  // …and the refusal still says what the bot is for.
  assert.match(parseCommand("ok").message, /describe an item/);
});

test("/setaikey is a secret, and can be revoked", () => {
  const set = parseCommand("/setaikey sk-ant-api03-abc");
  assert.equal(set.cmd, "setaikey");
  assert.equal(set.key, "sk-ant-api03-abc");
  assert.equal(set.redactMessage, true, "a model key must never linger in the chat");

  const off = parseCommand("/setaikey off");
  assert.equal(off.clear, true);
  assert.ok(!off.key);

  assert.equal(parseCommand("/setaikey").redactMessage, false, "nothing secret in a bare usage error");
});

test("retired /pause and /resume no longer route — they fall through to unknown", () => {
  assert.equal(parseCommand("/pause 1").cmd, "unknown");
  assert.equal(parseCommand("/resume 1").cmd, "unknown");
});

test("/size takes free text after the item number", () => {
  assert.deepEqual(parseCommand("/size 2 M"), { cmd: "size", ref: "2", value: "M" });
  assert.deepEqual(parseCommand("/size 2 Navy / 32inch"), { cmd: "size", ref: "2", value: "Navy / 32inch" });
  assert.match(parseCommand("/size 2").message, /Usage/);
});

test("/every parses the interval option", () => {
  assert.deepEqual(parseCommand("/every 1 12H"), { cmd: "every", ref: "1", value: "12h" });
  assert.match(parseCommand("/every 1").message, /3h\|6h\|12h\|1d/);
});

// ── /market and /setcountry ─────────────────────────────────────────────────
// Both are DELIBERATELY unadvertised: the /list button is the real UI. They
// cost a parse case and a one-line switch arm each — the handler is shared with
// the button — so keeping them is close to free for the people who do type.

test("/market takes a list number and a country, and normalises the case", () => {
  assert.deepEqual(parseCommand("/market 2 gb"), { cmd: "market", ref: "2", value: "GB" });
});

test("/market without both parts explains itself instead of guessing", () => {
  assert.match(parseCommand("/market 2").message, /Usage: \/market/);
  assert.match(parseCommand("/market").message, /Usage: \/market/);
});

test("/setcountry sets the account default", () => {
  assert.deepEqual(parseCommand("/setcountry sg"), { cmd: "setcountry", value: "SG" });
  assert.match(parseCommand("/setcountry").message, /Usage: \/setcountry/);
});
