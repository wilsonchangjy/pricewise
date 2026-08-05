-- Phase 1 — BYO model keys (Anthropic / OpenAI) for describe-an-item search.
--
-- A SECOND key kind, deliberately in its own table rather than a `kind` column
-- on user_api_keys: that table is keyed one-row-per-user (`on conflict (user_id)`)
-- and every unblocker path — get_unblocker_key_for_product, the credit tracking,
-- count_defended_subscriptions — joins it expecting exactly that. Widening its
-- key would have meant touching all of them to add `and kind = 'unblocker'`, and
-- a single missed join would silently hand an Anthropic key to Scrape.do.
--
-- Same custody rules as the unblocker key: Vault at rest, SECURITY DEFINER to
-- read, and the Telegram message carrying it deleted by the webhook on receipt.

create table if not exists user_ai_keys (
  user_id         bigint primary key references users(id) on delete cascade,
  provider        text not null,               -- 'anthropic' | 'openai'
  vault_secret_id uuid not null,
  updated_at      timestamptz not null default now()
);
alter table user_ai_keys enable row level security;
-- No policies: only the service role (Edge Functions) and the definer functions
-- below ever touch this. RLS on with zero policies = deny to anon/authenticated.

-- ── set: create or rotate ────────────────────────────────────────────────────
create or replace function set_user_ai_key(p_user_id bigint, p_key text, p_provider text)
returns void
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_existing uuid;
  v_name     text := 'ai_user_' || p_user_id;
begin
  select vault_secret_id into v_existing from user_ai_keys where user_id = p_user_id;

  if v_existing is not null then
    perform vault.update_secret(v_existing, p_key, v_name, 'Pricewise BYO model key');
    update user_ai_keys set provider = p_provider, updated_at = now() where user_id = p_user_id;
  else
    insert into user_ai_keys (user_id, provider, vault_secret_id)
    values (p_user_id, p_provider,
            vault.create_secret(p_key, v_name, 'Pricewise BYO model key'))
    on conflict (user_id) do update
       set provider = excluded.provider,
           vault_secret_id = excluded.vault_secret_id,
           updated_at = now();
  end if;
end $$;

-- ── get: returns the key AND which service it's for, in one round trip ───────
-- Returning them together removes a whole class of bug: a key read without its
-- provider is a key you might send to the wrong API.
create or replace function get_user_ai_key(p_user_id bigint)
returns table (api_key text, provider text)
language sql
security definer
set search_path = public, vault, extensions
stable
as $$
  select s.decrypted_secret, k.provider
    from user_ai_keys k
    join vault.decrypted_secrets s on s.id = k.vault_secret_id
   where k.user_id = p_user_id;
$$;

-- ── forget: the user asked us to stop holding it ─────────────────────────────
create or replace function delete_user_ai_key(p_user_id bigint)
returns void
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_existing uuid;
begin
  select vault_secret_id into v_existing from user_ai_keys where user_id = p_user_id;
  if v_existing is null then return; end if;
  delete from user_ai_keys where user_id = p_user_id;
  delete from vault.secrets where id = v_existing;   -- the secret itself, not just the pointer
end $$;

revoke all on function set_user_ai_key(bigint, text, text) from anon, authenticated;
revoke all on function get_user_ai_key(bigint)             from anon, authenticated;
revoke all on function delete_user_ai_key(bigint)          from anon, authenticated;
