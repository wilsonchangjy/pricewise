# 🛍️ Pricewise

**Never miss the window again.** Pricewise watches the fashion items you're
eyeing and pings you on Telegram the moment your size restocks or the price
drops — so you buy at the right time instead of finding out too late.

It's built for how people actually shop online: you keep a handful of
high-intent items across different brands, and you care about **your** size, not
just "is it in stock somewhere."

## What you get

- 📉 **Price-drop alerts** (and a heads-up if a price jumps).
- 👕 **Per-size stock** — "your size S is back," not just "available."
- 🔗 Every alert links straight to the product so you can grab it.
- 🎯 Optional **target price** — only ping me below $X.
- 💬 All on **Telegram** — add an item by pasting its link to the bot.

## Supported stores

`/stores` in the bot prints this same list, always current — it's generated from
the code, not written twice.

### Free — just paste a link

| Store | Notes |
|---|---|
| **Any Shopify store** | thousands of independent brands |
| **END.** | sold-out sizes aren't published, so they can't be pre-picked |
| **Uniqlo** | |
| **COS** | |
| **Mango** | |
| **Wix stores** | |
| **Most other shops** | read automatically wherever a site publishes standard product data — product-level, not per size |

### Bring your own key (`/setkey`)

These block bots, so checks run through an unblocker on **your** credits — up to
5 such items. The bot quotes the monthly cost before you commit to one.

| Store | Per check | Notes |
|---|---|---|
| **Amazon** | 1 credit | each size is its own listing, so the link pins your size |
| **eBay** | 1 credit | fixed-price listings only; prices in USD |
| **ASOS** | 1 credit | |
| **Bershka** | 1 credit | |
| **Stradivarius** | 1 credit | |
| **& Other Stories** | 1 credit | |
| **Farfetch** | 1 credit | 6h | |
| **Massimo Dutti & Oysho** | 5 credits | |
| **Zara** | 10 credits | |
| **MR PORTER** | 10 credits | prices in GBP |
| **NET-A-PORTER** | 10 credits | prices in USD |
| **Cettire** | 10 credits | prices in USD |

`/providers` lists the unblocker services that work and their free tiers — some
renew monthly, which matters more than the headline number.

**A few things worth knowing**

- **Self-hosting from home?** Inditex brands (Zara, Bershka, Stradivarius…) block
  datacentre IPs but not residential ones, so those adapters try direct first and
  cost you nothing on a home connection.
- **Share links work.** The short URLs store apps hand out (`amzn.asia`,
  `s.lazada.sg` and friends) are followed to the real product page.
- **eBay** is read from `ebay.com`; regional hosts like `ebay.com.sg` can't be
  reached through an unblocker and item numbers are global, so prices come back
  in USD. The bot says so when you add one.
- **Missing a shop?** Send the link anyway — unknown sites are tried against
  standard product data first, and logged as a request if that fails.

## How it works

```
You ──paste a link──▶ Telegram bot ──▶ Supabase (your list)
                                          │
                         every few hours: check price + per-size stock
                                          │
        change detected ──▶ alert back to you on Telegram
```

- **Supabase Postgres** holds each user's list (one row per item you track).
- Two **Edge Functions**: a Telegram *webhook* (commands) and a *checker* (on a
  schedule) that reads each store via a small per-brand **adapter**.
- Shared items are fetched **once** and alerted to everyone watching them.

## Using the bot

Most of the bot lives behind two commands. Paste a link to track something, then
tap it in your list to change anything about it.

| Command | What it does |
|---|---|
| paste a URL / `/add <url>` | start tracking an item |
| `/list` | your items — **tap one** to set its size, a price-drop target, how often it's checked, see its history, or remove it |
| `/stores` | which shops are supported, and which need a key |
| `/prefs` | your default size and check frequency, limits, and credit balance |
| `/setkey <key>` | add your own unblocker key for bot-protected stores (`/providers` lists the options) |
| `/help` | the short version of this |

Everything on an item is a tap, not a command to memorise — the size picker shows
what the shop actually stocks, and a price target is a preset (−10% / −20% / −30%
of the current price). Check frequency can be set per item, or in `/prefs` for
everything at once (or just the bot-protected ones that spend your credits).

Small price moves are ignored on purpose: a drop has to be at least **5% and 2
currency units** before it's worth interrupting you. A price target you set always
alerts, however small the step.

## Self-hosting

It's a Supabase project + a Telegram bot — no servers to run. Full steps in
**[SETUP.md](SETUP.md)**: create the project, apply the migrations in
`supabase/migrations/`, deploy the two Edge Functions, and point the bot's
webhook at it.

## Contributing

**You don't need to write code to help.** The slow part of supporting a shop is
working out where it hides its per-size stock — browser work, not programming.
Open a [store request](../../issues/new?template=store-request.yml) and the form
walks you through it.

Writing an adapter is welcome too: each is a small, self-contained module turning
a product URL into `{ price, per-size availability }`. See
**[CONTRIBUTING.md](CONTRIBUTING.md)** for the contract, a copyable template, and
a list of the traps that have already bitten us.

## License

MIT — see [LICENSE](LICENSE). Fork it, self-host it, make it yours.
