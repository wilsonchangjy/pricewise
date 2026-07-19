-- Phase 1 — BYO ScrapingBee keys, stored in Supabase Vault (never plaintext).
--
-- The webhook passes the key to Postgres exactly once (over TLS); Vault encrypts
-- it at rest and only these SECURITY DEFINER functions can read it back. The
-- Telegram message carrying the key is deleted from the chat by the webhook.

-- ── set: create or rotate a user's key ───────────────────────────────────────
create or replace function set_user_api_key(p_user_id bigint, p_key text)
returns void
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_existing uuid;
  v_name     text := 'scrapingbee_user_' || p_user_id;
begin
  select vault_secret_id into v_existing from user_api_keys where user_id = p_user_id;

  if v_existing is not null then
    perform vault.update_secret(v_existing, p_key, v_name, 'Pricewise BYO unblocker key');
    update user_api_keys set updated_at = now() where user_id = p_user_id;
  else
    insert into user_api_keys (user_id, provider, vault_secret_id)
    values (p_user_id, 'scrapingbee',
            vault.create_secret(p_key, v_name, 'Pricewise BYO unblocker key'))
    on conflict (user_id) do update
       set vault_secret_id = excluded.vault_secret_id, updated_at = now();
  end if;
end $$;

-- ── get: the webhook/checker reads a key only when it needs to fetch ─────────
create or replace function get_user_api_key(p_user_id bigint)
returns text
language sql
security definer
set search_path = public, vault, extensions
stable
as $$
  select s.decrypted_secret
    from user_api_keys k
    join vault.decrypted_secrets s on s.id = k.vault_secret_id
   where k.user_id = p_user_id;
$$;

-- ── whose key pays for this product? ─────────────────────────────────────────
-- A defended product may be shared; the longest-standing subscriber with a key
-- funds the fetch, and everyone subscribed gets the alert.
create or replace function get_unblocker_key_for_product(p_product_id bigint)
returns text
language sql
security definer
set search_path = public, vault, extensions
stable
as $$
  select s.decrypted_secret
    from subscriptions sub
    join user_api_keys k on k.user_id = sub.user_id
    join vault.decrypted_secrets s on s.id = k.vault_secret_id
   where sub.product_id = p_product_id
     and sub.status = 'active'
   order by sub.created_at
   limit 1;
$$;

-- Only the service role (Edge Functions) may touch these.
revoke all on function set_user_api_key(bigint, text)      from anon, authenticated;
revoke all on function get_user_api_key(bigint)            from anon, authenticated;
revoke all on function get_unblocker_key_for_product(bigint) from anon, authenticated;
