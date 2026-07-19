-- Pricewise Phase 1 — multi-user schema (decision D9).
-- Split "what we check" (tracked_products) from "who wants it" (subscriptions):
-- N friends on the same URL => ONE fetch, N alerts. Append-only readings history.
--
-- Applied by the Supabase CLI (supabase db push) or the SQL editor. Edge
-- Functions use the service role and bypass RLS; RLS below is a deny-by-default
-- guard for the eventual web dashboard (phase 2). Times are UTC (timestamptz).

-- ── users ────────────────────────────────────────────────────────────────────
create table if not exists users (
  id                bigint generated always as identity primary key,
  telegram_user_id  bigint not null unique,          -- tenant key
  telegram_chat_id  bigint not null,                 -- where alerts go
  settings          jsonb  not null default '{}',    -- {default_interval_minutes, quiet_hours, currency, ...}
  is_allowed        boolean not null default false,  -- allowlist guard for controlled rollout
  created_at        timestamptz not null default now()
);

-- ── tracked_products ── one row per URL (the fetch target + its clock) ─────────
create table if not exists tracked_products (
  id                     bigint generated always as identity primary key,
  url                    text not null unique,
  adapter                text not null,              -- shopify | uniqlo | inditex | ... (from the /add router)
  fetch_strategy         text not null default 'direct'  check (fetch_strategy in ('direct','unblocker')),
  market                 text,                       -- locale/country derived from the URL
  title                  text,
  -- scheduling: next_check_at is the clock; interval = min over all subscribers
  next_check_at          timestamptz not null default now(),
  check_interval_minutes int not null default 180,
  last_checked_at        timestamptz,
  last_ok_at             timestamptz,
  consecutive_failures   int not null default 0,     -- drives exponential back-off
  status                 text not null default 'active' check (status in ('active','backing_off','dead')),
  created_at             timestamptz not null default now()
);
create index if not exists tracked_products_due_idx
  on tracked_products (next_check_at) where status <> 'dead';

-- ── subscriptions ── one row per user × product × variant ─────────────────────
create table if not exists subscriptions (
  id               bigint generated always as identity primary key,
  user_id          bigint not null references users(id) on delete cascade,
  product_id       bigint not null references tracked_products(id) on delete cascade,
  variant_id       text,                             -- chosen size/colour key (adapter-specific); null = any
  variant_label    text,                             -- human label for messages ("size S", "Navy / 32inch")
  target_price     numeric(12,2),                    -- alert at/below this
  alert_on         jsonb not null default '{"price_drop":true,"price_up":true,"restock":true,"low_stock":true}',
  interval_minutes int,                              -- per-sub override; product interval = min(...)
  status           text not null default 'active' check (status in ('active','paused')),
  snooze_until     timestamptz,
  last_alert_price numeric(12,2),                    -- dedup: last price we alerted at
  last_alert_status text,                            -- dedup: in_stock | oos | low
  created_at       timestamptz not null default now(),
  unique (user_id, product_id, variant_id)
);
create index if not exists subscriptions_product_idx on subscriptions (product_id);

-- ── product_readings ── append-only history, one row per product per check ────
create table if not exists product_readings (
  id               bigint generated always as identity primary key,
  product_id       bigint not null references tracked_products(id) on delete cascade,
  checked_at       timestamptz not null default now(),
  price            numeric(12,2),
  compare_at_price numeric(12,2),
  currency         text,
  available        boolean,                          -- any variant in stock
  variants         jsonb,                            -- [{id, label, price, available}] matrix
  raw_status       text not null default 'ok' check (raw_status in ('ok','oos','blocked','error','soft'))
);
create index if not exists product_readings_history_idx on product_readings (product_id, checked_at desc);

-- ── alerts (optional log) ─────────────────────────────────────────────────────
create table if not exists alerts (
  id              bigint generated always as identity primary key,
  subscription_id bigint not null references subscriptions(id) on delete cascade,
  kind            text not null,                     -- baseline|price_drop|price_up|restock|oos|low_stock|target_hit
  payload         jsonb,
  sent_at         timestamptz not null default now()
);

-- RLS: deny-by-default (service role bypasses). Phase-2 web dashboard adds
-- per-user policies keyed on auth.jwt() -> telegram_user_id.
alter table users            enable row level security;
alter table tracked_products enable row level security;
alter table subscriptions    enable row level security;
alter table product_readings enable row level security;
alter table alerts           enable row level security;

-- ── claim_due_products ── the checker calls this each pg_cron tick ────────────
-- SELECT ... FOR UPDATE SKIP LOCKED so overlapping ticks never double-check a row.
create or replace function claim_due_products(batch_size int default 20)
returns setof tracked_products
language sql
as $$
  update tracked_products t
     set last_checked_at = now()
   where t.id in (
     select id from tracked_products
      where status <> 'dead' and next_check_at <= now()
      order by next_check_at
      for update skip locked
      limit batch_size
   )
  returning t.*;
$$;
