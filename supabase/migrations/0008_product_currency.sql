-- A price without its currency is a guess. /list rendered "now 1450" for a
-- Farfetch item in USD, "now 870" for MR PORTER in GBP and "now 59.9" for
-- Uniqlo in SGD — identically, which invites exactly the wrong comparison.
-- The alerting path already prints currency (alerting.fmt); the list read from
-- subscriptions, which never carried one.
--
-- Currency belongs to the PRODUCT, not the reading: it's a property of the shop
-- and locale, stable across checks. Denormalised onto tracked_products so the
-- bot can render a list without joining every product's latest reading.
alter table tracked_products add column if not exists currency text;

comment on column tracked_products.currency is
  'Currency of this product''s prices, learned from the latest successful reading. Denormalised from product_readings so /list can show it without an N+1 join.';

update tracked_products tp
   set currency = r.currency
  from (
    select distinct on (product_id) product_id, currency
      from product_readings
     where currency is not null and currency <> ''
     order by product_id, checked_at desc
  ) r
 where r.product_id = tp.id
   and tp.currency is null;
