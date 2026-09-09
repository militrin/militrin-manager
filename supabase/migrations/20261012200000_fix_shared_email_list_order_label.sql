-- Gate #7 follow-up: order_label precisa de tipos text homogeneos no COALESCE.

begin;

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
    select email_norm from event_contacts group by email_norm having count(*) > 1
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
        where r.registration_contact_id = ec.id and b.event_id = p_event_id
      ) as source_row,
      exists (select 1 from auth.users au where au.id = ec.user_id) as has_valid_auth
    from event_contacts ec
    join shared_emails se on se.email_norm = ec.email_norm
  ), recommended as (
    select distinct on (email_norm) id, email_norm
    from ranked
    order by email_norm, has_valid_auth desc, completeness desc, coalesce(source_row, 2147483647), created_at, id
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
          having count(*) = (
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
             and bool_and(t.intended_owner_contact_id = (select rec.id from recommended rec where rec.email_norm = r.email_norm))
        ),
        'has_auth', exists (
          select 1 from auth.users au where lower(trim(coalesce(au.email, ''))) = r.email_norm
        ),
        'pending_invites', (
          select count(*)::int
          from public.participant_account_invites
          where organization_id = v_org
            and status = 'pending'
            and lower(trim(email)) = r.email_norm
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
            'order_label', coalesce(o.display_number::text, o.order_number::text, t.order_id::text)
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

revoke all on function public.list_event_first_access_blockers(uuid) from public, anon, authenticated;
grant execute on function public.list_event_first_access_blockers(uuid) to authenticated, service_role;

commit;
