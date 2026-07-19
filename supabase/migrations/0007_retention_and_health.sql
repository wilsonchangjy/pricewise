-- Phase 1 — keeping the system honest about its own health.
--
-- Two jobs, both pure Postgres:
--
--   prune_readings()  — bounds storage. product_readings is append-only and each
--     row carries the fat `variants` blob, which is what actually fills a free
--     tier (checks are cheap; storage is the cliff). The checker already only
--     writes on CHANGE; this compacts what's left.
--
--   notify_owner_if_unhealthy() — the backlog alarm. Deliberately implemented in
--     the DATABASE, not in the checker: a monitor that runs inside the thing it
--     monitors goes quiet exactly when you need it most.

-- ── retention ────────────────────────────────────────────────────────────────
-- Two tiers, because price HISTORY is a feature ("lowest in 90 days") while the
-- per-size variants blob is only interesting while it's recent:
--   1. keep the 5 newest rows per product intact, plus anything under 30 days
--   2. older rows keep price/currency/available but lose `variants` (~95% of bytes)
--   3. anything past a year goes entirely
create or replace function prune_readings()
returns table(compacted int, deleted int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_compacted int;
  v_deleted   int;
begin
  with ranked as (
    select id, row_number() over (partition by product_id order by checked_at desc) as rn, checked_at
      from product_readings
     where variants is not null and variants <> '[]'::jsonb
  )
  update product_readings p
     set variants = '[]'::jsonb
    from ranked r
   where p.id = r.id
     and r.rn > 5
     and r.checked_at < now() - interval '30 days';
  get diagnostics v_compacted = row_count;

  delete from product_readings where checked_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;

  return query select v_compacted, v_deleted;
end $$;

-- ── health ───────────────────────────────────────────────────────────────────
-- "Overdue" = a full 15 minutes past due. The cron ticks every 5 minutes and
-- claims 20 products, so anything later than that means the queue is stretching:
-- nothing errors when we're over capacity, items just quietly get checked late,
-- which turns "catch the window" into "we'll tell you eventually".
create or replace function checker_health()
returns table(
  active_products    int,
  overdue            int,
  worst_overdue_min  int,
  backing_off        int,
  dead               int,
  reading_rows       bigint,
  readings_size      text,
  last_success_min   int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::int from tracked_products where status <> 'dead'),
    (select count(*)::int from tracked_products
      where status <> 'dead' and next_check_at < now() - interval '15 minutes'),
    (select coalesce(max(extract(epoch from (now() - next_check_at)) / 60), 0)::int
       from tracked_products where status <> 'dead' and next_check_at < now()),
    (select count(*)::int from tracked_products where status = 'backing_off'),
    (select count(*)::int from tracked_products where status = 'dead'),
    (select count(*) from product_readings),
    pg_size_pretty(pg_total_relation_size('product_readings')),
    (select coalesce(min(extract(epoch from (now() - last_ok_at)) / 60), 999999)::int
       from tracked_products where status <> 'dead');
$$;

-- Sends ONLY when something is wrong, so a silent bot means a healthy bot.
-- Needs two Vault secrets: 'telegram_bot_token' and 'owner_chat_id'.
create or replace function notify_owner_if_unhealthy()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  h        record;
  v_token  text;
  v_chat   text;
  v_text   text;
begin
  select * into h from checker_health();

  -- Healthy: backlog clear, nothing parked, and a successful check within 24h.
  if h.overdue = 0 and h.dead = 0 and h.last_success_min < 1440 then
    return;
  end if;

  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';
  select decrypted_secret into v_chat  from vault.decrypted_secrets where name = 'owner_chat_id';
  if v_token is null or v_chat is null then
    raise warning 'notify_owner_if_unhealthy: vault secrets missing — cannot alert';
    return;
  end if;

  v_text := '🩺 Pricewise health' || chr(10) ||
            'Tracked: ' || h.active_products || chr(10) ||
            'Overdue: ' || h.overdue || (case when h.overdue > 0
                 then ' (worst ' || h.worst_overdue_min || ' min late)' else '' end) || chr(10) ||
            'Backing off: ' || h.backing_off || ' · Parked: ' || h.dead || chr(10) ||
            'Readings: ' || h.reading_rows || ' rows, ' || h.readings_size || chr(10) ||
            'Last successful check: ' || h.last_success_min || ' min ago';

  perform net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    headers := jsonb_build_object('content-type', 'application/json'),
    body    := jsonb_build_object('chat_id', v_chat, 'text', v_text,
                                  'disable_web_page_preview', true)
  );
end $$;

revoke all on function prune_readings()            from anon, authenticated;
revoke all on function checker_health()            from anon, authenticated;
revoke all on function notify_owner_if_unhealthy() from anon, authenticated;
