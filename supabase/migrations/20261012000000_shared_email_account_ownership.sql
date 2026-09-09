-- Gate #7: e-mail compartilhado escolhe UMA conta/login sem mergear Pessoas.
-- intended_owner_contact_id registra a intencao; owner_user_id so materializa no claim.

begin;

create or replace function public.inspect_auth_operational_links(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_exists boolean := false;
  v_links jsonb := '{}'::jsonb;
  v_real integer := 0;
  v_count integer;
begin
  if v_actor is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'Sem permissao.';
    end if;
  elsif not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao.';
  end if;
  if p_user_id is null then
    return jsonb_build_object(
      'user_id', null,
      'classification', 'NO_AUTH',
      'real_link_count', 0,
      'links', '{}'::jsonb
    );
  end if;

  select exists(select 1 from auth.users au where au.id = p_user_id) into v_exists;
  if not v_exists then
    return jsonb_build_object(
      'user_id', p_user_id,
      'classification', 'NO_AUTH',
      'real_link_count', 0,
      'links', '{}'::jsonb
    );
  end if;

  select count(*) into v_count from public.registration_contacts where user_id = p_user_id;
  v_links := v_links || jsonb_build_object('registration_contacts.user_id', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.participants where user_id = p_user_id;
  v_links := v_links || jsonb_build_object('participants.user_id', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.tickets where owner_user_id = p_user_id;
  v_links := v_links || jsonb_build_object('tickets.owner_user_id', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.orders where user_id = p_user_id;
  v_links := v_links || jsonb_build_object('orders.user_id', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.participant_account_invites
    where auth_user_id = p_user_id or claimed_user_id = p_user_id;
  v_links := v_links || jsonb_build_object('participant_account_invites', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.organization_members where user_id = p_user_id;
  v_links := v_links || jsonb_build_object('organization_members.user_id', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.admin_users where user_id = p_user_id;
  v_links := v_links || jsonb_build_object('admin_users.user_id', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.store_orders where user_id = p_user_id;
  v_links := v_links || jsonb_build_object('store_orders.user_id', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.ticket_owner_history
    where previous_owner_user_id = p_user_id
       or new_owner_user_id = p_user_id
       or actor_user_id = p_user_id;
  v_links := v_links || jsonb_build_object('ticket_owner_history', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.account_invite_jobs where created_by = p_user_id;
  v_links := v_links || jsonb_build_object('account_invite_jobs.created_by', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.user_feedback where user_id = p_user_id;
  v_links := v_links || jsonb_build_object('user_feedback.user_id', v_count);
  v_real := v_real + v_count;
  select count(*) into v_count from public.customer_profiles where user_id = p_user_id;
  v_links := v_links || jsonb_build_object('customer_profiles.user_id', v_count);

  return jsonb_build_object(
    'user_id', p_user_id,
    'classification', case when v_real > 0 then 'ACTIVE_REAL_ACCOUNT' else 'ORPHAN_AUTH' end,
    'real_link_count', v_real,
    'links', v_links
  );
end;
$$;

create or replace function public.delete_orphan_auth_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_inspect jsonb;
begin
  if v_actor is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'Somente o owner pode excluir Auth orfao.';
    end if;
  elsif not public.is_active_owner(v_actor) then
    raise exception 'Somente o owner pode excluir Auth orfao.';
  end if;
  v_inspect := public.inspect_auth_operational_links(p_user_id);
  if v_inspect->>'classification' is distinct from 'ORPHAN_AUTH' then
    raise exception 'Auth nao e orfao; exclusao recusada.';
  end if;

  delete from public.customer_profiles where user_id = p_user_id;
  delete from auth.users where id = p_user_id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'orphan_auth_user_deleted',
    'auth.users',
    p_user_id,
    null,
    jsonb_build_object('actor_user_id', v_actor, 'inspect', v_inspect)
  );

  return jsonb_build_object('success', true, 'deleted_user_id', p_user_id, 'inspect', v_inspect);
end;
$$;

create or replace function public.list_event_first_access_blockers(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_groups jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
begin
  if v_actor is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'Sem permissao.';
    end if;
  elsif not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao.';
  end if;
  select e.organization_id into v_org
  from public.events e
  where e.id = p_event_id;
  if v_org is null or (v_actor is not null and not public.user_can_access_organization(v_actor, v_org)) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  with event_contacts as (
    select distinct c.id, c.full_name, c.public_pin, c.email, c.cpf, c.birth_date,
           c.phone, c.city, c.user_id, c.created_at,
           lower(trim(coalesce(c.email, ''))) as email_norm
    from public.registration_contacts c
    join public.participants p on p.registration_contact_id = c.id
    where p.event_id = p_event_id
      and c.organization_id = v_org
      and nullif(lower(trim(coalesce(c.email, ''))), '') is not null
  ), shared_emails as (
    select email_norm
    from event_contacts
    group by email_norm
    having count(*) > 1
  ), ranked as (
    select
      ec.*,
      (
        case when length(trim(coalesce(ec.full_name, ''))) >= 3 then 1 else 0 end
        + case when public.is_valid_cpf(ec.cpf) then 2 else 0 end
        + case when ec.birth_date is not null then 2 else 0 end
        + 1
        + case when length(regexp_replace(coalesce(ec.phone, ''), '\D', '', 'g')) >= 10 then 1 else 0 end
        + case when nullif(trim(coalesce(ec.city, '')), '') is not null then 1 else 0 end
      ) as completeness,
      (
        select min(r.row_number)
        from public.import_batch_rows r
        join public.import_batches b on b.id = r.import_batch_id
        where r.registration_contact_id = ec.id
          and b.event_id = p_event_id
      ) as source_row,
      exists (
        select 1 from auth.users au
        where au.id = ec.user_id
      ) as has_valid_auth
    from event_contacts ec
    join shared_emails se on se.email_norm = ec.email_norm
  ), recommended as (
    select distinct on (email_norm) id, email_norm
    from ranked
    order by email_norm,
      has_valid_auth desc,
      completeness desc,
      coalesce(source_row, 2147483647),
      created_at,
      id
  )
  select coalesce(jsonb_agg(group_row.payload order by group_row.email_masked), '[]'::jsonb)
  into v_groups
  from (
    select
      left(r.email_norm, 2) || '***@' || split_part(r.email_norm, '@', 2) as email_masked,
      jsonb_build_object(
        'email_masked', left(r.email_norm, 2) || '***@' || split_part(r.email_norm, '@', 2),
        'people_count', count(*)::int,
        'recommended_contact_id', (select rec.id from recommended rec where rec.email_norm = r.email_norm),
        'current_primary_contact_id', (
          select t.intended_owner_contact_id
          from public.tickets t
          join public.participants p on p.id = t.participant_id
          join ranked rr on rr.id = p.registration_contact_id
          where t.event_id = p_event_id
            and rr.email_norm = r.email_norm
            and t.status not in ('cancelled', 'canceled', 'void', 'voided')
            and t.intended_owner_contact_id is not null
          group by t.intended_owner_contact_id
          having count(distinct t.intended_owner_contact_id) = 1
             and count(*) = (
               select count(*)
               from public.tickets t2
               join public.participants p2 on p2.id = t2.participant_id
               join ranked rr2 on rr2.id = p2.registration_contact_id
               where t2.event_id = p_event_id
                 and rr2.email_norm = r.email_norm
                 and t2.status not in ('cancelled', 'canceled', 'void', 'voided')
             )
          limit 1
        ),
        'resolved', exists (
          select 1
          from public.tickets t
          join public.participants p on p.id = t.participant_id
          join ranked rr on rr.id = p.registration_contact_id
          where t.event_id = p_event_id
            and rr.email_norm = r.email_norm
            and t.status not in ('cancelled', 'canceled', 'void', 'voided')
          having count(distinct t.intended_owner_contact_id) = 1
             and min(t.intended_owner_contact_id) = (select rec.id from recommended rec where rec.email_norm = r.email_norm)
        ),
        'has_auth', exists (
          select 1 from auth.users au where lower(trim(coalesce(au.email, ''))) = r.email_norm
        ),
        'pending_invites', (
          select count(*)::int
          from public.participant_account_invites pai
          where pai.organization_id = v_org
            and pai.status = 'pending'
            and lower(trim(pai.email)) = r.email_norm
        ),
        'people', jsonb_agg(jsonb_build_object(
          'contact_id', r.id,
          'pin', r.public_pin,
          'full_name', r.full_name,
          'user_id', r.user_id,
          'has_valid_auth', r.has_valid_auth,
          'completeness', r.completeness,
          'source_row', r.source_row,
          'valid_cpf', public.is_valid_cpf(r.cpf),
          'has_dob', r.birth_date is not null
        ) order by r.has_valid_auth desc, r.completeness desc, coalesce(r.source_row, 2147483647), r.created_at, r.id),
        'tickets', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ticket_id', t.id,
            'holder_contact_id', holder.id,
            'holder_pin', holder.public_pin,
            'holder_name', holder.full_name,
            'intended_owner_contact_id', t.intended_owner_contact_id,
            'owner_user_id', t.owner_user_id,
            'order_label', coalesce(o.display_number, o.order_number::text, t.order_id::text)
          ) order by holder.full_name, t.id)
          from public.tickets t
          join public.participants p on p.id = t.participant_id
          join ranked holder on holder.id = p.registration_contact_id
          left join public.orders o on o.id = t.order_id
          where t.event_id = p_event_id
            and holder.email_norm = r.email_norm
            and t.status not in ('cancelled', 'canceled', 'void', 'voided')
        ), '[]'::jsonb)
      ) as payload
    from ranked r
    group by r.email_norm
  ) group_row;

  select coalesce(jsonb_agg(conflict.payload order by conflict.pin), '[]'::jsonb)
  into v_conflicts
  from (
    select
      c.public_pin as pin,
      jsonb_build_object(
        'contact_id', c.id,
        'pin', c.public_pin,
        'full_name', c.full_name,
        'email_masked', left(lower(trim(c.email)), 2) || '***@' || split_part(lower(trim(c.email)), '@', 2),
        'auth_user_id', au.id,
        'classification', public.inspect_auth_operational_links(au.id)->>'classification',
        'inspect', public.inspect_auth_operational_links(au.id)
      ) as payload
    from public.registration_contacts c
    join public.participants p on p.registration_contact_id = c.id and p.event_id = p_event_id
    join auth.users au on lower(trim(coalesce(au.email, ''))) = lower(trim(coalesce(c.email, '')))
    where c.organization_id = v_org
      and c.user_id is null
  ) conflict;

  return jsonb_build_object('groups', coalesce(v_groups, '[]'::jsonb), 'auth_conflicts', coalesce(v_conflicts, '[]'::jsonb));
end;
$$;

create or replace function public.assign_shared_email_account_owner(
  p_event_id uuid,
  p_primary_contact_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_primary public.registration_contacts%rowtype;
  v_email text;
  v_previous jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if v_actor is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'Sem permissao para definir a conta principal.';
    end if;
  elsif not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para definir a conta principal.';
  end if;
  select e.organization_id into v_org from public.events e where e.id = p_event_id;
  if v_org is null or (v_actor is not null and not public.user_can_access_organization(v_actor, v_org)) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;
  select * into v_primary
  from public.registration_contacts
  where id = p_primary_contact_id and organization_id = v_org;
  if not found then raise exception 'Pessoa principal invalida para esta organizacao.'; end if;
  v_email := lower(trim(coalesce(v_primary.email, '')));
  if v_email = '' then raise exception 'A Pessoa principal precisa de e-mail.'; end if;

  if exists (
    select 1
    from public.tickets t
    join public.participants p on p.id = t.participant_id
    join public.registration_contacts c on c.id = p.registration_contact_id
    where t.event_id = p_event_id
      and c.organization_id = v_org
      and lower(trim(coalesce(c.email, ''))) = v_email
      and t.status not in ('cancelled', 'canceled', 'void', 'voided')
      and t.owner_user_id is not null
      and t.owner_user_id is distinct from v_primary.user_id
  ) then
    raise exception 'Ha ingressos ja materializados em outra conta. Nao e possivel reatribuir a intencao.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'ticket_id', t.id,
    'previous_intended_owner_contact_id', t.intended_owner_contact_id,
    'holder_contact_id', p.registration_contact_id
  )), '[]'::jsonb)
  into v_previous
  from public.tickets t
  join public.participants p on p.id = t.participant_id
  join public.registration_contacts c on c.id = p.registration_contact_id
  where t.event_id = p_event_id
    and c.organization_id = v_org
    and lower(trim(coalesce(c.email, ''))) = v_email
    and t.status not in ('cancelled', 'canceled', 'void', 'voided');

  update public.tickets t
  set intended_owner_contact_id = v_primary.id
  from public.participants p
  join public.registration_contacts c on c.id = p.registration_contact_id
  where t.participant_id = p.id
    and t.event_id = p_event_id
    and c.organization_id = v_org
    and lower(trim(coalesce(c.email, ''))) = v_email
    and t.status not in ('cancelled', 'canceled', 'void', 'voided')
    and t.owner_user_id is null;

  get diagnostics v_count = row_count;

  update public.order_items oi
  set intended_owner_contact_id = v_primary.id, updated_at = now()
  from public.tickets t
  join public.participants p on p.id = t.participant_id
  join public.registration_contacts c on c.id = p.registration_contact_id
  where oi.id = t.order_item_id
    and t.event_id = p_event_id
    and c.organization_id = v_org
    and lower(trim(coalesce(c.email, ''))) = v_email
    and t.status not in ('cancelled', 'canceled', 'void', 'voided')
    and t.owner_user_id is null;

  update public.import_batch_rows r
  set intended_owner_contact_id = v_primary.id,
      review_decision = 'assign_owner_contact',
      reviewed_by = v_actor,
      reviewed_at = now(),
      updated_at = now(),
      identity_match_details = coalesce(r.identity_match_details, '{}'::jsonb)
        || jsonb_build_object(
          'account_review_resolved', 'assign_owner_contact',
          'intended_owner_contact_id', v_primary.id
        )
  from public.import_batches b
  where r.import_batch_id = b.id
    and b.event_id = p_event_id
    and b.organization_id = v_org
    and (
      r.registration_contact_id in (
        select c.id from public.registration_contacts c
        where c.organization_id = v_org
          and lower(trim(coalesce(c.email, ''))) = v_email
      )
      or lower(trim(coalesce(r.normalized_data->>'email', ''))) = v_email
    );

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'shared_email_account_owner_assigned',
    'registration_contacts',
    v_primary.id,
    p_event_id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'primary_contact_id', v_primary.id,
      'email_masked', left(v_email, 2) || '***@' || split_part(v_email, '@', 2),
      'tickets_updated', v_count,
      'previous', v_previous,
      'people_merged', false,
      'holders_changed', false
    )
  );

  return jsonb_build_object(
    'success', true,
    'changed', true,
    'primary_contact_id', v_primary.id,
    'tickets_updated', v_count,
    'owner_user_id_materialized', false
  );
end;
$$;

create or replace function public.check_participant_account_invite_eligibility(p_participant_id uuid)
returns table(eligible boolean, reason_code text, reason_message text, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_p public.participants%rowtype;
  v_email text;
  v_same_email integer;
  v_auth_count integer;
  v_auth_user auth.users%rowtype;
  v_inv public.participant_account_invites%rowtype;
  v_conflicting_participants integer;
  v_profile_cpf text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao.';
  end if;
  select p.* into v_p from public.participants p where p.id = p_participant_id;
  if not found or not public.user_can_access_organization(v_actor, v_p.organization_id) then
    return query select false, 'inaccessible', 'Cadastro invalido ou sem acesso.', null::text;
    return;
  end if;
  if v_p.registration_contact_id is not null then
    return query
      select e.eligible, e.reason_code, e.reason_message, e.email
      from public.check_registration_contact_account_invite_eligibility(v_p.registration_contact_id) e;
    return;
  end if;
  if v_p.user_id is not null then
    return query select false, 'already_linked', 'Cadastro ja vinculado a uma conta.', null::text;
    return;
  end if;
  if nullif(trim(coalesce(v_p.email, '')), '') is null then
    return query select false, 'missing_email', 'E-mail ausente.', null::text;
    return;
  end if;
  v_email := lower(trim(v_p.email));
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return query select false, 'invalid_email', 'E-mail invalido.', v_email;
    return;
  end if;
  if not public.is_valid_cpf(v_p.cpf) then
    return query select false, 'invalid_cpf', 'CPF invalido.', v_email;
    return;
  end if;
  select count(*) into v_same_email
  from public.participants p
  where p.organization_id = v_p.organization_id
    and p.user_id is null
    and lower(trim(coalesce(p.email, ''))) = v_email;
  if v_same_email <> 1 then
    return query select false, 'shared_email', 'E-mail compartilhado por mais de um cadastro.', v_email;
    return;
  end if;

  select count(*) into v_auth_count from auth.users au where lower(trim(coalesce(au.email, ''))) = v_email;
  if v_auth_count = 0 then
    return query select true, 'eligible', 'Cadastro apto para convite.', v_email;
    return;
  end if;
  if v_auth_count <> 1 then
    return query select false, 'account_conflict', 'E-mail pertence a outra conta.', v_email;
    return;
  end if;
  select au.* into strict v_auth_user from auth.users au where lower(trim(coalesce(au.email, ''))) = v_email;

  select pai.* into v_inv
  from public.participant_account_invites pai
  where pai.participant_id = v_p.id
    and lower(trim(pai.email)) = v_email
    and pai.status = 'pending'
    and (
      pai.auth_user_id = v_auth_user.id
      or (pai.auth_user_id is null and v_auth_user.raw_user_meta_data->>'participant_invite_id' = pai.id::text)
    )
  order by pai.created_at desc
  limit 1;
  if not found then
    return query select false, 'account_conflict', 'E-mail pertence a outra conta.', v_email;
    return;
  end if;

  select count(*) into v_conflicting_participants
  from public.participants p
  where p.user_id = v_auth_user.id and p.id <> v_p.id;
  if v_conflicting_participants > 0 then
    return query select false, 'account_conflict', 'E-mail pertence a outra conta.', v_email;
    return;
  end if;

  select regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g') into v_profile_cpf
  from public.customer_profiles cp
  where cp.user_id = v_auth_user.id;
  if nullif(v_profile_cpf, '') is not null
    and v_profile_cpf <> regexp_replace(coalesce(v_p.cpf, ''), '\D', '', 'g') then
    return query select false, 'account_conflict', 'E-mail pertence a outra conta.', v_email;
    return;
  end if;

  return query select true, 'resend_invite_existing_account', 'Convite pendente pode ser reenviado.', v_email;
end;
$$;

create or replace function public.prepare_registration_contact_account_invite(
  p_registration_contact_id uuid
)
returns table(invite_id uuid, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_check record;
  v_id uuid;
begin
  select * into v_check
  from public.check_registration_contact_account_invite_eligibility(p_registration_contact_id);
  if not coalesce(v_check.eligible, false) then
    raise exception '%', coalesce(v_check.reason_message, 'Cadastro nao elegivel.');
  end if;

  select * into v_contact
  from public.registration_contacts
  where id = p_registration_contact_id
  for update;

  if exists (
    select 1
    from public.participant_account_invites pai
    where pai.organization_id = v_contact.organization_id
      and pai.status = 'pending'
      and lower(trim(pai.email)) = v_check.email
      and pai.registration_contact_id is distinct from v_contact.id
  ) then
    raise exception 'Ja existe convite pendente para este e-mail.';
  end if;

  update public.participant_account_invites
  set status = 'revoked', updated_at = now()
  where registration_contact_id = v_contact.id
    and status = 'pending'
    and expires_at <= now();

  insert into public.participant_account_invites(
    organization_id, registration_contact_id, email, invited_by,
    requires_password_setup
  ) values (
    v_contact.organization_id, v_contact.id, v_check.email, v_actor, false
  )
  on conflict(registration_contact_id)
    where status = 'pending' and registration_contact_id is not null
  do update set
    email = excluded.email,
    invited_by = excluded.invited_by,
    expires_at = now() + interval '7 days',
    updated_at = now()
  returning id into v_id;

  return query select v_id, v_check.email::text;
end;
$$;

create unique index if not exists ux_participant_account_invites_pending_org_email
  on public.participant_account_invites (organization_id, (lower(trim(email))))
  where status = 'pending' and nullif(trim(email), '') is not null;

revoke all on function public.inspect_auth_operational_links(uuid) from public, anon, authenticated;
revoke all on function public.delete_orphan_auth_user(uuid) from public, anon, authenticated;
revoke all on function public.list_event_first_access_blockers(uuid) from public, anon, authenticated;
revoke all on function public.assign_shared_email_account_owner(uuid, uuid) from public, anon, authenticated;
revoke all on function public.check_participant_account_invite_eligibility(uuid) from public, anon, authenticated;
revoke all on function public.prepare_registration_contact_account_invite(uuid) from public, anon, authenticated;

grant execute on function public.inspect_auth_operational_links(uuid) to authenticated, service_role;
grant execute on function public.delete_orphan_auth_user(uuid) to authenticated, service_role;
grant execute on function public.list_event_first_access_blockers(uuid) to authenticated, service_role;
grant execute on function public.assign_shared_email_account_owner(uuid, uuid) to authenticated, service_role;
grant execute on function public.check_participant_account_invite_eligibility(uuid) to authenticated, service_role;
grant execute on function public.prepare_registration_contact_account_invite(uuid) to authenticated, service_role;

commit;
