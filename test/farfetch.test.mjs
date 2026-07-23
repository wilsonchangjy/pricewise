import { test } from "node:test";
import assert from "node:assert/strict";
import { farfetchTitle } from "../supabase/functions/_shared/adapters/farfetch.mjs";

// Farfetch's JSON-LD name is a bare "small Croissant bag in leather"; a share
// link carries no slug either, so the bot showed "Item .Aspx". og:title is the
// real, brand-led, title-cased name.
test("farfetchTitle takes og:title and drops the ' | colour | FARFETCH' tail", () => {
  const html = `<meta property="og:title" content="LEMAIRE Small Croissant Bag In Leather | Black | FARFETCH">`;
  assert.equal(farfetchTitle(html), "LEMAIRE Small Croissant Bag In Leather");
});

test("falls back to <title>, and decodes entities", () => {
  assert.equal(farfetchTitle(`<title>Acne Studios Fa&#233;n Coat | FARFETCH</title>`), "Acne Studios Faén Coat");
  assert.equal(farfetchTitle(`<html>no title here</html>`), undefined);
});
