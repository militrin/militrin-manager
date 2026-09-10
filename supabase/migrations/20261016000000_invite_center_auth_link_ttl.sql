-- Central de Convites: validade canônica do link Auth (24h) separada do
-- expires_at interno (7 dias). Não consulta auth.users por linha na listagem.
-- Backfill set-based de auth.users só nesta migration.

begin;

alter table public.participant_account_invites
  add column if not exists auth_email_sent_at timestamptz,
  add column if not exists auth_link_expires_at timestamptz,
  add column if not exists auth_confirmed_at timestamptz;

create index if not exists idx_participant_account_invites_auth_link_expires
  on public.participant_account_invites (organization_id, auth_link_expires_at)
  where status = 'pending' and auth_link_expires_at is not null;

update public.participant_account_invites pai
set auth_email_sent_at = coalesce(
  pai.auth_email_sent_at,
  (
    select max(sent_at)
    from (
      select ji.sent_at
      from public.account_invite_job_items ji
      join public.participants p on p.id = ji.participant_id
      join public.registration_contacts c on c.id = p.registration_contact_id
      where c.organization_id = pai.organization_id
        and lower(trim(c.email)) = lower(trim(pai.email))
        and ji.sent_at is not null
      union all
      select i.sent_at
      from public.account_invite_center_job_items i
      where i.invite_id = pai.id and i.sent_at is not null
    ) sends
  ),
  pai.created_at
)
where pai.auth_email_sent_at is null
  and pai.status in ('pending', 'claimed', 'expired');

update public.participant_account_invites
set auth_link_expires_at = auth_email_sent_at + interval '24 hours'
where auth_email_sent_at is not null
  and (auth_link_expires_at is null or auth_link_expires_at is distinct from auth_email_sent_at + interval '24 hours');

update public.participant_account_invites pai
set auth_confirmed_at = u.email_confirmed_at
from auth.users u
where pai.auth_user_id = u.id
  and u.email_confirmed_at is not null
  and pai.auth_confirmed_at is null;

update public.participant_account_invites
set auth_confirmed_at = claimed_at
where auth_confirmed_at is null and claimed_at is not null;

drop function if exists public.invite_center_ui_status(boolean, text, timestamptz, text, boolean, boolean, timestamptz, boolean, text);

create or replace function public.invite_center_ui_status(
  p_mixed_intended_owners boolean,
  p_invite_status text,
  p_auth_link_expires_at timestamptz,
  p_account_status text,
  p_must_complete_profile boolean,
  p_must_change_password boolean,
  p_activation_completed_at timestamptz,
  p_cadastral_incomplete boolean,
  p_job_status text,
  p_auth_confirmed_at timestamptz default null,
  p_password_setup_completed_at timestamptz default null
) returns text
language sql
immutable
as $$
  select case
    when coalesce(p_mixed_intended_owners, false) then 'admin_action'
    when coalesce(p_must_complete_profile, false) is false
      and coalesce(p_must_change_password, false) is false
      and coalesce(p_cadastral_incomplete, false) is false
      and (
        p_activation_completed_at is not null
        or coalesce(p_account_status, '') = 'active'
        or (p_invite_status = 'claimed' and p_password_setup_completed_at is not null)
      )
      then 'concluido'
    when p_invite_status = 'claimed' or p_auth_confirmed_at is not null then 'cadastro_pendente'
    when p_invite_status = 'pending' and p_auth_link_expires_at is not null and p_auth_link_expires_at <= now() then 'expirado'
    when p_invite_status = 'expired' then 'expirado'
    when p_invite_status = 'pending' then 'pendente'
    when p_job_status = 'failed' then 'falha'
    when p_job_status = 'skipped' then 'pulado'
    else 'nao_enviado'
  end;
$$;

create or replace function public.list_invite_center(
  p_event_id uuid default null,
  p_import_batch_id uuid default null,
  p_status text default 'all',
  p_shared text default 'all',
  p_search text default null,
  p_sort text default 'attention',
  p_limit integer default 25,
  p_offset integer default 0,
  p_organization_id uuid default null,
  p_row_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 500));
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_sent_24h integer := 0;
  v_result jsonb;
begin
  if v_actor is null or not public.current_user_has_permission('invites.view') then
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
        'total', 0, 'concluido', 0, 'pendente', 0, 'expirado', 0, 'falha', 0,
        'cadastro_pendente', 0, 'admin_action', 0, 'nao_enviado', 0, 'pulado', 0, 'shared_groups', 0
      ),
      'completion', jsonb_build_object('done', 0, 'total', 0, 'percent', 0),
      'rows', '[]'::jsonb,
      'page', 1,
      'page_size', v_limit,
      'row_count', 0,
      'scoped_count', 0,
      'sent_last_24h', 0,
      'events', '[]'::jsonb,
      'import_batches', '[]'::jsonb
    );
  end if;

  select
    (select count(*)::int from public.account_invite_job_items i
      join public.account_invite_jobs j on j.id = i.job_id
      where j.organization_id = v_org and i.status = 'sent' and i.sent_at > now() - interval '24 hours')
    + (select count(*)::int from public.account_invite_center_job_items i
      where i.organization_id = v_org and i.status = 'sent' and i.sent_at > now() - interval '24 hours')
  into v_sent_24h;

  with contacts as (
    select
      c.id,
      c.organization_id,
      c.full_name,
      c.email,
      c.public_pin,
      c.user_id,
      c.cpf,
      c.birth_date,
      c.phone,
      lower(trim(c.email)) as email_norm
    from public.registration_contacts c
    where c.organization_id = v_org
      and nullif(trim(c.email), '') is not null
  ),
  groups as (
    select
      email_norm,
      count(*)::int as person_count,
      array_agg(id) as contact_ids
    from contacts
    group by email_norm
  ),
  ticket_facts as (
    select
      g.email_norm,
      count(distinct t.id) filter (
        where lower(coalesce(t.status, '')) not in ('cancelled', 'canceled', 'void', 'voided')
      )::int as active_ticket_count,
      count(distinct t.intended_owner_contact_id) filter (
        where lower(coalesce(t.status, '')) not in ('cancelled', 'canceled', 'void', 'voided')
          and t.intended_owner_contact_id is not null
      )::int as intended_owner_count,
      (array_remove(array_agg(distinct t.event_id) filter (
        where p_event_id is null or t.event_id = p_event_id
      ), null))[1] as event_id,
      (array_remove(array_agg(distinct e.name) filter (
        where p_event_id is null or t.event_id = p_event_id
      ), null))[1] as event_name,
      bool_or(p_event_id is null or t.event_id = p_event_id) as matches_event,
      bool_or(
        t.owner_user_id is not null
        and lower(coalesce(t.status, '')) not in ('cancelled', 'canceled', 'void', 'voided')
      ) as any_owner_materialized
    from groups g
    left join public.tickets t
      on t.organization_id = v_org
      and (
        t.intended_owner_contact_id = any (g.contact_ids)
        or exists (
          select 1 from public.order_items oi
          where oi.id = t.order_item_id and oi.registration_contact_id = any (g.contact_ids)
        )
        or exists (
          select 1 from public.participants p
          where p.id = t.participant_id and p.registration_contact_id = any (g.contact_ids)
        )
      )
    left join public.events e on e.id = t.event_id
    group by g.email_norm
  ),
  batch_facts as (
    select g.email_norm, bool_or(ph.import_batch_id = p_import_batch_id) as matches_batch
    from groups g
    left join public.participants p on p.registration_contact_id = any (g.contact_ids)
    left join public.participation_history ph on ph.participant_id = p.id
    group by g.email_norm
  ),
  invites as (
    select distinct on (lower(trim(pai.email)))
      lower(trim(pai.email)) as email_norm,
      pai.id as invite_id,
      pai.status as invite_status,
      pai.created_at as invite_created_at,
      pai.expires_at,
      pai.claimed_at,
      pai.claimed_user_id,
      pai.auth_user_id,
      pai.registration_contact_id,
      pai.password_setup_completed_at,
      pai.auth_email_sent_at,
      pai.auth_link_expires_at,
      pai.auth_confirmed_at,
      pai.event_id as invite_event_id
    from public.participant_account_invites pai
    where pai.organization_id = v_org
      and nullif(trim(pai.email), '') is not null
    order by lower(trim(pai.email)),
      case pai.status when 'claimed' then 0 when 'pending' then 1 when 'expired' then 2 else 3 end,
      pai.created_at desc
  ),
  jobs as (
    select distinct on (lower(trim(c.email)))
      lower(trim(c.email)) as email_norm,
      ji.status as job_status,
      ji.reason_code,
      ji.error_code,
      ji.attempt_count,
      ji.sent_at,
      ji.finished_at,
      j.import_batch_id,
      j.id as job_id
    from public.account_invite_job_items ji
    join public.participants p on p.id = ji.participant_id
    join public.registration_contacts c on c.id = p.registration_contact_id
    join public.account_invite_jobs j on j.id = ji.job_id
    where c.organization_id = v_org
      and nullif(trim(c.email), '') is not null
    order by lower(trim(c.email)), ji.finished_at desc nulls last, ji.sent_at desc nulls last
  ),
  profiles as (
    select
      cp.user_id,
      cp.account_status,
      cp.must_complete_profile,
      cp.must_change_password,
      cp.activation_completed_at
    from public.customer_profiles cp
  ),
  cadastral as (
    select
      g.email_norm,
      bool_or(
        nullif(regexp_replace(coalesce(c.cpf, ''), '\D', '', 'g'), '') is null
        or c.birth_date is null
        or exists (
          select 1 from public.participants p
          join public.participant_data_issues di on di.participant_id = p.id and di.status = 'open'
          where p.registration_contact_id = c.id
            and di.field_code in ('cpf', 'birth_date', 'phone', 'full_name')
        )
      ) as incomplete
    from groups g
    join contacts c on c.id = any (g.contact_ids)
    group by g.email_norm
  ),
  principals as (
    select
      g.email_norm,
      coalesce(
        (
          select c.id
          from contacts c
          join ticket_facts tf on tf.email_norm = g.email_norm
          where c.id = any (g.contact_ids)
            and tf.intended_owner_count = 1
            and exists (
              select 1 from public.tickets t
              where t.organization_id = v_org
                and t.intended_owner_contact_id = c.id
                and lower(coalesce(t.status, '')) not in ('cancelled', 'canceled', 'void', 'voided')
            )
          limit 1
        ),
        i.registration_contact_id,
        (select c.id from contacts c where c.id = any (g.contact_ids) order by c.full_name, c.id limit 1)
      ) as principal_contact_id
    from groups g
    left join invites i on i.email_norm = g.email_norm
  ),
  accounts as (
    select
      md5(v_org::text || chr(1) || g.email_norm) as row_key,
      g.email_norm,
      g.person_count,
      g.contact_ids,
      pr.principal_contact_id,
      pc.full_name as principal_name,
      pc.public_pin as principal_pin,
      pc.user_id as principal_user_id,
      i.invite_id,
      i.invite_status,
      i.invite_created_at,
      i.expires_at,
      i.claimed_at,
      i.claimed_user_id,
      i.auth_user_id,
      i.password_setup_completed_at,
      i.auth_email_sent_at,
      i.auth_link_expires_at,
      i.auth_confirmed_at,
      jb.job_status,
      jb.reason_code,
      jb.error_code,
      jb.attempt_count,
      jb.sent_at,
      jb.import_batch_id,
      tf.active_ticket_count,
      tf.event_id,
      tf.event_name,
      tf.intended_owner_count,
      tf.any_owner_materialized,
      coalesce(tf.matches_event, true) as matches_event,
      coalesce(bf.matches_batch, p_import_batch_id is null) as matches_batch,
      coalesce(cad.incomplete, false) as cadastral_incomplete,
      pf.account_status,
      coalesce(pf.must_complete_profile, false) as must_complete_profile,
      coalesce(pf.must_change_password, false) as must_change_password,
      pf.activation_completed_at,
      public.invite_center_ui_status(
        coalesce(tf.intended_owner_count, 0) > 1,
        i.invite_status,
        i.auth_link_expires_at,
        pf.account_status,
        coalesce(pf.must_complete_profile, false),
        coalesce(pf.must_change_password, false),
        pf.activation_completed_at,
        coalesce(cad.incomplete, false) and i.invite_status = 'claimed',
        jb.job_status,
        i.auth_confirmed_at,
        i.password_setup_completed_at
      ) as ui_status
    from groups g
    left join principals pr on pr.email_norm = g.email_norm
    left join contacts pc on pc.id = pr.principal_contact_id
    left join invites i on i.email_norm = g.email_norm
    left join jobs jb on jb.email_norm = g.email_norm
    left join ticket_facts tf on tf.email_norm = g.email_norm
    left join batch_facts bf on bf.email_norm = g.email_norm
    left join cadastral cad on cad.email_norm = g.email_norm
    left join profiles pf on pf.user_id = coalesce(i.claimed_user_id, i.auth_user_id, pc.user_id)
  ),
  scoped as (
    select *
    from accounts a
    where (p_row_key is null or a.row_key = p_row_key)
      and (a.invite_id is not null or a.job_status is not null or coalesce(a.active_ticket_count, 0) > 0)
      and (p_event_id is null or a.matches_event)
      and (p_import_batch_id is null or a.matches_batch)
      and (
        coalesce(p_shared, 'all') = 'all'
        or (p_shared = 'yes' and a.person_count > 1)
        or (p_shared = 'no' and a.person_count <= 1)
      )
      and (
        v_search is null
        or a.principal_name ilike '%' || v_search || '%'
        or a.email_norm ilike '%' || v_search || '%'
        or a.principal_pin ilike '%' || v_search || '%'
        or exists (
          select 1
          from public.tickets t
          left join public.orders o on o.id = t.order_id
          where t.organization_id = v_org
            and (
              upper(left(t.token::text, 8)) ilike '%' || upper(replace(v_search, '#', '')) || '%'
              or o.order_number::text ilike '%' || v_search || '%'
              or o.display_number::text ilike '%' || v_search || '%'
            )
            and (
              t.intended_owner_contact_id = any (a.contact_ids)
              or exists (
                select 1 from public.order_items oi
                where oi.id = t.order_item_id and oi.registration_contact_id = any (a.contact_ids)
              )
            )
        )
      )
  ),
  filtered as (
    select *
    from scoped a
    where (
        coalesce(p_status, 'all') in ('all', 'todos')
        or (p_status in ('pendentes', 'pendente') and a.ui_status = 'pendente')
        or (p_status in ('concluidos', 'concluido') and a.ui_status = 'concluido')
        or (p_status in ('expirados', 'expirado') and a.ui_status = 'expirado')
        or (p_status in ('cadastro_pendente', 'cadastro-pendente') and a.ui_status = 'cadastro_pendente')
        or (p_status in ('falha', 'falhas') and a.ui_status = 'falha')
        or (p_status in ('admin_action', 'acao_admin') and a.ui_status = 'admin_action')
        or (p_status in ('nao_enviado', 'nao-enviados') and a.ui_status = 'nao_enviado')
        or (p_status in ('pulado', 'pulados') and a.ui_status = 'pulado')
        or (p_status in ('reenvio', 'resendable') and a.ui_status in ('expirado', 'falha'))
      )
  ),
  counted as (
    select
      count(*)::int as row_count,
      count(*) filter (where ui_status = 'concluido')::int as concluido,
      count(*) filter (where ui_status = 'pendente')::int as pendente,
      count(*) filter (where ui_status = 'expirado')::int as expirado,
      count(*) filter (where ui_status = 'falha')::int as falha,
      count(*) filter (where ui_status = 'cadastro_pendente')::int as cadastro_pendente,
      count(*) filter (where ui_status = 'admin_action')::int as admin_action,
      count(*) filter (where ui_status = 'nao_enviado')::int as nao_enviado,
      count(*) filter (where ui_status = 'pulado')::int as pulado,
      count(*) filter (where person_count > 1)::int as shared_groups
    from scoped
  ),
  sorted as (
    select *
    from filtered
    order by
      case coalesce(p_sort, 'attention')
        when 'recent' then extract(epoch from coalesce(sent_at, invite_created_at, claimed_at))
        when 'oldest' then extract(epoch from coalesce(invite_created_at, sent_at))
        when 'expiring' then extract(epoch from auth_link_expires_at)
        else null
      end desc nulls last,
      case when coalesce(p_sort, 'attention') = 'oldest' then extract(epoch from coalesce(invite_created_at, sent_at)) end asc nulls last,
      case when coalesce(p_sort, 'attention') = 'name' then lower(coalesce(principal_name, '')) end asc,
      case coalesce(p_sort, 'attention')
        when 'attention' then case ui_status
          when 'admin_action' then 0
          when 'falha' then 1
          when 'cadastro_pendente' then 2
          when 'expirado' then 3
          when 'pendente' then 4
          when 'nao_enviado' then 5
          when 'pulado' then 6
          else 7
        end
      end asc,
      lower(coalesce(principal_name, email_norm))
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'total', c.row_count,
      'concluido', c.concluido,
      'pendente', c.pendente,
      'expirado', c.expirado,
      'falha', c.falha,
      'cadastro_pendente', c.cadastro_pendente,
      'admin_action', c.admin_action,
      'nao_enviado', c.nao_enviado,
      'pulado', c.pulado,
      'shared_groups', c.shared_groups
    ),
    'completion', jsonb_build_object(
      'done', c.concluido,
      'total', c.row_count,
      'percent', case when c.row_count = 0 then 0 else round((c.concluido::numeric * 100) / c.row_count) end
    ),
    'rows', coalesce((
      select jsonb_agg(row_payload)
      from (
        select jsonb_build_object(
          'row_key', s.row_key,
          'invite_id', s.invite_id,
          'principal_contact_id', s.principal_contact_id,
          'email_masked', public.invite_center_mask_email(s.email_norm),
          'principal_name', s.principal_name,
          'principal_pin', s.principal_pin,
          'person_count', s.person_count,
          'event_id', s.event_id,
          'event_name', s.event_name,
          'ticket_count', coalesce(s.active_ticket_count, 0),
          'sent_at', coalesce(s.auth_email_sent_at, s.sent_at, s.invite_created_at),
          'invite_created_at', s.invite_created_at,
          'expires_at', s.auth_link_expires_at,
          'record_expires_at', s.expires_at,
          'auth_confirmed_at', s.auth_confirmed_at,
          'claimed_at', s.claimed_at,
          'status', s.ui_status,
          'cadastral_incomplete', s.cadastral_incomplete,
          'auth_linked', s.principal_user_id is not null or s.claimed_user_id is not null or s.auth_user_id is not null,
          'owner_materialized', coalesce(s.any_owner_materialized, false),
          'import_batch_id', s.import_batch_id,
          'mixed_intended_owners', coalesce(s.intended_owner_count, 0) > 1,
          'can_resend', s.ui_status in ('pendente', 'expirado', 'falha', 'nao_enviado', 'cadastro_pendente'),
          'people', coalesce((
            select jsonb_agg(jsonb_build_object(
              'contact_id', c.id,
              'full_name', c.full_name,
              'is_principal', c.id = s.principal_contact_id
            ) order by (c.id = s.principal_contact_id) desc, c.full_name)
            from contacts c
            where c.id = any (s.contact_ids)
          ), '[]'::jsonb)
        ) as row_payload
        from sorted s
      ) listed
    ), '[]'::jsonb),
    'page', (v_offset / v_limit) + 1,
    'page_size', v_limit,
    'row_count', (select count(*)::int from filtered),
    'scoped_count', c.row_count,
    'sent_last_24h', v_sent_24h,
    'bulk_batch_size', 5,
    'active_job', (
      select jsonb_build_object(
        'id', j.id,
        'status', j.status,
        'total_count', j.total_count,
        'unique_email_count', j.unique_email_count,
        'processed_count', j.processed_count,
        'sent_count', j.sent_count,
        'failed_count', j.failed_count,
        'skipped_count', j.skipped_count,
        'last_error_safe', j.last_error_safe
      )
      from public.account_invite_center_jobs j
      where j.organization_id = v_org
      order by j.created_at desc
      limit 1
    ),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by e.starts_at desc)
      from public.events e
      where e.organization_id = v_org
    ), '[]'::jsonb),
    'import_batches', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'label', coalesce(b.file_name, b.id::text)) order by b.created_at desc)
      from public.import_batches b
      where b.organization_id = v_org
    ), '[]'::jsonb)
  )
  into v_result
  from counted c;

  return v_result;
end;
$$;


create or replace function public.get_invite_center_detail(p_row_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_list jsonb;
  v_row jsonb;
  v_org uuid;
  v_actor uuid := auth.uid();
  v_email text;
  v_principal uuid;
begin
  if v_actor is null or not public.current_user_has_permission('invites.view') then
    raise exception 'Sem permissao.';
  end if;
  if p_row_key is null or length(p_row_key) < 8 then
    raise exception 'Registro invalido.';
  end if;

  select o.id into v_org
  from public.organizations o
  where public.user_can_access_organization(v_actor, o.id)
  order by o.created_at
  limit 1;
  if v_org is null then
    return jsonb_build_object('found', false);
  end if;

  select c.email, c.id
    into v_email, v_principal
  from public.registration_contacts c
  where c.organization_id = v_org
    and md5(v_org::text || chr(1) || lower(trim(c.email))) = p_row_key
  limit 1;

  if v_email is null then
    select pai.email, pai.registration_contact_id
      into v_email, v_principal
    from public.participant_account_invites pai
    where pai.organization_id = v_org
      and (pai.id::text = p_row_key or md5(v_org::text || chr(1) || lower(trim(pai.email))) = p_row_key)
    order by pai.created_at desc
    limit 1;
  end if;

  if v_email is null then
    return jsonb_build_object('found', false);
  end if;

  v_list := public.list_invite_center(null, null, 'all', 'all', null, 'attention', 1, 0, v_org, p_row_key);
  v_row := v_list->'rows'->0;

  return jsonb_build_object(
    'found', true,
    'summary', v_row,
    'email', v_email,
    'email_masked', public.invite_center_mask_email(v_email),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contact_id', c.id,
        'full_name', c.full_name,
        'public_pin', c.public_pin,
        'is_principal', c.id = coalesce((v_row->>'principal_contact_id')::uuid, v_principal),
        'role', case when c.id = coalesce((v_row->>'principal_contact_id')::uuid, v_principal) then 'principal' else 'titular' end
      ) order by (c.id = coalesce((v_row->>'principal_contact_id')::uuid, v_principal)) desc, c.full_name)
      from public.registration_contacts c
      where c.organization_id = v_org
        and lower(trim(c.email)) = lower(trim(v_email))
    ), '[]'::jsonb),
    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'event_id', t.event_id,
        'event_name', e.name,
        'status', t.status,
        'holder_contact_id', coalesce(oi.registration_contact_id, p.registration_contact_id),
        'holder_name', coalesce(hc.full_name, p.full_name, oi.holder_full_name),
        'intended_owner_contact_id', t.intended_owner_contact_id,
        'intended_owner_name', oc.full_name,
        'owner_user_id', t.owner_user_id,
        'owner_materialized', t.owner_user_id is not null,
        'shirt', nullif(trim(concat_ws(' ', oi.shirt_type, oi.shirt_size)), ''),
        'used_at', t.used_at,
        'kit_delivered', exists (
          select 1 from public.participant_kit_items ki
          where ki.ticket_id = t.id and ki.status = 'delivered'
        )
      ) order by e.starts_at desc, t.issued_at)
      from public.tickets t
      left join public.events e on e.id = t.event_id
      left join public.order_items oi on oi.id = t.order_item_id
      left join public.participants p on p.id = t.participant_id
      left join public.registration_contacts hc on hc.id = coalesce(oi.registration_contact_id, p.registration_contact_id)
      left join public.registration_contacts oc on oc.id = t.intended_owner_contact_id
      where t.organization_id = v_org
        and (
          t.intended_owner_contact_id in (select id from public.registration_contacts where organization_id = v_org and lower(trim(email)) = lower(trim(v_email)))
          or oi.registration_contact_id in (select id from public.registration_contacts where organization_id = v_org and lower(trim(email)) = lower(trim(v_email)))
          or p.registration_contact_id in (select id from public.registration_contacts where organization_id = v_org and lower(trim(email)) = lower(trim(v_email)))
        )
    ), '[]'::jsonb),
    'invite', (
      select jsonb_build_object(
        'id', pai.id,
        'status', pai.status,
        'created_at', pai.created_at,
        'expires_at', pai.expires_at,
        'auth_email_sent_at', pai.auth_email_sent_at,
        'auth_link_expires_at', pai.auth_link_expires_at,
        'auth_confirmed_at', pai.auth_confirmed_at,
        'claimed_at', pai.claimed_at,
        'auth_user_id', pai.auth_user_id,
        'claimed_user_id', pai.claimed_user_id,
        'password_setup_completed_at', pai.password_setup_completed_at,
        'attempt_count', coalesce((
          select sum(ji.attempt_count)::int
          from public.account_invite_job_items ji
          join public.participants p on p.id = ji.participant_id
          join public.registration_contacts c on c.id = p.registration_contact_id
          where c.organization_id = v_org and lower(trim(c.email)) = lower(trim(v_email))
        ), 0),
        'last_error_safe', (
          select ji.error_code
          from public.account_invite_job_items ji
          join public.participants p on p.id = ji.participant_id
          join public.registration_contacts c on c.id = p.registration_contact_id
          where c.organization_id = v_org and lower(trim(c.email)) = lower(trim(v_email)) and ji.status = 'failed'
          order by ji.finished_at desc nulls last
          limit 1
        ),
        'job_id', (
          select j.id
          from public.account_invite_jobs j
          join public.account_invite_job_items ji on ji.job_id = j.id
          join public.participants p on p.id = ji.participant_id
          join public.registration_contacts c on c.id = p.registration_contact_id
          where c.organization_id = v_org and lower(trim(c.email)) = lower(trim(v_email))
          order by j.created_at desc
          limit 1
        ),
        'import_batch_id', (
          select j.import_batch_id
          from public.account_invite_jobs j
          join public.account_invite_job_items ji on ji.job_id = j.id
          join public.participants p on p.id = ji.participant_id
          join public.registration_contacts c on c.id = p.registration_contact_id
          where c.organization_id = v_org and lower(trim(c.email)) = lower(trim(v_email))
          order by j.created_at desc
          limit 1
        )
      )
      from public.participant_account_invites pai
      where pai.organization_id = v_org
        and lower(trim(pai.email)) = lower(trim(v_email))
      order by case pai.status when 'claimed' then 0 when 'pending' then 1 else 2 end, pai.created_at desc
      limit 1
    ),
    'profile', (
      select jsonb_build_object(
        'account_status', cp.account_status,
        'must_complete_profile', cp.must_complete_profile,
        'must_change_password', cp.must_change_password,
        'activation_completed_at', cp.activation_completed_at,
        'last_sign_in_at', au.last_sign_in_at
      )
      from public.registration_contacts c
      left join public.participant_account_invites pai
        on pai.organization_id = v_org and lower(trim(pai.email)) = lower(trim(v_email))
      left join public.customer_profiles cp
        on cp.user_id = coalesce(pai.claimed_user_id, pai.auth_user_id, c.user_id)
      left join auth.users au on au.id = cp.user_id
      where c.organization_id = v_org and lower(trim(c.email)) = lower(trim(v_email))
      order by (c.id = v_principal) desc
      limit 1
    ),
    'timeline', coalesce((
      select jsonb_agg(jsonb_build_object('at', x.at, 'title', x.title, 'description', x.description) order by x.at)
      from (
        select pai.created_at as at, 'Convite enviado'::text as title, 'Convite interno registrado.'::text as description
        from public.participant_account_invites pai
        where pai.organization_id = v_org and lower(trim(pai.email)) = lower(trim(v_email))
        union all
        select ji.sent_at, 'E-mail aceito pelo provedor', null
        from public.account_invite_job_items ji
        join public.participants p on p.id = ji.participant_id
        join public.registration_contacts c on c.id = p.registration_contact_id
        where c.organization_id = v_org and lower(trim(c.email)) = lower(trim(v_email)) and ji.sent_at is not null
        union all
        select pai.claimed_at, 'Primeiro acesso reclamado', null
        from public.participant_account_invites pai
        where pai.organization_id = v_org and lower(trim(pai.email)) = lower(trim(v_email)) and pai.claimed_at is not null
        union all
        select pai.password_setup_completed_at, 'Senha definida', null
        from public.participant_account_invites pai
        where pai.organization_id = v_org and lower(trim(pai.email)) = lower(trim(v_email)) and pai.password_setup_completed_at is not null
        union all
        select cp.activation_completed_at, 'Conta ativada', null
        from public.customer_profiles cp
        join public.participant_account_invites pai on pai.claimed_user_id = cp.user_id or pai.auth_user_id = cp.user_id
        where pai.organization_id = v_org and lower(trim(pai.email)) = lower(trim(v_email)) and cp.activation_completed_at is not null
        union all
        select h.created_at, 'Ingresso vinculado à conta', coalesce(h.reason_code, '')
        from public.ticket_owner_history h
        join public.tickets t on t.id = h.ticket_id
        where t.organization_id = v_org
          and h.new_owner_user_id is not null
          and (
            t.intended_owner_contact_id in (select id from public.registration_contacts where organization_id = v_org and lower(trim(email)) = lower(trim(v_email)))
          )
        union all
        select ji.finished_at, 'Falha de envio', coalesce(ji.error_code, ji.reason_code)
        from public.account_invite_job_items ji
        join public.participants p on p.id = ji.participant_id
        join public.registration_contacts c on c.id = p.registration_contact_id
        where c.organization_id = v_org and lower(trim(c.email)) = lower(trim(v_email)) and ji.status = 'failed' and ji.finished_at is not null
      ) x
      where x.at is not null
    ), '[]'::jsonb)
  );
end;
$$;


-- preview_invite_center_bulk_resend permanece o da 20261015000000:
-- chama list_invite_center(..., 'reenvio') e devolve sends_nothing=true.
-- Com o classificador novo, "reenvio" passa a ser link Auth expirado/falha.

revoke all on function public.invite_center_ui_status(boolean, text, timestamptz, text, boolean, boolean, timestamptz, boolean, text, timestamptz, timestamptz) from public, anon;
revoke all on function public.list_invite_center(uuid, uuid, text, text, text, text, integer, integer, uuid, text) from public, anon;
revoke all on function public.get_invite_center_detail(text) from public, anon;
grant execute on function public.invite_center_ui_status(boolean, text, timestamptz, text, boolean, boolean, timestamptz, boolean, text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.list_invite_center(uuid, uuid, text, text, text, text, integer, integer, uuid, text) to authenticated, service_role;
grant execute on function public.get_invite_center_detail(text) to authenticated, service_role;

commit;
