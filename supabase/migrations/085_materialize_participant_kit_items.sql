-- 085_materialize_participant_kit_items.sql
-- Materializa, sem entregar, itens aplicaveis ausentes por ingresso ou evento.

begin;

create or replace function public.materialize_participant_kit_items_internal(
  p_ticket_id uuid,
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_ticket public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_order_item public.order_items%rowtype;
  v_item public.event_kit_items%rowtype;
  v_shirt_type text;
  v_shirt_size text;
  v_status text := 'reserved';
  v_created_ids uuid[] := array[]::uuid[];
  v_existing_ids uuid[] := array[]::uuid[];
  v_skipped jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_link_id uuid;
  v_was_created boolean;
  v_organization_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') then
    raise exception 'Sem permissao para vincular itens.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;

  if v_ticket.order_item_id is not null then
    select * into v_order_item from public.order_items where id = v_ticket.order_item_id for update;
  end if;

  select * into v_participant
  from public.participants
  where id = coalesce(v_ticket.participant_id, v_order_item.participant_id)
  for update;
  if not found then raise exception 'Ingresso sem participante vinculado.'; end if;

  select e.organization_id into v_organization_id from public.events e where e.id = v_ticket.event_id;
  if v_organization_id is null
    or not public.user_can_access_organization(v_actor, v_organization_id) then
    raise exception 'Usuario sem acesso a organizacao do evento.';
  end if;

  v_shirt_type := nullif(trim(coalesce(v_participant.shirt_type, v_order_item.shirt_type)), '');
  v_shirt_size := nullif(trim(coalesce(v_participant.shirt_size, v_order_item.shirt_size)), '');

  if exists (
    select 1 from public.payments p
    where p.participant_id = v_participant.id and p.payment_status = 'paid'
  ) then
    v_status := 'confirmed';
  end if;

  for v_item in
    select * from public.event_kit_items
    where event_id = v_ticket.event_id and is_active = true
    order by sort_order, created_at
  loop
    select pki.id into v_link_id
    from public.participant_kit_items pki
    where pki.participant_id = v_participant.id and pki.kit_item_id = v_item.id;

    if v_link_id is not null then
      v_existing_ids := array_append(v_existing_ids, v_link_id);
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'kit_item_id', v_item.id, 'name', v_item.name, 'item_type', v_item.item_type,
        'result', 'existing', 'link_id', v_link_id
      ));
      v_link_id := null;
      continue;
    end if;

    if v_item.item_type = 'shirt' and (v_shirt_type is null or v_shirt_size is null) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'kit_item_id', v_item.id, 'name', v_item.name, 'item_type', v_item.item_type,
        'reason', 'Informe modelo e tamanho antes de vincular os itens.'
      ));
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'kit_item_id', v_item.id, 'name', v_item.name, 'item_type', v_item.item_type,
        'result', 'skipped', 'reason', 'Informe modelo e tamanho antes de vincular os itens.'
      ));
      continue;
    end if;

    v_was_created := false;
    insert into public.participant_kit_items (
      participant_id, event_id, kit_item_id, variant_data, quantity, status
    ) values (
      v_participant.id, v_ticket.event_id, v_item.id,
      case when v_item.item_type = 'shirt'
        then jsonb_build_object('shirt_type', v_shirt_type, 'shirt_size', v_shirt_size)
        else null end,
      v_item.quantity_per_participant, v_status
    )
    on conflict on constraint participant_kit_items_participant_kit_unique do nothing
    returning id into v_link_id;

    if v_link_id is not null then
      v_was_created := true;
      v_created_ids := array_append(v_created_ids, v_link_id);
    else
      select pki.id into v_link_id from public.participant_kit_items pki
      where pki.participant_id = v_participant.id and pki.kit_item_id = v_item.id;
      v_existing_ids := array_append(v_existing_ids, v_link_id);
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'kit_item_id', v_item.id, 'name', v_item.name, 'item_type', v_item.item_type,
      'result', case when v_was_created then 'created' else 'existing' end,
      'link_id', v_link_id,
      'variant_data', case when v_item.item_type = 'shirt'
        then jsonb_build_object('shirt_type', v_shirt_type, 'shirt_size', v_shirt_size)
        else null end
    ));
  end loop;

  select lower(email) into v_actor_email from auth.users where id = v_actor;
  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('participant_kit_items_materialized', 'participants', v_participant.id, v_ticket.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor, 'actor_email', v_actor_email,
      'organization_id', v_organization_id, 'event_id', v_ticket.event_id,
      'participant_id', v_participant.id, 'ticket_id', p_ticket_id,
      'created_item_ids', v_created_ids, 'existing_item_ids', v_existing_ids,
      'source', p_source, 'timestamp', now()
    ));

  return jsonb_build_object(
    'participant_id', v_participant.id, 'ticket_id', p_ticket_id,
    'created_count', cardinality(v_created_ids),
    'existing_count', cardinality(v_existing_ids),
    'skipped_count', jsonb_array_length(v_skipped),
    'items', v_items, 'skipped', v_skipped
  );
end;
$$;

create or replace function public.materialize_participant_kit_items(p_ticket_id uuid)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.materialize_participant_kit_items_internal(p_ticket_id, 'operations_manual');
$$;

create or replace function public.materialize_event_participant_kit_items(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_organization_id uuid;
  v_ticket record;
  v_result jsonb;
  v_created integer := 0;
  v_existing integer := 0;
  v_skipped integer := 0;
  v_participants integer := 0;
  v_results jsonb := '[]'::jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') then
    raise exception 'Sem permissao para vincular itens.';
  end if;

  select organization_id into v_organization_id from public.events where id = p_event_id;
  if v_organization_id is null
    or not public.user_can_access_organization(v_actor, v_organization_id) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  for v_ticket in
    select distinct on (coalesce(t.participant_id, oi.participant_id))
      t.id, coalesce(t.participant_id, oi.participant_id) as participant_id
    from public.tickets t
    left join public.order_items oi on oi.id = t.order_item_id
    where t.event_id = p_event_id
      and coalesce(t.participant_id, oi.participant_id) is not null
      and t.status <> 'cancelled'
    order by coalesce(t.participant_id, oi.participant_id), t.issued_at desc
  loop
    begin
      v_result := public.materialize_participant_kit_items_internal(v_ticket.id, 'operations_batch');
      v_created := v_created + coalesce((v_result ->> 'created_count')::integer, 0);
      v_existing := v_existing + coalesce((v_result ->> 'existing_count')::integer, 0);
      v_skipped := v_skipped + coalesce((v_result ->> 'skipped_count')::integer, 0);
      v_participants := v_participants + 1;
      v_results := v_results || jsonb_build_array(v_result);
    exception when others then
      v_skipped := v_skipped + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'participant_id', v_ticket.participant_id, 'ticket_id', v_ticket.id,
        'error', sqlerrm
      ));
    end;
  end loop;

  return jsonb_build_object(
    'event_id', p_event_id, 'processed_participants', v_participants,
    'created_count', v_created, 'existing_count', v_existing,
    'skipped_count', v_skipped, 'results', v_results
  );
end;
$$;

revoke all on function public.materialize_participant_kit_items_internal(uuid, text)
  from public, anon, authenticated;
revoke all on function public.materialize_participant_kit_items(uuid)
  from public, anon, authenticated;
revoke all on function public.materialize_event_participant_kit_items(uuid)
  from public, anon, authenticated;
grant execute on function public.materialize_participant_kit_items(uuid) to authenticated;
grant execute on function public.materialize_event_participant_kit_items(uuid) to authenticated;

commit;
