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

**Free to track** (no setup): any **Shopify** store, plus **Uniqlo, Mango, COS,
Wix stores**, and any site with standard product data. That's a huge slice of
fashion retail.

**Bot-protected stores** (Amazon, Zara, Massimo Dutti, Oysho, ASOS, Bershka,
Stradivarius, Farfetch, MR PORTER, eBay, & Other Stories) need an unblocker, so they're opt-in: bring your
own key with `/setkey` — up to 5 such items, on your own credits. How often each
is checked follows what it costs: the cheap ones every 6 hours, the priciest
once a day, and the bot tells you the monthly cost before you add anything.
`/providers` lists the services that work and their free tiers — some renew
monthly, which matters more than the headline number.

Note for self-hosters: Inditex brands (Zara, Bershka, Stradivarius…) block
datacentre IPs but not home connections, so if you run this from a residential
network those adapters try direct first and cost you nothing.

On **Amazon**, paste the link for the size you want — each size is its own
listing there, so the link already pins your variant. It's the cheapest of the
bot-protected stores to check.

Share links work too: the short URLs that store apps hand out (`amzn.asia`,
`s.lazada.sg` and friends) are followed to the real product page.

**eBay** listings are read from `ebay.com` — regional hosts like `ebay.com.sg`
can't be reached through an unblocker, and item numbers are global. Prices
therefore come back in USD, which the bot tells you when you add one.

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
