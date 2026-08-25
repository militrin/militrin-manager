-- Pessoa canonica -> conta -> participacoes -> propriedade de ingressos.
-- Corrige vinculos parciais sem recriar contato, participante, pedido ou ticket.

alter table public.sponsors
  add column if not exists registration_contact_id uuid
  references public.registration_contacts(id) on delete set null;

create index if not exists idx_sponsors_registration_contact_id
  on public.sponsors(registration_contact_id)
  where registration_contact_id is not null;

drop function if exists public.list_sponsors_for_admin(uuid);
create function public.list_sponsors_for_admin(p_organization_id uuid default null)
returns table(sponsor_id uuid,name text,banner_url text,link_url text,is_active boolean,sort_order integer,registration_contact_id uuid,user_id uuid,user_full_name text,user_email text,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_org uuid;
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.view') then raise exception 'Sem permissao para ver patrocinadores.'; end if;
  v_org:=coalesce(p_organization_id,public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor,v_org) then raise exception 'Acesso negado a organizacao.'; end if;
  return query select sponsor.id,sponsor.name,sponsor.banner_url,sponsor.link_url,sponsor.is_active,sponsor.sort_order,sponsor.registration_contact_id,sponsor.user_id,
    coalesce(nullif(trim(contact.full_name),''),nullif(trim(profile.full_name),''),nullif(trim(account_user.raw_user_meta_data->>'full_name'),'')),
    coalesce(account_user.email,contact.email)::text,sponsor.created_at,sponsor.updated_at
  from public.sponsors as sponsor
  left join public.registration_contacts as contact on contact.id=sponsor.registration_contact_id
  left join auth.users as account_user on account_user.id=sponsor.user_id
  left join public.customer_profiles as profile on profile.user_id=sponsor.user_id
  where sponsor.organization_id=v_org order by sponsor.sort_order,sponsor.name;
end $$;
revoke all on function public.list_sponsors_for_admin(uuid) from public,anon;
grant execute on function public.list_sponsors_for_admin(uuid) to authenticated;

create or replace function public.reconcile_registration_contact_account(
  p_registration_contact_id uuid,
  p_user_id uuid
)
returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_ticket_count integer:=0;
begin
  if p_registration_contact_id is null or p_user_id is null then raise exception 'Pessoa e conta sao obrigatorias.'; end if;
  if v_actor is not null and v_actor<>p_user_id and not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para reconciliar esta pessoa.';
  end if;
  if not exists(select 1 from auth.users as account_user where account_user.id=p_user_id) then raise exception 'Conta Auth inexistente.'; end if;

  select contact.* into v_contact
  from public.registration_contacts as contact
  where contact.id=p_registration_contact_id for update;
  if not found then raise exception 'Pessoa nao encontrada.'; end if;
  if v_actor is not null and v_actor<>p_user_id and not public.user_can_access_organization(v_actor,v_contact.organization_id) then
    raise exception 'Pessoa fora da organizacao atual.';
  end if;
  if v_contact.user_id is not null and v_contact.user_id<>p_user_id then raise exception 'Pessoa ja vinculada a outra conta.'; end if;
  if exists(select 1 from public.participants as conflicting where conflicting.registration_contact_id=v_contact.id and conflicting.user_id is not null and conflicting.user_id<>p_user_id) then
    raise exception 'Participacao vinculada a outra conta.';
  end if;

  update public.registration_contacts as linked_contact
  set user_id=p_user_id,updated_at=now()
  where linked_contact.id=v_contact.id and linked_contact.user_id is distinct from p_user_id;

  update public.customer_profiles as profile
  set full_name=v_contact.full_name,updated_at=now()
  where profile.user_id=p_user_id
    and nullif(trim(v_contact.full_name),'') is not null
    and (nullif(trim(profile.full_name),'') is null or lower(trim(profile.full_name))='participante');

  update public.participants as linked_participant
  set user_id=p_user_id,updated_at=now()
  where linked_participant.registration_contact_id=v_contact.id
    and linked_participant.organization_id=v_contact.organization_id
    and linked_participant.user_id is null;

  update public.sponsors as linked_sponsor
  set user_id=p_user_id,updated_at=now()
  where linked_sponsor.registration_contact_id=v_contact.id
    and linked_sponsor.user_id is null;

  with owned as (
    update public.tickets as ticket
    set owner_user_id=p_user_id
    where ticket.organization_id=v_contact.organization_id
      and ticket.owner_user_id is null
      and (
        exists(select 1 from public.participants as holder where holder.id=ticket.participant_id and holder.registration_contact_id=v_contact.id)
        or exists(select 1 from public.order_items as item where item.id=ticket.order_item_id and item.registration_contact_id=v_contact.id)
      )
    returning ticket.id,ticket.order_id,ticket.event_id,ticket.organization_id
  ), history as (
    insert into public.ticket_owner_history(ticket_id,order_id,event_id,organization_id,operation,previous_owner_user_id,new_owner_user_id,actor_user_id,reason_code,reason_text)
    select owned.id,owned.order_id,owned.event_id,owned.organization_id,'owner_assigned',null,p_user_id,coalesce(v_actor,p_user_id),'data_regularization','Propriedade materializada a partir da Pessoa canonica vinculada a conta.'
    from owned
    returning ticket_id
  ) select count(*)::integer into v_ticket_count from history;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('registration_contact_account_reconciled','registration_contacts',v_contact.id,null,
    jsonb_build_object('organization_id',v_contact.organization_id,'user_id',p_user_id,'tickets_assigned',v_ticket_count,'actor_user_id',v_actor));
  return v_ticket_count;
end $$;

create or replace function public.trg_reconcile_contact_account()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if pg_trigger_depth()>1 or new.user_id is null then return new; end if;
  if tg_op='UPDATE' and new.user_id is not distinct from old.user_id then return new; end if;
  perform public.reconcile_registration_contact_account(new.id,new.user_id);
  return new;
end $$;

drop trigger if exists trg_reconcile_contact_account on public.registration_contacts;
create trigger trg_reconcile_contact_account after update of user_id on public.registration_contacts
for each row execute function public.trg_reconcile_contact_account();
drop trigger if exists trg_reconcile_contact_account_insert on public.registration_contacts;
create trigger trg_reconcile_contact_account_insert after insert on public.registration_contacts
for each row when (new.user_id is not null) execute function public.trg_reconcile_contact_account();

create or replace function public.trg_reconcile_participant_account()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if pg_trigger_depth()>1 or new.user_id is null or new.user_id is not distinct from old.user_id or new.registration_contact_id is null then return new; end if;
  perform public.reconcile_registration_contact_account(new.registration_contact_id,new.user_id);
  return new;
end $$;

drop trigger if exists trg_reconcile_participant_account on public.participants;
create trigger trg_reconcile_participant_account after update of user_id on public.participants
for each row execute function public.trg_reconcile_participant_account();

create or replace function public.admin_search_sponsor_candidate_contacts(p_term text,p_organization_id uuid default null)
returns table(registration_contact_id uuid,participant_id uuid,user_id uuid,full_name text,masked_email text,masked_cpf text,has_account boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_org uuid; v_term text:=trim(coalesce(p_term,'')); v_digits text:=regexp_replace(trim(coalesce(p_term,'')),'\D','','g');
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then raise exception 'Sem permissao para gerenciar patrocinadores.'; end if;
  v_org:=coalesce(p_organization_id,public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor,v_org) then raise exception 'Acesso negado a organizacao.'; end if;
  if length(v_term)<3 then raise exception 'Informe ao menos 3 caracteres para buscar.'; end if;
  return query
  select contact.id,
    (select participant.id from public.participants as participant where participant.registration_contact_id=contact.id order by participant.created_at desc,participant.id limit 1),
    contact.user_id,contact.full_name,
    case when position('@' in coalesce(contact.email,''))>1 then left(contact.email,2)||'***@'||split_part(contact.email,'@',2) end,
    case when length(regexp_replace(coalesce(contact.cpf,''),'\D','','g'))=11 then left(regexp_replace(contact.cpf,'\D','','g'),3)||'.***.***-'||right(regexp_replace(contact.cpf,'\D','','g'),2) end,
    contact.user_id is not null
  from public.registration_contacts as contact
  where contact.organization_id=v_org
    and not exists(select 1 from public.sponsors as existing_sponsor where existing_sponsor.registration_contact_id=contact.id)
    and (contact.full_name ilike '%'||v_term||'%' or coalesce(contact.email,'') ilike '%'||v_term||'%' or (v_digits<>'' and regexp_replace(coalesce(contact.cpf,''),'\D','','g') like '%'||v_digits||'%'))
  order by contact.full_name,contact.id limit 20;
end $$;

create or replace function public.admin_set_sponsor_contact(p_sponsor_id uuid,p_registration_contact_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_sponsor public.sponsors%rowtype; v_contact public.registration_contacts%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then raise exception 'Sem permissao para gerenciar patrocinadores.'; end if;
  select sponsor.* into v_sponsor from public.sponsors as sponsor where sponsor.id=p_sponsor_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_sponsor.organization_id) then raise exception 'Patrocinador nao encontrado.'; end if;
  if p_registration_contact_id is not null then
    select contact.* into v_contact from public.registration_contacts as contact where contact.id=p_registration_contact_id and contact.organization_id=v_sponsor.organization_id;
    if not found then raise exception 'Pessoa nao encontrada nesta organizacao.'; end if;
    if exists(select 1 from public.sponsors as other where other.id<>v_sponsor.id and other.registration_contact_id=v_contact.id) then raise exception 'Pessoa ja vinculada a outro patrocinador.'; end if;
  end if;
  update public.sponsors as target set registration_contact_id=p_registration_contact_id,user_id=case when p_registration_contact_id is null then null else v_contact.user_id end,updated_at=now() where target.id=v_sponsor.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('sponsor_contact_linked','sponsors',v_sponsor.id,null,
    jsonb_build_object('actor_user_id',v_actor,'organization_id',v_sponsor.organization_id,'previous_registration_contact_id',v_sponsor.registration_contact_id,'new_registration_contact_id',p_registration_contact_id,'new_user_id',case when p_registration_contact_id is null then null else v_contact.user_id end));
end $$;

revoke all on function public.reconcile_registration_contact_account(uuid,uuid) from public,anon;
grant execute on function public.reconcile_registration_contact_account(uuid,uuid) to authenticated,service_role;
revoke all on function public.admin_search_sponsor_candidate_contacts(text,uuid),public.admin_set_sponsor_contact(uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_search_sponsor_candidate_contacts(text,uuid),public.admin_set_sponsor_contact(uuid,uuid) to authenticated;

-- Backfill idempotente de vinculos parciais ja existentes.
select public.reconcile_registration_contact_account(contact.id,contact.user_id)
from public.registration_contacts as contact
where contact.user_id is not null;
