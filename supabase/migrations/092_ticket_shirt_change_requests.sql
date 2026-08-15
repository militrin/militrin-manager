-- 092_ticket_shirt_change_requests.sql
-- Regras e solicitacoes genericas de alteracao de variantes por ticket/item.

begin;

alter table public.events add column if not exists allow_participant_item_changes boolean not null default false;
alter table public.event_kit_items
  add column if not exists allow_participant_change boolean not null default false,
  add column if not exists track_variant_inventory boolean not null default false;

create table if not exists public.event_kit_item_variant_inventory(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  kit_item_id uuid not null references public.event_kit_items(id) on delete cascade,
  variant_id uuid not null references public.event_kit_item_variants(id) on delete cascade,
  total_quantity integer not null default 0 check(total_quantity>=0),
  reserved_quantity integer not null default 0 check(reserved_quantity>=0),
  delivered_quantity integer not null default 0 check(delivered_quantity>=0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(kit_item_id,variant_id),
  check(reserved_quantity+delivered_quantity<=total_quantity)
);

create table if not exists public.ticket_item_change_requests(
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  kit_item_id uuid not null references public.event_kit_items(id) on delete cascade,
  participant_kit_item_id uuid references public.participant_kit_items(id) on delete set null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  current_variant_id uuid references public.event_kit_item_variants(id) on delete set null,
  requested_variant_id uuid not null references public.event_kit_item_variants(id) on delete restrict,
  current_variant jsonb,requested_variant jsonb not null,
  status text not null default 'pending' check(status in('pending','approved','rejected')),
  requested_by uuid not null references auth.users(id) on delete restrict,
  reviewed_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),reviewed_at timestamptz,
  reason text,review_notes text,updated_at timestamptz not null default now()
);
create unique index if not exists ux_ticket_item_change_requests_pending
  on public.ticket_item_change_requests(ticket_id,kit_item_id) where status='pending';
create index if not exists idx_ticket_item_change_requests_event_status
  on public.ticket_item_change_requests(event_id,status,requested_at desc);

alter table public.event_kit_item_variant_inventory enable row level security;
alter table public.ticket_item_change_requests enable row level security;
create policy ticket_item_change_requests_select on public.ticket_item_change_requests for select to authenticated
  using(requested_by=auth.uid() or public.user_can_access_organization(auth.uid(),organization_id));
create policy event_kit_item_variant_inventory_select on public.event_kit_item_variant_inventory for select to authenticated
  using(public.user_can_access_organization(auth.uid(),organization_id));
grant select on public.ticket_item_change_requests,public.event_kit_item_variant_inventory to authenticated;
revoke insert,update,delete on public.ticket_item_change_requests,public.event_kit_item_variant_inventory from anon,authenticated;

create or replace function public.request_ticket_item_change(p_ticket_id uuid,p_kit_item_id uuid,p_requested_variant_id uuid,p_reason text default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_event public.events%rowtype;
  v_item public.event_kit_items%rowtype; v_link public.participant_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_current uuid; v_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled';
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if not exists(select 1 from public.orders o where o.id=v_ticket.order_id and o.user_id=v_actor)
    and not exists(select 1 from public.participants p where p.id=coalesce((select participant_id from public.order_items where id=v_ticket.order_item_id),v_ticket.participant_id) and p.user_id=v_actor)
  then raise exception 'Usuario sem acesso ao ingresso.'; end if;
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

create or replace function public.review_ticket_item_change_request(p_request_id uuid,p_decision text,p_notes text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_req public.ticket_item_change_requests%rowtype; v_item public.event_kit_items%rowtype;
  v_link public.participant_kit_items%rowtype; v_variant public.event_kit_item_variants%rowtype; v_event public.events%rowtype;
  v_old_inv public.event_kit_item_variant_inventory%rowtype; v_new_inv public.event_kit_item_variant_inventory%rowtype;
  v_decision text:=lower(trim(p_decision)); v_qty integer; v_delivered boolean; v_shirt_type text;
begin
  if v_actor is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para revisar solicitacao.'; end if;
  if v_decision not in('approved','rejected') then raise exception 'Decisao invalida.'; end if;
  select * into v_req from public.ticket_item_change_requests where id=p_request_id for update;
  if not found or v_req.status<>'pending' then raise exception 'Solicitacao inexistente ou ja revisada.'; end if;
  if not public.user_can_access_organization(v_actor,v_req.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_decision='approved' then
    select * into v_event from public.events where id=v_req.event_id;
    select * into v_item from public.event_kit_items where id=v_req.kit_item_id and event_id=v_req.event_id and is_active for update;
    if not found or not v_event.allow_participant_item_changes or not v_item.allow_participant_change or not v_item.requires_variant then raise exception 'Alteracao nao esta mais habilitada para o item.'; end if;
    select * into v_variant from public.event_kit_item_variants where id=v_req.requested_variant_id and kit_item_id=v_req.kit_item_id and is_active;
    if not found then raise exception 'Variante solicitada nao esta mais disponivel.'; end if;
    select * into v_link from public.participant_kit_items where id=v_req.participant_kit_item_id and ticket_id=v_req.ticket_id and kit_item_id=v_req.kit_item_id for update;
    if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
    v_qty:=greatest(v_link.quantity,1); v_delivered:=v_link.status='delivered';
    if v_item.item_type='shirt' then
      select shirt_type into v_shirt_type from public.order_items where id=(select order_item_id from public.tickets where id=v_req.ticket_id);
      perform public.change_ticket_shirt(v_req.ticket_id,v_shirt_type,v_variant.value);
      update public.participant_kit_items set variant_data=coalesce(variant_data,'{}'::jsonb)||jsonb_build_object('variant_id',v_variant.id,'variant_name',v_variant.name,'variant_value',v_variant.value) where id=v_link.id;
    else
      if v_item.track_variant_inventory then
        select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_req.kit_item_id and variant_id=v_req.current_variant_id for update;
        select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_req.kit_item_id and variant_id=v_req.requested_variant_id for update;
        if v_new_inv.id is null then raise exception 'Estoque nao configurado para a variante.'; end if;
        if v_new_inv.total_quantity-v_new_inv.reserved_quantity-v_new_inv.delivered_quantity<v_qty then raise exception 'Variante sem saldo disponivel.'; end if;
        if v_old_inv.id is not null then
          if v_delivered then update public.event_kit_item_variant_inventory set delivered_quantity=greatest(delivered_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id;
          else update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
        end if;
        if v_delivered then update public.event_kit_item_variant_inventory set delivered_quantity=delivered_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
        else update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id; end if;
      end if;
      update public.participant_kit_items set variant_data=jsonb_build_object('variant_id',v_variant.id,'variant_name',v_variant.name,'variant_value',v_variant.value) where id=v_link.id;
    end if;
  end if;
  update public.ticket_item_change_requests set status=v_decision,reviewed_by=v_actor,reviewed_at=now(),review_notes=nullif(trim(coalesce(p_notes,'')),''),updated_at=now() where id=p_request_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_item_change_'||v_decision,'tickets',v_req.ticket_id,v_req.event_id,
    jsonb_build_object('request_id',v_req.id,'kit_item_id',v_req.kit_item_id,'current_variant_id',v_req.current_variant_id,'requested_variant_id',v_req.requested_variant_id,'actor_user_id',v_actor));
  return true;
end; $$;

create or replace function public.set_event_participant_item_changes(p_event_id uuid,p_enabled boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$ declare v_org uuid; begin
  if auth.uid() is null or not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao para configurar o evento.'; end if;
  select organization_id into v_org from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Evento invalido ou sem acesso.'; end if;
  update public.events set allow_participant_item_changes=coalesce(p_enabled,false),updated_at=now() where id=p_event_id; return true;
end; $$;
create or replace function public.set_event_kit_item_change_rules(p_kit_item_id uuid,p_allow_change boolean,p_track_inventory boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$ declare v_event uuid; v_org uuid; begin
  if auth.uid() is null or not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao para configurar o item.'; end if;
  select eki.event_id,e.organization_id into v_event,v_org from public.event_kit_items eki join public.events e on e.id=eki.event_id where eki.id=p_kit_item_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Item invalido ou sem acesso.'; end if;
  update public.event_kit_items set allow_participant_change=coalesce(p_allow_change,false),track_variant_inventory=coalesce(p_track_inventory,false),updated_at=now() where id=p_kit_item_id; return true;
end; $$;
create or replace function public.set_event_kit_item_variant_stock(p_variant_id uuid,p_total_quantity integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$ declare v_item uuid; v_event uuid; v_org uuid; begin
  if auth.uid() is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para configurar estoque.'; end if;
  select v.kit_item_id,eki.event_id,e.organization_id into v_item,v_event,v_org from public.event_kit_item_variants v join public.event_kit_items eki on eki.id=v.kit_item_id join public.events e on e.id=eki.event_id where v.id=p_variant_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Variante invalida ou sem acesso.'; end if;
  if coalesce(p_total_quantity,-1)<0 then raise exception 'Quantidade invalida.'; end if;
  insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
  values(v_org,v_event,v_item,p_variant_id,p_total_quantity)
  on conflict(kit_item_id,variant_id) do update set total_quantity=excluded.total_quantity,updated_at=now()
  where event_kit_item_variant_inventory.reserved_quantity+event_kit_item_variant_inventory.delivered_quantity<=excluded.total_quantity;
  if not found then raise exception 'Total nao pode ser menor que o estoque reservado/entregue.'; end if; return true;
end; $$;
create or replace function public.admin_change_ticket_shirt(p_ticket_id uuid,p_new_shirt_type text,p_new_shirt_size text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$ begin
  if auth.uid() is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para trocar camiseta.'; end if;
  return public.change_ticket_shirt(p_ticket_id,p_new_shirt_type,p_new_shirt_size); end; $$;

revoke all on function public.change_ticket_shirt(uuid,text,text) from public,anon,authenticated;
revoke all on function public.change_participant_shirt(uuid,text,text) from public,anon,authenticated;
revoke all on function public.request_ticket_item_change(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.review_ticket_item_change_request(uuid,text,text) from public,anon,authenticated;
revoke all on function public.set_event_participant_item_changes(uuid,boolean) from public,anon,authenticated;
revoke all on function public.set_event_kit_item_change_rules(uuid,boolean,boolean) from public,anon,authenticated;
revoke all on function public.set_event_kit_item_variant_stock(uuid,integer) from public,anon,authenticated;
revoke all on function public.admin_change_ticket_shirt(uuid,text,text) from public,anon,authenticated;
grant execute on function public.request_ticket_item_change(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.review_ticket_item_change_request(uuid,text,text) to authenticated;
grant execute on function public.set_event_participant_item_changes(uuid,boolean) to authenticated;
grant execute on function public.set_event_kit_item_change_rules(uuid,boolean,boolean) to authenticated;
grant execute on function public.set_event_kit_item_variant_stock(uuid,integer) to authenticated;
grant execute on function public.admin_change_ticket_shirt(uuid,text,text) to authenticated;

commit;
