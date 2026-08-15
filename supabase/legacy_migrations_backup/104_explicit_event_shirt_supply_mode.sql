-- 104_explicit_event_shirt_supply_mode.sql
-- Politica explicita de fornecimento; nao classifica eventos por estoque.

begin;

alter table public.event_kit_items add column if not exists shirt_supply_mode text;
alter table public.event_kit_items drop constraint if exists event_kit_items_shirt_supply_mode_check;
alter table public.event_kit_items add constraint event_kit_items_shirt_supply_mode_check check(
  shirt_supply_mode is null or shirt_supply_mode in('stock','made_to_order','disabled')
);

-- Plano autorizado e identificado exclusivamente pelos UUIDs revisados.
do $plan$
declare
  v_event_id constant uuid:='6c931940-03ad-48c2-836c-754924a00d00';
  v_kit_item_id constant uuid:='2b6aa3a1-3453-4486-9c6c-658e883fc209';
  v_variant record; v_existing_count integer;
begin
  if not exists(
    select 1 from public.events e join public.organizations o on o.id=e.organization_id
    join public.event_kit_items eki on eki.event_id=e.id
    where e.id=v_event_id and e.name='Militrin 2026'
      and eki.id=v_kit_item_id and eki.item_type='shirt' and eki.is_active
  ) then raise exception 'Alvo explicito Militrin 2026/camiseta nao corresponde ao banco ativo.'; end if;

  if exists(
    select 1 from public.event_kit_items eki
    where eki.item_type='shirt' and eki.is_active and eki.shirt_supply_mode is null
      and (eki.event_id,eki.id)<>(v_event_id,v_kit_item_id)
  ) then raise exception 'Existe camiseta ativa sem cobertura pelo plano explicito 104.'; end if;

  update public.event_kit_items set shirt_supply_mode='made_to_order',allow_participant_change=false,updated_at=now()
  where id=v_kit_item_id and event_id=v_event_id;

  for v_variant in
    select * from (values
      ('Camiseta','PP',10),('Camiseta','P',20),('Camiseta','M',30),('Camiseta','G',40),
      ('Camiseta','GG',50),('Camiseta','EG',60),('Camiseta','EXG',70),('Camiseta','EXGG',80),
      ('Babylook','PP',110),('Babylook','P',120),('Babylook','M',130),('Babylook','G',140),
      ('Babylook','GG',150),('Babylook','EG',160),('Babylook','EXG',170)
    ) as planned(shirt_type,shirt_size,sort_order)
  loop
    select count(*) into v_existing_count from public.event_kit_item_variants
    where kit_item_id=v_kit_item_id and name=v_variant.shirt_type and value=v_variant.shirt_size;
    if v_existing_count>1 then raise exception 'Variante duplicada no alvo: % / %.',v_variant.shirt_type,v_variant.shirt_size; end if;
    if v_existing_count=1 then
      update public.event_kit_item_variants set is_active=true,sort_order=v_variant.sort_order
      where kit_item_id=v_kit_item_id and name=v_variant.shirt_type and value=v_variant.shirt_size;
    else
      insert into public.event_kit_item_variants(kit_item_id,name,value,sort_order,is_active)
      values(v_kit_item_id,v_variant.shirt_type,v_variant.shirt_size,v_variant.sort_order,true);
    end if;
  end loop;

  update public.event_kit_item_variants set is_active=false
  where kit_item_id=v_kit_item_id and is_active
    and (name,value) not in(
      ('Camiseta','PP'),('Camiseta','P'),('Camiseta','M'),('Camiseta','G'),('Camiseta','GG'),('Camiseta','EG'),('Camiseta','EXG'),('Camiseta','EXGG'),
      ('Babylook','PP'),('Babylook','P'),('Babylook','M'),('Babylook','G'),('Babylook','GG'),('Babylook','EG'),('Babylook','EXG')
    );

  if (select count(*) from public.event_kit_item_variants where kit_item_id=v_kit_item_id and is_active)<>15 then
    raise exception 'O plano deve resultar em exatamente 15 variantes ativas.';
  end if;
end;
$plan$;

create or replace function public.enforce_explicit_shirt_supply_mode()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.item_type='shirt' and new.is_active and new.shirt_supply_mode is null then
    raise exception 'Camiseta ativa exige modo stock, made_to_order ou disabled.';
  end if;
  if new.item_type='shirt' then new.allow_participant_change:=false; end if;
  return new;
end; $$;
drop trigger if exists trg_enforce_explicit_shirt_supply_mode on public.event_kit_items;
create trigger trg_enforce_explicit_shirt_supply_mode before insert or update on public.event_kit_items
for each row execute function public.enforce_explicit_shirt_supply_mode();

-- Falha fechada depois da aplicacao do plano explicito.
do $$ begin
  if exists(select 1 from public.event_kit_items where item_type='shirt' and is_active and shirt_supply_mode is null) then
    raise exception 'Existem camisetas ativas sem classificacao explicita; execute e revise o preflight 104.';
  end if;
end $$;

create or replace function public.get_ticket_kit_items(p_ticket_id uuid)
returns table(id uuid,kit_item_id uuid,item_name text,item_type text,quantity integer,status text,variant_data jsonb,delivered_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket public.tickets%rowtype; v_holder_user uuid;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where tickets.id=p_ticket_id;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select p.user_id into v_holder_user from public.participants p where p.id=v_ticket.participant_id;
  if not public.user_can_access_organization(auth.uid(),v_ticket.organization_id)
    and auth.uid() is distinct from v_holder_user
    and not exists(select 1 from public.orders o where o.id=v_ticket.order_id and o.user_id=auth.uid())
  then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  return query select pki.id,eki.id,eki.name,eki.item_type,coalesce(pki.quantity,eki.quantity_per_participant),
    coalesce(pki.status,'not_linked'),pki.variant_data,pki.delivered_at
  from public.event_kit_items eki left join public.participant_kit_items pki
    on pki.ticket_id=p_ticket_id and pki.kit_item_id=eki.id
  where eki.event_id=v_ticket.event_id and eki.is_active
    and not(eki.item_type='shirt' and eki.shirt_supply_mode='disabled')
  order by eki.sort_order,eki.created_at;
end; $$;

create or replace function public.get_admin_ticket_shirt_options(p_ticket_id uuid)
returns table(kit_item_id uuid,variant_id uuid,shirt_type text,shirt_size text,supply_mode text,available_quantity integer,option_label text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket public.tickets%rowtype;
begin
  if auth.uid() is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para configurar camiseta.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  return query select eki.id,v.id,v.name,v.value,eki.shirt_supply_mode,
    case when eki.shirt_supply_mode='stock' then coalesce(inv.total_quantity-inv.reserved_quantity-inv.delivered_quantity,0) end,
    case when eki.shirt_supply_mode='made_to_order' then v.name||' / '||v.value||' - Sob encomenda' else v.name||' / '||v.value end
  from public.event_kit_items eki join public.event_kit_item_variants v on v.kit_item_id=eki.id and v.is_active
  left join public.event_kit_item_variant_inventory inv on inv.kit_item_id=eki.id and inv.variant_id=v.id
  where eki.event_id=v_ticket.event_id and eki.item_type='shirt' and eki.is_active
    and eki.shirt_supply_mode in('stock','made_to_order')
    and (eki.shirt_supply_mode='made_to_order' or coalesce(inv.total_quantity-inv.reserved_quantity-inv.delivered_quantity,0)>0)
  order by v.sort_order,v.name,v.value;
end; $$;

create or replace function public.admin_change_ticket_shirt(p_ticket_id uuid,p_new_shirt_type text,p_new_shirt_size text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_link public.participant_kit_items%rowtype; v_old_inv public.event_kit_item_variant_inventory%rowtype;
  v_new_inv public.event_kit_item_variant_inventory%rowtype; v_qty integer; v_old_variant uuid;
begin
  if v_actor is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para trocar camiseta.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into strict v_oi from public.order_items where id=v_ticket.order_item_id for update;
  select * into strict v_item from public.event_kit_items where event_id=v_ticket.event_id and item_type='shirt' and is_active;
  if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Fornecimento de camiseta indisponivel.'; end if;
  select * into strict v_variant from public.event_kit_item_variants
    where kit_item_id=v_item.id and is_active and name=trim(p_new_shirt_type) and value=trim(p_new_shirt_size);
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id for update;
  if found and v_link.status='delivered' then raise exception 'Camiseta ja entregue; use operacao explicita de troca ou estorno.'; end if;
  v_qty:=greatest(coalesce(v_link.quantity,v_item.quantity_per_participant),1);
  v_old_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  if v_item.shirt_supply_mode='stock' then
    select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;
    if not found or v_new_inv.total_quantity-v_new_inv.reserved_quantity-v_new_inv.delivered_quantity<v_qty then raise exception 'Variante sem saldo disponivel.'; end if;
    if v_old_variant is distinct from v_variant.id then
      select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
      if found then update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
    end if;
  end if;
  update public.order_items set shirt_type=v_variant.name,shirt_size=v_variant.value,updated_at=now() where id=v_oi.id;
  insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
  values(v_ticket.id,v_oi.id,coalesce(v_oi.participant_id,v_ticket.participant_id),v_ticket.event_id,v_ticket.organization_id,v_item.id,
    jsonb_build_object('variant_id',v_variant.id,'shirt_type',v_variant.name,'shirt_size',v_variant.value,'supply_mode',v_item.shirt_supply_mode),v_qty,'confirmed')
  on conflict(ticket_id,kit_item_id) where ticket_id is not null do update set variant_data=excluded.variant_data,quantity=excluded.quantity;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_shirt_admin_changed','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',v_actor,'kit_item_id',v_item.id,'variant_id',v_variant.id,'supply_mode',v_item.shirt_supply_mode));
  return true;
end; $$;

-- A API legada deixa de permitir o caminho de titular e usa a politica administrativa canonica.
create or replace function public.change_ticket_shirt(p_ticket_id uuid,p_new_shirt_type text,p_new_shirt_size text)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  select public.admin_change_ticket_shirt(p_ticket_id,p_new_shirt_type,p_new_shirt_size);
$$;

create or replace function public.deliver_ticket_kit_item(p_ticket_id uuid,p_kit_item_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_link public.participant_kit_items%rowtype; v_ticket public.tickets%rowtype; v_item public.event_kit_items%rowtype;
  v_variant_id uuid; v_inv public.event_kit_item_variant_inventory%rowtype;
begin
  if auth.uid() is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update;
  if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
  if v_link.status='delivered' then return true; end if;
  if not exists(select 1 from public.payments where order_id=v_ticket.order_id and payment_status='paid') then raise exception 'Pagamento pendente. Entrega bloqueada.'; end if;
  select * into strict v_item from public.event_kit_items where id=p_kit_item_id and event_id=v_ticket.event_id and is_active;
  if v_item.item_type='shirt' then
    if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Camiseta indisponivel para entrega.'; end if;
    v_variant_id:=nullif(v_link.variant_data->>'variant_id','')::uuid;
    if v_variant_id is null then raise exception 'Camiseta nao vinculada.'; end if;
    if v_item.shirt_supply_mode='stock' then
      select * into v_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant_id for update;
      if not found or v_inv.reserved_quantity<v_link.quantity then raise exception 'Reserva de camiseta insuficiente para entrega.'; end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity-v_link.quantity,
        delivered_quantity=delivered_quantity+v_link.quantity,updated_at=now() where id=v_inv.id;
    end if;
  end if;
  update public.participant_kit_items set status='delivered',delivered_at=now() where id=v_link.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_kit_item_delivered','participant_kit_items',v_link.id,v_link.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'kit_item_id',p_kit_item_id,'supply_mode',v_item.shirt_supply_mode));
  return true;
end; $$;

revoke all on function public.get_ticket_kit_items(uuid),public.get_admin_ticket_shirt_options(uuid),public.admin_change_ticket_shirt(uuid,text,text),public.change_ticket_shirt(uuid,text,text),public.deliver_ticket_kit_item(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_ticket_kit_items(uuid),public.get_admin_ticket_shirt_options(uuid),public.admin_change_ticket_shirt(uuid,text,text) to authenticated;
grant execute on function public.deliver_ticket_kit_item(uuid,uuid) to authenticated;

commit;
