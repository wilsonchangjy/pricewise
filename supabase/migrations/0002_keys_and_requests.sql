-- Phase 1 — credit policy support (decision D14):
-- BYO ScrapingBee keys for defended sites + a demand log for unsupported sites.

-- ── user_api_keys ── the user's OWN unblocker key (defended sites) ────────────
-- SECURITY: store encrypted. Prefer Supabase Vault (vault.create_secret) and
-- keep only the secret's uuid here; the column below is the fallback for a
-- pgsodium-encrypted value. NEVER store plaintext; the webhook deletes the
-- Telegram message that carried the key.
create table if not exists user_api_keys (
  user_id     bigint primary key references users(id) on delete cascade,
  provider    text not null default 'scrapingbee',
  vault_secret_id uuid,           -- preferred: Supabase Vault secret id
  encrypted_key   bytea,          -- fallback: pgsodium-encrypted key bytes
  updated_at  timestamptz not null default now(),
  check (vault_secret_id is not null or encrypted_key is not null)
);
alter table user_api_keys enable row level security;

-- ── site_requests ── every unsupported URL becomes a prioritisation signal ────
create table if not exists site_requests (
  host          text primary key,
  sample_url    text not null,
  request_count int not null default 1,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);

create or replace function log_site_request(p_url text)
returns void language plpgsql as $$
declare h text := lower(split_part(regexp_replace(p_url, '^https?://', ''), '/', 1));
begin
  insert into site_requests (host, sample_url)
       values (h, p_url)
  on conflict (host) do update
     set request_count = site_requests.request_count + 1,
         last_seen     = now();
end $$;

-- ── defended cap ── count a user's active DEFENDED subscriptions (limit = 5) ──
create or replace function count_defended_subscriptions(p_user_id bigint)
returns int language sql stable as $$
  select count(*)::int
    from subscriptions s
    join tracked_products t on t.id = s.product_id
   where s.user_id = p_user_id
     and s.status = 'active'
     and t.fetch_strategy = 'unblocker';
$$;
