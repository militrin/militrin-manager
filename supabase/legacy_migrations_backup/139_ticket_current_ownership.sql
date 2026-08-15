-- 139_ticket_current_ownership.sql
-- Separa comprador historico, proprietario atual da conta e titular operacional.
-- Aplicar somente depois de 138_ticket_holder_reason_taxonomy.sql.

begin;

alter table public.tickets
  add column if not exists owner_user_id uuid references auth.users(id) on delete restrict;

create index if not exists idx_tickets_owner_user_id
  on public.tickets(owner_user_id) where owner_user_id is not null;
create index if not exists idx_tickets_org_owner_user_id
  on public.tickets(organization_id,owner_user_id) where owner_user_id is not null;

-- Nenhum caso inconsistente pode ser silenciosamente classificado pelo backfill.
do $$
declare v_invalid integer;
begin
  select count(*) into v_invalid
  from public.tickets t
  left join public.orders o on o.id=t.order_id
  left join auth.users au on au.id=o.user_id
  where o.id is null
     or t.organization_id is distinct from o.organization_id
     or (o.buyer_type='account' and (o.user_id is null or au.id is null))
     or (o.buyer_type not in('account','imported_holder'))
     or (o.buyer_type='imported_holder' and o.user_id is not null);
  if v_invalid>0 then
    raise exception 'OWNERSHIP_PREFLIGHT_FAILED: % ingresso(s) possuem pedido/comprador/organizacao inconsistente. Execute o preflight 139.',v_invalid;
  end if;
end; $$;

-- Fonte exclusiva: comprador de pedido account comprovado. Titular nunca participa.
update public.tickets t
set owner_user_id=o.user_id
from public.orders o
join auth.users au on au.id=o.user_id
where o.id=t.order_id
  and o.buyer_type='account'
  and t.organization_id=o.organization_id
  and t.owner_user_id is null;

create or replace function public.trg_initialize_ticket_owner()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders%rowtype;
begin
  if new.owner_user_id is not null then return new; end if;
  select * into v_order from public.orders where id=new.order_id;
  if not found then raise exception 'Pedido do ingresso nao encontrado.'; end if;
  if new.organization_id is distinct from v_order.organization_id then
    raise exception 'Organizacao do ingresso diverge do pedido.';
  end if;
  if v_order.buyer_type='account' then
    if v_order.user_id is null or not exists(select 1 from auth.users where id=v_order.user_id) then
      raise exception 'Pedido de conta sem comprador autenticado valido.';
    end if;
    new.owner_user_id:=v_order.user_id;
  elsif v_order.buyer_type='imported_holder' then
    new.owner_user_id:=null;
  else
    raise exception 'Origem do pedido nao permite inicializar proprietario.';
  end if;
  return new;
end; $$;

drop trigger if exists initialize_ticket_owner on public.tickets;
create trigger initialize_ticket_owner
before insert on public.tickets
for each row execute function public.trg_initialize_ticket_owner();

create table if not exists public.ticket_owner_history(
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  event_id uuid not null references public.events(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  operation text not null check(operation in('owner_assigned','owner_transferred')),
  previous_owner_user_id uuid references auth.users(id) on delete restrict,
  new_owner_user_id uuid not null references auth.users(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  reason_code text not null check(reason_code in(
    'registration_correction','buyer_request','holder_request','third_party_ticket','administrative_adjustment',
    'issuance_error','system_error','data_regularization','other','legacy_unclassified')),
  reason_text text,
  created_at timestamptz not null default now(),
  constraint ticket_owner_history_other_reason_check check(reason_code<>'other' or nullif(trim(reason_text),'') is not null)
);
create index if not exists idx_ticket_owner_history_ticket_created
  on public.ticket_owner_history(ticket_id,created_at desc);
create index if not exists idx_ticket_owner_history_org_created
  on public.ticket_owner_history(organization_id,created_at desc);

alter table public.ticket_owner_history enable row level security;
drop policy if exists ticket_owner_history_admin_select on public.ticket_owner_history;
create policy ticket_owner_history_admin_select on public.ticket_owner_history for select to authenticated
using(public.user_can_access_organization(auth.uid(),organization_id)
  and (public.current_user_has_permission('participants.view') or public.current_user_has_permission('orders.view')));
revoke insert,update,delete on public.ticket_owner_history from public,anon,authenticated;
grant select on public.ticket_owner_history to authenticated;

insert into public.admin_permissions(code,name,description,module,sort_order,is_active)
values('tickets.transfer_ownership','Transferir propriedade de ingresso','Transfere administrativamente a conta proprietaria atual do ingresso','tickets',10,true)
on conflict(code) do update set name=excluded.name,description=excluded.description,module=excluded.module,is_active=true;

-- Owner/administrator recebem todas as permissoes ativas pelo bootstrap; garante o novo codigo
-- tambem em bases onde o bootstrap ja foi executado.
insert into public.admin_role_permissions(role_id,permission_id)
select r.id,p.id from public.admin_roles r cross join public.admin_permissions p
where r.code in('owner','administrator') and p.code='tickets.transfer_ownership'
on conflict do nothing;

drop policy if exists "tickets_owner_select" on public.tickets;
drop policy if exists tickets_holder_select on public.tickets;
drop policy if exists tickets_current_owner_select on public.tickets;
create policy tickets_current_owner_select on public.tickets for select to authenticated
using(owner_user_id=auth.uid());

-- O proprietario precisa ler o item/kit do ingresso, mas nao recebe acesso ao pedido ou financeiro.
drop policy if exists order_items_ticket_owner_select on public.order_items;
create policy order_items_ticket_owner_select on public.order_items for select to authenticated
using(exists(select 1 from public.tickets t where t.order_item_id=order_items.id and t.owner_user_id=auth.uid()));

drop policy if exists participant_kit_items_ticket_owner_select on public.participant_kit_items;
create policy participant_kit_items_ticket_owner_select on public.participant_kit_items for select to authenticated
using(exists(select 1 from public.tickets t where t.id=participant_kit_items.ticket_id and t.owner_user_id=auth.uid()));

create or replace function public.get_ticket_kit_items(p_ticket_id uuid)
returns table(id uuid,kit_item_id uuid,item_name text,item_type text,quantity integer,status text,variant_data jsonb,delivered_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket public.tickets%rowtype;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where tickets.id=p_ticket_id;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_ticket.owner_user_id is distinct from auth.uid()
    and not public.user_can_access_organization(auth.uid(),v_ticket.organization_id)
  then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  return query select pki.id,eki.id,eki.name,eki.item_type,coalesce(pki.quantity,eki.quantity_per_participant),
    coalesce(pki.status,'not_linked'),pki.variant_data,pki.delivered_at
  from public.event_kit_items eki left join public.participant_kit_items pki
    on pki.ticket_id=p_ticket_id and pki.kit_item_id=eki.id
  where eki.event_id=v_ticket.event_id and eki.is_active
    and not(eki.item_type='shirt' and eki.shirt_supply_mode='disabled')
  order by eki.sort_order,eki.created_at;
end; $$;

create or replace function public.find_user_by_public_pin(p_ticket_id uuid,p_pin text) returns table(full_name text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_pin text:=upper(regexp_replace(coalesce(p_pin,''),'[^A-Za-z0-9]','','g'));
  v_ticket public.tickets%rowtype; v_found boolean:=false;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if (select count(*) from public.user_pin_lookup_attempts where actor_user_id=v_actor and attempted_at>now()-interval '10 minutes')>=15 then raise exception 'Limite de buscas atingido. Tente novamente mais tarde.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled';
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_ticket.owner_user_id is distinct from v_actor
    and not(public.current_user_has_permission('participants.edit_basic') and public.user_can_access_organization(v_actor,v_ticket.organization_id))
  then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  if v_pin ~ '^[A-Z0-9]{10}$' then select exists(select 1 from public.customer_profiles cp where cp.public_pin=v_pin and coalesce(cp.account_status,'active')='active') into v_found; end if;
  insert into public.user_pin_lookup_attempts(actor_user_id,found) values(v_actor,v_found);
  return query select cp.full_name from public.customer_profiles cp where v_found and cp.public_pin=v_pin and coalesce(cp.account_status,'active')='active' limit 1;
end; $$;

create or replace function public.change_ticket_holder_by_pin_for_owner(p_ticket_id uuid,p_pin text,p_operation text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_event public.events%rowtype;
  v_profile public.customer_profiles%rowtype; v_contact_id uuid; v_contact_count integer; v_target_count integer; v_target public.participants%rowtype;
  v_previous public.participants%rowtype; v_operation text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled' for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_ticket.owner_user_id is distinct from v_actor then raise exception 'Somente o proprietario atual pode alterar o titular.'; end if;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  select * into strict v_event from public.events where id=v_ticket.event_id;
  if p_operation='holder_assigned' then
    if coalesce(v_item.participant_id,v_ticket.participant_id) is not null then raise exception 'Ingresso ja possui titular; use transferencia.'; end if;
    if not v_event.allow_holder_change then raise exception 'Definicao de titular desabilitada para o evento.'; end if;
    v_operation:='holder_assigned';
  elsif p_operation in('holder_changed','ticket_transferred') then
    if coalesce(v_item.participant_id,v_ticket.participant_id) is null then raise exception 'Ingresso sem titular; use definicao de titular.'; end if;
    if not v_event.allow_ticket_transfer then raise exception 'Alteracao de titular desabilitada para o evento.'; end if;
    v_operation:='holder_changed';
  else raise exception 'Operacao invalida.'; end if;
  select * into v_profile from public.customer_profiles
    where public_pin=upper(regexp_replace(coalesce(p_pin,''),'[^A-Za-z0-9]','','g')) and coalesce(account_status,'active')='active';
  if not found or not exists(select 1 from auth.users where id=v_profile.user_id) then raise exception 'PIN de conta NEXORA nao encontrado.'; end if;
  select count(distinct registration_contact_id),(array_agg(distinct registration_contact_id order by registration_contact_id))[1] into v_contact_count,v_contact_id
  from public.participants where organization_id=v_ticket.organization_id and user_id=v_profile.user_id and registration_contact_id is not null;
  if v_contact_count=0 then raise exception 'Conta sem cadastro vinculado nesta organizacao.'; end if;
  if v_contact_count>1 then raise exception 'Vinculo ambiguo entre conta e cadastro.'; end if;
  perform public.assert_ticket_holder_contact_available(v_ticket.id,v_ticket.event_id,v_contact_id);
  select count(*) into v_target_count from public.participants where event_id=v_ticket.event_id and registration_contact_id=v_contact_id;
  if v_target_count>1 then raise exception 'Cadastro possui multiplas projecoes no evento.'; end if;
  if v_target_count=1 then
    select * into strict v_target from public.participants where event_id=v_ticket.event_id and registration_contact_id=v_contact_id;
  else
    insert into public.participants(event_id,organization_id,registration_contact_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,
      shirt_type,shirt_size,registration_status,ticket_category_id,batch_id)
    select v_ticket.event_id,v_ticket.organization_id,rc.id,v_profile.user_id,rc.full_name,rc.cpf,rc.birth_date,rc.gender,rc.phone,rc.email,rc.city,
      nullif(trim(coalesce(v_item.shirt_type,'')),''),nullif(trim(coalesce(v_item.shirt_size,'')),''),'confirmed',v_item.ticket_category_id,v_item.batch_id
    from public.registration_contacts rc where rc.id=v_contact_id returning * into v_target;
  end if;
  if coalesce(v_item.participant_id,v_ticket.participant_id) is not null then select * into v_previous from public.participants where id=coalesce(v_item.participant_id,v_ticket.participant_id); end if;
  update public.order_items set participant_id=v_target.id,registration_contact_id=v_contact_id,holder_full_name=v_target.full_name,
    ownership_status=case when v_operation='holder_assigned' then 'assigned' else 'transferred' end,updated_at=now() where id=v_item.id;
  update public.tickets set participant_id=v_target.id where id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,
    previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason_code,reason_text)
  values(v_ticket.id,v_item.id,v_ticket.event_id,v_ticket.organization_id,v_operation,v_previous.id,v_target.id,
    coalesce(v_item.registration_contact_id,v_previous.registration_contact_id),v_contact_id,v_previous.user_id,v_target.user_id,v_actor,'portal','holder_request',null);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values(v_operation,'tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('previous_registration_contact_id',coalesce(v_item.registration_contact_id,v_previous.registration_contact_id),
      'new_registration_contact_id',v_contact_id,'previous_user_id',v_previous.user_id,'new_user_id',v_target.user_id,'actor_user_id',v_actor,'reason_code','holder_request'));
  return v_target.id;
end; $$;

create or replace function public.define_ticket_holder_by_pin(p_ticket_id uuid,p_pin text) returns uuid language sql security definer set search_path=public,pg_temp as $$
  select public.change_ticket_holder_by_pin_for_owner(p_ticket_id,p_pin,'holder_assigned');
$$;
create or replace function public.transfer_ticket_by_pin(p_ticket_id uuid,p_pin text) returns uuid language sql security definer set search_path=public,pg_temp as $$
  select public.change_ticket_holder_by_pin_for_owner(p_ticket_id,p_pin,'holder_changed');
$$;

create or replace function public.request_ticket_item_change(p_ticket_id uuid,p_kit_item_id uuid,p_requested_variant_id uuid,p_reason text default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_event public.events%rowtype;
  v_item public.event_kit_items%rowtype; v_link public.participant_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_current uuid; v_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled';
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_ticket.owner_user_id is distinct from v_actor then raise exception 'Somente o proprietario atual pode solicitar alteracao de item.'; end if;
  select * into v_event from public.events where id=v_ticket.event_id;
  select * into v_item from public.event_kit_items where id=p_kit_item_id and event_id=v_ticket.event_id and is_active;
  if not found then raise exception 'Item invalido para o ingresso.'; end if;
  if not v_item.requires_variant then raise exception 'Item de opcao unica nao possui variante alteravel.'; end if;
  if not v_event.allow_participant_item_changes or not v_item.allow_participant_change then raise exception 'Alteracao desabilitada para este item.'; end if;
  if v_item.item_type='shirt' and v_event.shirt_order_deadline is not null and now()>v_event.shirt_order_deadline then raise exception 'Prazo para solicitar alteracao encerrado.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id;
  if not found then raise exception 'Item ainda nao materializado para este ingresso.'; end if;
  select * into v_variant from public.event_kit_item_variants where id=p_requested_variant_id and kit_item_id=p_kit_item_id and is_active;
  if not found then raise exception 'Variante invalida para o item.'; end if;
  v_current:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  if v_current is null and v_item.item_type='shirt' then
    select id into v_current from public.event_kit_item_variants where kit_item_id=p_kit_item_id and is_active
      and value=coalesce(v_link.variant_data->>'shirt_size',(select shirt_size from public.order_items where id=v_ticket.order_item_id)) limit 1;
  end if;
  if v_current=p_requested_variant_id then raise exception 'A variante solicitada e igual a atual.'; end if;
  insert into public.ticket_item_change_requests(ticket_id,kit_item_id,participant_kit_item_id,organization_id,event_id,
    current_variant_id,requested_variant_id,current_variant,requested_variant,requested_by,reason)
  values(p_ticket_id,p_kit_item_id,v_link.id,v_ticket.organization_id,v_ticket.event_id,v_current,p_requested_variant_id,
    v_link.variant_data,jsonb_build_object('id',v_variant.id,'name',v_variant.name,'value',v_variant.value),v_actor,nullif(trim(coalesce(p_reason,'')),'')) returning id into v_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_item_change_requested','tickets',p_ticket_id,v_ticket.event_id,
    jsonb_build_object('request_id',v_id,'kit_item_id',p_kit_item_id,'current_variant_id',v_current,'requested_variant_id',p_requested_variant_id,'actor_user_id',v_actor));
  return v_id;
end; $$;

create or replace function public.search_admin_ticket_owner_accounts(p_ticket_id uuid,p_term text)
returns table(user_id uuid,full_name text,masked_email text,registration_contact_id uuid,registration_contact_count integer)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_term text:=trim(coalesce(p_term,''));
begin
  if v_actor is null or not public.current_user_has_permission('tickets.transfer_ownership') then raise exception 'Sem permissao para buscar proprietarios.'; end if;
  if length(v_term)<3 then raise exception 'Informe ao menos 3 caracteres para buscar.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  return query
  with organization_accounts as (
    select o.user_id from public.orders o where o.organization_id=v_ticket.organization_id and o.user_id is not null
    union
    select p.user_id from public.participants p where p.organization_id=v_ticket.organization_id and p.user_id is not null
  ), contacts as (
    select p.user_id,count(distinct p.registration_contact_id)::integer contact_count,
      case when count(distinct p.registration_contact_id)=1 then (array_agg(distinct p.registration_contact_id order by p.registration_contact_id))[1] end contact_id
    from public.participants p
    where p.organization_id=v_ticket.organization_id and p.user_id is not null and p.registration_contact_id is not null
    group by p.user_id
  )
  select au.id,coalesce(nullif(trim(cp.full_name),''),nullif(trim(au.raw_user_meta_data->>'full_name'),''),'Conta NEXORA'),
    case when position('@' in coalesce(au.email,''))>1 then left(au.email,2)||'***@'||split_part(au.email,'@',2) end,
    c.contact_id,coalesce(c.contact_count,0)
  from organization_accounts oa
  join auth.users au on au.id=oa.user_id
  left join public.customer_profiles cp on cp.user_id=au.id
  left join contacts c on c.user_id=au.id
  where au.id is distinct from v_ticket.owner_user_id
    and (coalesce(cp.full_name,au.raw_user_meta_data->>'full_name','') ilike '%'||v_term||'%' or coalesce(au.email,'') ilike '%'||v_term||'%')
  order by 2,au.id limit 20;
end; $$;

create or replace function public.admin_transfer_ticket_ownership(
  p_ticket_id uuid,
  p_expected_owner_user_id uuid,
  p_new_owner_user_id uuid,
  p_holder_action text,
  p_reason_code text,
  p_reason_text text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_operation text;
  v_reason_code text:=trim(coalesce(p_reason_code,'')); v_reason_text text:=nullif(trim(coalesce(p_reason_text,'')),'');
  v_contact_id uuid; v_contact_count integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('tickets.transfer_ownership') then raise exception 'Sem permissao para transferir propriedade.'; end if;
  if p_new_owner_user_id is null or not exists(select 1 from auth.users where id=p_new_owner_user_id) then raise exception 'Novo proprietario precisa possuir conta NEXORA valida.'; end if;
  if p_holder_action not in('keep','assign_new_owner','remove') then raise exception 'Tratamento do titular invalido.'; end if;
  if v_reason_code not in('registration_correction','buyer_request','holder_request','third_party_ticket','administrative_adjustment',
    'issuance_error','system_error','data_regularization','other','legacy_unclassified') then raise exception 'Motivo de alteracao invalido.'; end if;
  if v_reason_code='other' and v_reason_text is null then raise exception 'Descreva o motivo da alteracao.'; end if;

  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.owner_user_id is distinct from p_expected_owner_user_id then raise exception 'TICKET_OWNER_CHANGED_CONCURRENTLY'; end if;
  if v_ticket.owner_user_id=p_new_owner_user_id then raise exception 'A conta selecionada ja e proprietaria do ingresso.'; end if;

  if p_holder_action in('assign_new_owner','remove') and not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para alterar o titular durante a transferencia.';
  end if;
  if p_holder_action='assign_new_owner' then
    select count(distinct p.registration_contact_id),(array_agg(distinct p.registration_contact_id order by p.registration_contact_id))[1]
      into v_contact_count,v_contact_id
    from public.participants p
    where p.organization_id=v_ticket.organization_id and p.user_id=p_new_owner_user_id and p.registration_contact_id is not null;
    if v_contact_count=0 then raise exception 'A conta selecionada nao possui cadastro vinculado nesta organizacao.'; end if;
    if v_contact_count>1 then raise exception 'OWNER_CONTACT_AMBIGUOUS'; end if;
    perform public.admin_set_ticket_holder_contact(v_ticket.id,v_contact_id,v_reason_code,v_reason_text);
  elsif p_holder_action='remove' then
    perform public.admin_set_ticket_holder_contact(v_ticket.id,null,v_reason_code,v_reason_text);
  end if;

  v_operation:=case when v_ticket.owner_user_id is null then 'owner_assigned' else 'owner_transferred' end;
  update public.tickets set owner_user_id=p_new_owner_user_id where id=v_ticket.id;
  insert into public.ticket_owner_history(ticket_id,order_id,event_id,organization_id,operation,previous_owner_user_id,new_owner_user_id,actor_user_id,reason_code,reason_text)
  values(v_ticket.id,v_ticket.order_id,v_ticket.event_id,v_ticket.organization_id,v_operation,v_ticket.owner_user_id,p_new_owner_user_id,v_actor,v_reason_code,v_reason_text);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values(v_operation,'tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object(
    'ticket_id',v_ticket.id,'order_id',v_ticket.order_id,'previous_owner_user_id',v_ticket.owner_user_id,
    'new_owner_user_id',p_new_owner_user_id,'actor_user_id',v_actor,'holder_action',p_holder_action,
    'reason_code',v_reason_code,'reason_text',v_reason_text));
  return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'previous_owner_user_id',v_ticket.owner_user_id,
    'new_owner_user_id',p_new_owner_user_id,'holder_action',p_holder_action);
end; $$;

revoke all on function public.trg_initialize_ticket_owner(),public.change_ticket_holder_by_pin_for_owner(uuid,text,text),public.search_admin_ticket_owner_accounts(uuid,text),
  public.admin_transfer_ticket_ownership(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.search_admin_ticket_owner_accounts(uuid,text),
  public.admin_transfer_ticket_ownership(uuid,uuid,uuid,text,text,text) to authenticated;

commit;
