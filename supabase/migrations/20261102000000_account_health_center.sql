-- Central de Saude de Contas.
-- Classificacao derivada do estado atual. Sem cache. Sem limpeza. Sem merge.
-- Escopo: uma Auth so entra na visao da org quando ha ancora desta org
-- (Cadastro, participacao, pedido, ingresso, convite) ou, para owner da
-- plataforma, orfa estrita global. E-mail classifica; nunca transfere ingresso.

begin;

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values (
  'accounts.health.view',
  'Ver Saude de contas',
  'Visualiza o diagnostico de identidade Cadastro x Conta da organizacao, sem enumerar Auth global',
  'accounts',
  40,
  true
)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  module = excluded.module,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

-- 20260879000000 atualiza administrator mas nao o cria. Fixtures locais
-- frequentemente so materializam owner/operational. Sem este upsert o grant
-- abaixo casa 0 linhas e Administrator nunca recebe a Central.
insert into public.admin_roles (code, name, description, is_system, is_active)
values (
  'administrator',
  'Administrador',
  'Administracao ampla da organizacao e dos eventos.',
  true,
  true
)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  is_system = true,
  is_active = true;

insert into public.admin_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.admin_roles role
join public.admin_permissions permission on permission.code = 'accounts.health.view'
where role.code = 'administrator'
on conflict (role_id, permission_id) do nothing;

insert into public.admin_role_permissions_system_default (role_id, permission_id)
select arp.role_id, arp.permission_id
from public.admin_role_permissions arp
join public.admin_roles r on r.id = arp.role_id
join public.admin_permissions p on p.id = arp.permission_id
where p.code = 'accounts.health.view' and r.code = 'administrator'
on conflict do nothing;

create index if not exists idx_orders_org_user_id
  on public.orders (organization_id, user_id)
  where user_id is not null;

create index if not exists idx_participants_org_user_id
  on public.participants (organization_id, user_id)
  where user_id is not null;

create index if not exists idx_participant_account_invites_org_auth
  on public.participant_account_invites (organization_id, auth_user_id)
  where auth_user_id is not null;

create or replace function public.account_health_can_view()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.current_user_has_permission('accounts.health.view');
$$;

revoke all on function public.account_health_can_view() from public, anon;
grant execute on function public.account_health_can_view() to authenticated, service_role;

create or replace function public.account_health_diagnosis(p_state text, p_reason_code text)
returns text
language sql
immutable
as $$
  select case
    when p_state = 'healthy' then 'Cadastro, conta confirmada e vinculo coerentes.'
    when p_state = 'pending_confirmation' then 'Existe uma conta pendente de confirmacao para o e-mail deste Cadastro.'
    when p_state = 'no_account' and p_reason_code = 'missing_email' then 'Este Cadastro ainda nao possui conta vinculada e nao tem e-mail para convite.'
    when p_state = 'no_account' then 'Este Cadastro ainda nao possui conta vinculada.'
    when p_state = 'confirmed_unlinked' then 'Ja existe uma conta confirmada com este e-mail. O Cadastro ainda nao esta vinculado a ela.'
    when p_state = 'email_divergent' and p_reason_code = 'participant_email_mismatch' then 'O Cadastro esta vinculado a uma conta, mas o e-mail da participacao e diferente.'
    when p_state = 'email_divergent' then 'O Cadastro esta vinculado a uma conta cujo e-mail e diferente.'
    when p_state = 'auth_without_contact' then 'Ha uma conta com vinculo operacional nesta organizacao, mas sem Cadastro vinculado.'
    when p_state = 'possible_orphan' then 'Possivel conta sem vinculo operacional.'
    when p_reason_code = 'occupying_email_auth' then 'O e-mail deste Cadastro esta ocupado por outra conta. Este caso requer analise administrativa.'
    when p_reason_code = 'shared_email' then 'E-mail compartilhado entre Cadastros. Este caso requer analise administrativa.'
    else 'Este caso requer analise administrativa.'
  end;
$$;

create or replace function public.account_health_actions(p_state text, p_reason_code text, p_contact_id uuid)
returns text[]
language sql
immutable
as $$
  select case
    when p_state = 'pending_confirmation' then
      case when p_contact_id is null then array['resend_confirmation'] else array['resend_confirmation', 'open_contact'] end
    when p_state = 'no_account' and p_reason_code in ('missing_email', 'invalid_email') then
      case when p_contact_id is null then array[]::text[] else array['open_contact'] end
    when p_state = 'no_account' then
      array['send_invite', 'open_contact']
    when p_state = 'confirmed_unlinked' then
      array['send_access', 'open_contact']
    when p_contact_id is not null then
      array['open_contact']
    else
      array[]::text[]
  end;
$$;

create or replace function public.list_account_health_cases(
  p_organization_id uuid,
  p_state text default 'all',
  p_search text default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_case_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_case_id text := nullif(btrim(coalesce(p_case_id, '')), '');
  v_filter text := coalesce(nullif(btrim(p_state), ''), 'all');
  v_include_orphans boolean := false;
  v_result jsonb;
begin
  if v_actor is null or not public.current_user_has_permission('accounts.health.view') then
    raise exception 'Sem permissao.';
  end if;

  select o.id into v_org
  from public.organizations o
  where public.user_can_access_organization(v_actor, o.id)
    and (p_organization_id is null or o.id = p_organization_id)
  order by o.created_at
  limit 1;
  if v_org is null then
    return jsonb_build_object(
      'counts', jsonb_build_object(
        'total', 0, 'healthy', 0, 'pending_confirmation', 0, 'no_account', 0,
        'confirmed_unlinked', 0, 'email_divergent', 0, 'attention', 0,
        'auth_without_contact', 0, 'auth_without_contact_confirmed', 0,
        'possible_orphan', 0, 'possible_orphan_confirmed', 0, 'possible_orphan_unconfirmed', 0
      ),
      'rows', '[]'::jsonb,
      'page', 1,
      'page_size', v_limit,
      'row_count', 0,
      'can_view_orphans', false
    );
  end if;

  v_include_orphans := public.is_active_owner(v_actor);

  with org_contacts as (
    select
      c.id,
      c.organization_id,
      c.user_id,
      c.full_name,
      c.email,
      c.cpf,
      c.updated_at,
      lower(trim(coalesce(c.email, ''))) as email_norm,
      regexp_replace(coalesce(c.cpf, ''), '\D', '', 'g') as cpf_digits
    from public.registration_contacts c
    where c.organization_id = v_org
  ),
  email_auth as (
    select
      c.id as contact_id,
      u.id as auth_id,
      u.email as auth_email,
      u.email_confirmed_at,
      u.last_sign_in_at,
      (
        select count(*)::int
        from auth.users au
        where c.email_norm <> ''
          and lower(trim(coalesce(au.email, ''))) = c.email_norm
      ) as auth_count,
      exists (
        select 1 from public.registration_contacts other
        where other.user_id = u.id and other.id is distinct from c.id
      ) as linked_other,
      exists (
        select 1 from public.tickets t
        where t.owner_user_id = u.id
          and t.status not in ('cancelled', 'canceled', 'void', 'voided')
      ) as owns_ticket
    from org_contacts c
    left join lateral (
      select au.id, au.email, au.email_confirmed_at, au.last_sign_in_at
      from auth.users au
      where c.email_norm <> ''
        and lower(trim(coalesce(au.email, ''))) = c.email_norm
      order by au.created_at
      limit 1
    ) u on true
  ),
  linked_auth as (
    select
      c.id as contact_id,
      u.id as auth_id,
      u.email as auth_email,
      u.email_confirmed_at,
      u.last_sign_in_at
    from org_contacts c
    left join auth.users u on u.id = c.user_id
  ),
  contact_flags as (
    select
      c.id as contact_id,
      exists (
        select 1 from public.participants p
        where p.registration_contact_id = c.id
          and p.organization_id = c.organization_id
      ) as has_participant,
      exists (
        select 1 from public.orders o
        where o.organization_id = c.organization_id
          and o.user_id is not null
          and o.user_id = c.user_id
      ) as has_orders,
      exists (
        select 1 from public.tickets t
        where t.organization_id = c.organization_id
          and t.status not in ('cancelled', 'canceled', 'void', 'voided')
          and (
            t.intended_owner_contact_id = c.id
            or t.owner_user_id = c.user_id
            or t.participant_id in (
              select p.id from public.participants p
              where p.registration_contact_id = c.id and p.organization_id = c.organization_id
            )
          )
      ) as has_tickets,
      exists (
        select 1 from public.tickets t
        where t.organization_id = c.organization_id
          and t.owner_user_id = c.user_id
          and t.status not in ('cancelled', 'canceled', 'void', 'voided')
      ) as is_owner,
      exists (
        select 1 from public.participants p
        where p.registration_contact_id = c.id
          and p.organization_id = c.organization_id
          and nullif(trim(coalesce(p.email, '')), '') is not null
          and lower(trim(p.email)) is distinct from c.email_norm
      ) as participant_email_divergent,
      exists (
        select 1 from public.registration_contacts other
        where other.organization_id = c.organization_id
          and other.id <> c.id
          and c.email_norm <> ''
          and lower(trim(coalesce(other.email, ''))) = c.email_norm
      ) as shared_email,
      (
        select p.id from public.participants p
        where p.registration_contact_id = c.id and p.organization_id = c.organization_id
        order by p.created_at desc
        limit 1
      ) as participant_id,
      greatest(
        c.updated_at,
        la.last_sign_in_at,
        (
          select max(t.issued_at) from public.tickets t
          where t.organization_id = c.organization_id
            and (
              t.intended_owner_contact_id = c.id
              or t.owner_user_id = c.user_id
            )
        )
      ) as last_activity_at
    from org_contacts c
    left join linked_auth la on la.contact_id = c.id
  ),
  classified_contacts as (
    select
      c.id::text as case_id,
      c.organization_id,
      c.id as registration_contact_id,
      cf.participant_id,
      case
        when c.user_id is not null and la.auth_id is null then 'attention'
        when c.user_id is not null and ea.auth_id is not null and ea.auth_id is distinct from c.user_id then 'attention'
        when c.user_id is not null and la.email_confirmed_at is null then 'attention'
        when c.user_id is not null
          and c.email_norm <> ''
          and lower(trim(coalesce(la.auth_email, ''))) is distinct from c.email_norm then 'email_divergent'
        when c.user_id is not null then 'healthy'
        when cf.shared_email then 'attention'
        when coalesce(ea.auth_count, 0) > 1 then 'attention'
        when ea.auth_id is not null and ea.email_confirmed_at is null and (ea.linked_other or ea.owns_ticket) then 'attention'
        when ea.auth_id is not null and ea.email_confirmed_at is null then 'pending_confirmation'
        when ea.auth_id is not null and ea.linked_other then 'attention'
        when ea.auth_id is not null then 'confirmed_unlinked'
        else 'no_account'
      end as state,
      case
        when c.user_id is not null and la.auth_id is null then 'dangling_user'
        when c.user_id is not null and ea.auth_id is not null and ea.auth_id is distinct from c.user_id then 'occupying_email_auth'
        when c.user_id is not null and la.email_confirmed_at is null then 'linked_unconfirmed'
        when c.user_id is not null
          and c.email_norm <> ''
          and lower(trim(coalesce(la.auth_email, ''))) is distinct from c.email_norm then 'email_mismatch'
        when c.user_id is not null then 'already_linked'
        when c.email_norm = '' then 'missing_email'
        when cf.shared_email then 'shared_email'
        when coalesce(ea.auth_count, 0) > 1 then 'account_attention'
        when ea.auth_id is not null and ea.email_confirmed_at is null and (ea.linked_other or ea.owns_ticket) then 'account_attention'
        when ea.auth_id is not null and ea.email_confirmed_at is null then 'pending_email_confirmation'
        when ea.auth_id is not null and ea.linked_other then 'account_attention'
        when ea.auth_id is not null then 'invite_existing_confirmed_account'
        else 'eligible'
      end as reason_code,
      c.full_name as display_name,
      nullif(c.email_norm, '') as display_email,
      case
        when c.user_id is not null then (la.email_confirmed_at is not null)
        when ea.auth_id is not null then (ea.email_confirmed_at is not null)
        else null
      end as auth_confirmed,
      true as has_registration,
      cf.has_participant,
      cf.has_orders,
      cf.has_tickets,
      cf.is_owner,
      cf.last_activity_at,
      cf.participant_email_divergent,
      cf.shared_email,
      c.cpf_digits,
      c.full_name
    from org_contacts c
    left join email_auth ea on ea.contact_id = c.id
    left join linked_auth la on la.contact_id = c.id
    left join contact_flags cf on cf.contact_id = c.id
  ),
  org_auth as (
    select distinct x.user_id
    from (
      select owner_user_id as user_id from public.tickets
        where organization_id = v_org and owner_user_id is not null
      union
      select user_id from public.orders
        where organization_id = v_org and user_id is not null
      union
      select user_id from public.participants
        where organization_id = v_org and user_id is not null
      union
      select auth_user_id from public.participant_account_invites
        where organization_id = v_org and auth_user_id is not null
    ) x
  ),
  auth_without_contact as (
    select
      ('auth-' || u.id::text) as case_id,
      v_org as organization_id,
      null::uuid as registration_contact_id,
      (
        select p.id from public.participants p
        where p.organization_id = v_org and p.user_id = u.id
        order by p.created_at desc
        limit 1
      ) as participant_id,
      'auth_without_contact'::text as state,
      case when u.email_confirmed_at is not null then 'confirmed_without_contact' else 'unconfirmed_without_contact' end as reason_code,
      coalesce(
        (
          select p.full_name from public.participants p
          where p.organization_id = v_org and p.user_id = u.id
          order by p.created_at desc
          limit 1
        ),
        'Conta sem cadastro'
      ) as display_name,
      lower(trim(coalesce(u.email, ''))) as display_email,
      (u.email_confirmed_at is not null) as auth_confirmed,
      false as has_registration,
      exists (select 1 from public.participants p where p.organization_id = v_org and p.user_id = u.id) as has_participant,
      exists (select 1 from public.orders o where o.organization_id = v_org and o.user_id = u.id) as has_orders,
      exists (
        select 1 from public.tickets t
        where t.organization_id = v_org
          and t.owner_user_id = u.id
          and t.status not in ('cancelled', 'canceled', 'void', 'voided')
      ) as has_tickets,
      exists (
        select 1 from public.tickets t
        where t.organization_id = v_org
          and t.owner_user_id = u.id
          and t.status not in ('cancelled', 'canceled', 'void', 'voided')
      ) as is_owner,
      greatest(u.last_sign_in_at, u.created_at) as last_activity_at,
      false as participant_email_divergent,
      false as shared_email,
      ''::text as cpf_digits,
      coalesce(
        (
          select p.full_name from public.participants p
          where p.organization_id = v_org and p.user_id = u.id
          order by p.created_at desc
          limit 1
        ),
        'Conta sem cadastro'
      ) as full_name
    from org_auth oa
    join auth.users u on u.id = oa.user_id
    where not exists (
      select 1 from public.registration_contacts c
      where c.organization_id = v_org and c.user_id = u.id
    )
    and not exists (
      select 1 from public.registration_contacts c
      where c.organization_id = v_org
        and nullif(trim(coalesce(c.email, '')), '') is not null
        and lower(trim(c.email)) = lower(trim(coalesce(u.email, '')))
    )
  ),
  global_links as (
    select user_id as id from public.registration_contacts where user_id is not null
    union select user_id from public.participants where user_id is not null
    union select owner_user_id from public.tickets where owner_user_id is not null
    union select user_id from public.orders where user_id is not null
    union select auth_user_id from public.participant_account_invites where auth_user_id is not null
    union select claimed_user_id from public.participant_account_invites where claimed_user_id is not null
    union select user_id from public.organization_members where user_id is not null
    union select user_id from public.admin_users where user_id is not null
    union select user_id from public.store_orders where user_id is not null
    union select previous_owner_user_id from public.ticket_owner_history where previous_owner_user_id is not null
    union select new_owner_user_id from public.ticket_owner_history where new_owner_user_id is not null
    union select created_by from public.account_invite_jobs where created_by is not null
    union select user_id from public.user_feedback where user_id is not null
  ),
  possible_orphans as (
    select
      ('orphan-' || u.id::text) as case_id,
      v_org as organization_id,
      null::uuid as registration_contact_id,
      null::uuid as participant_id,
      'possible_orphan'::text as state,
      case when u.email_confirmed_at is not null then 'orphan_confirmed' else 'orphan_unconfirmed' end as reason_code,
      'Conta sem vinculo operacional' as display_name,
      lower(trim(coalesce(u.email, ''))) as display_email,
      (u.email_confirmed_at is not null) as auth_confirmed,
      false as has_registration,
      false as has_participant,
      false as has_orders,
      false as has_tickets,
      false as is_owner,
      greatest(u.last_sign_in_at, u.created_at) as last_activity_at,
      false as participant_email_divergent,
      false as shared_email,
      ''::text as cpf_digits,
      'Conta sem vinculo operacional'::text as full_name
    from auth.users u
    where v_include_orphans
      and not exists (select 1 from global_links g where g.id = u.id)
  ),
  all_cases as (
    select * from classified_contacts
    union all
    select * from auth_without_contact
    union all
    select * from possible_orphans
  ),
  decorated as (
    select
      a.*,
      public.account_health_diagnosis(a.state, a.reason_code) as reason_message,
      public.account_health_actions(a.state, a.reason_code, a.registration_contact_id) as available_actions
    from all_cases a
  ),
  filtered as (
    select d.*
    from decorated d
    where (
      v_filter = 'all'
      or (v_filter = 'healthy' and d.state = 'healthy')
      or (v_filter = 'pending_confirmation' and d.state = 'pending_confirmation')
      or (v_filter = 'no_account' and d.state in ('no_account', 'confirmed_unlinked'))
      or (v_filter = 'attention' and d.state = 'attention')
      or (v_filter = 'auth_without_contact' and d.state = 'auth_without_contact')
      or (v_filter = 'email_divergent' and (d.state = 'email_divergent' or d.participant_email_divergent))
      or (v_filter = 'possible_orphan' and d.state = 'possible_orphan')
    )
    and (v_case_id is null or d.case_id = v_case_id)
    and (
      v_search is null
      or d.full_name ilike '%' || v_search || '%'
      or coalesce(d.display_email, '') ilike '%' || v_search || '%'
      or (d.cpf_digits <> '' and d.cpf_digits like '%' || regexp_replace(v_search, '\D', '', 'g') || '%'
          and regexp_replace(v_search, '\D', '', 'g') <> '')
    )
  ),
  counted as (
    select
      count(*)::int as total,
      count(*) filter (where state = 'healthy')::int as healthy,
      count(*) filter (where state = 'pending_confirmation')::int as pending_confirmation,
      count(*) filter (where state = 'no_account')::int as no_account,
      count(*) filter (where state = 'confirmed_unlinked')::int as confirmed_unlinked,
      count(*) filter (where state = 'email_divergent' or participant_email_divergent)::int as email_divergent,
      count(*) filter (where state = 'attention')::int as attention,
      count(*) filter (where state = 'auth_without_contact')::int as auth_without_contact,
      count(*) filter (where state = 'auth_without_contact' and auth_confirmed)::int as auth_without_contact_confirmed,
      count(*) filter (where state = 'possible_orphan')::int as possible_orphan,
      count(*) filter (where state = 'possible_orphan' and auth_confirmed)::int as possible_orphan_confirmed,
      count(*) filter (where state = 'possible_orphan' and not auth_confirmed)::int as possible_orphan_unconfirmed
    from decorated
  ),
  ranked as (
    select
      f.*,
      case f.state
        when 'attention' then 0
        when 'pending_confirmation' then 1
        when 'email_divergent' then 2
        when 'confirmed_unlinked' then 3
        when 'auth_without_contact' then 4
        when 'no_account' then 5
        when 'possible_orphan' then 6
        else 7
      end as state_rank
    from filtered f
  )
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'total', c.total,
      'healthy', c.healthy,
      'pending_confirmation', c.pending_confirmation,
      'no_account', c.no_account,
      'confirmed_unlinked', c.confirmed_unlinked,
      'email_divergent', c.email_divergent,
      'attention', c.attention,
      'auth_without_contact', c.auth_without_contact,
      'auth_without_contact_confirmed', c.auth_without_contact_confirmed,
      'possible_orphan', c.possible_orphan,
      'possible_orphan_confirmed', c.possible_orphan_confirmed,
      'possible_orphan_unconfirmed', c.possible_orphan_unconfirmed
    ),
    'rows', coalesce((
      select jsonb_agg(row_json order by state_rank, last_activity_at desc nulls last, display_name)
      from (
        select
          r.state_rank,
          r.last_activity_at,
          r.display_name,
          jsonb_build_object(
            'case_id', r.case_id,
            'organization_id', r.organization_id,
            'registration_contact_id', r.registration_contact_id,
            'participant_id', r.participant_id,
            'state', r.state,
            'reason_code', r.reason_code,
            'reason_message', r.reason_message,
            'display_name', r.display_name,
            'display_email', r.display_email,
            'auth_confirmed', r.auth_confirmed,
            'has_registration', r.has_registration,
            'has_participant', r.has_participant,
            'has_orders', r.has_orders,
            'has_tickets', r.has_tickets,
            'is_owner', r.is_owner,
            'last_activity_at', r.last_activity_at,
            'available_actions', to_jsonb(r.available_actions),
            'participant_email_divergent', r.participant_email_divergent,
            'shared_email', r.shared_email
          ) as row_json
        from ranked r
        order by r.state_rank, r.last_activity_at desc nulls last, r.display_name
        offset v_offset
        limit v_limit
      ) page_rows
    ), '[]'::jsonb),
    'page', (v_offset / v_limit) + 1,
    'page_size', v_limit,
    'row_count', (select count(*)::int from filtered),
    'can_view_orphans', v_include_orphans
  )
  into v_result
  from counted c;

  return v_result;
end;
$$;

create or replace function public.get_account_health_case(
  p_case_id text,
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_list jsonb;
  v_row jsonb;
  v_contact_id uuid;
  v_auth_id uuid;
  v_identity jsonb := 'null'::jsonb;
  v_account jsonb := 'null'::jsonb;
  v_participation jsonb := '[]'::jsonb;
  v_tickets jsonb := '[]'::jsonb;
  v_case_id text := btrim(coalesce(p_case_id, ''));
begin
  if v_actor is null or not public.current_user_has_permission('accounts.health.view') then
    raise exception 'Sem permissao.';
  end if;
  if v_case_id = '' then
    return jsonb_build_object('found', false);
  end if;

  select o.id into v_org
  from public.organizations o
  where public.user_can_access_organization(v_actor, o.id)
    and (p_organization_id is null or o.id = p_organization_id)
  order by o.created_at
  limit 1;
  if v_org is null then
    return jsonb_build_object('found', false);
  end if;

  -- Busca pontual no universo ja autorizado, sem enumerar Auth fora da org.
  if v_case_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_contact_id := v_case_id::uuid;
    select c.id into v_contact_id
    from public.registration_contacts c
    where c.id = v_contact_id
      and c.organization_id = v_org;
    if v_contact_id is null then
      return jsonb_build_object('found', false);
    end if;
  elsif v_case_id like 'auth-%' then
    begin
      v_auth_id := substr(v_case_id, 6)::uuid;
    exception when others then
      return jsonb_build_object('found', false);
    end;
  elsif v_case_id like 'orphan-%' then
    if not public.is_active_owner(v_actor) then
      return jsonb_build_object('found', false);
    end if;
    begin
      v_auth_id := substr(v_case_id, 8)::uuid;
    exception when others then
      return jsonb_build_object('found', false);
    end;
  else
    return jsonb_build_object('found', false);
  end if;

  v_list := public.list_account_health_cases(v_org, 'all', null, 1, 0, v_case_id);
  select item into v_row
  from jsonb_array_elements(coalesce(v_list->'rows', '[]'::jsonb)) item
  where item->>'case_id' = v_case_id
  limit 1;

  if v_row is null then
    return jsonb_build_object('found', false);
  end if;

  v_contact_id := nullif(v_row->>'registration_contact_id', '')::uuid;

  if v_contact_id is not null then
    select jsonb_build_object(
      'full_name', c.full_name,
      'cpf', c.cpf,
      'email', c.email
    )
    into v_identity
    from public.registration_contacts c
    where c.id = v_contact_id and c.organization_id = v_org;

    select jsonb_build_object(
      'confirmed', u.email_confirmed_at is not null,
      'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at
    )
    into v_account
    from public.registration_contacts c
    left join auth.users u on u.id = c.user_id
    where c.id = v_contact_id;

    if v_account is null or v_account->>'created_at' is null then
      select jsonb_build_object(
        'confirmed', u.email_confirmed_at is not null,
        'created_at', u.created_at,
        'last_sign_in_at', u.last_sign_in_at
      )
      into v_account
      from public.registration_contacts c
      join auth.users u on lower(trim(coalesce(u.email, ''))) = lower(trim(coalesce(c.email, '')))
      where c.id = v_contact_id
      order by u.created_at
      limit 1;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'participant_id', p.id,
      'event_name', e.name,
      'email', p.email
    ) order by e.starts_at desc nulls last), '[]'::jsonb)
    into v_participation
    from public.participants p
    left join public.events e on e.id = p.event_id
    where p.registration_contact_id = v_contact_id
      and p.organization_id = v_org;

    select coalesce(jsonb_agg(jsonb_build_object(
      'ticket_id', t.id,
      'display_number', coalesce(o.display_number::text, o.order_number, t.id::text),
      'status', t.status,
      'is_owner', (t.owner_user_id is not null and t.owner_user_id = c.user_id)
    ) order by t.issued_at desc nulls last), '[]'::jsonb)
    into v_tickets
    from public.registration_contacts c
    join public.tickets t on t.organization_id = c.organization_id
      and t.status not in ('cancelled', 'canceled', 'void', 'voided')
      and (
        t.intended_owner_contact_id = c.id
        or t.owner_user_id = c.user_id
        or t.participant_id in (
          select p.id from public.participants p
          where p.registration_contact_id = c.id and p.organization_id = c.organization_id
        )
      )
    left join public.orders o on o.id = t.order_id
    where c.id = v_contact_id;
  elsif v_case_id like 'auth-%' then
    v_auth_id := substr(v_case_id, 6)::uuid;
    select jsonb_build_object(
      'confirmed', u.email_confirmed_at is not null,
      'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at
    )
    into v_account
    from auth.users u
    where u.id = v_auth_id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'participant_id', p.id,
      'event_name', e.name,
      'email', p.email
    ) order by e.starts_at desc nulls last), '[]'::jsonb)
    into v_participation
    from public.participants p
    left join public.events e on e.id = p.event_id
    where p.organization_id = v_org and p.user_id = v_auth_id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'ticket_id', t.id,
      'display_number', coalesce(o.display_number::text, o.order_number, t.id::text),
      'status', t.status,
      'is_owner', true
    ) order by t.issued_at desc nulls last), '[]'::jsonb)
    into v_tickets
    from public.tickets t
    left join public.orders o on o.id = t.order_id
    where t.organization_id = v_org
      and t.owner_user_id = v_auth_id
      and t.status not in ('cancelled', 'canceled', 'void', 'voided');
  elsif v_case_id like 'orphan-%' then
    v_auth_id := substr(v_case_id, 8)::uuid;
    select jsonb_build_object(
      'confirmed', u.email_confirmed_at is not null,
      'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at
    )
    into v_account
    from auth.users u
    where u.id = v_auth_id;
  end if;

  return jsonb_build_object(
    'found', true,
    'case', v_row,
    'identity', v_identity,
    'account', v_account,
    'participation', coalesce(v_participation, '[]'::jsonb),
    'tickets', coalesce(v_tickets, '[]'::jsonb),
    'diagnosis', coalesce(v_row->>'reason_message', 'Este caso requer analise administrativa.')
  );
end;
$$;

comment on function public.list_account_health_cases(uuid, text, text, integer, integer, text) is
  'Lista casos de saude de conta no universo autorizado da organizacao. Nao enumera auth.users global.';

comment on function public.get_account_health_case(text, uuid) is
  'Detalhe de um caso de saude de conta. Nao devolve confirmation_token nem dados de outra organizacao.';

revoke all on function public.list_account_health_cases(uuid, text, text, integer, integer, text)
  from public, anon;
grant execute on function public.list_account_health_cases(uuid, text, text, integer, integer, text)
  to authenticated, service_role;

revoke all on function public.get_account_health_case(text, uuid)
  from public, anon;
grant execute on function public.get_account_health_case(text, uuid)
  to authenticated, service_role;

revoke all on function public.account_health_diagnosis(text, text) from public, anon;
grant execute on function public.account_health_diagnosis(text, text) to authenticated, service_role;

revoke all on function public.account_health_actions(text, text, uuid) from public, anon;
grant execute on function public.account_health_actions(text, text, uuid) to authenticated, service_role;

commit;
