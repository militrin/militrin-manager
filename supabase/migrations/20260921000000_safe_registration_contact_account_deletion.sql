begin;

create table if not exists public.registration_contact_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  registration_contact_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  auth_user_id uuid,
  requested_by uuid not null,
  reason text not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'auth_deleted', 'completed', 'failed')),
  last_error text,
  created_at timestamptz not null default now(),
  auth_deleted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists registration_contact_deletion_requests_active_contact_uidx
  on public.registration_contact_deletion_requests(registration_contact_id)
  where status <> 'completed';

alter table public.registration_contact_deletion_requests enable row level security;
revoke all on public.registration_contact_deletion_requests from public, anon, authenticated;
grant all on public.registration_contact_deletion_requests to service_role;

create or replace function public.prepare_owner_registration_contact_deletion(
  p_registration_contact_id uuid,
  p_confirmation text,
  p_reason text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_request public.registration_contact_deletion_requests%rowtype;
  v_participant_ids uuid[];
  v_blockers jsonb;
  v_total integer;
begin
  if v_actor is null then raise exception 'Autenticacao obrigatoria.'; end if;

  select * into v_contact
  from public.registration_contacts
  where id = p_registration_contact_id
  for update;
  if not found then raise exception 'Cadastro nao encontrado.'; end if;

  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = v_contact.organization_id
      and m.user_id = v_actor and m.is_owner and m.is_active
  ) then raise exception 'Somente o Owner da organizacao pode excluir cadastros.'; end if;
  if btrim(coalesce(p_confirmation, '')) <> btrim(v_contact.full_name) then
    raise exception 'Confirmacao incorreta. Digite o nome completo exatamente como exibido.';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Informe um motivo com pelo menos 5 caracteres.';
  end if;

  select coalesce(array_agg(p.id), '{}'::uuid[]) into v_participant_ids
  from public.participants p where p.registration_contact_id = v_contact.id;

  select jsonb_build_object(
    'pedidos', (select count(distinct o.id) from public.orders o
      where o.user_id = v_contact.user_id or o.participant_id = any(v_participant_ids)
         or exists (select 1 from public.order_items oi where oi.order_id=o.id and (oi.registration_contact_id=v_contact.id or oi.participant_id=any(v_participant_ids)))),
    'ingressos', (select count(distinct t.id) from public.tickets t
      where t.owner_user_id=v_contact.user_id or t.participant_id=any(v_participant_ids)
         or exists (select 1 from public.order_items oi where oi.id=t.order_item_id and oi.registration_contact_id=v_contact.id)),
    'pagamentos', (select count(*) from public.payments p where p.participant_id=any(v_participant_ids)
      or exists(select 1 from public.orders o where o.id=p.order_id and o.user_id=v_contact.user_id)),
    'participacoes_historicas', (select count(*) from public.participation_history h
      where h.participant_id=any(v_participant_ids) or h.user_id=v_contact.user_id),
    'pedidos_loja', (select count(*) from public.store_orders so
      where so.registration_contact_id=v_contact.id or so.participant_id=any(v_participant_ids) or so.user_id=v_contact.user_id),
    'lancamentos_financeiros', (select count(*) from public.financial_entries f
      where f.source_participant_id=any(v_participant_ids)
         or exists(select 1 from public.orders o where o.id=f.source_order_id and o.user_id=v_contact.user_id)
         or exists(select 1 from public.payments p where p.id=f.source_payment_id and p.participant_id=any(v_participant_ids))),
    'cupons', (select count(*) from public.coupon_redemptions c where c.participant_id=any(v_participant_ids)),
    'entregas', (select count(*) from public.kit_deliveries k where k.participant_id=any(v_participant_ids)),
    'itens_operacionais', (select count(*) from public.participant_kit_items k where k.participant_id=any(v_participant_ids)),
    'pulseiras', (select count(*) from public.participant_wristbands w where w.participant_id=any(v_participant_ids)),
    'historico_titularidade', (select count(*) from public.ticket_holder_history h
      where h.previous_registration_contact_id=v_contact.id or h.new_registration_contact_id=v_contact.id
         or h.previous_participant_id=any(v_participant_ids) or h.new_participant_id=any(v_participant_ids)),
    'patrocinios', (select count(*) from public.sponsors s where s.registration_contact_id=v_contact.id),
    'convites_administrados', (select count(*) from public.participant_account_invites i
      where i.invited_by=v_contact.user_id and i.registration_contact_id is distinct from v_contact.id)
  ) into v_blockers;

  select coalesce(sum(value::text::integer), 0) into v_total from jsonb_each(v_blockers);
  if v_total > 0 then
    return jsonb_build_object('success', false, 'blocked', true, 'blockers', v_blockers,
      'message', 'Exclusao bloqueada: o cadastro possui historico operacional, financeiro ou de participacao.');
  end if;

  select * into v_request from public.registration_contact_deletion_requests
  where registration_contact_id=v_contact.id and status<>'completed' for update;
  if not found then
    insert into public.registration_contact_deletion_requests
      (registration_contact_id,organization_id,auth_user_id,requested_by,reason)
    values (v_contact.id,v_contact.organization_id,v_contact.user_id,v_actor,btrim(p_reason))
    returning * into v_request;
    insert into public.audit_logs(action,entity_type,entity_id,details)
    values ('registration_contact_deletion_requested','registration_contact_deletion_requests',v_request.id,
      jsonb_build_object('actor_user_id',v_actor,'organization_id',v_contact.organization_id,
        'registration_contact_id',v_contact.id,'auth_user_id',v_contact.user_id,'reason',btrim(p_reason)));
  end if;
  return jsonb_build_object('success',true,'blocked',false,'request_id',v_request.id,
    'auth_user_id',v_request.auth_user_id,'status',v_request.status);
end;
$$;

create or replace function public.mark_owner_registration_contact_auth_deleted(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_request public.registration_contact_deletion_requests%rowtype;
begin
  select * into v_request from public.registration_contact_deletion_requests where id=p_request_id for update;
  if not found then raise exception 'Solicitacao de exclusao nao encontrada.'; end if;
  if not exists(select 1 from public.organization_members m where m.organization_id=v_request.organization_id and m.user_id=v_actor and m.is_owner and m.is_active)
    then raise exception 'Somente o Owner da organizacao pode excluir cadastros.'; end if;
  update public.registration_contact_deletion_requests set status='auth_deleted',auth_deleted_at=coalesce(auth_deleted_at,now()),last_error=null,updated_at=now() where id=p_request_id;
  return jsonb_build_object('success',true);
end; $$;

create or replace function public.finalize_owner_registration_contact_deletion(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_request public.registration_contact_deletion_requests%rowtype; v_ids uuid[];
begin
  select * into v_request from public.registration_contact_deletion_requests where id=p_request_id for update;
  if not found then raise exception 'Solicitacao de exclusao nao encontrada.'; end if;
  if not exists(select 1 from public.organization_members m where m.organization_id=v_request.organization_id and m.user_id=v_actor and m.is_owner and m.is_active)
    then raise exception 'Somente o Owner da organizacao pode excluir cadastros.'; end if;
  if v_request.auth_user_id is not null and v_request.status<>'auth_deleted' then
    raise exception 'A conta de autenticacao ainda nao foi removida.';
  end if;
  if v_request.status='completed' then return jsonb_build_object('success',true,'already_completed',true); end if;

  perform 1 from public.registration_contacts where id=v_request.registration_contact_id for update;
  if found then
    select coalesce(array_agg(id),'{}'::uuid[]) into v_ids from public.participants where registration_contact_id=v_request.registration_contact_id;
    -- Revalida sob lock imediatamente antes dos deletes. Alem de produzir uma
    -- falha segura em concorrencia, impede que cascatas de participants apaguem
    -- historico criado depois da etapa de preparacao.
    perform 1 from public.participants where id=any(v_ids) for update;
    if exists(select 1 from public.orders o where o.user_id=v_request.auth_user_id or o.participant_id=any(v_ids)
        or exists(select 1 from public.order_items oi where oi.order_id=o.id and (oi.registration_contact_id=v_request.registration_contact_id or oi.participant_id=any(v_ids))))
      or exists(select 1 from public.tickets t where t.owner_user_id=v_request.auth_user_id or t.participant_id=any(v_ids)
        or exists(select 1 from public.order_items oi where oi.id=t.order_item_id and oi.registration_contact_id=v_request.registration_contact_id))
      or exists(select 1 from public.payments p where p.participant_id=any(v_ids))
      or exists(select 1 from public.participation_history h where h.participant_id=any(v_ids) or h.user_id=v_request.auth_user_id)
      or exists(select 1 from public.store_orders s where s.registration_contact_id=v_request.registration_contact_id or s.participant_id=any(v_ids) or s.user_id=v_request.auth_user_id)
      or exists(select 1 from public.financial_entries f where f.source_participant_id=any(v_ids))
      or exists(select 1 from public.coupon_redemptions c where c.participant_id=any(v_ids))
      or exists(select 1 from public.kit_deliveries k where k.participant_id=any(v_ids))
      or exists(select 1 from public.participant_kit_items k where k.participant_id=any(v_ids))
      or exists(select 1 from public.participant_wristbands w where w.participant_id=any(v_ids))
      or exists(select 1 from public.ticket_holder_history h where h.previous_registration_contact_id=v_request.registration_contact_id or h.new_registration_contact_id=v_request.registration_contact_id or h.previous_participant_id=any(v_ids) or h.new_participant_id=any(v_ids))
      or exists(select 1 from public.sponsors s where s.registration_contact_id=v_request.registration_contact_id)
    then raise exception 'Exclusao interrompida: um vinculo historico foi criado durante a operacao.'; end if;
    delete from public.participant_account_invites where registration_contact_id=v_request.registration_contact_id or participant_id=any(v_ids)
      or auth_user_id=v_request.auth_user_id or claimed_user_id=v_request.auth_user_id;
    delete from public.participant_data_issues where participant_id=any(v_ids);
    delete from public.participants where id=any(v_ids);
    delete from public.registration_contacts where id=v_request.registration_contact_id;
  end if;
  update public.registration_contact_deletion_requests set status='completed',completed_at=coalesce(completed_at,now()),last_error=null,updated_at=now() where id=p_request_id;
  insert into public.audit_logs(action,entity_type,entity_id,details)
  values ('registration_contact_account_deleted','registration_contact_deletion_requests',p_request_id,
    jsonb_build_object('actor_user_id',v_actor,'organization_id',v_request.organization_id,
      'registration_contact_id',v_request.registration_contact_id,'auth_user_id',v_request.auth_user_id,'reason',v_request.reason));
  return jsonb_build_object('success',true,'already_completed',false);
end; $$;

revoke all on function public.prepare_owner_registration_contact_deletion(uuid,text,text) from public,anon;
revoke all on function public.mark_owner_registration_contact_auth_deleted(uuid) from public,anon;
revoke all on function public.finalize_owner_registration_contact_deletion(uuid) from public,anon;
grant execute on function public.prepare_owner_registration_contact_deletion(uuid,text,text) to authenticated,service_role;
grant execute on function public.mark_owner_registration_contact_auth_deleted(uuid) to authenticated,service_role;
grant execute on function public.finalize_owner_registration_contact_deletion(uuid) to authenticated,service_role;

commit;
