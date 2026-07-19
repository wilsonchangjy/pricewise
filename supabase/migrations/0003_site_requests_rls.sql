-- Enable RLS on site_requests (0002 missed it). No policies: only the
-- service-role Edge Functions touch this table, and they bypass RLS. This just
-- closes anon/authenticated access to the demand log.
alter table public.site_requests enable row level security;
