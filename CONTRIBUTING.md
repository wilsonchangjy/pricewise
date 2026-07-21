# Contributing

Two ways to help, and the first one needs no code at all.

## 1. Do the homework for a shop

The hard part of supporting a store isn't the adapter — it's finding where the
shop keeps its per-size stock, and proving that what we read matches what a
shopper sees. Open a
**[store request](../../issues/new?template=store-request.yml)** and fill in what
you can. The form walks you through it.

What makes a request genuinely actionable:

| | Why it matters |
|---|---|
| A product link **with a sold-out size** | A fully-in-stock page looks identical whether the parser works or is silently wrong. The sold-out case is the one that catches bugs. |
| The request URL carrying the data | Tells us whether to read the HTML or call an API — a completely different adapter either way. |
| The response body | Lets the adapter be written and tested without hammering the shop. |
| **A screenshot of the size selector** | The ground truth. Without it we can only prove our code runs, not that it's correct. |
| Country / currency | Prices and stock are market-specific; a reading without a market is unverifiable. |

That last row is the whole discipline of this project in one line: **every
reading gets checked against a live page or a screenshot before we trust it.**
Almost every bug we've shipped came from skipping it.

## 2. Write an adapter

Copy [`_template.mjs`](supabase/functions/_shared/adapters/_template.mjs) and
work through the checklist inside it. Add it to `adapters/index.mjs` (dispatch),
`router.mjs` (host → name, plus `DEFENDED` if it needs an unblocker key),
`resolve.mjs` (URL → selector), `policy.mjs` (cost tier), and `urlguard.mjs` (URL
canonicaliser). Tests live in `test/`; run them with `node --test test/`.

### The contract

An adapter turns an `Item` into a `Reading` or a `ReadError`:

```js
{ ok: true,  price, currency, available, variants: [{ id, label, price, available, state }], title, checkedAt }
{ ok: false, kind: "blocked"|"timeout"|"http"|"parse"|"soft"|"permanent", message, checkedAt }
```

`state` is one of `in_stock`, `low_stock`, `coming_soon`, `out_of_stock` (see
`stock.mjs`). Only the first two are buyable.

### Two rules that aren't negotiable

**Unknown is never "in stock."** If you can't tell what a page is saying, return
a failure. A false "your size is back" sends someone to a sold-out page; a false
"sold out" makes them miss the restock they were waiting for. Both are worse than
saying nothing.

**A page you couldn't read is a soft failure, not a reading.** A 200 OK can still
be a challenge page or an empty shell. Validate that the data you need is
actually present — `fetchMaybeUnblocked` takes a `validate` callback for exactly
this — and fail loudly rather than parsing a husk into confident nonsense.

### Fixtures vary by STATE, not by product

`test/fixtures/` holds real captured pages. When adding one, ask what *situation*
it covers — sold out, one size left, on sale, coming soon, an auction — not which
product it is. A second fixture of another in-stock item tests nothing the first
one didn't. Trim them to the markup the parser touches, then confirm the trimmed
file still exercises the code path: more than once a fixture has been trimmed so
enthusiastically that it dropped the very variant under test.

## Known traps

Every one of these cost us a real bug. Skimming this list is the cheapest hour
you'll spend on an adapter.

- **Product-level availability lies.** One store reported
  `inventory.status: "in_stock"` on an item whose `quantity` was `0`. If a
  quantity is present, believe the quantity.
- **Variant parameters change everything.** `?variant=`, `?var=` and friends
  change the price *and* the stock. One eBay listing read USD 5.69 / "Last one"
  without its `?var=`, and USD 5.99 / "10 available" with it. Preserve them
  through canonicalisation, or you'll watch a different thing than the user asked
  for.
- **Other people's products are on the page.** Marketplace pages carry carousels
  of unrelated listings, each with its own badge. One eBay page had four
  "LAST ONE" and three "Out of stock" markers belonging to neighbours while the
  item itself had ten available. Scope every stock read to the listing's own
  container.
- **Distance from an anchor is a measurement, not a guess.** Amazon's stock line
  sits roughly 67,000 characters from `id="availability"`. A window sized by
  intuition will either miss it or swallow half the page — and may appear to work
  by coincidence on the full page while failing on a trimmed one.
- **Stock vocabularies change without warning.** If a shop's status field returns
  a word you don't recognise, treat the whole reading as untrustworthy rather than
  mapping it to a guess.
- **Sold-out sizes sometimes vanish** instead of greying out, so "my size isn't in
  the list" and "my size is unavailable" can look identical. Say which one you're
  reporting.
- **Regional hosts may be unreachable** even when the product is global. eBay's
  country domains can't be fetched through an unblocker at all, so we read
  `ebay.com` and tell the user their prices come back in USD.

## Before opening a PR

- `node --test test/` passes.
- Any new user-facing string is added to the content inventory (ask, and we'll
  point you at it) — the bot's voice is deliberately consistent.
- New readings have been eyeballed against the live page at least once. Say so in
  the PR; it's the check we care most about.
