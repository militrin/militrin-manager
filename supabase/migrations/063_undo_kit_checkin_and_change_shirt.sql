-- 063_undo_kit_checkin_and_change_shirt.sql
-- Adiciona reversão de entrega, reversão de check-in e troca segura de camiseta.

begin;

create or replace function public.undo_participant_kit_item(
  p_participant_id uuid,
  p_kit_item_id uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_item public.participant_kit_items%rowtype;
  v_participant public.participants%rowtype;
  v_kit_item public.event_kit_items%rowtype;
  v_inventory public.shirt_inventory%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('kits.undo_delivery') then
    raise exception 'Sem permissao para desfazer entrega de kit.';
  end if;

  select pki.*
  into v_item
  from public.participant_kit_items pki
  where pki.participant_id = p_participant_id
    and pki.kit_item_id = p_kit_item_id
  for update;

  if not found then
    raise exception 'Item do participante nao encontrado.';
  end if;

  if v_item.status <> 'delivered' then
    raise exception 'Este item ainda nao foi entregue.';
  end if;

  select p.*
  into v_participant
  from public.participants p
  where p.id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select eki.*
  into v_kit_item
  from public.event_kit_items eki
  where eki.id = p_kit_item_id;

  if not found then
    raise exception 'Configuracao de item nao encontrada.';
  end if;

  if v_kit_item.item_type = 'shirt' then
    select si.*
    into v_inventory
    from public.shirt_inventory si
    where si.event_id = v_participant.event_id
      and si.shirt_type = v_participant.shirt_type
      and si.shirt_size = v_participant.shirt_size
    for update;

    if found then
      if coalesce(v_inventory.delivered_quantity, 0) < v_item.quantity then
        raise exception 'Quantidade entregue inconsistente no estoque.';
      end if;

      update public.shirt_inventory si
      set delivered_quantity = coalesce(si.delivered_quantity, 0) - v_item.quantity,
          reserved_quantity = coalesce(si.reserved_quantity, 0) + v_item.quantity,
          updated_at = now()
      where si.id = v_inventory.id;

      insert into public.inventory_movements (
        event_id,
        inventory_id,
        movement_type,
        quantity,
        notes
      ) values (
        v_participant.event_id,
        v_inventory.id,
        'kit_delivery_undo',
        v_item.quantity,
        format(
          'Entrega desfeita para %s. Operador: %s.',
          coalesce(v_participant.full_name, p_participant_id::text),
          v_actor_email
        )
      );
    end if;
  end if;

  update public.participant_kit_items pki
  set status = 'confirmed',
      delivered_at = null
  where pki.id = v_item.id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'participant_kit_item_delivery_undone',
    'participant_kit_items',
    v_item.id,
    v_item.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'participant_id', p_participant_id,
      'kit_item_id', p_kit_item_id,
      'item_type', v_kit_item.item_type,
      'quantity', v_item.quantity
    )
  );

  return true;
end;
$function$;


create or replace function public.undo_participant_full_kit(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_row record;
  v_found boolean := false;
begin
  if not public.current_user_has_permission('kits.undo_delivery') then
    raise exception 'Sem permissao para desfazer entrega de kit.';
  end if;

  for v_row in
    select pki.kit_item_id
    from public.participant_kit_items pki
    where pki.participant_id = p_participant_id
      and pki.status = 'delivered'
  loop
    v_found := true;
    perform public.undo_participant_kit_item(
      p_participant_id,
      v_row.kit_item_id
    );
  end loop;

  if not v_found then
    raise exception 'Nenhum item entregue para desfazer.';
  end if;

  return true;
end;
$function$;


create or replace function public.undo_participant_checkin(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_participant public.participants%rowtype;
  v_ticket public.tickets%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('checkin.undo') then
    raise exception 'Sem permissao para desfazer check-in.';
  end if;

  select p.*
  into v_participant
  from public.participants p
  where p.id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select t.*
  into v_ticket
  from public.tickets t
  where t.participant_id = p_participant_id
  order by t.issued_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  if v_ticket.status <> 'used' and v_ticket.used_at is null then
    raise exception 'Este ingresso ainda nao realizou check-in.';
  end if;

  update public.tickets t
  set status = 'active',
      used_at = null
  where t.id = v_ticket.id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'participant_checkin_undone',
    'participants',
    p_participant_id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'ticket_id', v_ticket.id,
      'previous_used_at', v_ticket.used_at,
      'undone_at', now()
    )
  );

  return true;
end;
$function$;


create or replace function public.change_participant_shirt(
  p_participant_id uuid,
  p_new_shirt_type text,
  p_new_shirt_size text
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_shirt_item public.participant_kit_items%rowtype;
  v_old_inventory public.shirt_inventory%rowtype;
  v_new_inventory public.shirt_inventory%rowtype;
  v_quantity integer := 1;
  v_is_delivered boolean := false;
  v_enforce_stock boolean := false;
  v_available integer;
  v_new_type text := nullif(trim(p_new_shirt_type), '');
  v_new_size text := nullif(trim(p_new_shirt_size), '');
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('inventory.change_participant_shirt') then
    raise exception 'Sem permissao para trocar camiseta do participante.';
  end if;

  if v_new_type is null or v_new_size is null then
    raise exception 'Tipo e tamanho da nova camiseta sao obrigatorios.';
  end if;

  select p.*
  into v_participant
  from public.participants p
  where p.id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  if v_participant.shirt_type = v_new_type
     and v_participant.shirt_size = v_new_size then
    raise exception 'A nova camiseta e igual a atual.';
  end if;

  select e.*
  into v_event
  from public.events e
  where e.id = v_participant.event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  v_enforce_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

  select pki.*
  into v_shirt_item
  from public.participant_kit_items pki
  join public.event_kit_items eki
    on eki.id = pki.kit_item_id
  where pki.participant_id = p_participant_id
    and eki.item_type = 'shirt'
  order by pki.created_at asc
  limit 1
  for update;

  if found then
    v_quantity := greatest(coalesce(v_shirt_item.quantity, 1), 1);
    v_is_delivered := v_shirt_item.status = 'delivered';
  end if;

  select si.*
  into v_old_inventory
  from public.shirt_inventory si
  where si.event_id = v_participant.event_id
    and si.shirt_type = v_participant.shirt_type
    and si.shirt_size = v_participant.shirt_size
  for update;

  select si.*
  into v_new_inventory
  from public.shirt_inventory si
  where si.event_id = v_participant.event_id
    and si.shirt_type = v_new_type
    and si.shirt_size = v_new_size
  for update;

  if v_enforce_stock and not found then
    raise exception 'Novo tamanho nao possui estoque cadastrado.';
  end if;

  if v_new_inventory.id is not null then
    v_available :=
      coalesce(v_new_inventory.total_quantity, 0)
      - coalesce(v_new_inventory.reserved_quantity, 0)
      - coalesce(v_new_inventory.delivered_quantity, 0);

    if v_available < v_quantity then
      raise exception 'Novo tamanho esgotado ou com saldo insuficiente.';
    end if;
  end if;

  if v_old_inventory.id is not null then
    if v_is_delivered then
      update public.shirt_inventory si
      set delivered_quantity = greatest(
            coalesce(si.delivered_quantity, 0) - v_quantity,
            0
          ),
          updated_at = now()
      where si.id = v_old_inventory.id;
    else
      update public.shirt_inventory si
      set reserved_quantity = greatest(
            coalesce(si.reserved_quantity, 0) - v_quantity,
            0
          ),
          updated_at = now()
      where si.id = v_old_inventory.id;
    end if;
  end if;

  if v_new_inventory.id is not null then
    if v_is_delivered then
      update public.shirt_inventory si
      set delivered_quantity = coalesce(si.delivered_quantity, 0) + v_quantity,
          updated_at = now()
      where si.id = v_new_inventory.id;
    else
      update public.shirt_inventory si
      set reserved_quantity = coalesce(si.reserved_quantity, 0) + v_quantity,
          updated_at = now()
      where si.id = v_new_inventory.id;
    end if;
  end if;

  update public.participants p
  set shirt_type = v_new_type,
      shirt_size = v_new_size,
      updated_at = now()
  where p.id = p_participant_id;

  if v_shirt_item.id is not null then
    update public.participant_kit_items pki
    set variant_data = jsonb_build_object(
          'shirt_type', v_new_type,
          'shirt_size', v_new_size
        )
    where pki.id = v_shirt_item.id;
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'participant_shirt_changed',
    'participants',
    p_participant_id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'previous_type', v_participant.shirt_type,
      'previous_size', v_participant.shirt_size,
      'next_type', v_new_type,
      'next_size', v_new_size,
      'kit_item_delivered', v_is_delivered,
      'quantity', v_quantity
    )
  );

  return true;
end;
$function$;


grant execute on function public.undo_participant_kit_item(uuid, uuid)
to authenticated;

grant execute on function public.undo_participant_full_kit(uuid)
to authenticated;

grant execute on function public.undo_participant_checkin(uuid)
to authenticated;

grant execute on function public.change_participant_shirt(uuid, text, text)
to authenticated;

commit;