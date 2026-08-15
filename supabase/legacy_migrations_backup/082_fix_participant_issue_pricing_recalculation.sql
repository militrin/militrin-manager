-- 082_fix_participant_issue_pricing_recalculation.sql
-- Substitui as RPCs de pendencias para manter valores somente em payments.

begin;

create or replace function public.reevaluate_participant_data_issues(
  p_participant_id uuid,
  p_import_batch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_batch public.registration_batches%rowtype;
  v_price public.registration_batch_prices%rowtype;
  v_pricing record;
  v_gender text;
  v_open integer;
  v_price_defined boolean := false;
begin
  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;

  select * into v_event
  from public.events
  where id = v_participant.event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;

  if v_actor is not null
    and v_actor is distinct from v_participant.user_id
    and not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Usuario sem acesso ao participante.';
  end if;

  select * into v_batch
  from public.registration_batches
  where id = v_participant.batch_id;

  if not found then
    select * into v_batch
    from public.registration_batches
    where event_id = v_participant.event_id
      and is_active = true
    order by sequence_number asc
    limit 1;
  end if;

  if v_batch.id is not null and v_participant.ticket_category_id is not null then
    select * into v_price
    from public.registration_batch_prices
    where batch_id = v_batch.id
      and ticket_category_id = v_participant.ticket_category_id;
  end if;

  v_gender := lower(trim(coalesce(v_participant.gender, '')));

  if v_price.id is not null
    and v_price.male_price is distinct from v_price.female_price
    and v_gender not in ('masculino', 'male', 'm', 'feminino', 'female', 'f') then
    insert into public.participant_data_issues (
      organization_id, event_id, participant_id, import_batch_id, field_code,
      issue_type, message, blocks_payment, blocks_ticket_issuance
    ) values (
      v_event.organization_id, v_event.id, v_participant.id, p_import_batch_id, 'gender',
      'missing_required_for_pricing',
      'Informe o genero para calcular o valor da inscricao.', true, true
    ) on conflict do nothing;
  else
    update public.participant_data_issues
    set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
    where participant_id = v_participant.id
      and field_code = 'gender'
      and issue_type = 'missing_required_for_pricing'
      and status = 'open';

    if v_price.id is not null
      and v_gender in ('masculino', 'male', 'm', 'feminino', 'female', 'f') then
      select * into v_pricing
      from public.get_registration_pricing_preview(
        v_participant.gender,
        null,
        v_participant.event_id,
        v_participant.ticket_category_id
      )
      limit 1;

      if v_pricing.base_amount is not null then
        v_price_defined := true;

        update public.participants
        set batch_id = v_pricing.batch_id,
            updated_at = now()
        where id = v_participant.id;

        update public.payments
        set amount = v_pricing.base_amount,
            discount_amount = v_pricing.discount_amount,
            final_amount = v_pricing.final_amount,
            payment_status = 'pending',
            updated_at = now()
        where participant_id = v_participant.id
          and payment_status <> 'paid';

        if not exists (
          select 1 from public.payments where participant_id = v_participant.id
        ) then
          insert into public.payments (
            participant_id, event_id, amount, discount_amount, final_amount,
            payment_method, payment_status
          ) values (
            v_participant.id, v_event.id, v_pricing.base_amount,
            v_pricing.discount_amount, v_pricing.final_amount,
            'pix', 'pending'
          );
        end if;
      end if;
    end if;
  end if;

  if coalesce(v_event.limit_shirt_selection_to_stock, false)
    and exists (
      select 1 from public.event_kit_items
      where event_id = v_event.id and item_type = 'shirt' and is_active = true
    )
    and (
      nullif(trim(v_participant.shirt_type), '') is null
      or nullif(trim(v_participant.shirt_size), '') is null
    ) then
    insert into public.participant_data_issues (
      organization_id, event_id, participant_id, import_batch_id, field_code,
      issue_type, message, blocks_kit_delivery
    ) values (
      v_event.organization_id, v_event.id, v_participant.id, p_import_batch_id, 'shirt_selection',
      'missing_required_for_inventory',
      'Modelo e tamanho da camiseta devem ser informados antes da conclusao.', true
    ) on conflict do nothing;
  else
    update public.participant_data_issues
    set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
    where participant_id = v_participant.id
      and field_code = 'shirt_selection'
      and issue_type = 'missing_required_for_inventory'
      and status = 'open';
  end if;

  select count(*) into v_open
  from public.participant_data_issues
  where participant_id = v_participant.id and status = 'open';

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('participant_data_issues_reevaluated', 'participants', v_participant.id, v_event.id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'import_batch_id', p_import_batch_id,
      'open_issue_count', v_open,
      'source', case when p_import_batch_id is null then 'edit' else 'import' end
    ));

  return jsonb_build_object(
    'participant_id', v_participant.id,
    'open_issue_count', v_open,
    'price_defined', v_price_defined
  );
end;
$$;

revoke all on function public.reevaluate_participant_data_issues(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reevaluate_participant_data_issues(uuid, uuid)
  to authenticated;

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
  v_payment_amount numeric;
  v_payment_final_amount numeric;
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

  perform 1
  from public.participant_data_issues i
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
    return jsonb_build_object(
      'success', false,
      'conflict', true,
      'message', 'As pendencias foram atualizadas por outro usuario. Recarregue e tente novamente.'
    );
  end if;

  for v_requested_field in
    select jsonb_object_keys(coalesce(p_values, '{}'::jsonb))
  loop
    if v_requested_field not in (
      'gender', 'birth_date', 'cpf', 'shirt_type', 'shirt_size', 'city', 'phone', 'email'
    ) then
      raise exception 'Campo nao permitido: %.', v_requested_field;
    end if;
    if not (
      v_requested_field = any(v_allowed_fields)
      or (
        v_requested_field in ('shirt_type', 'shirt_size')
        and 'shirt_selection' = any(v_allowed_fields)
      )
    ) then
      raise exception 'Campo % nao corresponde a uma pendencia aberta.', v_requested_field;
    end if;
  end loop;

  if p_values ? 'gender'
    and lower(trim(p_values ->> 'gender')) not in ('male', 'female') then
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
    'id', i.id,
    'field_code', i.field_code,
    'issue_type', i.issue_type,
    'message', i.message,
    'blocks_payment', i.blocks_payment,
    'blocks_ticket_issuance', i.blocks_ticket_issuance,
    'blocks_checkin', i.blocks_checkin,
    'blocks_kit_delivery', i.blocks_kit_delivery
  ) order by i.created_at), '[]'::jsonb)
  into v_remaining
  from public.participant_data_issues i
  where i.participant_id = p_participant_id and i.status = 'open';

  select pay.payment_status, pay.amount, pay.final_amount
  into v_payment_status, v_payment_amount, v_payment_final_amount
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1;

  select lower(au.email) into v_actor_email
  from auth.users au
  where au.id = v_actor;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('participant_data_issues_resolved', 'participants', p_participant_id, v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'actor_email', v_actor_email,
      'organization_id', v_organization_id,
      'event_id', v_participant.event_id,
      'participant_id', p_participant_id,
      'issue_ids', p_expected_issue_ids,
      'fields_updated', (
        select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_values) k
      ),
      'previous_values', v_previous_values,
      'new_values', v_new_values,
      'remaining_issues', v_remaining,
      'source', 'participant_issue_resolution'
    ));

  return jsonb_build_object(
    'success', true,
    'message', case when jsonb_array_length(v_remaining) = 0
      then 'Dados atualizados. Valor recalculado. Pagamento permanece pendente.'
      else 'Dados atualizados. Ainda existem pendencias.' end,
    'base_amount', v_payment_amount,
    'final_amount', v_payment_final_amount,
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
