// Garment category detection, so "my default shoe size is UK9" can be applied
// without asking every time.
//
// This is a HEURISTIC over the product title, and it is allowed to say "I don't
// know". That matters more than coverage: applying a default size to the wrong
// category means silently watching a size the user never asked for, and they'd
// only find out by missing the restock they were waiting for. When unsure we
// return null and the bot asks.

const RULES = [
  // Footwear first — most distinctive vocabulary, and "boot cut" is the only
  // real collision (handled by requiring boot/boots as a whole word).
  ["shoes", /\b(shoes?|boots?|sneakers?|trainers?|oxfords?|loafers?|sandals?|derbys?|brogues?|mules?|clogs?|slippers?|heels?|pumps?|espadrilles?)\b/i],
  ["bottoms", /\b(jeans?|trousers?|pants?|chinos?|shorts?|skirts?|leggings?|joggers?|culottes?|sarouel|slacks?|bermudas?)\b/i],
  ["tops", /\b(shirts?|tees?|t-shirts?|tops?|blouses?|jackets?|coats?|sweaters?|jumpers?|knits?|hoodies?|cardigans?|blazers?|polos?|sweatshirts?|vests?|gilets?)\b/i],
];

/** The categories a user can hold a default size for. */
export const CATEGORIES = ["tops", "bottoms", "shoes"];

/**
 * @param {string} title
 * @param {string} [url]
 * @returns {"tops"|"bottoms"|"shoes"|null}
 */
export function detectCategory(title, url = "") {
  const hay = `${title ?? ""} ${url ?? ""}`;
  for (const [category, re] of RULES) {
    if (re.test(hay)) return category;
  }
  return null; // dresses, bags, accessories, anything ambiguous — ask, don't guess
}

/** Normalise a user's category word ("shoe", "footwear", "top") to a key. */
export function normalizeCategory(word) {
  const w = String(word ?? "").toLowerCase().trim();
  if (/^(shoe|shoes|footwear|boots?|sneakers?)$/.test(w)) return "shoes";
  if (/^(bottom|bottoms|pants?|trousers?|jeans?|legs?)$/.test(w)) return "bottoms";
  if (/^(top|tops|shirts?|upper)$/.test(w)) return "tops";
  return CATEGORIES.includes(w) ? w : null;
}
