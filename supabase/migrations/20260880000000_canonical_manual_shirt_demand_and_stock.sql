-- Fecha a divergencia entre selecao de camiseta, demanda agregada e estoque
-- fisico usado pela entrega ticket-first.
begin;

alter table public.participant_kit_items
  add column if not exists inventory_reservation_accounted boolean not null default false;

-- O estoque continua sendo editado pela tela historica em shirt_inventory.
-- Espelha somente o estoque fisico total para o saldo ticket-first; reservas
-- sao derivadas dos vinculos de ingresso e entregas continuam sendo gravadas
-- pelo fluxo operacional canonico.
create or replace function public.sync_shirt_physical_total_to_kit_inventory()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_match record;
begin
  select eki.id as kit_item_id, v.id as variant_id, e.organization_id
    into v_match
  from public.event_kit_items eki
  join public.events e on e.id=eki.event_id
  join public.event_kit_item_variants v on v.kit_item_id=eki.id
    and lower(trim(v.name))=lower(trim(new.shirt_type))
    and upper(trim(v.value))=upper(trim(new.shirt_size))
  where eki.event_id=new.event_id and eki.item_type='shirt' and eki.is_active
  order by v.is_active desc,v.id limit 1;

  if v_match.kit_item_id is not null then
    insert into public.event_kit_item_variant_inventory(
      organization_id,event_id,kit_item_id,variant_id,total_quantity,reserved_quantity,delivered_quantity
    ) values(v_match.organization_id,new.event_id,v_match.kit_item_id,v_match.variant_id,greatest(new.total_quantity,0),0,0)
    on conflict(kit_item_id,variant_id) do update
      set total_quantity=greatest(excluded.total_quantity,event_kit_item_variant_inventory.delivered_quantity),updated_at=now();
  end if;
  return new;
end; $$;

drop trigger if exists trg_sync_shirt_physical_total_to_kit_inventory on public.shirt_inventory;
create trigger trg_sync_shirt_physical_total_to_kit_inventory
after insert or update of total_quantity,shirt_type,shirt_size on public.shirt_inventory
for each row execute function public.sync_shirt_physical_total_to_kit_inventory();

-- Reconcilia o estoque fisico que ja existia antes do trigger.
update public.shirt_inventory set total_quantity=total_quantity;

-- Reconstroi a demanda atual a partir do vinculo que identifica exatamente
-- qual variante pertence a cada ingresso. A operacao e repetivel e nao soma
-- contadores antigos possivelmente incorretos.
with demand as (
  select pki.kit_item_id,(pki.variant_data->>'variant_id')::uuid variant_id,sum(pki.quantity)::integer quantity
  from public.participant_kit_items pki
  join public.event_kit_items eki on eki.id=pki.kit_item_id and eki.item_type='shirt'
  where pki.status not in('delivered','cancelled') and nullif(pki.variant_data->>'variant_id','') is not null
  group by pki.kit_item_id,(pki.variant_data->>'variant_id')::uuid
)
update public.event_kit_item_variant_inventory inv
set reserved_quantity=coalesce(demand.quantity,0),updated_at=now()
from public.event_kit_item_variants variant
left join demand on demand.kit_item_id=variant.kit_item_id and demand.variant_id=variant.id
where inv.kit_item_id=variant.kit_item_id and inv.variant_id=variant.id;

update public.participant_kit_items pki
set inventory_reservation_accounted=true
from public.event_kit_items eki
where eki.id=pki.kit_item_id and eki.item_type='shirt'
  and pki.status not in('delivered','cancelled')
  and nullif(pki.variant_data->>'variant_id','') is not null;

create or replace function public.account_ticket_shirt_demand(p_link_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_link public.participant_kit_items%rowtype; v_item public.event_kit_items%rowtype; v_variant_id uuid;
begin
  select * into v_link from public.participant_kit_items where id=p_link_id for update;
  if not found or v_link.inventory_reservation_accounted or v_link.status in('delivered','cancelled') then return; end if;
  select * into v_item from public.event_kit_items where id=v_link.kit_item_id;
  if not found or v_item.item_type<>'shirt' then return; end if;
  v_variant_id:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  if v_variant_id is null then return; end if;
  insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity,reserved_quantity,delivered_quantity)
  values(v_link.organization_id,v_link.event_id,v_link.kit_item_id,v_variant_id,0,v_link.quantity,0)
  on conflict(kit_item_id,variant_id) do update
    set reserved_quantity=event_kit_item_variant_inventory.reserved_quantity+excluded.reserved_quantity,updated_at=now();
  update public.participant_kit_items set inventory_reservation_accounted=true where id=v_link.id;
end; $$;

-- Mantem a funcao de materializacao como porta unica e idempotente. Alem de
-- criar/enriquecer o vinculo, ela agora garante que a demanda foi contabilizada.
create or replace function public.ensure_ticket_kit_items(p_ticket_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype;
  v_item public.event_kit_items%rowtype; v_variant public.event_kit_item_variants%rowtype;
  v_variant_count integer; v_created integer:=0; v_existing integer:=0; v_skipped jsonb:='[]'::jsonb;
  v_status text:='reserved'; v_link uuid; v_link_variant_data jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_ticket.organization_id)
    and not exists(select 1 from public.orders o where o.id=v_ticket.order_id and o.user_id=v_actor)
    and not exists(select 1 from public.participants p where p.id=v_ticket.participant_id and p.user_id=v_actor)
  then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  select * into strict v_oi from public.order_items where id=v_ticket.order_item_id for update;
  if exists(select 1 from public.payments p where p.order_id=v_ticket.order_id and p.payment_status='paid') then v_status:='confirmed'; end if;

  for v_item in select * from public.event_kit_items where event_id=v_ticket.event_id and is_active order by sort_order,created_at loop
    v_link:=null; v_link_variant_data:=null;
    select id,variant_data into v_link,v_link_variant_data from public.participant_kit_items
      where ticket_id=p_ticket_id and kit_item_id=v_item.id;
    if v_link is not null and (v_item.item_type<>'shirt' or nullif(v_link_variant_data->>'variant_id','') is not null) then
      if v_item.item_type='shirt' then perform public.account_ticket_shirt_demand(v_link); end if;
      v_existing:=v_existing+1; continue;
    end if;
    if v_item.item_type='shirt' then
      if nullif(trim(v_oi.shirt_type),'') is null or nullif(trim(v_oi.shirt_size),'') is null then
        v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('kit_item_id',v_item.id,'code','SHIRT_SELECTION_MISSING')); continue;
      end if;
      select count(*),(array_agg(v.id order by v.id))[1] into v_variant_count,v_variant.id
      from public.event_kit_item_variants v where v.kit_item_id=v_item.id and v.is_active
        and lower(trim(v.name))=lower(trim(v_oi.shirt_type)) and upper(trim(v.value))=upper(trim(v_oi.shirt_size));
      if v_variant_count<>1 then
        v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('kit_item_id',v_item.id,'code',case when v_variant_count=0 then 'SHIRT_VARIANT_NOT_FOUND' else 'SHIRT_VARIANT_AMBIGUOUS' end)); continue;
      end if;
      if v_link is not null then
        update public.participant_kit_items set variant_data=coalesce(variant_data,'{}'::jsonb)||jsonb_build_object(
          'variant_id',v_variant.id,'shirt_type',trim(v_oi.shirt_type),'shirt_size',upper(trim(v_oi.shirt_size)),'supply_mode',v_item.shirt_supply_mode)
        where id=v_link;
        perform public.account_ticket_shirt_demand(v_link);
        v_existing:=v_existing+1; continue;
      end if;
    end if;
    insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
    values(v_ticket.id,v_oi.id,coalesce(v_oi.participant_id,v_ticket.participant_id),v_ticket.event_id,v_ticket.organization_id,v_item.id,
      case when v_item.item_type='shirt' then jsonb_build_object('variant_id',v_variant.id,'shirt_type',trim(v_oi.shirt_type),'shirt_size',upper(trim(v_oi.shirt_size)),'supply_mode',v_item.shirt_supply_mode) end,
      v_item.quantity_per_participant,v_status)
    on conflict(ticket_id,kit_item_id) where ticket_id is not null do nothing returning id into v_link;
    if v_link is not null then
      if v_item.item_type='shirt' then perform public.account_ticket_shirt_demand(v_link); end if;
      v_created:=v_created+1;
    else v_existing:=v_existing+1; end if;
  end loop;
  return jsonb_build_object('ticket_id',p_ticket_id,'created_count',v_created,'existing_count',v_existing,
    'skipped_count',jsonb_array_length(v_skipped),'skipped',v_skipped);
end; $$;

-- O primeiro ingresso com titular ja passava por ensure_ticket_kit_items via
-- create_manual_registration_order. Os ingressos adicionais/sem titular nao.
-- Mantem a orquestracao existente e garante a mesma materializacao para ambos.
create or replace function public.issue_manual_ticket_batch(
  p_registration_contact_id uuid,p_event_id uuid,p_ticket_category_id uuid,p_batch_id uuid,p_quantity integer,
  p_pricing_gender text,p_shirt_type text,p_shirt_size text,p_payment_method text,p_notes text default null,
  p_assign_holder boolean default true
) returns table(ticket_id uuid) language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_contact public.registration_contacts%rowtype; v_event_organization_id uuid;
  v_first record; v_extra record; v_index integer; v_owner_user_id uuid;
  v_issue_reason text:=lower(trim(coalesce(p_payment_method,''))); v_financial_method constant text:='courtesy';
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if v_issue_reason not in('courtesy','system_failure','administrative_correction','other') then raise exception 'Motivo de emissao manual invalido.'; end if;
  if v_issue_reason='other' and nullif(trim(coalesce(p_notes,'')),'') is null then raise exception 'Descreva o motivo da emissao manual.'; end if;
  if p_quantity is null or p_quantity<1 or p_quantity>20 then raise exception 'Quantidade deve estar entre 1 e 20.'; end if;
  select organization_id into v_event_organization_id from public.events where id=p_event_id;
  if v_event_organization_id is null then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event_organization_id) then raise exception 'Evento invalido ou sem acesso a organizacao.'; end if;
  select * into v_contact from public.registration_contacts where id=p_registration_contact_id and organization_id=v_event_organization_id;
  if not found then raise exception 'Cadastro nao pertence a organizacao do evento.'; end if;
  perform set_config('app.administrative_ticket_issue_actor',v_actor::text,true);

  if coalesce(p_assign_holder,true) then
    perform public.assert_ticket_holder_contact_available(null,p_event_id,v_contact.id);
    select * into v_first from public.create_manual_registration_order(
      p_event_id,p_ticket_category_id,p_batch_id,v_contact.full_name,v_contact.cpf,v_contact.birth_date,
      p_pricing_gender,v_contact.phone,v_contact.email,v_contact.city,p_shirt_type,p_shirt_size,v_financial_method,p_notes);
    update public.participants set registration_contact_id=v_contact.id where id=v_first.participant_id;
    if not found then raise exception 'Falha ao vincular participante ao cadastro.'; end if;
    update public.order_items set registration_contact_id=v_contact.id where id=v_first.order_item_id;
    if not found then raise exception 'Falha ao vincular item ao cadastro.'; end if;
    v_owner_user_id:=public.resolve_administrative_ticket_owner(v_event_organization_id,v_contact.id);
    update public.tickets set owner_user_id=v_owner_user_id where id=v_first.ticket_id;
    perform public.ensure_ticket_kit_items(v_first.ticket_id);
    ticket_id:=v_first.ticket_id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('manual_ticket_issued','tickets',ticket_id,p_event_id,jsonb_build_object(
      'actor_user_id',v_actor,'registration_contact_id',v_contact.id,'order_id',v_first.order_id,'order_item_id',v_first.order_item_id,
      'issue_reason',v_issue_reason,'reason_text',nullif(trim(coalesce(p_notes,'')),''),'payment_method',v_financial_method,
      'assign_holder',true,'owner_user_id',v_owner_user_id,'buyer_type','administrative','organization_id',v_event_organization_id));
    return next; v_index:=2;
  else v_index:=1;
  end if;

  for v_index in v_index..p_quantity loop
    select * into v_extra from public.create_manual_unassigned_ticket_order(
      p_event_id,p_ticket_category_id,p_batch_id,p_pricing_gender,p_shirt_type,p_shirt_size,v_financial_method,p_notes);
    update public.tickets set owner_user_id=null where id=v_extra.ticket_id;
    perform public.ensure_ticket_kit_items(v_extra.ticket_id);
    ticket_id:=v_extra.ticket_id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('manual_ticket_issued','tickets',ticket_id,p_event_id,jsonb_build_object(
      'actor_user_id',v_actor,'registration_contact_id',v_contact.id,'order_id',v_extra.order_id,'order_item_id',v_extra.order_item_id,
      'issue_reason',v_issue_reason,'reason_text',nullif(trim(coalesce(p_notes,'')),''),'payment_method',v_financial_method,
      'assign_holder',false,'owner_user_id',null,'buyer_type','administrative','organization_id',v_event_organization_id));
    return next;
  end loop;
end; $$;

revoke all on function public.account_ticket_shirt_demand(uuid) from public,anon,authenticated;
grant execute on function public.account_ticket_shirt_demand(uuid) to service_role;

commit;
