-- 141_manual_ticket_issue_organization_consistency.sql
-- Garante que toda emissao por order_item derive a organizacao do evento/pedido
-- antes dos triggers de owner, independentemente de haver titular.

begin;

create or replace function public.confirm_order_item_and_issue_ticket(p_order_item_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_event public.events%rowtype;
  v_payment public.payments%rowtype;
  v_ticket_id uuid;
begin
  if p_order_item_id is null then raise exception 'Item do pedido obrigatorio.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Item do pedido nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if not found then raise exception 'Pedido nao encontrado para o item.'; end if;
  select * into v_event from public.events where id=v_item.event_id for share;
  if not found then raise exception 'Evento nao encontrado para o item.'; end if;

  -- Evento e sua organizacao sao a fonte canonica para pedido, item e ticket.
  if v_order.event_id is distinct from v_event.id then
    raise exception 'Evento do item diverge do evento do pedido.';
  end if;
  if v_order.organization_id is distinct from v_event.organization_id then
    raise exception 'Organizacao do pedido diverge da organizacao do evento.';
  end if;
  if v_item.participant_id is not null and exists(
    select 1 from public.participants p
    where p.id=v_item.participant_id and p.organization_id is distinct from v_event.organization_id
  ) then
    raise exception 'Organizacao do titular diverge da organizacao do evento.';
  end if;

  select * into v_payment from public.payments where order_id=v_order.id
  order by created_at desc limit 1 for update;
  if not found then raise exception 'Pagamento nao encontrado para o pedido.'; end if;
  if v_payment.payment_status<>'paid' then raise exception 'Pagamento ainda nao confirmado.'; end if;
  if v_payment.event_id is distinct from v_event.id
    or v_payment.organization_id is distinct from v_event.organization_id then
    raise exception 'Pagamento diverge do evento ou organizacao da emissao.';
  end if;

  update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now()
  where id=v_item.id;

  insert into public.tickets(order_id,order_item_id,participant_id,event_id,organization_id,status)
  values(v_order.id,v_item.id,v_item.participant_id,v_event.id,v_event.organization_id,'active')
  on conflict(order_item_id) where order_item_id is not null do update set
    order_id=excluded.order_id,
    participant_id=excluded.participant_id,
    event_id=excluded.event_id,
    organization_id=excluded.organization_id,
    status='active',cancelled_at=null,used_at=null
  returning id into v_ticket_id;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('ticket_issued','tickets',v_ticket_id,v_event.id,jsonb_build_object(
    'participant_id',v_item.participant_id,'order_id',v_order.id,'order_item_id',v_item.id,
    'payment_id',v_payment.id,'organization_id',v_event.organization_id));
  return v_ticket_id;
end; $$;

-- Corrige a dependencia de ordem entre os triggers BEFORE INSERT da 072 e 139/140.
-- O trigger de owner passa a resolver organization_id pelo pedido quando ainda esta NULL.
create or replace function public.trg_initialize_ticket_owner()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_holder public.participants%rowtype;
  v_registration_contact_id uuid;
  v_import_batch_ids uuid[]:=array[]::uuid[];
  v_imported_by_user_ids uuid[]:=array[]::uuid[];
  v_holder_account_count integer:=0;
  v_expected_owner_user_id uuid;
  v_is_imported boolean:=false;
begin
  select * into v_order from public.orders where id=new.order_id;
  if not found then raise exception 'Pedido do ingresso nao encontrado.'; end if;
  if new.organization_id is null then
    new.organization_id:=v_order.organization_id;
  elsif new.organization_id is distinct from v_order.organization_id then
    raise exception 'Organizacao do ingresso diverge do pedido.';
  end if;

  if new.order_item_id is not null then select * into v_item from public.order_items where id=new.order_item_id; end if;
  if coalesce(v_item.participant_id,new.participant_id) is not null then
    select * into v_holder from public.participants where id=coalesce(v_item.participant_id,new.participant_id);
  end if;
  v_registration_contact_id:=coalesce(v_item.registration_contact_id,v_holder.registration_contact_id);

  select coalesce(array_agg(distinct ib.id order by ib.id),array[]::uuid[]),
    coalesce(array_agg(distinct ib.imported_by order by ib.imported_by)
      filter(where ib.imported_by is not null),array[]::uuid[])
  into v_import_batch_ids,v_imported_by_user_ids
  from public.import_batches ib
  where ib.id=v_order.import_batch_id or exists(
    select 1 from public.participation_history ph
    where ph.import_batch_id=ib.id and ph.source='import'
      and ph.participant_id in(v_order.participant_id,coalesce(v_item.participant_id,new.participant_id)));
  v_is_imported:=v_order.buyer_type='imported_holder' or cardinality(v_import_batch_ids)>0;

  if v_is_imported then
    select count(distinct p.user_id),(array_agg(distinct p.user_id order by p.user_id))[1]
    into v_holder_account_count,v_expected_owner_user_id
    from public.participants p join auth.users au on au.id=p.user_id
    where v_registration_contact_id is not null and p.organization_id=new.organization_id
      and p.registration_contact_id=v_registration_contact_id
      and not(p.user_id=any(v_imported_by_user_ids));
    if v_holder_account_count>1 then
      raise exception 'IMPORTED_TICKET_OWNER_AMBIGUOUS: contato do titular possui mais de uma conta valida.';
    end if;
    new.owner_user_id:=case when v_holder_account_count=1 then v_expected_owner_user_id else null end;
    return new;
  end if;

  if new.owner_user_id is not null then return new; end if;
  if v_order.buyer_type='account' then
    if v_order.user_id is null or not exists(select 1 from auth.users where id=v_order.user_id) then
      raise exception 'Pedido de conta sem comprador autenticado valido.';
    end if;
    new.owner_user_id:=v_order.user_id;
  else
    raise exception 'Origem do pedido nao permite inicializar proprietario.';
  end if;
  return new;
end; $$;

drop trigger if exists initialize_ticket_owner on public.tickets;
create trigger initialize_ticket_owner before insert on public.tickets
for each row execute function public.trg_initialize_ticket_owner();

revoke all on function public.confirm_order_item_and_issue_ticket(uuid),public.trg_initialize_ticket_owner()
  from public,anon,authenticated;
grant execute on function public.confirm_order_item_and_issue_ticket(uuid) to authenticated;

commit;
