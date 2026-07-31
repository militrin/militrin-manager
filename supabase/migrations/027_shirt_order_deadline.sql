-- 025_shirt_order_deadline.sql
-- Data-limite para encomenda de camisetas por evento.

alter table if exists public.events
  add column if not exists shirt_order_deadline timestamptz;
