import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCategory, normalizeCategory } from "../supabase/functions/_shared/category.mjs";
import { matchVariant } from "../supabase/functions/_shared/variants.mjs";

test("real product titles land in the right category", () => {
  assert.equal(detectCategory("Vintage 1461 Quilon Leather Oxford Shoes"), "shoes");
  assert.equal(detectCategory("Mens Straight Jeans Selvedge"), "bottoms");
  assert.equal(detectCategory("Unisex Smart Wide Straight Pants"), "bottoms");
  assert.equal(detectCategory("Cotton-Linen Blend Shirt"), "tops");
  assert.equal(detectCategory("Seersucker Resort Shirt"), "tops");
  assert.equal(detectCategory("Wool Blend Coat"), "tops");
});

test("ambiguous items return null rather than a wrong default", () => {
  assert.equal(detectCategory("Pleated Bodice Maxi Dress"), null);
  assert.equal(detectCategory("Leather Tote Bag"), null);
  assert.equal(detectCategory("Silver Birthstone Ring"), null);
  assert.equal(detectCategory(""), null);
});

test("users can say it their own way", () => {
  assert.equal(normalizeCategory("shoe"), "shoes");
  assert.equal(normalizeCategory("Footwear"), "shoes");
  assert.equal(normalizeCategory("trousers"), "bottoms");
  assert.equal(normalizeCategory("top"), "tops");
  assert.equal(normalizeCategory("hats"), null);
});

test("a default size matches the shop's own label, or nothing", () => {
  const variants = [
    { id: "1", label: "UK8/EU42", sizeCode: "UK8" },
    { id: "2", label: "UK9/EU43", sizeCode: "UK9" },
    { id: "3", label: "UK10/EU44", sizeCode: "UK10" },
  ];
  assert.equal(matchVariant(variants, "UK9").id, "2");
  assert.equal(matchVariant(variants, "uk 9").id, "2");
  assert.equal(matchVariant(variants, "EU43").id, "2");
  assert.equal(matchVariant(variants, "XL"), null, "an unavailable size must not be approximated");
});

test("exactness beats prefix — M is not Mint", () => {
  const variants = [
    { id: "1", label: "Mint", sizeCode: "Mint" },
    { id: "2", label: "M", sizeCode: "M" },
  ];
  assert.equal(matchVariant(variants, "M").id, "2");
});
