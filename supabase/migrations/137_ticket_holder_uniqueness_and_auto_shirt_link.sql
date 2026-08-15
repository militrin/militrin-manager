-- 137_ticket_holder_uniqueness_and_auto_shirt_link.sql
-- Garante titular unico por cadastro/evento e materializa camiseta ticket-first.

begin;

-- Titular e uma pessoa global. Conta autenticada e apenas um vinculo opcional.
alter table public.ticket_holder_history
  add column if not exists previous_registration_contact_id uuid references public.registration_contacts(id) on delete set null,
  add column if not exists new_registration_contact_id uuid references public.registration_contacts(id) on delete set null;
alter table public.ticket_holder_history alter column new_user_id drop not null;
alter table public.ticket_holder_history drop constraint if exists ticket_holder_history_operation_check;
alter table public.ticket_holder_history add constraint ticket_holder_history_operation_check
  check(operation in('holder_assigned','ticket_transferred','holder_removed'));

update public.ticket_holder_history h set
  previous_registration_contact_id=oldp.registration_contact_id,
  new_registration_contact_id=newp.registration_contact_id
from public.participants oldp,public.participants newp
where oldp.id=h.previous_participant_id and newp.id=h.new_participant_id
  and (h.previous_registration_contact_id is null or h.new_registration_contact_id is null);
update public.ticket_holder_history h set previous_registration_contact_id=p.registration_contact_id
from public.participants p where p.id=h.previous_participant_id and h.previous_registration_contact_id is null;
update public.ticket_holder_history h set new_registration_contact_id=p.registration_contact_id
from public.participants p where p.id=h.new_participant_id and h.new_registration_contact_id is null;

create or replace function public.trg_ticket_holder_history_contacts()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.previous_registration_contact_id is null and new.previous_participant_id is not null then
    select registration_contact_id into new.previous_registration_contact_id from public.participants where id=new.previous_participant_id;
  end if;
  if new.new_registration_contact_id is null and new.new_participant_id is not null then
    select registration_contact_id into new.new_registration_contact_id from public.participants where id=new.new_participant_id;
  end if;
  return new;
end; $$;
drop trigger if exists ticket_holder_history_contacts on public.ticket_holder_history;
create trigger ticket_holder_history_contacts before insert or update of previous_participant_id,new_participant_id on public.ticket_holder_history
for each row execute function public.trg_ticket_holder_history_contacts();

create or replace function public.registration_contact_has_active_ticket(
  p_event_id uuid,p_registration_contact_id uuid,p_exclude_ticket_id uuid default null
) returns boolean language sql volatile security definer set search_path=public,pg_temp as $$
  select exists(
    select 1 from public.tickets t
    left join public.order_items oi on oi.id=t.order_item_id
    left join public.participants p on p.id=coalesce(oi.participant_id,t.participant_id)
    where t.event_id=p_event_id and t.id is distinct from p_exclude_ticket_id
      and t.status not in('cancelled','canceled','void','voided')
      and coalesce(oi.registration_contact_id,p.registration_contact_id)=p_registration_contact_id
  );
$$;

create or replace function public.assert_ticket_holder_contact_available(
  p_ticket_id uuid,
  p_event_id uuid,
  p_registration_contact_id uuid
) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_registration_contact_id is null then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text||':'||p_registration_contact_id::text,0));
  if public.registration_contact_has_active_ticket(p_event_id,p_registration_contact_id,p_ticket_id) then
    raise exception using errcode='P0001',message='HOLDER_ALREADY_HAS_TICKET_FOR_EVENT',
      detail=jsonb_build_object('code','HOLDER_ALREADY_HAS_TICKET_FOR_EVENT',
        'message','Esta pessoa ja e titular de outro ingresso neste evento.')::text;
  end if;
end; $$;

create or replace function public.trg_enforce_ticket_holder_contact_uniqueness()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_contact uuid; v_ticket_id uuid; v_event_id uuid;
begin
  if tg_table_name='tickets' then
    v_ticket_id:=new.id; v_event_id:=new.event_id;
    if new.status in ('cancelled','canceled','void','voided') then return new; end if;
    select registration_contact_id into v_contact from public.participants where id=new.participant_id;
    if new.order_item_id is not null then
      select coalesce(v_contact,oi.registration_contact_id,p.registration_contact_id) into v_contact
      from public.order_items oi left join public.participants p on p.id=oi.participant_id where oi.id=new.order_item_id;
    end if;
  else
    select t.id,t.event_id into v_ticket_id,v_event_id from public.tickets t where t.order_item_id=new.id;
    if v_ticket_id is null then return new; end if;
    if new.participant_id is not null then
      select registration_contact_id into v_contact from public.participants where id=new.participant_id;
      new.registration_contact_id:=coalesce(v_contact,new.registration_contact_id);
    else
      v_contact:=new.registration_contact_id;
    end if;
  end if;
  perform public.assert_ticket_holder_contact_available(v_ticket_id,v_event_id,v_contact);
  return new;
end; $$;

drop trigger if exists enforce_ticket_holder_contact_uniqueness on public.tickets;
create trigger enforce_ticket_holder_contact_uniqueness
before insert or update of participant_id,event_id,status,order_item_id on public.tickets
for each row execute function public.trg_enforce_ticket_holder_contact_uniqueness();

drop trigger if exists enforce_order_item_holder_contact_uniqueness on public.order_items;
create trigger enforce_order_item_holder_contact_uniqueness
before update of participant_id,registration_contact_id,event_id on public.order_items
for each row execute function public.trg_enforce_ticket_holder_contact_uniqueness();

create or replace function public.search_admin_ticket_holder_contacts(p_ticket_id uuid,p_term text)
returns table(registration_contact_id uuid,full_name text,masked_email text,masked_cpf text,has_account boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_term text:=trim(coalesce(p_term,'')); v_digits text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao para buscar titulares.'; end if;
  if length(v_term)<3 then raise exception 'Informe ao menos 3 caracteres para buscar.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  v_digits:=regexp_replace(v_term,'\D','','g');
  return query select rc.id,rc.full_name,
    case when position('@' in coalesce(rc.email,''))>1 then left(rc.email,2)||'***@'||split_part(rc.email,'@',2) end,
    case when length(regexp_replace(coalesce(rc.cpf,''),'\D','','g'))=11 then '***.***.***-'||right(regexp_replace(rc.cpf,'\D','','g'),2) end,
    exists(select 1 from public.participants p where p.registration_contact_id=rc.id and p.user_id is not null)
  from public.registration_contacts rc
  where rc.organization_id=v_ticket.organization_id and
    (rc.full_name ilike '%'||v_term||'%' or rc.email ilike '%'||v_term||'%'
      or (length(v_digits)>=3 and regexp_replace(coalesce(rc.cpf,''),'\D','','g') like '%'||v_digits||'%')
      or upper(coalesce(rc.public_pin,''))=upper(regexp_replace(v_term,'[^A-Za-z0-9]','','g')))
  order by rc.full_name,rc.id limit 20;
end; $$;

create or replace function public.admin_set_ticket_holder_contact(p_ticket_id uuid,p_registration_contact_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_item public.order_items%rowtype;
  v_contact public.registration_contacts%rowtype; v_previous public.participants%rowtype;
  v_target public.participants%rowtype; v_target_count integer; v_operation text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao para alterar titular.'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status in('cancelled','canceled','void','voided') then raise exception 'Ingresso cancelado nao pode ter titular alterado.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Ingresso ja utilizado nao pode ter titular alterado.'; end if;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  if coalesce(v_item.participant_id,v_ticket.participant_id) is not null then
    select * into v_previous from public.participants where id=coalesce(v_item.participant_id,v_ticket.participant_id);
  end if;

  if p_registration_contact_id is null then
    if v_previous.id is null and v_item.registration_contact_id is null then return jsonb_build_object('success',true,'changed',false,'ticket_id',v_ticket.id); end if;
    update public.order_items set participant_id=null,registration_contact_id=null,holder_full_name=null,ownership_status='unassigned',updated_at=now() where id=v_item.id;
    update public.tickets set participant_id=null where id=v_ticket.id;
    update public.participant_kit_items set participant_id=null where ticket_id=v_ticket.id;
    insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,
      previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason)
    values(v_ticket.id,v_item.id,v_ticket.event_id,v_ticket.organization_id,'holder_removed',v_previous.id,null,
      coalesce(v_item.registration_contact_id,v_previous.registration_contact_id),null,v_previous.user_id,null,v_actor,'admin',trim(p_reason));
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('holder_removed','tickets',v_ticket.id,v_ticket.event_id,
      jsonb_build_object('previous_registration_contact_id',coalesce(v_item.registration_contact_id,v_previous.registration_contact_id),'new_registration_contact_id',null,'actor_user_id',v_actor,'reason',trim(p_reason)));
    return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'registration_contact_id',null);
  end if;

  select * into v_contact from public.registration_contacts where id=p_registration_contact_id and organization_id=v_ticket.organization_id for update;
  if not found then raise exception 'Cadastro de destino invalido ou de outra organizacao.'; end if;
  if coalesce(v_item.registration_contact_id,v_previous.registration_contact_id)=v_contact.id then
    return jsonb_build_object('success',true,'changed',false,'ticket_id',v_ticket.id,'registration_contact_id',v_contact.id);
  end if;
  perform public.assert_ticket_holder_contact_available(v_ticket.id,v_ticket.event_id,v_contact.id);
  select count(*) into v_target_count from public.participants where event_id=v_ticket.event_id and registration_contact_id=v_contact.id;
  if v_target_count>1 then raise exception 'VALIDACAO_ADMINISTRATIVA: cadastro possui multiplas projecoes no evento.'; end if;
  if v_target_count=1 then
    select * into strict v_target from public.participants where event_id=v_ticket.event_id and registration_contact_id=v_contact.id;
  else
    insert into public.participants(event_id,organization_id,registration_contact_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,
      shirt_type,shirt_size,registration_status,ticket_category_id,batch_id)
    values(v_ticket.event_id,v_ticket.organization_id,v_contact.id,null,v_contact.full_name,v_contact.cpf,v_contact.birth_date,v_contact.gender,
      v_contact.phone,v_contact.email,v_contact.city,nullif(trim(coalesce(v_item.shirt_type,'')),''),nullif(trim(coalesce(v_item.shirt_size,'')),''),
      'confirmed',v_item.ticket_category_id,v_item.batch_id) returning * into v_target;
  end if;
  v_operation:=case when v_previous.id is null then 'holder_assigned' else 'ticket_transferred' end;
  update public.order_items set participant_id=v_target.id,registration_contact_id=v_contact.id,holder_full_name=v_contact.full_name,
    ownership_status=case when v_operation='holder_assigned' then 'assigned' else 'transferred' end,updated_at=now() where id=v_item.id;
  update public.tickets set participant_id=v_target.id where id=v_ticket.id;
  update public.participant_kit_items set participant_id=v_target.id,order_item_id=v_item.id where ticket_id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,
    previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason)
  values(v_ticket.id,v_item.id,v_ticket.event_id,v_ticket.organization_id,v_operation,v_previous.id,v_target.id,
    coalesce(v_item.registration_contact_id,v_previous.registration_contact_id),v_contact.id,v_previous.user_id,v_target.user_id,v_actor,'admin',trim(p_reason));
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('admin_ticket_holder_changed','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('previous_registration_contact_id',coalesce(v_item.registration_contact_id,v_previous.registration_contact_id),
      'new_registration_contact_id',v_contact.id,'previous_user_id',v_previous.user_id,'new_user_id',v_target.user_id,'actor_user_id',v_actor,'reason',trim(p_reason)));
  return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'participant_id',v_target.id,'registration_contact_id',v_contact.id);
end; $$;

create or replace function public.admin_transfer_ticket_holder(p_ticket_id uuid,p_target_participant_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_contact uuid;
begin
  select registration_contact_id into v_contact from public.participants where id=p_target_participant_id;
  if v_contact is null then raise exception 'Participante sem cadastro global vinculado.'; end if;
  return public.admin_set_ticket_holder_contact(p_ticket_id,v_contact,p_reason);
end; $$;

-- Atualiza a 135 ja instalada: escolha explicita entre primeiro titular e lote inteiro sem titular.
create or replace function public.issue_manual_ticket_batch(
  p_registration_contact_id uuid,p_event_id uuid,p_ticket_category_id uuid,p_batch_id uuid,p_quantity integer,
  p_pricing_gender text,p_shirt_type text,p_shirt_size text,p_payment_method text,p_notes text default null,
  p_assign_holder boolean default true
) returns table(ticket_id uuid) language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_contact public.registration_contacts%rowtype; v_event_organization_id uuid;
  v_first record; v_extra record; v_index integer;
begin
  if p_quantity is null or p_quantity<1 or p_quantity>20 then raise exception 'Quantidade deve estar entre 1 e 20.'; end if;
  select organization_id into v_event_organization_id from public.events where id=p_event_id;
  if v_event_organization_id is null then raise exception 'Evento nao encontrado.'; end if;
  select * into v_contact from public.registration_contacts
  where id=p_registration_contact_id and organization_id=v_event_organization_id;
  if not found then raise exception 'Cadastro nao pertence a organizacao do evento.'; end if;

  if coalesce(p_assign_holder,true) then
    perform public.assert_ticket_holder_contact_available(null,p_event_id,v_contact.id);
    select * into v_first from public.create_manual_registration_order(
      p_event_id,p_ticket_category_id,p_batch_id,v_contact.full_name,v_contact.cpf,v_contact.birth_date,
      p_pricing_gender,v_contact.phone,v_contact.email,v_contact.city,p_shirt_type,p_shirt_size,p_payment_method,p_notes);
    update public.participants set registration_contact_id=v_contact.id where id=v_first.participant_id;
    if not found then raise exception 'Falha ao vincular participante ao cadastro.'; end if;
    update public.order_items set registration_contact_id=v_contact.id where id=v_first.order_item_id;
    if not found then raise exception 'Falha ao vincular item ao cadastro.'; end if;
    ticket_id:=v_first.ticket_id; return next; v_index:=2;
  else v_index:=1;
  end if;
  for v_index in v_index..p_quantity loop
    select * into v_extra from public.create_manual_unassigned_ticket_order(
      p_event_id,p_ticket_category_id,p_batch_id,p_pricing_gender,p_shirt_type,p_shirt_size,p_payment_method,p_notes);
    ticket_id:=v_extra.ticket_id; return next;
  end loop;
end; $$;

revoke all on function public.issue_manual_ticket_batch(uuid,uuid,uuid,uuid,integer,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.issue_manual_ticket_batch(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.issue_manual_ticket_batch(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,boolean) to authenticated;

create or replace function public.ensure_ticket_kit_items(p_ticket_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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
    select id,variant_data into v_link,v_link_variant_data
    from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id;
    if v_link is not null and (v_item.item_type<>'shirt' or nullif(v_link_variant_data->>'variant_id','') is not null) then
      v_existing:=v_existing+1; continue;
    end if;
    if v_item.item_type='shirt' then
      if nullif(trim(v_oi.shirt_type),'') is null or nullif(trim(v_oi.shirt_size),'') is null then
        v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('kit_item_id',v_item.id,'code','SHIRT_SELECTION_MISSING')); continue;
      end if;
      select count(*),(array_agg(v.id order by v.id))[1] into v_variant_count,v_variant.id
      from public.event_kit_item_variants v where v.kit_item_id=v_item.id and v.is_active
        and v.name=trim(v_oi.shirt_type) and v.value=trim(v_oi.shirt_size);
      if v_variant_count<>1 then
        v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('kit_item_id',v_item.id,'code',case when v_variant_count=0 then 'SHIRT_VARIANT_NOT_FOUND' else 'SHIRT_VARIANT_AMBIGUOUS' end)); continue;
      end if;
      if v_link is not null then
        update public.participant_kit_items
        set variant_data=coalesce(variant_data,'{}'::jsonb)||jsonb_build_object(
          'variant_id',v_variant.id,'shirt_type',trim(v_oi.shirt_type),'shirt_size',trim(v_oi.shirt_size),'supply_mode',v_item.shirt_supply_mode)
        where id=v_link;
        v_existing:=v_existing+1;
        continue;
      end if;
    end if;
    insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
    values(v_ticket.id,v_oi.id,coalesce(v_oi.participant_id,v_ticket.participant_id),v_ticket.event_id,v_ticket.organization_id,v_item.id,
      case when v_item.item_type='shirt' then jsonb_build_object('variant_id',v_variant.id,'shirt_type',trim(v_oi.shirt_type),'shirt_size',trim(v_oi.shirt_size),'supply_mode',v_item.shirt_supply_mode) end,
      v_item.quantity_per_participant,v_status)
    on conflict(ticket_id,kit_item_id) where ticket_id is not null do nothing returning id into v_link;
    if v_link is not null then v_created:=v_created+1; else v_existing:=v_existing+1; end if;
    v_link:=null;
  end loop;
  return jsonb_build_object('ticket_id',p_ticket_id,'created_count',v_created,'existing_count',v_existing,
    'skipped_count',jsonb_array_length(v_skipped),'skipped',v_skipped);
end; $$;

-- Enriquece somente selecoes legadas com correspondencia ativa inequivoca.
-- Nao altera status, quantidade, entrega ou contadores de estoque.
with deterministic_shirt_variants as (
  select pki.id link_id,(array_agg(v.id order by v.id))[1] variant_id,
    trim(oi.shirt_type) shirt_type,trim(oi.shirt_size) shirt_size,eki.shirt_supply_mode
  from public.participant_kit_items pki
  join public.order_items oi on oi.id=pki.order_item_id
  join public.event_kit_items eki on eki.id=pki.kit_item_id and eki.item_type='shirt'
  join public.event_kit_item_variants v on v.kit_item_id=eki.id and v.is_active
    and v.name=trim(oi.shirt_type) and v.value=trim(oi.shirt_size)
  where nullif(pki.variant_data->>'variant_id','') is null
    and nullif(trim(oi.shirt_type),'') is not null and nullif(trim(oi.shirt_size),'') is not null
  group by pki.id,oi.shirt_type,oi.shirt_size,eki.shirt_supply_mode
  having count(*)=1
)
update public.participant_kit_items pki
set variant_data=coalesce(pki.variant_data,'{}'::jsonb)||jsonb_build_object(
  'variant_id',d.variant_id,'shirt_type',d.shirt_type,'shirt_size',d.shirt_size,'supply_mode',d.shirt_supply_mode)
from deterministic_shirt_variants d where d.link_id=pki.id;

-- Mantem todas as chamadas antigas (inclusive deliver_ticket_full_kit da 136)
-- na mesma implementacao canonica, idempotente e capaz de resolver variant_id.
create or replace function public.materialize_ticket_kit_items_internal(p_ticket_id uuid,p_source text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  v_result:=public.ensure_ticket_kit_items(p_ticket_id);
  return v_result||jsonb_build_object('source',p_source);
end; $$;

revoke all on function public.registration_contact_has_active_ticket(uuid,uuid,uuid),public.assert_ticket_holder_contact_available(uuid,uuid,uuid),public.ensure_ticket_kit_items(uuid),
  public.search_admin_ticket_holder_contacts(uuid,text),public.admin_set_ticket_holder_contact(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.ensure_ticket_kit_items(uuid),public.search_admin_ticket_holder_contacts(uuid,text),
  public.admin_set_ticket_holder_contact(uuid,uuid,text) to authenticated;

commit;
