-- Referencia publica compartilhada para pedidos de inscricao e da loja.
-- order_number e tokens permanecem internos para compatibilidade.
begin;

alter table public.orders add column if not exists display_number bigint;
alter table public.store_orders add column if not exists display_number bigint;

update public.orders
set display_number = substring(order_number from '^MIL-[0-9]{4}-([0-9]+)$')::bigint
where display_number is null and order_number ~ '^MIL-[0-9]{4}-[0-9]+$';

-- Pedidos historicos fora do formato MIL tambem recebem referencia publica.
with base as (
  select greatest(
    coalesce((select max(display_number) from public.orders), 0),
    coalesce((select last_value from public.order_number_seq), 0)
  ) as value
), numbered as (
  select o.id, base.value + row_number() over (order by o.created_at, o.id) as display_number
  from public.orders o cross join base
  where o.display_number is null
)
update public.orders o
set display_number = numbered.display_number
from numbered where numbered.id = o.id;

-- Backfill deterministico das compras/concessoes da loja, na ordem de criacao.
with base as (
  select greatest(
    coalesce((select max(display_number) from public.orders), 0),
    coalesce((select last_value from public.order_number_seq), 0)
  ) as value
), numbered as (
  select so.id, base.value + row_number() over (order by so.created_at, so.id) as display_number
  from public.store_orders so cross join base
  where so.display_number is null
)
update public.store_orders so
set display_number = numbered.display_number
from numbered where numbered.id = so.id;

select setval(
  'public.order_number_seq',
  greatest(
    coalesce((select max(display_number) from public.orders), 0),
    coalesce((select max(display_number) from public.store_orders), 0),
    1
  ),
  true
);

create or replace function public.assign_public_order_display_number()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
declare v_legacy_number bigint;
begin
  if new.display_number is not null then return new; end if;
  if tg_table_name = 'orders' and new.order_number ~ '^MIL-[0-9]{4}-[0-9]+$' then
    v_legacy_number := substring(new.order_number from '^MIL-[0-9]{4}-([0-9]+)$')::bigint;
  end if;
  new.display_number := coalesce(v_legacy_number, nextval('public.order_number_seq')::bigint);
  return new;
end; $$;

drop trigger if exists trg_orders_public_display_number on public.orders;
create trigger trg_orders_public_display_number before insert on public.orders
for each row execute function public.assign_public_order_display_number();

drop trigger if exists trg_store_orders_public_display_number on public.store_orders;
create trigger trg_store_orders_public_display_number before insert on public.store_orders
for each row execute function public.assign_public_order_display_number();

alter table public.orders alter column display_number set not null;
alter table public.store_orders alter column display_number set not null;
create unique index if not exists ux_orders_display_number on public.orders(display_number);
create unique index if not exists ux_store_orders_display_number on public.store_orders(display_number);
create index if not exists idx_orders_org_display_number on public.orders(organization_id, display_number);
create index if not exists idx_store_orders_org_display_number on public.store_orders(organization_id, display_number);

comment on column public.orders.display_number is 'Numero publico curto do pedido, compartilhado com store_orders pela order_number_seq.';
comment on column public.store_orders.display_number is 'Numero publico curto do pedido, compartilhado com orders pela order_number_seq.';

commit;
