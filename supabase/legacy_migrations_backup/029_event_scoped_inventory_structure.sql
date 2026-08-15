-- 028_event_scoped_inventory_structure.sql
-- Explicita event_id nas funcoes de estrutura de estoque.

create or replace function public.create_inventory_item(
  p_event_id uuid,
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
  v_item_id uuid;
  v_actor text := coalesce(auth.role(), 'anon');
  v_event_exists boolean := false;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(trim(p_shirt_type), '') = '' then
    raise exception 'Modelo obrigatorio.';
  end if;

  if coalesce(trim(p_shirt_size), '') = '' then
    raise exception 'Tamanho obrigatorio.';
  end if;

  if p_total_quantity is null or p_total_quantity < 0 then
    raise exception 'Quantidade total deve ser maior ou igual a zero.';
  end if;

  select exists (
    select 1
    from public.events
    where id = p_event_id
  ) into v_event_exists;

  if not v_event_exists then
    raise exception 'Evento nao encontrado.';
  end if;

  if exists (
    select 1
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
  ) then
    raise exception 'Ja existe uma linha para este modelo e tamanho neste evento.';
  end if;

  insert into public.shirt_inventory (
    event_id,
    shirt_type,
    shirt_size,
    total_quantity,
    reserved_quantity,
    delivered_quantity
  ) values (
    p_event_id,
    p_shirt_type,
    p_shirt_size,
    p_total_quantity,
    0,
    0
  ) returning id into v_item_id;

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
    p_event_id,
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
  p_event_id uuid,
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
  v_actor text := coalesce(auth.role(), 'anon');
  v_item public.shirt_inventory%rowtype;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if coalesce(trim(p_shirt_type), '') = '' then
    raise exception 'Modelo obrigatorio.';
  end if;

  if coalesce(trim(p_shirt_size), '') = '' then
    raise exception 'Tamanho obrigatorio.';
  end if;

  if p_total_quantity is null or p_total_quantity < 0 then
    raise exception 'Quantidade total deve ser maior ou igual a zero.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada para o evento informado.';
  end if;

  if (v_item.reserved_quantity + v_item.delivered_quantity) > p_total_quantity then
    raise exception 'Total deve ser maior ou igual a reservadas + entregues.';
  end if;

  if exists (
    select 1
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
      and id <> p_inventory_id
  ) then
    raise exception 'Ja existe outra linha para este modelo e tamanho neste evento.';
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
    p_event_id,
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

revoke all on function public.create_inventory_item(uuid, text, text, integer) from public, authenticated, anon;
revoke all on function public.update_inventory_item(uuid, uuid, text, text, integer) from public, authenticated, anon;

grant execute on function public.create_inventory_item(uuid, text, text, integer) to authenticated;
grant execute on function public.update_inventory_item(uuid, uuid, text, text, integer) to authenticated;
