-- 116_store_module_foundation.sql
-- Fundacao da "lojinha": modulo novo e isolado para itens opcionais vendidos
-- avulsos (pela conta do participante) ou como upsell na compra do ingresso.
-- Nao toca em shirt_inventory/event_kit_items/RPCs de checkout existentes -
-- e um braco totalmente novo, com suas proprias tabelas de catalogo, estoque
-- e pedido, espelhando o padrao ja usado por shirt_inventory/orders/payments.

begin;

-- ============================================================
-- 1. Catalogo
-- ============================================================

create table if not exists public.store_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  price numeric(10,2) not null default 0 check (price >= 0),
  requires_variant boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_store_items_event_slug on public.store_items (event_id, slug);
create index if not exists idx_store_items_event_active on public.store_items (event_id, is_active, sort_order);

create table if not exists public.store_item_variants (
  id uuid primary key default gen_random_uuid(),
  store_item_id uuid not null references public.store_items(id) on delete cascade,
  name text not null,
  value text not null,
  price_adjustment numeric(10,2) not null default 0,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_store_item_variants_item on public.store_item_variants (store_item_id, is_active, sort_order);

-- ============================================================
-- 2. Estoque (mesmo desenho de event_kit_item_variant_inventory)
-- ============================================================

create table if not exists public.store_item_inventory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  store_item_id uuid not null references public.store_items(id) on delete cascade,
  variant_id uuid references public.store_item_variants(id) on delete cascade,
  total_quantity integer not null default 0 check (total_quantity >= 0),
  reserved_quantity integer not null default 0 check (reserved_quantity >= 0),
  delivered_quantity integer not null default 0 check (delivered_quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_item_inventory_stock_bounds check (reserved_quantity + delivered_quantity <= total_quantity)
);

create unique index if not exists ux_store_item_inventory_item_variant
  on public.store_item_inventory (store_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ============================================================
-- 3. Pedidos da loja (espelha orders/order_items, sem tocar neles)
-- ============================================================

create table if not exists public.store_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  participant_id uuid references public.participants(id) on delete set null,
  order_number text not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'expired')),
  payment_method text,
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'refunded', 'cancelled')),
  base_amount numeric(10,2) not null default 0,
  final_amount numeric(10,2) not null default 0,
  notes text,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_store_orders_number on public.store_orders (order_number);
create index if not exists idx_store_orders_event on public.store_orders (event_id, status);
create index if not exists idx_store_orders_user on public.store_orders (user_id);

create table if not exists public.store_order_items (
  id uuid primary key default gen_random_uuid(),
  store_order_id uuid not null references public.store_orders(id) on delete cascade,
  store_item_id uuid not null references public.store_items(id),
  variant_id uuid references public.store_item_variants(id),
  quantity integer not null default 1 check (quantity > 0),
  unit_price numeric(10,2) not null,
  final_amount numeric(10,2) not null,
  status text not null default 'reserved' check (status in ('reserved', 'confirmed', 'delivered', 'cancelled')),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_store_order_items_order on public.store_order_items (store_order_id);

-- ============================================================
-- 4. organization_id automatico (mesmo padrao de trg_event_kit_items_set_org)
-- ============================================================

create or replace function public.trg_store_items_set_org()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.events where id = NEW.event_id;
  if not found or v_org is null then raise exception 'Evento % nao encontrado ou sem organization_id.', NEW.event_id; end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_items (esperado %).', v_org; end if;
  NEW.organization_id := v_org;
  return NEW;
end; $$;

drop trigger if exists trg_store_items_org on public.store_items;
create trigger trg_store_items_org before insert or update on public.store_items
  for each row execute function public.trg_store_items_set_org();

create or replace function public.trg_store_item_inventory_set_org()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.events where id = NEW.event_id;
  if not found or v_org is null then raise exception 'Evento % nao encontrado ou sem organization_id.', NEW.event_id; end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_item_inventory (esperado %).', v_org; end if;
  NEW.organization_id := v_org;
  return NEW;
end; $$;

drop trigger if exists trg_store_item_inventory_org on public.store_item_inventory;
create trigger trg_store_item_inventory_org before insert or update on public.store_item_inventory
  for each row execute function public.trg_store_item_inventory_set_org();

create or replace function public.trg_store_orders_set_org()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.events where id = NEW.event_id;
  if not found or v_org is null then raise exception 'Evento % nao encontrado ou sem organization_id.', NEW.event_id; end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_orders (esperado %).', v_org; end if;
  NEW.organization_id := v_org;
  return NEW;
end; $$;

drop trigger if exists trg_store_orders_org on public.store_orders;
create trigger trg_store_orders_org before insert or update on public.store_orders
  for each row execute function public.trg_store_orders_set_org();

-- ============================================================
-- 5. RLS
-- ============================================================

alter table public.store_items enable row level security;
alter table public.store_item_variants enable row level security;
alter table public.store_item_inventory enable row level security;
alter table public.store_orders enable row level security;
alter table public.store_order_items enable row level security;

drop policy if exists "store_items_select" on public.store_items;
create policy "store_items_select" on public.store_items for select to authenticated
  using (is_active or public.user_can_access_organization(auth.uid(), organization_id));

drop policy if exists "store_item_variants_select" on public.store_item_variants;
create policy "store_item_variants_select" on public.store_item_variants for select to authenticated
  using (exists (select 1 from public.store_items si where si.id = store_item_id));

drop policy if exists "store_item_inventory_select" on public.store_item_inventory;
create policy "store_item_inventory_select" on public.store_item_inventory for select to authenticated
  using (true);

drop policy if exists "store_orders_select" on public.store_orders;
create policy "store_orders_select" on public.store_orders for select to authenticated
  using (user_id = auth.uid() or public.user_can_access_organization(auth.uid(), organization_id));

drop policy if exists "store_order_items_select" on public.store_order_items;
create policy "store_order_items_select" on public.store_order_items for select to authenticated
  using (exists (
    select 1 from public.store_orders so
    where so.id = store_order_id and (so.user_id = auth.uid() or public.user_can_access_organization(auth.uid(), so.organization_id))
  ));

-- Nenhuma policy de insert/update/delete: toda escrita passa por RPC security definer abaixo.

-- ============================================================
-- 6. Permissoes (catalogo de admin_permissions + grants de owner/administrator)
-- ============================================================

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values
  ('store.view', 'Ver lojinha', 'Visualiza catalogo, estoque e pedidos da lojinha', 'store', 10, true),
  ('store.manage', 'Gerenciar lojinha', 'Cria/edita itens, variantes e estoque da lojinha', 'store', 20, true),
  ('store.deliver', 'Entregar itens da lojinha', 'Registra entrega/desfazer entrega de itens comprados', 'store', 30, true)
on conflict (code) do update set name = excluded.name, description = excluded.description, module = excluded.module, sort_order = excluded.sort_order, is_active = excluded.is_active;

insert into public.admin_role_permissions (role_id, permission_id)
select ar.id, ap.id
from public.admin_roles ar
join public.admin_permissions ap on ap.code in ('store.view', 'store.manage', 'store.deliver')
where ar.code = 'administrator'
on conflict (role_id, permission_id) do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select ar.id, ap.id
from public.admin_roles ar
join public.admin_permissions ap on ap.code = 'store.view'
where ar.code in ('manager', 'inventory')
on conflict (role_id, permission_id) do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select ar.id, ap.id
from public.admin_roles ar
join public.admin_permissions ap on ap.code = 'store.deliver'
where ar.code in ('manager', 'kit_delivery')
on conflict (role_id, permission_id) do nothing;

-- ============================================================
-- 7. RPCs
-- ============================================================

create or replace function public.list_store_items_for_event(p_event_id uuid)
returns table (
  store_item_id uuid, name text, slug text, description text, price numeric, requires_variant boolean,
  sort_order integer, variant_id uuid, variant_name text, variant_value text, price_adjustment numeric,
  total_quantity integer, reserved_quantity integer, delivered_quantity integer, available_quantity integer
)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select si.id, si.name, si.slug, si.description, si.price, si.requires_variant, si.sort_order,
    siv.id, siv.name, siv.value, siv.price_adjustment,
    coalesce(inv.total_quantity, 0), coalesce(inv.reserved_quantity, 0), coalesce(inv.delivered_quantity, 0),
    greatest(coalesce(inv.total_quantity, 0) - coalesce(inv.reserved_quantity, 0) - coalesce(inv.delivered_quantity, 0), 0)
  from public.store_items si
  left join public.store_item_variants siv on siv.store_item_id = si.id and siv.is_active
  left join public.store_item_inventory inv on inv.store_item_id = si.id and inv.variant_id is not distinct from siv.id
  where si.event_id = p_event_id and si.is_active
  order by si.sort_order, si.name, siv.sort_order, siv.name;
$$;

grant execute on function public.list_store_items_for_event(uuid) to authenticated, anon;

create or replace function public.upsert_store_item(
  p_id uuid, p_event_id uuid, p_name text, p_slug text, p_description text,
  p_price numeric, p_requires_variant boolean, p_is_active boolean, p_sort_order integer
)
returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_event public.events%rowtype; v_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_event from public.events where id = p_event_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome obrigatorio.'; end if;
  if nullif(trim(coalesce(p_slug, '')), '') is null then raise exception 'Slug obrigatorio.'; end if;
  if p_price < 0 then raise exception 'Preco invalido.'; end if;

  if p_id is null then
    insert into public.store_items (event_id, name, slug, description, price, requires_variant, is_active, sort_order)
    values (p_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''), p_price, coalesce(p_requires_variant, false), coalesce(p_is_active, true), coalesce(p_sort_order, 0))
    returning id into v_id;
  else
    update public.store_items set
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      price = p_price, requires_variant = coalesce(p_requires_variant, false), is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), updated_at = now()
    where id = p_id and event_id = p_event_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da lojinha nao encontrado.'; end if;
  end if;
  return v_id;
end; $$;

grant execute on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer) to authenticated;

create or replace function public.upsert_store_item_variant(
  p_id uuid, p_store_item_id uuid, p_name text, p_value text, p_price_adjustment numeric, p_is_active boolean, p_sort_order integer
)
returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_item public.store_items%rowtype; v_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_item.organization_id) then raise exception 'Item invalido ou sem acesso.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome da variante obrigatorio.'; end if;
  if nullif(trim(coalesce(p_value, '')), '') is null then raise exception 'Valor da variante obrigatorio.'; end if;

  if p_id is null then
    insert into public.store_item_variants (store_item_id, name, value, price_adjustment, is_active, sort_order)
    values (p_store_item_id, trim(p_name), trim(p_value), coalesce(p_price_adjustment, 0), coalesce(p_is_active, true), coalesce(p_sort_order, 0))
    returning id into v_id;
  else
    update public.store_item_variants set
      name = trim(p_name), value = trim(p_value), price_adjustment = coalesce(p_price_adjustment, 0),
      is_active = coalesce(p_is_active, true), sort_order = coalesce(p_sort_order, 0)
    where id = p_id and store_item_id = p_store_item_id
    returning id into v_id;
    if v_id is null then raise exception 'Variante nao encontrada.'; end if;
  end if;
  return v_id;
end; $$;

grant execute on function public.upsert_store_item_variant(uuid, uuid, text, text, numeric, boolean, integer) to authenticated;

create or replace function public.set_store_item_stock(p_store_item_id uuid, p_variant_id uuid, p_total_quantity integer)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_item public.store_items%rowtype; v_committed integer;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_item.organization_id) then raise exception 'Item invalido ou sem acesso.'; end if;
  if p_total_quantity < 0 then raise exception 'Quantidade invalida.'; end if;
  if p_variant_id is not null and not exists (select 1 from public.store_item_variants where id = p_variant_id and store_item_id = p_store_item_id) then
    raise exception 'Variante nao pertence ao item.';
  end if;

  select coalesce(reserved_quantity, 0) + coalesce(delivered_quantity, 0) into v_committed
  from public.store_item_inventory where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id;
  if v_committed is not null and p_total_quantity < v_committed then
    raise exception 'Quantidade total nao pode ser menor que o ja reservado/entregue (%).', v_committed;
  end if;

  insert into public.store_item_inventory (event_id, store_item_id, variant_id, total_quantity)
  values (v_item.event_id, p_store_item_id, p_variant_id, p_total_quantity)
  on conflict (store_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set total_quantity = excluded.total_quantity, updated_at = now();
end; $$;

grant execute on function public.set_store_item_stock(uuid, uuid, integer) to authenticated;

create or replace function public.create_store_order(p_event_id uuid, p_items jsonb, p_payment_method text, p_notes text default null)
returns table (store_order_id uuid, order_number text, final_amount numeric)
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_event public.events%rowtype; v_order_id uuid; v_order_number text;
  v_item record; v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype; v_inv public.store_item_inventory%rowtype;
  v_unit_price numeric; v_line_total numeric; v_total numeric := 0; v_paid boolean; v_participant_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Evento invalido.'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Nenhum item selecionado.'; end if;

  v_paid := lower(trim(coalesce(p_payment_method, ''))) = 'courtesy';
  select id into v_participant_id from public.participants where user_id = v_actor and event_id = p_event_id order by created_at desc limit 1;
  v_order_number := 'LOJA-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.store_orders (event_id, user_id, participant_id, order_number, status, payment_method, payment_status, base_amount, final_amount, notes, confirmed_at)
  values (p_event_id, v_actor, v_participant_id, v_order_number, case when v_paid then 'confirmed' else 'pending' end,
    nullif(trim(coalesce(p_payment_method, '')), ''), case when v_paid then 'paid' else 'pending' end,
    0, 0, nullif(trim(coalesce(p_notes, '')), ''), case when v_paid then now() end)
  returning id into v_order_id;

  for v_item in select * from jsonb_to_recordset(p_items) as x(store_item_id uuid, variant_id uuid, quantity integer) loop
    if coalesce(v_item.quantity, 0) <= 0 then raise exception 'Quantidade invalida para item %.', v_item.store_item_id; end if;
    select * into v_store_item from public.store_items where id = v_item.store_item_id and event_id = p_event_id and is_active;
    if not found then raise exception 'Item % indisponivel para este evento.', v_item.store_item_id; end if;
    if v_store_item.requires_variant and v_item.variant_id is null then raise exception 'Item % exige selecao de variante.', v_store_item.name; end if;

    v_unit_price := v_store_item.price;
    if v_item.variant_id is not null then
      select * into v_variant from public.store_item_variants where id = v_item.variant_id and store_item_id = v_store_item.id and is_active;
      if not found then raise exception 'Variante invalida para o item %.', v_store_item.name; end if;
      v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
    end if;

    select * into v_inv from public.store_item_inventory where store_item_id = v_store_item.id and variant_id is not distinct from v_item.variant_id for update;
    if not found or (v_inv.total_quantity - v_inv.reserved_quantity - v_inv.delivered_quantity) < v_item.quantity then
      raise exception 'Estoque insuficiente para %.', v_store_item.name;
    end if;
    update public.store_item_inventory set reserved_quantity = reserved_quantity + v_item.quantity, updated_at = now() where id = v_inv.id;

    v_line_total := v_unit_price * v_item.quantity;
    v_total := v_total + v_line_total;
    insert into public.store_order_items (store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status)
    values (v_order_id, v_store_item.id, v_item.variant_id, v_item.quantity, v_unit_price, v_line_total, case when v_paid then 'confirmed' else 'reserved' end);
  end loop;

  update public.store_orders set base_amount = v_total, final_amount = v_total, updated_at = now() where id = v_order_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_created', 'store_orders', v_order_id, p_event_id, jsonb_build_object('actor_user_id', v_actor, 'final_amount', v_total, 'payment_method', p_payment_method));

  return query select v_order_id, v_order_number, v_total;
end; $$;

grant execute on function public.create_store_order(uuid, jsonb, text, text) to authenticated;

create or replace function public.confirm_store_order_payment(p_store_order_id uuid)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_order public.store_orders%rowtype;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para confirmar pagamentos da lojinha.'; end if;
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_order.status = 'cancelled' then raise exception 'Pedido cancelado nao pode ser confirmado.'; end if;
  if v_order.status = 'confirmed' then return; end if;

  update public.store_orders set status = 'confirmed', payment_status = 'paid', confirmed_at = now(), updated_at = now() where id = p_store_order_id;
  update public.store_order_items set status = 'confirmed' where store_order_id = p_store_order_id and status = 'reserved';
end; $$;

grant execute on function public.confirm_store_order_payment(uuid) to authenticated;

create or replace function public.cancel_store_order(p_store_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_order public.store_orders%rowtype; v_line record;
begin
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.current_user_has_permission('store.manage')) then raise exception 'Sem permissao para cancelar este pedido.'; end if;
  if v_order.status = 'cancelled' then return; end if;
  if exists (select 1 from public.store_order_items where store_order_id = p_store_order_id and status = 'delivered') then
    raise exception 'Pedido possui item entregue; nao pode ser cancelado.';
  end if;

  for v_line in select * from public.store_order_items where store_order_id = p_store_order_id and status <> 'cancelled' for update loop
    update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity - v_line.quantity, 0), updated_at = now()
    where store_item_id = v_line.store_item_id and variant_id is not distinct from v_line.variant_id;
    update public.store_order_items set status = 'cancelled' where id = v_line.id;
  end loop;

  update public.store_orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = p_store_order_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_cancelled', 'store_orders', p_store_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'reason', p_reason));
end; $$;

grant execute on function public.cancel_store_order(uuid, text) to authenticated;

create or replace function public.deliver_store_order_item(p_store_order_item_id uuid)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para entregar itens da lojinha.'; end if;
  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_line.status = 'delivered' then return true; end if;
  if v_line.status <> 'confirmed' then raise exception 'Item precisa estar confirmado (pago) para ser entregue.'; end if;

  update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity - v_line.quantity, 0),
    delivered_quantity = delivered_quantity + v_line.quantity, updated_at = now()
  where store_item_id = v_line.store_item_id and variant_id is not distinct from v_line.variant_id;
  update public.store_order_items set status = 'delivered', delivered_at = now() where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivered', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;

grant execute on function public.deliver_store_order_item(uuid) to authenticated;

create or replace function public.undo_store_order_item_delivery(p_store_order_item_id uuid)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para desfazer entrega da lojinha.'; end if;
  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_line.status <> 'delivered' then raise exception 'Item nao esta entregue.'; end if;

  update public.store_item_inventory set delivered_quantity = greatest(delivered_quantity - v_line.quantity, 0),
    reserved_quantity = reserved_quantity + v_line.quantity, updated_at = now()
  where store_item_id = v_line.store_item_id and variant_id is not distinct from v_line.variant_id;
  update public.store_order_items set status = 'confirmed', delivered_at = null where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivery_undone', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;

grant execute on function public.undo_store_order_item_delivery(uuid) to authenticated;

commit;
