-- A product's price and stock are per-MARKET, not per-URL.
--
-- Measured on mutimer.co, one variant, one moment:
--   no country hint   380.00  out of stock   (whatever geography the fetcher is in)
--   ?country=GB       240.00  IN STOCK       (the UK warehouse has it)
--   ?country=SG       418.00  out of stock
-- So "the price of this URL" is not a thing that exists. Two subscribers in
-- different countries are watching genuinely different offers, and one shared
-- row cannot represent both.
--
-- `market` has been on this table since 0001 and was never populated or read.
-- Making it part of the identity is what it was for.

alter table tracked_products drop constraint if exists tracked_products_url_key;

-- coalesce so the existing NULL-market rows (meaning "unpinned, whatever the
-- fetcher sees") still collide with each other rather than multiplying.
create unique index if not exists tracked_products_url_market_key
  on tracked_products (url, coalesce(market, ''));

comment on column tracked_products.market is
  'ISO country whose storefront these readings are for (Shopify ?country=XX). '
  'NULL means unpinned — the reading reflects wherever the checker happened to '
  'fetch from, which is why it should be set.';
