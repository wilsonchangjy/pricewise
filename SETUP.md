# Pricewise Phase 1 — setup (your side)

What **you** do vs. what **I** build. Nothing here needs the unblocker/credits —
defended sites are opt-in per user (their own key).

## ✅ You can do now (unblocks the rest)

1. **Create a Supabase project** (free tier) at supabase.com → note the project
   URL and the **service_role** key (Settings → API).
2. **Apply the schema** — in the Supabase SQL editor, run, in order:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_keys_and_requests.sql`
   (or `supabase link` + `supabase db push` if you use the CLI).
3. **Enable extensions** (Database → Extensions): `pg_cron`, and `pgsodium` **or**
   Vault (for encrypting users' ScrapingBee keys).
4. **Bot:** reuse the existing @BotFather bot, or make a fresh one for the public
   build → note the token. Register the slash-command menu with
   `TELEGRAM_BOT_TOKEN=… ./scripts/set-telegram-commands.sh` — that list lives on
   Telegram's servers, not in the code, so it's the one thing a code deploy won't
   update. Re-run it whenever the command set changes.
5. **Public repo (optional now):** create an empty GitHub repo. When the code's
   ready I'll extract `phase1/` into it (clean history, MIT license) — nothing
   personal is in the code.

## ⏳ I build next (code)

- Port the 12 Phase 0 adapters to Deno (they're pure ESM — near-copy).
- **`webhook` Edge Function** — validates the Telegram secret header, parses the
  message (`src/commands.mjs`), applies the credit policy (`src/policy.mjs`),
  reads/writes Supabase, deletes `/setkey` messages, replies.
- **`checker` Edge Function** — `claim_due_products()` → read via the adapter
  (decrypting the user's key for defended) → diff → alert → write readings.

## ⏳ You deploy (once I hand off the functions)

6. `supabase functions deploy webhook checker`
7. **Secrets:** `supabase secrets set TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=<random>`
   (no global `UNBLOCKER_KEY` — users bring their own).
8. **Register the webhook:**
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project>.functions.supabase.co/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"`
9. **Schedule the checker** (SQL editor):
   `select cron.schedule('pricewise-checker','*/15 * * * *', $$select net.http_post('https://<project>.functions.supabase.co/checker', '{}', 'application/json')$$);`
10. **Allowlist yourself** (then friends): `update users set is_allowed = true where telegram_user_id = <you>;`
    (a row is created the first time you message the bot).

## Rollout
Start with yourself + a few friends (`is_allowed`), watch `site_requests` for
demand, and keep defended usage on BYO-keys. Migrate your Phase 0 list by
`/add`-ing the URLs, or a one-off seed script.
