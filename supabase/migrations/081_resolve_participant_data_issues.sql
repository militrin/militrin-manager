-- 081_resolve_participant_data_issues.sql
-- Resolucao atomica e auditada de pendencias de dados de participantes.

begin;

create or replace function public.resolve_participant_data_issues(
  p_participant_id uuid,
  p_expected_issue_ids uuid[],
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_participant public.participants%rowtype;
  v_organization_id uuid;
  v_current_issue_ids uuid[];
  v_allowed_fields text[];
  v_requested_field text;
  v_previous_values jsonb := '{}'::jsonb;
  v_new_values jsonb := '{}'::jsonb;
  v_reevaluation jsonb;
  v_remaining jsonb;
  v_payment_status text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not (
    public.is_active_owner(v_actor)
    or public.resolve_user_permission(v_actor, 'participants.edit_basic')
  ) then
    raise exception 'Usuario sem permissao para resolver pendencias.';
  end if;

  select p.* into v_participant
  from public.participants p
  where p.id = p_participant_id
  for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;

  select e.organization_id into v_organization_id
  from public.events e where e.id = v_participant.event_id;
  if v_organization_id is null
    or not public.user_can_access_organization(v_actor, v_organization_id) then
    raise exception 'Usuario sem acesso a organizacao do participante.';
  end if;

  perform 1 from public.participant_data_issues i
  where i.participant_id = p_participant_id
  for update;

  select coalesce(array_agg(i.id order by i.id), array[]::uuid[]),
         coalesce(array_agg(distinct i.field_code), array[]::text[])
  into v_current_issue_ids, v_allowed_fields
  from public.participant_data_issues i
  where i.participant_id = p_participant_id and i.status = 'open';

  if v_current_issue_ids is distinct from (
    select coalesce(array_agg(x order by x), array[]::uuid[])
    from unnest(coalesce(p_expected_issue_ids, array[]::uuid[])) x
  ) then
    return jsonb_build_object(
      'success', false,
      'conflict', true,
      'message', 'As pendencias foram atualizadas por outro usuario. Recarregue e tente novamente.'
    );
  end if;

  if coalesce(array_length(v_current_issue_ids, 1), 0) = 0 then
    return jsonb_build_object('success', false, 'conflict', true,
      'message', 'As pendencias foram atualizadas por outro usuario. Recarregue e tente novamente.');
  end if;

  for v_requested_field in select jsonb_object_keys(coalesce(p_values, '{}'::jsonb))
  loop
    if v_requested_field not in ('gender', 'birth_date', 'cpf', 'shirt_type', 'shirt_size', 'city', 'phone', 'email') then
      raise exception 'Campo nao permitido: %.', v_requested_field;
    end if;
    if not (
      v_requested_field = any(v_allowed_fields)
      or (v_requested_field in ('shirt_type', 'shirt_size') and 'shirt_selection' = any(v_allowed_fields))
    ) then
      raise exception 'Campo % nao corresponde a uma pendencia aberta.', v_requested_field;
    end if;
  end loop;

  if p_values ? 'gender' and lower(trim(p_values ->> 'gender')) not in ('male', 'female') then
    raise exception 'Genero invalido.';
  end if;

  v_previous_values := jsonb_strip_nulls(jsonb_build_object(
    'gender', case when p_values ? 'gender' then v_participant.gender end,
    'birth_date', case when p_values ? 'birth_date' then v_participant.birth_date end,
    'cpf', case when p_values ? 'cpf' then v_participant.cpf end,
    'shirt_type', case when p_values ? 'shirt_type' then v_participant.shirt_type end,
    'shirt_size', case when p_values ? 'shirt_size' then v_participant.shirt_size end,
    'city', case when p_values ? 'city' then v_participant.city end,
    'phone', case when p_values ? 'phone' then v_participant.phone end,
    'email', case when p_values ? 'email' then v_participant.email end
  ));

  update public.participants p
  set gender = case when p_values ? 'gender' then nullif(trim(p_values ->> 'gender'), '') else p.gender end,
      birth_date = case when p_values ? 'birth_date' then nullif(trim(p_values ->> 'birth_date'), '')::date else p.birth_date end,
      cpf = case when p_values ? 'cpf' then nullif(regexp_replace(p_values ->> 'cpf', '\D', '', 'g'), '') else p.cpf end,
      shirt_type = case when p_values ? 'shirt_type' then nullif(trim(p_values ->> 'shirt_type'), '') else p.shirt_type end,
      shirt_size = case when p_values ? 'shirt_size' then nullif(upper(trim(p_values ->> 'shirt_size')), '') else p.shirt_size end,
      city = case when p_values ? 'city' then nullif(trim(p_values ->> 'city'), '') else p.city end,
      phone = case when p_values ? 'phone' then nullif(regexp_replace(p_values ->> 'phone', '\D', '', 'g'), '') else p.phone end,
      email = case when p_values ? 'email' then lower(nullif(trim(p_values ->> 'email'), '')) else p.email end,
      updated_at = now()
  where p.id = p_participant_id
  returning jsonb_strip_nulls(jsonb_build_object(
    'gender', case when p_values ? 'gender' then p.gender end,
    'birth_date', case when p_values ? 'birth_date' then p.birth_date end,
    'cpf', case when p_values ? 'cpf' then p.cpf end,
    'shirt_type', case when p_values ? 'shirt_type' then p.shirt_type end,
    'shirt_size', case when p_values ? 'shirt_size' then p.shirt_size end,
    'city', case when p_values ? 'city' then p.city end,
    'phone', case when p_values ? 'phone' then p.phone end,
    'email', case when p_values ? 'email' then p.email end
  )) into v_new_values;

  v_reevaluation := public.reevaluate_participant_data_issues(p_participant_id, null);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'field_code', i.field_code, 'issue_type', i.issue_type,
    'message', i.message, 'blocks_payment', i.blocks_payment,
    'blocks_ticket_issuance', i.blocks_ticket_issuance,
    'blocks_checkin', i.blocks_checkin, 'blocks_kit_delivery', i.blocks_kit_delivery
  ) order by i.created_at), '[]'::jsonb)
  into v_remaining
  from public.participant_data_issues i
  where i.participant_id = p_participant_id and i.status = 'open';

  select pay.payment_status into v_payment_status
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc limit 1;

  select lower(au.email) into v_actor_email from auth.users au where au.id = v_actor;
  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('participant_data_issues_resolved', 'participants', p_participant_id, v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor, 'actor_email', v_actor_email,
      'organization_id', v_organization_id, 'event_id', v_participant.event_id,
      'participant_id', p_participant_id, 'issue_ids', p_expected_issue_ids,
      'fields_updated', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_values) k),
      'previous_values', v_previous_values, 'new_values', v_new_values,
      'remaining_issues', v_remaining, 'source', 'participant_issue_resolution'
    ));

  return jsonb_build_object(
    'success', true,
    'message', case when jsonb_array_length(v_remaining) = 0
      then 'Dados atualizados. Valor recalculado. Pagamento permanece pendente.'
      else 'Dados atualizados. Ainda existem pendencias.' end,
    'base_amount', (select p.base_amount from public.participants p where p.id = p_participant_id),
    'final_amount', (select p.final_amount from public.participants p where p.id = p_participant_id),
    'payment_status', coalesce(v_payment_status, 'pending'),
    'remaining_issues', v_remaining,
    'reevaluation', v_reevaluation
  );
end;
$$;

revoke all on function public.resolve_participant_data_issues(uuid, uuid[], jsonb)
  from public, anon, authenticated;
grant execute on function public.resolve_participant_data_issues(uuid, uuid[], jsonb)
  to authenticated;

commit;
