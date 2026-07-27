/*
==================================================

ORDER ITEMS BLUEPRINT

Este arquivo NAO e uma migration.

Objetivo:

Preparar a futura evolucao do sistema para permitir
varios ingressos em um unico pedido.

Status:
PLANEJAMENTO

Nao executar.

==================================================
*/

-- Blueprint only: DO NOT APPLY in this sprint.
-- Goal: remove conceptual 1:1 constraint between orders and participants.

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  event_id uuid not null references public.events(id),
  participant_id uuid references public.participants(id) on delete set null,
  ticket_category_id uuid references public.ticket_categories(id),
  batch_id uuid references public.registration_batches(id),
  unit_price numeric(10,2) not null,
  discount_amount numeric(10,2) not null default 0,
  final_amount numeric(10,2) not null,
  status text not null default 'reserved',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_items_status_check check (status in ('reserved', 'confirmed', 'cancelled', 'refunded'))
);

create index if not exists idx_order_items_order_id on public.order_items(order_id);
create index if not exists idx_order_items_event_id on public.order_items(event_id);
create index if not exists idx_order_items_participant_id on public.order_items(participant_id);

-- Migration checklist for the future (not executed now):
-- 1) Backfill one order_item per legacy order/participant.
-- 2) Move totals source-of-truth from participant/payment to order_items aggregation.
-- 3) Remove unique constraint ux_orders_participant_id.
-- 4) Remove unique constraint ux_tickets_participant_id.
-- 5) Replace ensure_order_for_participant / confirm_order_and_issue_ticket by order-level functions.
-- 6) Use order_item as anchor for future official ticket transfer (see supabase/plans/030_ticket_transfer_blueprint.sql).
