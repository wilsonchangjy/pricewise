-- Health monitor: stop crying wolf over items nobody is watching.
--
-- `status = 'dead'` is set by THREE different paths, and only two are bad news:
--
--   1. recordFailure()      — gave up after MAX_FAILURES on something you track
--   2. permanent refusal    — e.g. an eBay auction we will never track
--   3. retireIfOrphaned()   — nobody subscribes any more, so stop paying to fetch
--
-- (3) is the system working correctly. But checker_health() counted all three as
-- "Parked", so a correctly-retired item tripped the DAILY alarm forever: Wilson
-- swapped one Farfetch URL for another variant of the same bag, the old row was
-- retired exactly as designed, and the bot then reported "Parked: 1" every
-- morning with nothing wrong.
--
-- An item nobody watches cannot be unhealthy in a way a user cares about. So the
-- two cases are now separate columns: `parked` (dead AND still subscribed —
-- alarms) and `orphaned` (dead AND unwatched — informational only).
--
-- Return type changes, so the function is dropped rather than replaced.

drop function if exists notify_owner_if_unhealthy();
drop function if exists checker_health();

create function checker_health()
returns table(
  active_products    int,
  overdue            int,
  worst_overdue_min  int,
  backing_off        int,
  parked             int,     -- dead, and someone still has it on their list
  orphaned           int,     -- dead because no one does (benign, never alarms)
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
    -- Any subscription at all counts, including a paused one: the item is still
    -- on somebody's list, so us giving up on it is news they want.
    (select count(*)::int from tracked_products tp
      where tp.status = 'dead'
        and exists (select 1 from subscriptions s where s.product_id = tp.id)),
    (select count(*)::int from tracked_products tp
      where tp.status = 'dead'
        and not exists (select 1 from subscriptions s where s.product_id = tp.id)),
    (select count(*) from product_readings),
    pg_size_pretty(pg_total_relation_size('product_readings')),
    (select coalesce(min(extract(epoch from (now() - last_ok_at)) / 60), 999999)::int
       from tracked_products where status <> 'dead');
$$;

-- Sends ONLY when something is wrong, so a silent bot means a healthy bot.
-- Needs two Vault secrets: 'telegram_bot_token' and 'owner_chat_id'.
create function notify_owner_if_unhealthy()
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

  -- Healthy: backlog clear, nothing parked that anyone watches, and a successful
  -- check within 24h. `orphaned` is deliberately absent from this test.
  if h.overdue = 0 and h.parked = 0 and h.last_success_min < 1440 then
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
            'Backing off: ' || h.backing_off || ' · Parked: ' || h.parked ||
              (case when h.orphaned > 0
                 then ' (plus ' || h.orphaned || ' retired, nobody watching)' else '' end) || chr(10) ||
            'Readings: ' || h.reading_rows || ' rows, ' || h.readings_size || chr(10) ||
            'Last successful check: ' || h.last_success_min || ' min ago';

  perform net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    headers := jsonb_build_object('content-type', 'application/json'),
    body    := jsonb_build_object('chat_id', v_chat, 'text', v_text,
                                  'disable_web_page_preview', true)
  );
end $$;

revoke all on function checker_health()            from anon, authenticated;
revoke all on function notify_owner_if_unhealthy() from anon, authenticated;
