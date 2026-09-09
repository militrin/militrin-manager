-- UX admin: e-mail compartilhado + alterar conta proprietaria sem trocar titular.

begin;

alter table public.ticket_owner_history
  drop constraint if exists ticket_owner_history_reason_code_check;

alter table public.ticket_owner_history
  add constraint ticket_owner_history_reason_code_check
  check (reason_code = any (array[
    'registration_correction',
    'buyer_request',
    'holder_request',
    'third_party_ticket',
    'administrative_adjustment',
    'issuance_error',
    'system_error',
    'data_regularization',
    'other',
    'legacy_unclassified',
    'shared_email',
    'family_responsible',
    'account_correction',
    'administrative_transfer'
  ]));

create or replace function public.apply_ticket_account_owner(
  p_ticket_id uuid,
  p_owner_contact_id uuid,
  p_actor uuid,
  p_reason_code text,
  p_reason_text text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket public.tickets%rowtype;
  v_order public.orders%rowtype;
  v_contact public.registration_contacts%rowtype;
  v_auth_user_id uuid;
  v_previous_holder uuid;
  v_previous_buyer uuid;
  v_previous_intended uuid;
  v_previous_owner uuid;
  v_operation text;
  v_history_actor uuid;
  v_changed boolean := false;
  v_materialized boolean := false;
begin
  if p_ticket_id is null or p_owner_contact_id is null then
    raise exception 'Ingresso ou Pessoa invalida.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ingresso invalido.'; end if;
  select * into v_order from public.orders where id = v_ticket.order_id for update;
  if not found then raise exception 'Pedido do ingresso nao encontrado.'; end if;
  select * into v_contact from public.registration_contacts where id = p_owner_contact_id for update;
  if not found or v_contact.organization_id is distinct from v_ticket.organization_id then
    raise exception 'Pessoa invalida para este ingresso.';
  end if;

  v_previous_holder := v_ticket.participant_id;
  v_previous_buyer := v_order.user_id;
  v_previous_intended := v_ticket.intended_owner_contact_id;
  v_previous_owner := v_ticket.owner_user_id;

  select au.id into v_auth_user_id
  from auth.users au
  where au.id = v_contact.user_id;

  if v_ticket.intended_owner_contact_id is not distinct from v_contact.id
    and v_ticket.owner_user_id is not distinct from v_auth_user_id then
    return jsonb_build_object(
      'success', true,
      'changed', false,
      'ticket_id', v_ticket.id,
      'owner_contact_id', v_contact.id,
      'owner_user_id', v_ticket.owner_user_id,
      'materialized', v_auth_user_id is not null,
      'holder_changed', false,
      'buyer_changed', false
    );
  end if;

  update public.tickets
  set intended_owner_contact_id = v_contact.id
  where id = v_ticket.id
    and intended_owner_contact_id is distinct from v_contact.id;
  if found then v_changed := true; end if;

  update public.order_items
  set intended_owner_contact_id = v_contact.id, updated_at = now()
  where id = v_ticket.order_item_id
    and intended_owner_contact_id is distinct from v_contact.id;

  if v_auth_user_id is not null then
    v_materialized := true;
    if v_ticket.owner_user_id is distinct from v_auth_user_id then
      update public.tickets
      set owner_user_id = v_auth_user_id
      where id = v_ticket.id;
      v_changed := true;
      v_operation := case when v_ticket.owner_user_id is null then 'owner_assigned' else 'owner_transferred' end;
      v_history_actor := coalesce(p_actor, v_auth_user_id);
      insert into public.ticket_owner_history(
        ticket_id, order_id, event_id, organization_id, operation,
        previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
      ) values (
        v_ticket.id, v_ticket.order_id, v_ticket.event_id, v_ticket.organization_id, v_operation,
        v_ticket.owner_user_id, v_auth_user_id, v_history_actor, p_reason_code, p_reason_text
      );
    end if;
  else
    if v_ticket.owner_user_id is not null then
      update public.tickets
      set owner_user_id = null
      where id = v_ticket.id;
      v_changed := true;
    end if;
  end if;

  if exists (
    select 1 from public.tickets t
    where t.id = v_ticket.id and t.participant_id is distinct from v_previous_holder
  ) then
    raise exception 'OWNER_HOLDER_MUTATION_FORBIDDEN';
  end if;
  if exists (
    select 1 from public.orders o
    where o.id = v_ticket.order_id and o.user_id is distinct from v_previous_buyer
  ) then
    raise exception 'OWNER_BUYER_MUTATION_FORBIDDEN';
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'ticket_account_owner_assigned',
    'tickets',
    v_ticket.id,
    v_ticket.event_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id,
      'order_id', v_ticket.order_id,
      'actor_user_id', p_actor,
      'previous_owner_contact_id', v_previous_intended,
      'new_owner_contact_id', v_contact.id,
      'previous_owner_user_id', v_previous_owner,
      'new_owner_user_id', v_auth_user_id,
      'owner_contact_name', v_contact.full_name,
      'materialized', v_materialized,
      'holder_changed', false,
      'buyer_changed', false,
      'people_merged', false,
      'reason_code', p_reason_code,
      'reason_text', p_reason_text
    )
  );

  return jsonb_build_object(
    'success', true,
    'changed', v_changed,
    'ticket_id', v_ticket.id,
    'owner_contact_id', v_contact.id,
    'owner_user_id', v_auth_user_id,
    'materialized', v_materialized,
    'holder_changed', false,
    'buyer_changed', false
  );
end;
$$;

create or replace function public.admin_assign_ticket_account_owner(
  p_ticket_id uuid,
  p_owner_contact_id uuid,
  p_reason_code text,
  p_reason_text text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_reason_code text := trim(coalesce(p_reason_code, ''));
  v_reason_text text := nullif(trim(coalesce(p_reason_text, '')), '');
  v_ticket public.tickets%rowtype;
begin
  if v_actor is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'Sem permissao.';
    end if;
  elsif not (
    public.current_user_has_permission('participants.edit_basic')
    or public.current_user_has_permission('tickets.transfer_ownership')
  ) then
    raise exception 'Sem permissao para alterar a conta proprietaria.';
  end if;
  if v_reason_code not in (
    'shared_email', 'family_responsible', 'account_correction', 'administrative_transfer', 'other'
  ) then
    raise exception 'Selecione um motivo valido.';
  end if;
  if v_reason_code = 'other' and v_reason_text is null then
    raise exception 'Descreva o motivo da alteracao.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id;
  if not found then raise exception 'Ingresso invalido.'; end if;
  if v_actor is not null and not public.user_can_access_organization(v_actor, v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso.';
  end if;
  if v_ticket.status in ('cancelled', 'canceled', 'void', 'voided') then
    raise exception 'Ingresso cancelado nao permite alterar a conta proprietaria.';
  end if;

  return public.apply_ticket_account_owner(
    p_ticket_id, p_owner_contact_id, v_actor, v_reason_code, v_reason_text
  );
end;
$$;

create or replace function public.assign_shared_email_account_owner_org(
  p_primary_contact_id uuid,
  p_reason_code text,
  p_reason_text text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_reason_code text := trim(coalesce(p_reason_code, ''));
  v_reason_text text := nullif(trim(coalesce(p_reason_text, '')), '');
  v_primary public.registration_contacts%rowtype;
  v_email text;
  v_ticket record;
  v_results jsonb := '[]'::jsonb;
  v_changed integer := 0;
  v_materialized integer := 0;
  v_result jsonb;
begin
  if v_actor is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'Sem permissao.';
    end if;
  elsif not (
    public.current_user_has_permission('participants.edit_basic')
    or public.current_user_has_permission('tickets.transfer_ownership')
  ) then
    raise exception 'Sem permissao para definir a conta principal.';
  end if;
  if v_reason_code not in (
    'shared_email', 'family_responsible', 'account_correction', 'administrative_transfer', 'other'
  ) then
    raise exception 'Selecione um motivo valido.';
  end if;
  if v_reason_code = 'other' and v_reason_text is null then
    raise exception 'Descreva o motivo da alteracao.';
  end if;

  select * into v_primary from public.registration_contacts where id = p_primary_contact_id;
  if not found then raise exception 'Pessoa invalida.'; end if;
  if v_actor is not null and not public.user_can_access_organization(v_actor, v_primary.organization_id) then
    raise exception 'Pessoa invalida ou sem acesso.';
  end if;
  v_email := lower(trim(coalesce(v_primary.email, '')));
  if v_email = '' then raise exception 'A Pessoa principal precisa de e-mail.'; end if;

  for v_ticket in
    select t.id
    from public.tickets t
    left join public.participants p on p.id = t.participant_id
    left join public.order_items oi on oi.id = t.order_item_id
    join public.registration_contacts holder
      on holder.id = coalesce(p.registration_contact_id, oi.registration_contact_id)
    where t.organization_id = v_primary.organization_id
      and holder.organization_id = v_primary.organization_id
      and lower(trim(coalesce(holder.email, ''))) = v_email
      and t.status not in ('cancelled', 'canceled', 'void', 'voided')
  loop
    v_result := public.apply_ticket_account_owner(
      v_ticket.id, v_primary.id, v_actor, v_reason_code, v_reason_text
    );
    v_results := v_results || jsonb_build_array(v_result);
    if coalesce((v_result->>'changed')::boolean, false) then
      v_changed := v_changed + 1;
    end if;
    if coalesce((v_result->>'materialized')::boolean, false) then
      v_materialized := v_materialized + 1;
    end if;
  end loop;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'shared_email_account_owner_assigned',
    'registration_contacts',
    v_primary.id,
    null,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'primary_contact_id', v_primary.id,
      'new_owner_contact_id', v_primary.id,
      'email_masked', left(v_email, 2) || '***@' || split_part(v_email, '@', 2),
      'tickets_changed', v_changed,
      'tickets_materialized', v_materialized,
      'people_merged', false,
      'holders_changed', false,
      'reason_code', v_reason_code,
      'reason_text', v_reason_text
    )
  );

  return jsonb_build_object(
    'success', true,
    'changed', v_changed > 0,
    'primary_contact_id', v_primary.id,
    'tickets_changed', v_changed,
    'tickets_materialized', v_materialized,
    'owner_user_id_materialized', v_materialized > 0,
    'results', v_results
  );
end;
$$;

create or replace function public.search_admin_ticket_account_owner_contacts(
  p_ticket_id uuid,
  p_term text
) returns table(
  registration_contact_id uuid,
  full_name text,
  masked_email text,
  public_pin text,
  has_valid_auth boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_term text := trim(coalesce(p_term, ''));
  v_digits text;
  v_pin text;
begin
  if v_actor is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'Sem permissao.';
    end if;
  elsif not (
    public.current_user_has_permission('participants.edit_basic')
    or public.current_user_has_permission('tickets.transfer_ownership')
  ) then
    raise exception 'Sem permissao para buscar Pessoas.';
  end if;
  if length(v_term) < 3 then
    raise exception 'Informe ao menos 3 caracteres para buscar.';
  end if;
  select * into v_ticket from public.tickets where id = p_ticket_id;
  if not found then raise exception 'Ingresso invalido.'; end if;
  if v_actor is not null and not public.user_can_access_organization(v_actor, v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso.';
  end if;
  v_digits := regexp_replace(v_term, '\D', '', 'g');
  v_pin := upper(regexp_replace(v_term, '[^A-Za-z0-9]', '', 'g'));
  return query
    select
      rc.id,
      rc.full_name,
      case when position('@' in coalesce(rc.email, '')) > 1
        then left(rc.email, 2) || '***@' || split_part(rc.email, '@', 2)
      end,
      rc.public_pin,
      exists(select 1 from auth.users au where au.id = rc.user_id)
    from public.registration_contacts rc
    where rc.organization_id = v_ticket.organization_id
      and (
        rc.full_name ilike '%' || v_term || '%'
        or rc.email ilike '%' || v_term || '%'
        or (length(v_digits) >= 3 and regexp_replace(coalesce(rc.cpf, ''), '\D', '', 'g') like '%' || v_digits || '%')
        or (v_pin <> '' and upper(coalesce(rc.public_pin, '')) = v_pin)
      )
    order by rc.full_name, rc.id
    limit 20;
end;
$$;

revoke all on function public.apply_ticket_account_owner(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_assign_ticket_account_owner(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.assign_shared_email_account_owner_org(uuid, text, text) from public, anon, authenticated;
revoke all on function public.search_admin_ticket_account_owner_contacts(uuid, text) from public, anon, authenticated;

grant execute on function public.apply_ticket_account_owner(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.admin_assign_ticket_account_owner(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function public.assign_shared_email_account_owner_org(uuid, text, text) to authenticated, service_role;
grant execute on function public.search_admin_ticket_account_owner_contacts(uuid, text) to authenticated, service_role;

commit;
