-- Search results, remembered for a short while.
--
-- WHY: a search costs the user real money (a model call) and real time (up to
-- three bot-protected pages read through their unblocker). Three things make the
-- same search happen twice:
--   · a retry after a failure — the most common, and the most galling, because
--     the user is paying again for the query that already didn't work;
--   · a typo corrected — the correction is a new search, and often close enough
--     to the original to want the same answer;
--   · two people wanting the same thing, which is the whole reason this project
--     dedupes products in the first place.
--
-- WHAT IS SAFE TO CACHE: the URLs, and nothing else. Prices and stock are NOT
-- stored here — they go stale, and a stale price presented as current is the one
-- failure this project refuses to have. A cache hit re-reads every page through
-- the adapters exactly as a cold search does; it only skips the finding.
--
-- Keyed on the normalised query AND the country, because "castlery joseph bed"
-- has a different right answer in SG and in the US.

create table if not exists search_cache (
  query      text        not null,
  country    text        not null default '',
  urls       jsonb       not null,          -- [{url, hint}] — leads, never facts
  created_at timestamptz not null default now(),
  hits       integer     not null default 0,
  primary key (query, country)
);
alter table search_cache enable row level security;
-- No policies: Edge Functions use the service role. Nothing user-facing reads it.

create index if not exists search_cache_created_idx on search_cache (created_at);

-- ── read: a hit only counts while it's fresh ────────────────────────────────
-- Seven days. Long enough that a retry or a second person is free; short enough
-- that a product page that has since moved or been delisted stops being offered.
-- (A wrong URL is not dangerous — verification drops it — but it wastes a fetch.)
create or replace function get_cached_search(p_query text, p_country text, p_max_age_hours integer default 168)
returns jsonb
language sql
security definer
set search_path = public
as $$
  update search_cache
     set hits = hits + 1
   where query = p_query
     and country = coalesce(p_country, '')
     and created_at > now() - make_interval(hours => p_max_age_hours)
  returning urls;
$$;

-- ── write: last search wins ─────────────────────────────────────────────────
create or replace function put_cached_search(p_query text, p_country text, p_urls jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into search_cache (query, country, urls)
  values (p_query, coalesce(p_country, ''), p_urls)
  on conflict (query, country) do update
     set urls = excluded.urls, created_at = now(), hits = 0;
$$;

-- Housekeeping: this table has no reason to grow forever.
create or replace function prune_search_cache(p_keep_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from search_cache where created_at < now() - make_interval(days => p_keep_days);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function get_cached_search(text, text, integer) from anon, authenticated;
revoke all on function put_cached_search(text, text, jsonb)   from anon, authenticated;
revoke all on function prune_search_cache(integer)            from anon, authenticated;
