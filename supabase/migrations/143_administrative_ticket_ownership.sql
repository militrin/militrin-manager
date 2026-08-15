-- 143_administrative_ticket_ownership.sql
-- Separa ator administrativo, comprador comercial, proprietario e titular.

begin;

alter table public.orders
  drop constraint if exists orders_buyer_type_check,
  drop constraint if exists orders_buyer_ownership_check;
alter table public.orders
  add constraint orders_buyer_type_check check(buyer_type in('account','imported_holder','administrative')),
  add constraint orders_buyer_ownership_check check(
    (buyer_type='account' and user_id is not null and import_batch_id is null)
    or (buyer_type='imported_holder' and user_id is null and import_batch_id is not null)
    or (buyer_type='administrative' and user_id is null and import_batch_id is null)
  );

-- O contexto e aberto somente pela RPC administrativa protegida. O trigger impede
-- que auth.uid() seja persistido como comprador apenas porque executou a emissao.
create or replace function public.trg_classify_administrative_order()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_context_actor text:=current_setting('app.administrative_ticket_issue_actor',true);
begin
  if nullif(v_context_actor,'') is not null then
    if auth.uid() is null or v_context_actor<>auth.uid()::text
      or not public.current_user_has_permission('participants.create') then
      raise exception 'Contexto de emissao administrativa invalido.';
    end if;
    new.user_id:=null;
    new.buyer_type:='administrative';
    new.import_batch_id:=null;
  end if;
  return new;
end; $$;
drop trigger if exists classify_administrative_order on public.orders;
create trigger classify_administrative_order before insert on public.orders
for each row execute function public.trg_classify_administrative_order();

create or replace function public.resolve_administrative_ticket_owner(
  p_organization_id uuid,p_registration_contact_id uuid
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer; v_owner uuid;
begin
  if p_registration_contact_id is null then return null; end if;
  select count(distinct p.user_id),(array_agg(distinct p.user_id order by p.user_id))[1]
  into v_count,v_owner
  from public.participants p join auth.users au on au.id=p.user_id
  where p.organization_id=p_organization_id
    and p.registration_contact_id=p_registration_contact_id;
  if v_count>1 then
    raise exception 'ADMINISTRATIVE_TICKET_OWNER_AMBIGUOUS: cadastro possui mais de uma conta valida.';
  end if;
  return case when v_count=1 then v_owner else null end;
end; $$;

-- Mantem integralmente a precedencia de importacao da 140/141 e adiciona a
-- origem administrativa antes do fallback comercial buyer_type=account.
create or replace function public.trg_initialize_ticket_owner()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_order public.orders%rowtype; v_item public.order_items%rowtype; v_holder public.participants%rowtype;
  v_registration_contact_id uuid; v_import_batch_ids uuid[]:=array[]::uuid[];
  v_imported_by_user_ids uuid[]:=array[]::uuid[]; v_holder_account_count integer:=0;
  v_expected_owner_user_id uuid; v_is_imported boolean:=false;
begin
  select * into v_order from public.orders where id=new.order_id;
  if not found then raise exception 'Pedido do ingresso nao encontrado.'; end if;
  if new.organization_id is null then new.organization_id:=v_order.organization_id;
  elsif new.organization_id is distinct from v_order.organization_id then raise exception 'Organizacao do ingresso diverge do pedido.'; end if;

  if new.order_item_id is not null then select * into v_item from public.order_items where id=new.order_item_id; end if;
  if coalesce(v_item.participant_id,new.participant_id) is not null then
    select * into v_holder from public.participants where id=coalesce(v_item.participant_id,new.participant_id);
  end if;
  v_registration_contact_id:=coalesce(v_item.registration_contact_id,v_holder.registration_contact_id);

  select coalesce(array_agg(distinct ib.id order by ib.id),array[]::uuid[]),
    coalesce(array_agg(distinct ib.imported_by order by ib.imported_by) filter(where ib.imported_by is not null),array[]::uuid[])
  into v_import_batch_ids,v_imported_by_user_ids
  from public.import_batches ib
  where ib.id=v_order.import_batch_id or exists(
    select 1 from public.participation_history ph where ph.import_batch_id=ib.id and ph.source='import'
      and ph.participant_id in(v_order.participant_id,coalesce(v_item.participant_id,new.participant_id)));
  v_is_imported:=v_order.buyer_type='imported_holder' or cardinality(v_import_batch_ids)>0;

  if v_is_imported then
    select count(distinct p.user_id),(array_agg(distinct p.user_id order by p.user_id))[1]
    into v_holder_account_count,v_expected_owner_user_id
    from public.participants p join auth.users au on au.id=p.user_id
    where v_registration_contact_id is not null and p.organization_id=new.organization_id
      and p.registration_contact_id=v_registration_contact_id and not(p.user_id=any(v_imported_by_user_ids));
    if v_holder_account_count>1 then raise exception 'IMPORTED_TICKET_OWNER_AMBIGUOUS: contato do titular possui mais de uma conta valida.'; end if;
    new.owner_user_id:=case when v_holder_account_count=1 then v_expected_owner_user_id else null end;
    return new;
  end if;

  if v_order.buyer_type='administrative' then
    new.owner_user_id:=public.resolve_administrative_ticket_owner(new.organization_id,v_registration_contact_id);
    return new;
  end if;
  if new.owner_user_id is not null then return new; end if;
  if v_order.buyer_type='account' then
    if v_order.user_id is null or not exists(select 1 from auth.users where id=v_order.user_id) then
      raise exception 'Pedido de conta sem comprador autenticado valido.';
    end if;
    new.owner_user_id:=v_order.user_id;
  else raise exception 'Origem do pedido nao permite inicializar proprietario.';
  end if;
  return new;
end; $$;
drop trigger if exists initialize_ticket_owner on public.tickets;
create trigger initialize_ticket_owner before insert on public.tickets
for each row execute function public.trg_initialize_ticket_owner();

-- Assinatura da 142 preservada. O GUC transacional classifica somente os pedidos
-- criados dentro desta RPC; a conta do titular e resolvida depois do vinculo contact-first.
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
    ticket_id:=v_extra.ticket_id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('manual_ticket_issued','tickets',ticket_id,p_event_id,jsonb_build_object(
      'actor_user_id',v_actor,'registration_contact_id',v_contact.id,'order_id',v_extra.order_id,'order_item_id',v_extra.order_item_id,
      'issue_reason',v_issue_reason,'reason_text',nullif(trim(coalesce(p_notes,'')),''),'payment_method',v_financial_method,
      'assign_holder',false,'owner_user_id',null,'buyer_type','administrative','organization_id',v_event_organization_id));
    return next;
  end loop;
end; $$;

-- Regularizacao estritamente limitada ao caso comprovado. Pedido/pagamento historicos
-- permanecem intocados; somente o owner derivado indevidamente e removido.
do $$
declare v_ticket public.tickets%rowtype; v_order public.orders%rowtype; v_actor uuid;
begin
  select * into v_ticket from public.tickets where id='449195bb-558a-4178-af4c-cf3daa218de1' for update;
  if not found then return; end if;
  select * into strict v_order from public.orders where id=v_ticket.order_id for update;
  select (a.details->>'actor_user_id')::uuid into v_actor from public.audit_logs a
  where a.action='manual_ticket_issued' and a.entity_type='tickets' and a.entity_id=v_ticket.id
    and a.details->>'assign_holder'='false' and a.details->>'issue_reason'='system_failure'
    and a.details->>'payment_method'='courtesy' order by a.created_at limit 1;
  if v_actor is null or v_ticket.owner_user_id is distinct from v_actor or v_order.user_id is distinct from v_actor
    or v_order.buyer_type<>'account' or v_ticket.participant_id is not null
    or exists(select 1 from public.order_items oi where oi.id=v_ticket.order_item_id
      and (oi.participant_id is not null or oi.registration_contact_id is not null)) then
    raise exception 'ADMINISTRATIVE_OWNER_REGULARIZATION_PRECONDITION_FAILED';
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('administrative_ticket_owner_regularized','tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object(
    'ticket_id',v_ticket.id,'order_id',v_ticket.order_id,'previous_owner_user_id',v_ticket.owner_user_id,
    'new_owner_user_id',null,'actor_user_id',v_actor,'reason','regularization_administrative_actor_as_owner',
    'reason_code','data_regularization','technical_actor','migration:143_administrative_ticket_ownership'));
  update public.tickets set owner_user_id=null where id=v_ticket.id;
end; $$;

revoke all on function public.trg_classify_administrative_order(),public.resolve_administrative_ticket_owner(uuid,uuid),
  public.trg_initialize_ticket_owner() from public,anon,authenticated;
revoke all on function public.issue_manual_ticket_batch(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,boolean)
  from public,anon,authenticated;
grant execute on function public.issue_manual_ticket_batch(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,boolean)
  to authenticated;

commit;
