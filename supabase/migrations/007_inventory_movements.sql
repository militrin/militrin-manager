-- 007_inventory_movements.sql
-- Movimentacoes de estoque para manter uma unica linha por evento + modelo + tamanho.

create unique index if not exists ux_shirt_inventory_event_type_size
on public.shirt_inventory (event_id, shirt_type, shirt_size);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  inventory_id uuid not null references public.shirt_inventory(id),
  movement_type text not null check (movement_type in ('purchase', 'adjustment', 'return', 'loss')),
  quantity integer not null check (quantity <> 0),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_inventory_movements_event_id on public.inventory_movements(event_id);
create index if not exists idx_inventory_movements_inventory_id_created_at on public.inventory_movements(inventory_id, created_at desc);

alter table public.inventory_movements enable row level security;
alter table public.shirt_inventory enable row level security;

drop policy if exists "inventory_movements_read_only" on public.inventory_movements;
create policy "inventory_movements_read_only"
on public.inventory_movements
for select
to anon, authenticated
using (true);

drop policy if exists "shirt_inventory_read_only" on public.shirt_inventory;
create policy "shirt_inventory_read_only"
on public.shirt_inventory
for select
to anon, authenticated
using (true);

revoke insert, update, delete on table public.shirt_inventory from anon, authenticated;
revoke insert, update, delete on table public.inventory_movements from anon, authenticated;

grant select on table public.shirt_inventory to anon, authenticated;
grant select on table public.inventory_movements to anon, authenticated;

create or replace function public.add_inventory_quantity(
  p_inventory_id uuid,
  p_quantity integer,
  p_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_actor text := coalesce(auth.role(), 'anon');
  v_item public.shirt_inventory%rowtype;
  v_new_total integer;
begin
  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantidade deve ser maior que zero.';
  end if;

  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada.';
  end if;

  if v_item.event_id is distinct from v_event_id then
    raise exception 'Apenas o estoque do evento ativo pode ser alterado.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = total_quantity + p_quantity,
    updated_at = now()
  where id = p_inventory_id
  returning total_quantity into v_new_total;

  insert into public.inventory_movements (
    event_id,
    inventory_id,
    movement_type,
    quantity,
    notes
  ) values (
    v_event_id,
    p_inventory_id,
    'purchase',
    p_quantity,
    nullif(trim(p_notes), '')
  );

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_quantity_added',
    'shirt_inventory',
    p_inventory_id,
    v_event_id,
    jsonb_build_object(
      'movement_type', 'purchase',
      'quantity', p_quantity,
      'notes', nullif(trim(p_notes), ''),
      'previous_total', v_item.total_quantity,
      'new_total', v_new_total,
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size
    )
  );

  return true;
end;
$$;

create or replace function public.adjust_inventory_quantity(
  p_inventory_id uuid,
  p_quantity integer,
  p_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_actor text := coalesce(auth.role(), 'anon');
  v_item public.shirt_inventory%rowtype;
  v_new_total integer;
  v_min_total integer;
begin
  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_quantity is null or p_quantity = 0 then
    raise exception 'Quantidade de ajuste deve ser diferente de zero.';
  end if;

  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada.';
  end if;

  if v_item.event_id is distinct from v_event_id then
    raise exception 'Apenas o estoque do evento ativo pode ser alterado.';
  end if;

  v_new_total := v_item.total_quantity + p_quantity;
  v_min_total := v_item.reserved_quantity + v_item.delivered_quantity;

  if v_new_total < v_min_total then
    raise exception 'Total nao pode ficar menor que reservadas + entregues.';
  end if;

  if v_new_total < 0 then
    raise exception 'Total nao pode ficar negativo.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = v_new_total,
    updated_at = now()
  where id = p_inventory_id;

  insert into public.inventory_movements (
    event_id,
    inventory_id,
    movement_type,
    quantity,
    notes
  ) values (
    v_event_id,
    p_inventory_id,
    'adjustment',
    p_quantity,
    nullif(trim(p_notes), '')
  );

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_quantity_adjusted',
    'shirt_inventory',
    p_inventory_id,
    v_event_id,
    jsonb_build_object(
      'movement_type', 'adjustment',
      'quantity', p_quantity,
      'notes', nullif(trim(p_notes), ''),
      'previous_total', v_item.total_quantity,
      'new_total', v_new_total,
      'reserved_quantity', v_item.reserved_quantity,
      'delivered_quantity', v_item.delivered_quantity,
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size
    )
  );

  return true;
end;
$$;

revoke all on function public.add_inventory_quantity(uuid, integer, text) from public, authenticated, anon;
revoke all on function public.adjust_inventory_quantity(uuid, integer, text) from public, authenticated, anon;
revoke all on function public.delete_inventory_item(uuid) from public, authenticated, anon;

grant execute on function public.add_inventory_quantity(uuid, integer, text) to anon;
grant execute on function public.adjust_inventory_quantity(uuid, integer, text) to anon;
