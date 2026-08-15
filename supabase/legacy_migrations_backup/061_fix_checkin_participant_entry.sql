-- 061_fix_checkin_participant_entry.sql
-- Corrige o check-in para buscar o pagamento em public.payments
-- e usar a estrutura atual de public.audit_logs, sem a coluna actor.

begin;

create or replace function public.checkin_participant_entry(
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
  v_payment_status text := 'pending';
  v_actor_user_id uuid := auth.uid();
  v_actor_email text := coalesce(
    (
      select lower(u.email)
      from auth.users u
      where u.id = auth.uid()
    ),
    'system'
  );
begin
  if not public.current_user_has_permission('checkin.scan'::text) then
    raise exception 'Sem permissao para realizar check-in.';
  end if;

  select p.*
  into v_participant
  from public.participants p
  where p.id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select coalesce(pay.payment_status, 'pending')
  into v_payment_status
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by
    case when pay.payment_status = 'paid' then 0 else 1 end,
    pay.paid_at desc nulls last,
    pay.created_at desc
  limit 1;

  v_payment_status := coalesce(v_payment_status, 'pending');

  if v_payment_status <> 'paid' then
    raise exception 'Pagamento pendente. Check-in bloqueado.';
  end if;

  if coalesce(v_participant.registration_status, 'pending') = 'cancelled' then
    raise exception 'Inscricao cancelada. Check-in bloqueado.';
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

  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    raise exception 'Ingresso ja utilizado anteriormente.';
  end if;

  update public.tickets t
  set status = 'used',
      used_at = now()
  where t.id = v_ticket.id;

  if v_participant.user_id is not null
     and v_participant.event_id is not null then
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
    action,
    entity_type,
    entity_id,
    event_id,
    details
  )
  values (
    'participant_checkin_entry',
    'participants',
    p_participant_id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'actor_email', v_actor_email,
      'ticket_id', v_ticket.id,
      'used_at', now()
    )
  );

  return true;
end;
$function$;

grant execute
on function public.checkin_participant_entry(uuid)
to authenticated;

commit;