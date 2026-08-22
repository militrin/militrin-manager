-- Enriquece o erro "pulseira ja vinculada a outro ingresso" de
-- link_wristband_to_ticket (migration 20260848000000) com um detail
-- estruturado (mesmo padrao P0001+detail ja usado por WRISTBAND_REQUIRED,
-- SHIRT_OUT_OF_STOCK etc.), incluindo o nome do titular do OUTRO ingresso
-- quando resolvivel -- pedido explicito do Modo Turbo pra mostrar um
-- bloqueio forte e informativo ao inves de so uma frase generica.
--
-- COMPATIBILIDADE: a MENSAGEM continua exatamente a mesma string
-- ('Pulseira ja vinculada a outro ingresso.') -- so o detail ganha o JSON
-- novo. Chamadores existentes que so leem error.message (linkWristbandAction,
-- replaceWristbandAction em src/app/operacoes/actions.ts) continuam
-- funcionando identico, sem nenhuma mudanca de comportamento pra eles;
-- somente quem passar a parsear error.details (operationRpcError, novo
-- branch WRISTBAND_LINKED_TO_ANOTHER_TICKET) ganha a info extra.
--
-- Mesma assinatura (uuid, text) -- create or replace basta, sem
-- drop/regrant.
begin;

create or replace function public.link_wristband_to_ticket(p_ticket_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_ticket      public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_event       public.events%rowtype;
  v_existing    public.participant_wristbands%rowtype;
  v_wristband   public.participant_wristbands%rowtype;
  v_code        text := nullif(trim(p_code), '');
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
  v_other_holder_name text;
begin
  if not (public.is_active_owner(auth.uid()) or public.current_user_has_permission('wristbands.link')) then
    raise exception 'Sem permissao para vincular pulseira.';
  end if;

  if p_ticket_id is null then raise exception 'Ingresso obrigatorio.'; end if;
  if v_code is null then raise exception 'Codigo da pulseira obrigatorio.'; end if;

  select t.* into v_ticket from public.tickets t where t.id = p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Sem permissao para vincular pulseira nesta organização.';
  end if;

  select e.* into v_event from public.events e where e.id = v_ticket.event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not coalesce(v_event.wristband_enabled, false) then
    raise exception 'Este evento nao utiliza pulseiras vinculadas.';
  end if;

  if v_ticket.participant_id is not null then
    select p.* into v_participant from public.participants p where p.id = v_ticket.participant_id;
  end if;

  select pw.* into v_existing
  from public.participant_wristbands pw
  where pw.event_id = v_ticket.event_id
    and lower(pw.code) = lower(v_code)
    and pw.status = 'active'
  limit 1 for update;

  if found then
    if v_existing.ticket_id = p_ticket_id then
      return jsonb_build_object('success', true, 'already_linked', true, 'wristband_id', v_existing.id, 'code', v_existing.code);
    end if;

    -- Best-effort: nome do titular do OUTRO ingresso, so pra enriquecer a
    -- mensagem (nunca bloqueia o fluxo se nao for resolvivel).
    select coalesce(oi.holder_full_name, op.full_name)
      into v_other_holder_name
    from public.tickets ot
    left join public.order_items oi on oi.id = ot.order_item_id
    left join public.participants op on op.id = ot.participant_id
    where ot.id = v_existing.ticket_id;

    raise exception using errcode = 'P0001', message = 'Pulseira ja vinculada a outro ingresso.',
      detail = jsonb_build_object(
        'code', 'WRISTBAND_LINKED_TO_ANOTHER_TICKET',
        'message', 'Pulseira ja vinculada a outro ingresso.',
        'holder_name', v_other_holder_name
      )::text;
  end if;

  if exists (select 1 from public.participant_wristbands pw where pw.ticket_id = p_ticket_id and pw.status = 'active') then
    raise exception 'Este ingresso ja possui uma pulseira ativa.';
  end if;

  insert into public.participant_wristbands (event_id, ticket_id, participant_id, code, status, linked_at, linked_by)
  values (v_ticket.event_id, p_ticket_id, v_participant.id, v_code, 'active', now(), auth.uid())
  returning * into v_wristband;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'wristband_linked', 'participant_wristbands', v_wristband.id, v_ticket.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(), 'actor_email', v_actor_email, 'organization_id', v_wristband.organization_id,
      'ticket_id', p_ticket_id, 'participant_id', v_participant.id, 'code', v_code
    )
  );

  return jsonb_build_object('success', true, 'already_linked', false, 'wristband_id', v_wristband.id, 'code', v_wristband.code);
end;
$$;

revoke all on function public.link_wristband_to_ticket(uuid, text) from public, anon;
grant execute on function public.link_wristband_to_ticket(uuid, text) to authenticated, service_role;

commit;
