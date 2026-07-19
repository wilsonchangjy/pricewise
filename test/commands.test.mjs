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

test("list/remove/pause/help/unknown", () => {
  assert.equal(parseCommand("/list").cmd, "list");
  assert.equal(parseCommand("/remove 2").ref, "2");
  assert.equal(parseCommand("/pause 1").ref, "1");
  assert.equal(parseCommand("/start").cmd, "help");
  assert.equal(parseCommand("hello there").cmd, "unknown");
});
