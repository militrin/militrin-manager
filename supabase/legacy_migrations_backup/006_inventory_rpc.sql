-- 006_inventory_rpc.sql
-- RPCs para CRUD de inventario com SECURITY DEFINER e RLS read-only para clientes publicos.

create unique index if not exists ux_shirt_inventory_event_type_size
on public.shirt_inventory (event_id, shirt_type, shirt_size);

alter table public.shirt_inventory enable row level security;

drop policy if exists "Authenticated users can read shirt inventory" on public.shirt_inventory;
drop policy if exists "Authenticated users can insert shirt inventory" on public.shirt_inventory;
drop policy if exists "Authenticated users can update shirt inventory" on public.shirt_inventory;
drop policy if exists "Authenticated users can delete shirt inventory" on public.shirt_inventory;
drop policy if exists "shirt_inventory_read_only" on public.shirt_inventory;

create policy "shirt_inventory_read_only"
on public.shirt_inventory
for select
to anon, authenticated
using (true);

revoke insert, update, delete on table public.shirt_inventory from anon, authenticated;

create or replace function public.create_inventory_item(
  p_shirt_type text,
  p_shirt_size text,
  p_total_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_item_id uuid;
  v_actor text := coalesce(auth.role(), 'anon');
begin
  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  if p_shirt_type not in ('Camiseta', 'Babylook') then
    raise exception 'Modelo invalido. Use Camiseta ou Babylook.';
  end if;

  if p_shirt_type = 'Camiseta' and p_shirt_size not in ('PP', 'P', 'M', 'G', 'GG', 'EG', 'EXG', 'EXGG') then
    raise exception 'Tamanho invalido para Camiseta.';
  end if;

  if p_shirt_type = 'Babylook' and p_shirt_size not in ('PP', 'P', 'M', 'G', 'GG', 'EG') then
    raise exception 'Tamanho invalido para Babylook.';
  end if;

  if p_total_quantity is null or p_total_quantity < 0 then
    raise exception 'Quantidade total deve ser maior ou igual a zero.';
  end if;

  if exists (
    select 1
    from public.shirt_inventory
    where event_id = v_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
  ) then
    raise exception 'Ja existe uma linha para este modelo e tamanho no evento ativo.';
  end if;

  insert into public.shirt_inventory (
    event_id,
    shirt_type,
    shirt_size,
    total_quantity,
    reserved_quantity,
    delivered_quantity
  ) values (
    v_event_id,
    p_shirt_type,
    p_shirt_size,
    p_total_quantity,
    0,
    0
  )
  returning id into v_item_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_created',
    'shirt_inventory',
    v_item_id,
    v_event_id,
    jsonb_build_object(
      'shirt_type', p_shirt_type,
      'shirt_size', p_shirt_size,
      'total_quantity', p_total_quantity,
      'reserved_quantity', 0,
      'delivered_quantity', 0
    )
  );

  return v_item_id;
end;
$$;

create or replace function public.update_inventory_item(
  p_inventory_id uuid,
  p_shirt_type text,
  p_shirt_size text,
  p_total_quantity integer
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
begin
  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_shirt_type not in ('Camiseta', 'Babylook') then
    raise exception 'Modelo invalido. Use Camiseta ou Babylook.';
  end if;

  if p_shirt_type = 'Camiseta' and p_shirt_size not in ('PP', 'P', 'M', 'G', 'GG', 'EG', 'EXG', 'EXGG') then
    raise exception 'Tamanho invalido para Camiseta.';
  end if;

  if p_shirt_type = 'Babylook' and p_shirt_size not in ('PP', 'P', 'M', 'G', 'GG', 'EG') then
    raise exception 'Tamanho invalido para Babylook.';
  end if;

  if p_total_quantity is null or p_total_quantity < 0 then
    raise exception 'Quantidade total deve ser maior ou igual a zero.';
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

  if (v_item.reserved_quantity + v_item.delivered_quantity) > p_total_quantity then
    raise exception 'Total deve ser maior ou igual a reservadas + entregues.';
  end if;

  if exists (
    select 1
    from public.shirt_inventory
    where event_id = v_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
      and id <> p_inventory_id
  ) then
    raise exception 'Ja existe outra linha para este modelo e tamanho no evento ativo.';
  end if;

  update public.shirt_inventory
  set
    shirt_type = p_shirt_type,
    shirt_size = p_shirt_size,
    total_quantity = p_total_quantity,
    updated_at = now()
  where id = p_inventory_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_updated',
    'shirt_inventory',
    p_inventory_id,
    v_event_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'shirt_type', v_item.shirt_type,
        'shirt_size', v_item.shirt_size,
        'total_quantity', v_item.total_quantity,
        'reserved_quantity', v_item.reserved_quantity,
        'delivered_quantity', v_item.delivered_quantity
      ),
      'after', jsonb_build_object(
        'shirt_type', p_shirt_type,
        'shirt_size', p_shirt_size,
        'total_quantity', p_total_quantity,
        'reserved_quantity', v_item.reserved_quantity,
        'delivered_quantity', v_item.delivered_quantity
      )
    )
  );

  return true;
end;
$$;

create or replace function public.delete_inventory_item(
  p_inventory_id uuid
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
begin
  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada.';
  end if;

  if v_item.event_id is distinct from v_event_id then
    raise exception 'Apenas o estoque do evento ativo pode ser excluido.';
  end if;

  delete from public.shirt_inventory
  where id = p_inventory_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_deleted',
    'shirt_inventory',
    p_inventory_id,
    v_event_id,
    jsonb_build_object(
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size,
      'total_quantity', v_item.total_quantity,
      'reserved_quantity', v_item.reserved_quantity,
      'delivered_quantity', v_item.delivered_quantity
    )
  );

  return true;
end;
$$;

revoke all on function public.create_inventory_item(text, text, integer) from public, authenticated, anon;
revoke all on function public.update_inventory_item(uuid, text, text, integer) from public, authenticated, anon;
revoke all on function public.delete_inventory_item(uuid) from public, authenticated, anon;

grant execute on function public.create_inventory_item(text, text, integer) to anon;
grant execute on function public.update_inventory_item(uuid, text, text, integer) to anon;
grant execute on function public.delete_inventory_item(uuid) to anon;
