-- The currency a banked alert price was read in.
--
-- last_alert_price stored a bare number whose currency was implied by whatever
-- the adapter happened to return that day. When market pinning changed two
-- items from AUD/EUR to SGD, the alerting state machine compared the old number
-- to the new one and sent two price movements that had never happened:
--   "PRICE UP:   SGD 380.00 -> SGD 418.00 (+10%)"   (the 380 was AUD)
--   "PRICE DROP: SGD 398.00 -> SGD 362.00 (9% off)" (the 398 was EUR)
--
-- Recording the currency alongside the price makes that comparison decidable.
-- NULL means "banked before we tracked this", which the guard treats as unknown
-- rather than as a change — so existing rows keep behaving exactly as they did.
alter table subscriptions add column if not exists last_alert_currency text;

comment on column subscriptions.last_alert_currency is
  'Currency of last_alert_price. NULL = unknown (pre-0013 row); a change between two KNOWN currencies re-baselines the item instead of alerting.';
