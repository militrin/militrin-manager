begin;

create or replace function public.checkin_ticket_entry(
  p_ticket_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_payment record;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
  v_used_at timestamptz := now();
begin
  if not public.current_user_has_permission('checkin.scan') then
    raise exception 'Sem permissao para realizar check-in.';
  end if;

  if p_ticket_id is null then
    raise exception 'Ingresso obrigatorio.';
  end if;

  select *
  into v_ticket
  from public.tickets
  where id = p_ticket_id
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  if coalesce(v_ticket.status, 'pending') = 'cancelled' then
    raise exception 'Ingresso cancelado. Check-in bloqueado.';
  end if;

  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    raise exception 'Este ingresso ja foi utilizado por outro operador.';
  end if;

  if v_ticket.participant_id is null then
    raise exception 'Ingresso sem titular definido.';
  end if;

  select *
  into v_participant
  from public.participants
  where id = v_ticket.participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select p.payment_status, p.payment_method
  into v_payment
  from public.get_participant_payment_details(v_participant.id) p
  limit 1;

  if coalesce(v_payment.payment_status, 'pending') <> 'paid' then
    raise exception 'Pagamento pendente. Check-in bloqueado.';
  end if;

  if coalesce(v_participant.registration_status, 'pending') = 'cancelled' then
    raise exception 'Inscricao cancelada. Check-in bloqueado.';
  end if;

  update public.tickets
  set status = 'used',
      used_at = v_used_at
  where id = v_ticket.id;

  if v_participant.user_id is not null and v_participant.event_id is not null then
    insert into public.participation_history (
      event_id,
      user_id,
      participant_id,
      legacy_event_name,
      event_year,
      full_name,
      normalized_name,
      cpf,
      email,
      status,
      source,
      manually_verified,
      created_at,
      updated_at
    )
    values (
      v_participant.event_id,
      v_participant.user_id,
      v_participant.id,
      null,
      extract(year from coalesce(v_participant.created_at, now()))::integer,
      coalesce(nullif(trim(v_participant.full_name), ''), 'Participante'),
      public.normalize_text_for_match(v_participant.full_name),
      v_participant.cpf,
      v_participant.email,
      'confirmed',
      'system',
      false,
      now(),
      now()
    )
    on conflict do nothing;

    perform public.recalculate_customer_loyalty(v_participant.user_id);
  end if;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor_email,
    'ticket_checkin_entry',
    'tickets',
    v_ticket.id,
    v_participant.event_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id,
      'participant_id', v_participant.id,
      'used_at', v_used_at,
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email
    )
  );

  return true;
end;
$$;

create or replace function public.undo_ticket_checkin(
  p_ticket_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('checkin.undo') then
    raise exception 'Sem permissao para desfazer check-in.';
  end if;

  if p_ticket_id is null then
    raise exception 'Ingresso obrigatorio.';
  end if;

  select *
  into v_ticket
  from public.tickets
  where id = p_ticket_id
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  if v_ticket.status <> 'used' and v_ticket.used_at is null then
    raise exception 'Ingresso nao possui check-in para desfazer.';
  end if;

  if v_ticket.participant_id is not null then
    select *
    into v_participant
    from public.participants
    where id = v_ticket.participant_id;
  end if;

  update public.tickets
  set status = 'active',
      used_at = null
  where id = v_ticket.id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor_email,
    'ticket_checkin_undo',
    'tickets',
    v_ticket.id,
    coalesce(v_participant.event_id, v_ticket.event_id),
    jsonb_build_object(
      'ticket_id', v_ticket.id,
      'participant_id', v_ticket.participant_id,
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email
    )
  );

  return true;
end;
$$;

grant execute on function public.checkin_ticket_entry(uuid) to authenticated;
grant execute on function public.undo_ticket_checkin(uuid) to authenticated;

commit;
