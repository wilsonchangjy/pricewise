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
Stradivarius, Bershka, & Other Stories, Wix stores**, and any site with standard
product data. That's a huge slice of fashion retail.

**Bot-protected stores** (Zara, Massimo Dutti, ASOS, …) need an unblocker, so
they're opt-in: bring your own free [ScrapingBee](https://www.scrapingbee.com/)
key with `/setkey` (up to 5 items, checked daily, on your own credits).

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

| Command | What it does |
|---|---|
| paste a URL / `/add <url>` | start tracking an item |
| `/list` | show your tracked items |
| `/remove <n>` | stop tracking one |
| `/setprice <n> <price>` | alert only at/below a price |
| `/pause <n>` · `/resume <n>` | mute / unmute |
| `/setkey <key>` | add your ScrapingBee key for bot-protected stores |

## Self-hosting

It's a Supabase project + a Telegram bot — no servers to run. Full steps in
**[SETUP.md](SETUP.md)**: create the project, apply the migrations in
`supabase/migrations/`, deploy the two Edge Functions, and point the bot's
webhook at it.

## Contributing

New store adapters are very welcome — each is a small, self-contained module that
turns a product URL into `{ price, per-size availability }`. See
`supabase/functions/_shared/adapters/` for examples, and `test/` for how they're
verified. Bug reports and store requests (the bot logs unsupported sites) help
prioritise what to add next.

## License

MIT — see [LICENSE](LICENSE). Fork it, self-host it, make it yours.
