-- Phase 1 — the clock. pg_cron ticks every 5 min and pokes the checker Edge
-- Function over HTTP (pg_net). The tick is cheap: claim_due_products() only
-- returns products whose own interval has elapsed (3h free / 24h defended), so
-- a frequent tick just means alerts land promptly, not more fetches.
--
-- Self-hosters: replace the URL below with your own project's, then store the
-- bearer token once (see SETUP.md):
--   select vault.create_secret('<anon or service-role key>', 'checker_auth_key', 'cron -> checker');
-- and schedule it:
--   select cron.schedule('pricewise-checker', '*/5 * * * *', $$select public.run_checker();$$);

create extension if not exists pg_net with schema extensions;

create or replace function public.run_checker()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_key text;
begin
  -- Auth for the call lives in Vault, never inline in the cron command.
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'checker_auth_key';
  if v_key is null then
    raise warning 'run_checker: vault secret checker_auth_key is missing — skipping tick';
    return;
  end if;

  perform net.http_post(
    url     := 'https://hjkqnkwjjdvnndnhbprf.supabase.co/functions/v1/checker',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'authorization', 'Bearer ' || v_key),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end $$;

revoke all on function public.run_checker() from anon, authenticated;
