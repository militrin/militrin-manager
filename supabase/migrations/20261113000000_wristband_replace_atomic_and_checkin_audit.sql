-- Pulseira operacional: substituicao atomica com motivo catalogado + auditoria
-- de check-in com a pulseira ativa no momento. Nao altera a regra de
-- obrigatoriedade (WRISTBAND_REQUIRED continua a mesma). Nao mexe em
-- tickets/pulseiras existentes. Sem backfill.
--
-- Concorrencia: unique index ja existente
--   participant_wristbands_event_code_active_uidx (event_id, lower(code)) WHERE status='active'
--   participant_wristbands_ticket_active_uidx (ticket_id) WHERE status='active'
-- mais SELECT ... FOR UPDATE no ticket, na pulseira antiga e na candidata.

begin;

create or replace function public.validate_wristband_replace_reason_code(p_reason_code text, p_reason_text text)
returns void
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_code text := lower(trim(coalesce(p_reason_code, '')));
begin
  if v_code not in ('damaged', 'lost', 'incorrectly_linked', 'operational_swap', 'other') then
    raise exception 'Selecione um motivo valido para substituir a pulseira.';
  end if;
  if v_code = 'other' and nullif(trim(coalesce(p_reason_text, '')), '') is null then
    raise exception 'Descreva o motivo quando selecionar Outro.';
  end if;
end;
$$;

comment on function public.validate_wristband_replace_reason_code(text, text) is
  'Catalogo de motivo da substituicao de pulseira: damaged/lost/incorrectly_linked/operational_swap/other (texto obrigatorio).';

revoke all on function public.validate_wristband_replace_reason_code(text, text) from public, anon;
grant execute on function public.validate_wristband_replace_reason_code(text, text) to authenticated, service_role;

-- Assinatura antiga (uuid, text, text) tinha motivo livre opcional. DROP
-- explicito: CREATE OR REPLACE nao troca o 3o argumento de p_reason para
-- p_reason_code + p_reason_text obrigatorio.
drop function if exists public.replace_wristband_for_ticket(uuid, text, text);

create or replace function public.replace_wristband_for_ticket(
  p_ticket_id uuid,
  p_new_code text,
  p_reason_code text,
  p_reason_text text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_ticket public.tickets%rowtype;
  v_event public.events%rowtype;
  v_participant public.participants%rowtype;
  v_old public.participant_wristbands%rowtype;
  v_existing public.participant_wristbands%rowtype;
  v_new public.participant_wristbands%rowtype;
  v_code text := nullif(trim(p_new_code), '');
  v_reason_code text := lower(trim(coalesce(p_reason_code, '')));
  v_reason_text text := nullif(trim(coalesce(p_reason_text, '')), '');
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
  v_constraint text;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.replace')
  ) then
    raise exception 'Sem permissao para substituir pulseira.';
  end if;

  perform public.validate_wristband_replace_reason_code(p_reason_code, p_reason_text);

  if p_ticket_id is null then
    raise exception 'Ingresso obrigatorio.';
  end if;
  if v_code is null then
    raise exception 'Codigo da pulseira obrigatorio.';
  end if;

  select t.* into v_ticket
  from public.tickets t
  where t.id = p_ticket_id
  for update;
  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;
  if not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Sem permissao para substituir pulseira nesta organização.';
  end if;
  if v_ticket.status = 'cancelled' then
    raise exception 'Ingresso cancelado nao permite substituir pulseira.';
  end if;

  select e.* into v_event from public.events e where e.id = v_ticket.event_id;
  if not found then
    raise exception 'Evento nao encontrado.';
  end if;
  if not coalesce(v_event.wristband_enabled, false) then
    raise exception 'Este evento nao utiliza pulseiras vinculadas.';
  end if;

  if v_ticket.participant_id is not null then
    select p.* into v_participant from public.participants p where p.id = v_ticket.participant_id;
  end if;

  select pw.* into v_old
  from public.participant_wristbands pw
  where pw.ticket_id = p_ticket_id
    and pw.status = 'active'
  limit 1
  for update;
  if not found then
    raise exception 'Este ingresso nao possui pulseira ativa para substituir.';
  end if;

  if lower(v_old.code) = lower(v_code) then
    raise exception 'A nova pulseira deve ser diferente da atual.';
  end if;

  select pw.* into v_existing
  from public.participant_wristbands pw
  where pw.event_id = v_ticket.event_id
    and lower(pw.code) = lower(v_code)
    and pw.status = 'active'
  limit 1
  for update;

  if found then
    raise exception using
      errcode = 'P0001',
      message = 'Esta pulseira já está vinculada a outro ingresso.',
      detail = jsonb_build_object(
        'code', 'WRISTBAND_LINKED_TO_ANOTHER_TICKET',
        'message', 'Esta pulseira já está vinculada a outro ingresso.'
      )::text;
  end if;

  update public.participant_wristbands pw
  set status = 'replaced',
      unlinked_at = now(),
      unlinked_by = auth.uid(),
      notes = concat_ws(' — ', v_reason_code, v_reason_text),
      updated_at = now()
  where pw.id = v_old.id;

  begin
    insert into public.participant_wristbands (
      event_id, ticket_id, participant_id, code, status, linked_at, linked_by
    ) values (
      v_ticket.event_id,
      p_ticket_id,
      v_participant.id,
      v_code,
      'active',
      now(),
      auth.uid()
    )
    returning * into v_new;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint in ('participant_wristbands_event_code_active_uidx', 'participant_wristbands_ticket_active_uidx') then
        raise exception using
          errcode = 'P0001',
          message = 'Esta pulseira já está vinculada a outro ingresso.',
          detail = jsonb_build_object(
            'code', 'WRISTBAND_LINKED_TO_ANOTHER_TICKET',
            'message', 'Esta pulseira já está vinculada a outro ingresso.'
          )::text;
      end if;
      raise;
  end;

  update public.participant_wristbands
  set replaced_by_wristband_id = v_new.id,
      updated_at = now()
  where id = v_old.id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'wristband_replaced',
    'participant_wristbands',
    v_new.id,
    v_ticket.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'operator_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_ticket.organization_id,
      'ticket_id', p_ticket_id,
      'old_wristband_id', v_old.id,
      'old_wristband_code', v_old.code,
      'new_wristband_id', v_new.id,
      'new_wristband_code', v_new.code,
      'reason_code', v_reason_code,
      'reason_text', v_reason_text
    )
  );

  return jsonb_build_object(
    'success', true,
    'wristband_id', v_new.id,
    'code', v_new.code,
    'replaced_wristband_id', v_old.id,
    'old_code', v_old.code
  );
end;
$$;

comment on function public.replace_wristband_for_ticket(uuid, text, text, text) is
  'Substitui a pulseira ativa do ingresso de forma atomica. Qualquer falha faz rollback completo. Nao altera check-in nem kit.';

revoke all on function public.replace_wristband_for_ticket(uuid, text, text, text) from public, anon;
grant execute on function public.replace_wristband_for_ticket(uuid, text, text, text) to authenticated, service_role;

-- Check-in: mesmos gates (pagamento, WRISTBAND_REQUIRED). So enriquece o
-- audit de NOVOS check-ins com a pulseira ativa no momento. Sem backfill.
create or replace function public.checkin_ticket_entry(p_ticket_id uuid, p_wristband_code text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_participant public.participants%rowtype; v_contact public.registration_contacts%rowtype; v_actor_email text;
  v_event public.events%rowtype; v_has_wristband boolean;
  v_wristband public.participant_wristbands%rowtype;
  v_details jsonb;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para realizar check-in.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado. Check-in bloqueado.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Este ingresso ja foi utilizado.'; end if;
  select * into v_item from public.order_items where id=v_ticket.order_item_id for update;
  if not found or v_item.status in('cancelled','expired','refunded') then raise exception 'Item de pedido invalido para check-in.'; end if;
  select * into strict v_order from public.orders where id=v_ticket.order_id;
  if not public.ticket_has_operational_payment(v_order.id) then
    raise exception 'Pagamento ainda não confirmado. A entrega/check-in não pode ser realizada.';
  end if;

  select * into v_event from public.events where id = v_ticket.event_id;
  if coalesce(v_event.wristband_enabled, false) and coalesce(v_event.wristband_required_for_checkin, false) then
    select exists(select 1 from public.participant_wristbands pw where pw.ticket_id = v_ticket.id and pw.status = 'active') into v_has_wristband;
    if not v_has_wristband then
      if nullif(trim(coalesce(p_wristband_code, '')), '') is null then
        raise exception using errcode = 'P0001', message = 'WRISTBAND_REQUIRED',
          detail = jsonb_build_object('code', 'WRISTBAND_REQUIRED', 'message', 'Este evento exige pulseira vinculada para o check-in.')::text;
      end if;
      perform public.link_wristband_to_ticket(v_ticket.id, p_wristband_code);
    end if;
  end if;

  update public.tickets set status='used',used_at=now() where id=v_ticket.id;
  if v_item.participant_id is not null then
    select * into v_participant from public.participants where id=v_item.participant_id;
    if found and v_participant.registration_contact_id is not null then select * into v_contact from public.registration_contacts where id=v_participant.registration_contact_id; end if;
    if found and v_participant.user_id is not null then
      insert into public.participation_history(event_id,user_id,participant_id,registration_contact_id,legacy_event_name,event_year,full_name,normalized_name,cpf,email,status,source,manually_verified,created_at,updated_at)
      values(v_ticket.event_id,v_participant.user_id,v_participant.id,v_participant.registration_contact_id,null,extract(year from coalesce(v_ticket.issued_at,now()))::integer,
        coalesce(v_contact.full_name,v_participant.full_name,'Participante'),public.normalize_text_for_match(coalesce(v_contact.full_name,v_participant.full_name)),
        coalesce(v_contact.cpf,v_participant.cpf),coalesce(v_contact.email,v_participant.email),'confirmed','system',false,now(),now()) on conflict do nothing;
    end if;
  end if;
  select lower(email) into v_actor_email from auth.users where id=auth.uid();
  select pw.* into v_wristband
  from public.participant_wristbands pw
  where pw.ticket_id = v_ticket.id and pw.status = 'active'
  limit 1;
  v_details := jsonb_build_object('actor_user_id',auth.uid(),'actor_email',v_actor_email,'organization_id',v_ticket.organization_id,'ticket_id',v_ticket.id,
      'order_item_id',v_ticket.order_item_id,'participant_id',v_item.participant_id,'registration_contact_id',v_item.registration_contact_id,'used_at',now());
  if v_wristband.id is not null then
    v_details := v_details || jsonb_build_object(
      'wristband_code', v_wristband.code,
      'wristband_id', v_wristband.id,
      'wristband_status', v_wristband.status
    );
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_checkin_entry','tickets',v_ticket.id,v_ticket.event_id, v_details);
  return true;
end;
$$;

revoke all on function public.checkin_ticket_entry(uuid, text) from public, anon;
grant execute on function public.checkin_ticket_entry(uuid, text) to authenticated, service_role;

commit;
