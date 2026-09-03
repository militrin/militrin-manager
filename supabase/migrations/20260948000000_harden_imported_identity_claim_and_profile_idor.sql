begin;

-- Release Gate #2 / P0 de seguranca.
--
-- 1. Cadastro importado com direitos comerciais/operacionais nao pode ser
--    assumido so porque uma conta autenticada informou o mesmo CPF.
--    Autorizacao especial vem do convite/claim ja existente
--    (participant_account_invites), nunca de flag enviada pelo cliente.
-- 2. link_participant_account_projection deixa de ser executavel por
--    authenticated: nao ha call site legitimo no app.
-- 3. get_customer_profile deixa de devolver PII de outro usuario a um
--    authenticated comum. Self-service usa auth.uid(); admin so com
--    participants.view e escopo de organizacao.
-- 4. reconcile_registration_contact_account deixa de ser executavel por
--    authenticated. Helper de trigger/claim; anexar cadastro protegido
--    exige claim ou participant ja vinculado a conta.
-- 5. ensure_order_for_participant deixa de gravar participants.user_id e
--    perde EXECUTE de authenticated.

-- ============================================================
-- Helpers internos. Sem GRANT a anon/authenticated.
-- Nao tratar auth.uid() IS NULL como service_role.
-- ============================================================

create or replace function public.registration_contact_has_protected_identity_rights(
  p_contact_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_contact_id is null then
    return false;
  end if;

  return exists (
      select 1 from public.participants p
      where p.registration_contact_id = p_contact_id
    )
    or exists (
      select 1 from public.order_items oi
      where oi.registration_contact_id = p_contact_id
    )
    or exists (
      select 1
      from public.orders o
      join public.participants p on p.id = o.participant_id
      where p.registration_contact_id = p_contact_id
    )
    or exists (
      select 1
      from public.tickets t
      where t.participant_id in (
        select p.id from public.participants p where p.registration_contact_id = p_contact_id
      )
      or t.order_item_id in (
        select oi.id from public.order_items oi where oi.registration_contact_id = p_contact_id
      )
    )
    or exists (
      select 1
      from public.payments pay
      where pay.participant_id in (
        select p.id from public.participants p where p.registration_contact_id = p_contact_id
      )
      or pay.order_id in (
        select oi.order_id from public.order_items oi where oi.registration_contact_id = p_contact_id
      )
    )
    or exists (
      select 1
      from public.participation_history ph
      where ph.registration_contact_id = p_contact_id
         or ph.participant_id in (
           select p.id from public.participants p where p.registration_contact_id = p_contact_id
         )
    )
    or exists (
      select 1 from public.import_batch_rows r
      where r.registration_contact_id = p_contact_id
    )
    or exists (
      select 1 from public.import_batches b
      where b.id in (
        select r.import_batch_id
        from public.import_batch_rows r
        where r.registration_contact_id = p_contact_id
      )
    )
    or exists (
      select 1 from public.sponsors s
      where s.registration_contact_id = p_contact_id
    )
    or exists (
      select 1 from public.participant_account_invites i
      where i.registration_contact_id = p_contact_id
         or i.participant_id in (
           select p.id from public.participants p where p.registration_contact_id = p_contact_id
         )
    );
end;
$$;

create or replace function public.registration_contact_invite_authorizes_user(
  p_contact_id uuid,
  p_user_id uuid,
  p_allow_pending boolean
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_contact_id is null or p_user_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.participant_account_invites i
    where (
        i.registration_contact_id = p_contact_id
        or i.participant_id in (
          select p.id from public.participants p where p.registration_contact_id = p_contact_id
        )
      )
      and (
        (i.status = 'claimed' and i.claimed_user_id = p_user_id)
        or (
          p_allow_pending
          and i.status = 'pending'
          and i.expires_at > now()
          and i.auth_user_id = p_user_id
        )
      )
  );
end;
$$;

revoke all on function public.registration_contact_has_protected_identity_rights(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.registration_contact_invite_authorizes_user(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

-- ============================================================
-- find_conflicting: orfao protegido e conflito, salvo convite
-- pendente/claimed verificavel para p_exclude_user_id.
-- ============================================================

create or replace function public.find_conflicting_registration_contact(
  p_cpf text,
  p_exclude_user_id uuid default null,
  p_organization_id uuid default null
)
returns table(has_conflict boolean, resolved_organization_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
  v_org_id uuid := p_organization_id;
  v_existing record;
begin
  if length(v_cpf) <> 11 then
    has_conflict := false;
    resolved_organization_id := null;
    return next;
    return;
  end if;

  if v_org_id is null then
    v_org_id := public.resolve_default_registration_organization();
  end if;

  if v_org_id is null then
    has_conflict := false;
    resolved_organization_id := null;
    return next;
    return;
  end if;

  select rc.id, rc.user_id into v_existing
    from public.registration_contacts rc
    where rc.organization_id = v_org_id and rc.cpf = v_cpf;

  has_conflict := found and (
    (v_existing.user_id is not null and v_existing.user_id is distinct from p_exclude_user_id)
    or (
      v_existing.user_id is null
      and public.registration_contact_has_protected_identity_rights(v_existing.id)
      and not public.registration_contact_invite_authorizes_user(v_existing.id, p_exclude_user_id, true)
    )
  );
  resolved_organization_id := v_org_id;
  return next;
end;
$$;

-- ============================================================
-- ensure: attach por CPF so para casca vazia ou apos claim.
-- ============================================================

create or replace function public.ensure_registration_contact_for_user(
  p_user_id uuid,
  p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_profile record;
  v_email text;
  v_email_confirmed_at timestamptz;
  v_cpf text;
  v_contact_id uuid;
  v_existing record;
  v_conflict_user_id uuid;
begin
  if p_user_id is null then
    raise exception 'Usuario obrigatorio.';
  end if;

  if v_actor is not null and v_actor <> p_user_id
     and not public.current_user_has_permission('participants.create') then
    raise exception 'Sem permissao para vincular este cadastro.';
  end if;

  select full_name, cpf, birth_date, gender, phone, city
    into v_profile
    from public.customer_profiles
    where user_id = p_user_id;

  if not found then
    return null;
  end if;

  select email, email_confirmed_at into v_email, v_email_confirmed_at from auth.users where id = p_user_id;
  v_cpf := regexp_replace(coalesce(v_profile.cpf, ''), '\D', '', 'g');

  if length(v_cpf) <> 11
     or nullif(trim(coalesce(v_profile.full_name, '')), '') is null
     or v_profile.birth_date is null
     or nullif(trim(coalesce(v_profile.phone, '')), '') is null
     or nullif(trim(coalesce(v_email, '')), '') is null
     or v_email_confirmed_at is null
  then
    return null;
  end if;

  if p_organization_id is null then
    p_organization_id := public.resolve_default_registration_organization();
    if p_organization_id is null then
      return null;
    end if;
  end if;

  if (select fc.has_conflict from public.find_conflicting_registration_contact(v_cpf, p_user_id, p_organization_id) fc) then
    raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
      detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
  end if;

  select id into v_contact_id
    from public.registration_contacts
    where organization_id = p_organization_id and user_id = p_user_id;

  if v_contact_id is not null then
    update public.registration_contacts set
      full_name = coalesce(nullif(trim(full_name), ''), trim(v_profile.full_name)),
      birth_date = coalesce(birth_date, v_profile.birth_date),
      gender = coalesce(nullif(trim(coalesce(gender, '')), ''), nullif(trim(coalesce(v_profile.gender, '')), '')),
      phone = coalesce(nullif(trim(coalesce(phone, '')), ''), trim(v_profile.phone)),
      city = coalesce(nullif(trim(coalesce(city, '')), ''), nullif(trim(coalesce(v_profile.city, '')), '')),
      updated_at = now()
      where id = v_contact_id;
    return v_contact_id;
  end if;

  select id, user_id into v_existing
    from public.registration_contacts
    where organization_id = p_organization_id and cpf = v_cpf
    for update;

  if v_existing.id is not null then
    if v_existing.user_id is not null and v_existing.user_id is distinct from p_user_id then
      raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
          'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
    end if;

    if v_existing.user_id is null
       and public.registration_contact_has_protected_identity_rights(v_existing.id)
       and not public.registration_contact_invite_authorizes_user(v_existing.id, p_user_id, false) then
      raise exception using errcode = 'P0001', message = 'REGISTRATION_CONTACT_REQUIRES_INVITE',
        detail = jsonb_build_object('code', 'REGISTRATION_CONTACT_REQUIRES_INVITE',
          'message', 'Este CPF pertence a um cadastro existente. Use o convite de primeiro acesso enviado pela organização.')::text;
    end if;

    update public.registration_contacts set
      user_id = p_user_id,
      full_name = coalesce(nullif(trim(full_name), ''), trim(v_profile.full_name)),
      birth_date = coalesce(birth_date, v_profile.birth_date),
      gender = coalesce(nullif(trim(coalesce(gender, '')), ''), nullif(trim(coalesce(v_profile.gender, '')), '')),
      phone = coalesce(nullif(trim(coalesce(phone, '')), ''), trim(v_profile.phone)),
      email = coalesce(nullif(trim(coalesce(email, '')), ''), lower(trim(v_email))),
      city = coalesce(nullif(trim(coalesce(city, '')), ''), nullif(trim(coalesce(v_profile.city, '')), '')),
      updated_at = now()
      where id = v_existing.id
        and (user_id is null or user_id = p_user_id)
      returning id into v_contact_id;

    if v_contact_id is null then
      raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
          'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
    end if;

    return v_contact_id;
  end if;

  insert into public.registration_contacts(
    organization_id, user_id, full_name, cpf, birth_date, gender, phone, email, city, created_by
  ) values (
    p_organization_id, p_user_id, trim(v_profile.full_name), v_cpf, v_profile.birth_date,
    nullif(trim(coalesce(v_profile.gender, '')), ''), trim(v_profile.phone), lower(trim(v_email)),
    nullif(trim(coalesce(v_profile.city, '')), ''), p_user_id
  )
  on conflict (organization_id, cpf) do update set
    user_id = excluded.user_id,
    updated_at = now()
  where registration_contacts.user_id is not distinct from excluded.user_id
     or (
       registration_contacts.user_id is null
       and (
         not public.registration_contact_has_protected_identity_rights(registration_contacts.id)
         or public.registration_contact_invite_authorizes_user(registration_contacts.id, excluded.user_id, false)
       )
     )
  returning id into v_contact_id;

  if v_contact_id is null then
    select rc.user_id into v_conflict_user_id
      from public.registration_contacts rc
      where rc.organization_id = p_organization_id and rc.cpf = v_cpf;
    if found and v_conflict_user_id is distinct from p_user_id then
      raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
          'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
    end if;
    raise exception using errcode = 'P0001', message = 'REGISTRATION_CONTACT_REQUIRES_INVITE',
      detail = jsonb_build_object('code', 'REGISTRATION_CONTACT_REQUIRES_INVITE',
        'message', 'Este CPF pertence a um cadastro existente. Use o convite de primeiro acesso enviado pela organização.')::text;
  end if;

  return v_contact_id;
end;
$$;

revoke all on function public.ensure_registration_contact_for_user(uuid, uuid)
  from public, anon;
grant execute on function public.ensure_registration_contact_for_user(uuid, uuid)
  to authenticated, service_role;

-- ============================================================
-- Patch 2: RPC de projecao arbitraria. Sem call site no app.
-- Mantida so para nao quebrar assinatura; corpo inerte + sem EXECUTE.
-- ============================================================

create or replace function public.link_participant_account_projection(p_participant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'RPC desativada. Use o convite/claim canonico.';
end;
$$;

revoke all on function public.link_participant_account_projection(uuid)
  from public, anon, authenticated, service_role;

-- ============================================================
-- Patch 3: IDOR get_customer_profile.
-- Self-service: alvo = auth.uid().
-- Admin: participants.view + cadastro/participante na org acessivel.
-- Sem sessao: nenhum row (fail-closed; nao e atalho de service_role).
-- ============================================================

create or replace function public.get_customer_profile(p_user_id uuid default auth.uid())
returns table(
  user_id uuid,
  full_name text,
  cpf text,
  birth_date date,
  gender text,
  phone text,
  city text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_target uuid := coalesce(p_user_id, auth.uid());
begin
  if v_actor is null or v_target is null then
    return;
  end if;

  if v_target is distinct from v_actor then
    if not public.current_user_has_permission('participants.view') then
      return;
    end if;
    if not exists (
      select 1
      from public.participants p
      where p.user_id = v_target
        and public.user_can_access_organization(v_actor, p.organization_id)
    ) and not exists (
      select 1
      from public.registration_contacts rc
      where rc.user_id = v_target
        and public.user_can_access_organization(v_actor, rc.organization_id)
    ) then
      return;
    end if;
  end if;

  return query
  select
    cp.user_id,
    cp.full_name,
    cp.cpf,
    cp.birth_date,
    cp.gender,
    cp.phone,
    cp.city,
    cp.created_at,
    cp.updated_at
  from public.customer_profiles cp
  where cp.user_id = v_target;
end;
$$;

revoke all on function public.get_customer_profile(uuid)
  from public, anon;
grant execute on function public.get_customer_profile(uuid)
  to authenticated, service_role;

-- ============================================================
-- Patch complementar: bypasses equivalentes ao P0.
-- reconcile_registration_contact_account e helper de trigger/claim.
-- Nenhum call site no app. authenticated nao pode anexar contact orfao.
-- ensure_order_for_participant e legado interno de confirmacao de
-- pagamento; nao pode gravar participants.user_id.
-- ============================================================

create or replace function public.reconcile_registration_contact_account(
  p_registration_contact_id uuid,
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_ticket_count integer := 0;
  v_participant_already_linked boolean := false;
begin
  if p_registration_contact_id is null or p_user_id is null then
    raise exception 'Pessoa e conta sao obrigatorias.';
  end if;
  if v_actor is not null and v_actor <> p_user_id
     and not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para reconciliar esta pessoa.';
  end if;
  if not exists(select 1 from auth.users as account_user where account_user.id = p_user_id) then
    raise exception 'Conta Auth inexistente.';
  end if;

  select contact.* into v_contact
  from public.registration_contacts as contact
  where contact.id = p_registration_contact_id
  for update;
  if not found then raise exception 'Pessoa nao encontrada.'; end if;
  if v_actor is not null and v_actor <> p_user_id
     and not public.user_can_access_organization(v_actor, v_contact.organization_id) then
    raise exception 'Pessoa fora da organizacao atual.';
  end if;
  if v_contact.user_id is not null and v_contact.user_id <> p_user_id then
    raise exception 'Pessoa ja vinculada a outra conta.';
  end if;
  if exists (
    select 1 from public.participants as conflicting
    where conflicting.registration_contact_id = v_contact.id
      and conflicting.user_id is not null
      and conflicting.user_id <> p_user_id
  ) then
    raise exception 'Participacao vinculada a outra conta.';
  end if;

  select exists (
    select 1 from public.participants as linked_participant
    where linked_participant.registration_contact_id = v_contact.id
      and linked_participant.user_id = p_user_id
  ) into v_participant_already_linked;

  -- Anexar cadastro protegido so com claim verificavel ou depois que o
  -- claim ja gravou participants.user_id (trigger). Conhecer o UUID ou
  -- ser o proprio auth.uid() nao autoriza.
  if v_contact.user_id is null
     and public.registration_contact_has_protected_identity_rights(v_contact.id)
     and not public.registration_contact_invite_authorizes_user(v_contact.id, p_user_id, false)
     and not v_participant_already_linked then
    raise exception using errcode = 'P0001',
      message = 'REGISTRATION_CONTACT_REQUIRES_INVITE',
      detail = jsonb_build_object(
        'code', 'REGISTRATION_CONTACT_REQUIRES_INVITE',
        'message', 'Este cadastro exige convite/claim. UUID nao e autorizacao.'
      )::text;
  end if;

  update public.registration_contacts as linked_contact
  set user_id = p_user_id, updated_at = now()
  where linked_contact.id = v_contact.id
    and linked_contact.user_id is distinct from p_user_id;

  update public.customer_profiles as profile
  set full_name = v_contact.full_name, updated_at = now()
  where profile.user_id = p_user_id
    and nullif(trim(v_contact.full_name), '') is not null
    and (
      nullif(trim(profile.full_name), '') is null
      or lower(trim(profile.full_name)) = 'participante'
    );

  update public.participants as linked_participant
  set user_id = p_user_id, updated_at = now()
  where linked_participant.registration_contact_id = v_contact.id
    and linked_participant.organization_id = v_contact.organization_id
    and linked_participant.user_id is null;

  update public.sponsors as linked_sponsor
  set user_id = p_user_id, updated_at = now()
  where linked_sponsor.registration_contact_id = v_contact.id
    and linked_sponsor.user_id is null;

  with owned as (
    update public.tickets as ticket
    set owner_user_id = p_user_id
    where ticket.organization_id = v_contact.organization_id
      and ticket.owner_user_id is null
      and (
        exists (
          select 1 from public.participants as holder
          where holder.id = ticket.participant_id
            and holder.registration_contact_id = v_contact.id
        )
        or exists (
          select 1 from public.order_items as item
          where item.id = ticket.order_item_id
            and item.registration_contact_id = v_contact.id
        )
      )
    returning ticket.id, ticket.order_id, ticket.event_id, ticket.organization_id
  ), history as (
    insert into public.ticket_owner_history(
      ticket_id, order_id, event_id, organization_id, operation,
      previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
    )
    select owned.id, owned.order_id, owned.event_id, owned.organization_id,
      'owner_assigned', null, p_user_id, coalesce(v_actor, p_user_id),
      'data_regularization',
      'Propriedade materializada a partir da Pessoa canonica vinculada a conta.'
    from owned
    returning ticket_id
  )
  select count(*)::integer into v_ticket_count from history;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'registration_contact_account_reconciled', 'registration_contacts', v_contact.id, null,
    jsonb_build_object(
      'organization_id', v_contact.organization_id,
      'user_id', p_user_id,
      'tickets_assigned', v_ticket_count,
      'actor_user_id', v_actor
    )
  );
  return v_ticket_count;
end;
$$;

revoke all on function public.reconcile_registration_contact_account(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reconcile_registration_contact_account(uuid, uuid)
  to service_role;

create or replace function public.ensure_order_for_participant(
  p_participant_id uuid,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_status text;
begin
  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;

  -- Nao anexa identidade. Pedido/pagamento continuam podendo ser
  -- sincronizados por SQL interno; ownership de participant/contact/ticket
  -- so via convite/claim.
  if v_participant.user_id is not null
     and v_participant.user_id is distinct from coalesce(p_user_id, v_actor) then
    raise exception 'Participante ja vinculado a outra conta.';
  end if;

  select * into v_payment
  from public.payments
  where participant_id = v_participant.id
  order by created_at desc
  limit 1
  for update;
  if not found then raise exception 'Pagamento nao encontrado.'; end if;

  select * into v_order
  from public.orders
  where payment_id = v_payment.id
  for update;
  if not found then raise exception 'Pedido canonico nao encontrado para o pagamento.'; end if;

  select * into v_item
  from public.order_items
  where order_id = v_order.id
  for update;
  if not found then raise exception 'Item canonico nao encontrado para o pedido.'; end if;

  v_status := case
    when v_payment.payment_status = 'paid' then 'confirmed'
    when v_payment.payment_status in ('cancelled', 'expired', 'refunded') then v_payment.payment_status
    else 'pending'
  end;
  update public.orders
  set status = v_status,
      confirmed_at = case when v_status = 'confirmed' then coalesce(confirmed_at, now()) else confirmed_at end
  where id = v_order.id;
  update public.order_items
  set status = case when v_status = 'pending' then 'reserved' else v_status end,
      reservation_expires_at = case when v_status = 'confirmed' then null else reservation_expires_at end,
      updated_at = now()
  where id = v_item.id;
  return v_order.id;
end;
$$;

revoke all on function public.ensure_order_for_participant(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.ensure_order_for_participant(uuid, uuid)
  to service_role;

commit;
