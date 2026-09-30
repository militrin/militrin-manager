-- Fase 8B: salvar o mesmo titular nao e troca.
-- Preserva participant_id, registration_contact_id e owner_user_id.
-- Comparacao canonica: trim() -- o mesmo contrato de canonicalHolderName
-- e de v_name nesta funcao. Sem fold de caixa, acento, ILIKE ou owner.
-- Troca real de nome continua convertendo o titular para textual (FKs null).
-- Nao altera checkout SELF. Nao faz backfill. Nao mexe em intended_owner.

begin;

create or replace function public.apply_ticket_holder_name_internal(
  p_ticket_id uuid,
  p_holder_name text,
  p_reason_code text,
  p_reason_text text,
  p_actor_origin text,
  p_require_event_flags boolean
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_item public.order_items%rowtype;
  v_event public.events%rowtype;
  v_previous public.participants%rowtype;
  v_previous_contact_id uuid;
  v_previous_user_id uuid;
  v_previous_name text;
  v_name text := nullif(trim(coalesce(p_holder_name, '')), '');
  v_reason_code text := trim(coalesce(p_reason_code, ''));
  v_reason_text text := nullif(trim(coalesce(p_reason_text, '')), '');
  v_operation text;
  v_owner_user_id uuid;
  v_order_user_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_actor_origin not in ('admin', 'portal') then raise exception 'Origem do ator invalida.'; end if;
  if v_reason_code not in (
    'registration_correction','buyer_request','holder_request','third_party_ticket','administrative_adjustment',
    'issuance_error','system_error','data_regularization','other','legacy_unclassified'
  ) then
    raise exception 'Motivo de alteracao invalido.';
  end if;
  if v_reason_code = 'other' and v_reason_text is null then
    raise exception 'Descreva o motivo da alteracao.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  v_owner_user_id := v_ticket.owner_user_id;

  if p_actor_origin = 'admin' then
    if not public.user_can_access_organization(v_actor, v_ticket.organization_id) then
      raise exception 'Ingresso invalido ou sem acesso.';
    end if;
  else
    if v_ticket.owner_user_id is distinct from v_actor then
      raise exception 'Somente o proprietario pode alterar o nome do titular.';
    end if;
  end if;

  if v_ticket.status in ('cancelled', 'canceled', 'void', 'voided') then
    raise exception 'Ingresso cancelado nao pode ter titular alterado.';
  end if;
  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    raise exception 'Ingresso ja utilizado nao pode ter titular alterado.';
  end if;

  select * into v_event from public.events where id = v_ticket.event_id;
  if not found then raise exception 'Evento do ingresso nao encontrado.'; end if;

  select * into strict v_item from public.order_items where id = v_ticket.order_item_id for update;
  select o.user_id into v_order_user_id from public.orders o where o.id = v_ticket.order_id;

  if coalesce(v_item.participant_id, v_ticket.participant_id) is not null then
    select * into v_previous from public.participants where id = coalesce(v_item.participant_id, v_ticket.participant_id);
  end if;
  v_previous_contact_id := coalesce(v_item.registration_contact_id, v_previous.registration_contact_id);
  v_previous_user_id := v_previous.user_id;
  v_previous_name := coalesce(
    nullif(trim(coalesce(v_item.holder_full_name, '')), ''),
    nullif(trim(coalesce(v_previous.full_name, '')), '')
  );

  -- Mesmo titular: trim() igual ao valor atual. Nao e troca.
  -- Preserva FKs, owner e intended_owner. Sem holder_changed / audit.
  if p_holder_name is not null then
    if v_name is null then raise exception 'Informe o nome do titular.'; end if;
    if char_length(v_name) > 200 then raise exception 'Nome do titular excede o limite.'; end if;
    if v_previous_name is not distinct from v_name then
      return jsonb_build_object(
        'success', true,
        'changed', false,
        'ticket_id', v_ticket.id,
        'holder_full_name', v_previous_name,
        'owner_user_id', v_ticket.owner_user_id
      );
    end if;
  end if;

  if p_require_event_flags then
    if v_previous_name is null then
      if not v_event.allow_holder_change then
        raise exception 'Definicao de titular desabilitada para o evento.';
      end if;
    else
      if not v_event.allow_ticket_transfer then
        raise exception 'Alteracao de titular desabilitada para o evento.';
      end if;
    end if;
  end if;

  if p_holder_name is null then
    if v_previous_name is null
      and v_item.participant_id is null
      and v_item.registration_contact_id is null
      and v_ticket.participant_id is null then
      return jsonb_build_object(
        'success', true, 'changed', false, 'ticket_id', v_ticket.id,
        'holder_full_name', null, 'owner_user_id', v_ticket.owner_user_id
      );
    end if;
    v_operation := 'holder_removed';
    update public.order_items
    set
      holder_full_name = null,
      participant_id = null,
      registration_contact_id = null,
      ownership_status = 'unassigned',
      updated_at = now()
    where id = v_item.id;
  else
    -- Troca real de texto: titular vira textual. Nao transfere propriedade.
    -- Titular textual nao entra em assert_ticket_holder_contact_available;
    -- essa limitacao de unicidade permanece fora deste lote.
    v_operation := case when v_previous_name is null then 'holder_assigned' else 'holder_changed' end;
    update public.order_items
    set
      holder_full_name = v_name,
      participant_id = null,
      registration_contact_id = null,
      ownership_status = 'assigned',
      updated_at = now()
    where id = v_item.id;
  end if;

  update public.tickets
  set participant_id = null
  where id = v_ticket.id
    and owner_user_id is not distinct from v_owner_user_id;

  if exists (
    select 1 from public.tickets t
    where t.id = v_ticket.id and t.owner_user_id is distinct from v_owner_user_id
  ) then
    raise exception 'Propriedade do ingresso nao pode ser alterada por esta operacao.';
  end if;
  if exists (
    select 1 from public.orders o
    where o.id = v_ticket.order_id and o.user_id is distinct from v_order_user_id
  ) then
    raise exception 'Comprador do pedido nao pode ser alterado por esta operacao.';
  end if;

  insert into public.ticket_holder_history(
    ticket_id, order_item_id, event_id, organization_id, operation,
    previous_participant_id, new_participant_id,
    previous_registration_contact_id, new_registration_contact_id,
    previous_user_id, new_user_id,
    previous_holder_name, new_holder_name,
    actor_user_id, actor_origin, reason, reason_code, reason_text
  ) values (
    v_ticket.id, v_item.id, v_ticket.event_id, v_ticket.organization_id, v_operation,
    v_previous.id, null,
    v_previous_contact_id, null,
    v_previous_user_id, null,
    v_previous_name, v_name,
    v_actor, p_actor_origin, v_reason_text, v_reason_code, v_reason_text
  );

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    v_operation, 'tickets', v_ticket.id, v_ticket.event_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id,
      'previous_holder_name', v_previous_name,
      'new_holder_name', v_name,
      'previous_participant_id', v_previous.id,
      'new_participant_id', null,
      'previous_registration_contact_id', v_previous_contact_id,
      'new_registration_contact_id', null,
      'previous_user_id', v_previous_user_id,
      'new_user_id', null,
      'owner_user_id', v_owner_user_id,
      'actor_user_id', v_actor,
      'reason_code', v_reason_code,
      'reason_text', v_reason_text
    )
  );

  return jsonb_build_object(
    'success', true,
    'changed', true,
    'ticket_id', v_ticket.id,
    'holder_full_name', v_name,
    'owner_user_id', v_owner_user_id,
    'operation', v_operation
  );
end;
$$;

comment on function public.apply_ticket_holder_name_internal(uuid, text, text, text, text, boolean) is
  'Altera titular por nome textual. Mesmo nome (trim) e no-op e preserva FKs. Troca real desvincula Cadastro/participant e nao altera owner. Titular textual nao participa da unicidade 1 titular/pessoa/evento.';

revoke all on function public.apply_ticket_holder_name_internal(uuid, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.apply_ticket_holder_name_internal(uuid, text, text, text, text, boolean)
  to service_role;

commit;
