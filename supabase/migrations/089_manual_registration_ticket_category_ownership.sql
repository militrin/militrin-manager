-- 089_manual_registration_ticket_category_ownership.sql
-- Faz da unidade comprada a dona da categoria no fluxo manual.

begin;

-- Um participante pode ser titular de mais de um ingresso. A unidade unica e o
-- order_item (ja protegido por tickets.order_item_id), nao participant_id.
drop index if exists public.ux_tickets_participant_id;
create index if not exists idx_tickets_participant_id
  on public.tickets(participant_id)
  where participant_id is not null;

create or replace function public.create_manual_registration_order(
  p_event_id uuid,
  p_ticket_category_id uuid,
  p_full_name text,
  p_cpf text,
  p_birth_date date,
  p_gender text,
  p_phone text,
  p_email text,
  p_city text,
  p_shirt_type text,
  p_shirt_size text,
  p_payment_method text,
  p_coupon_code text default null,
  p_notes text default null
)
returns table(
  participant_id uuid,
  order_id uuid,
  order_item_id uuid,
  payment_id uuid,
  ticket_id uuid,
  full_name text,
  batch_name text,
  base_amount numeric,
  discount_amount numeric,
  final_amount numeric,
  payment_status text,
  reservation_expires_at timestamptz,
  shirt_type text,
  shirt_size text
)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_event public.events%rowtype;
  v_category public.ticket_categories%rowtype;
  v_pricing record;
  v_participant public.participants%rowtype;
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_payment public.payments%rowtype;
  v_ticket_id uuid;
  v_paid boolean;
  v_expires_at timestamptz;
  v_cpf text:=regexp_replace(coalesce(p_cpf,''),'\D','','g');
  v_phone text:=regexp_replace(coalesce(p_phone,''),'\D','','g');
  v_inventory public.shirt_inventory%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.create') then
    raise exception 'Sem permissao para criar inscricao manual.';
  end if;
  if p_event_id is null or p_ticket_category_id is null then
    raise exception 'Evento e categoria de acesso sao obrigatorios.';
  end if;

  select * into v_event from public.events where id=p_event_id for share;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then
    raise exception 'Usuario sem acesso a organizacao do evento.';
  end if;
  if not coalesce(v_event.registration_enabled,false) then
    raise exception 'Inscricoes fechadas para este evento.';
  end if;

  select * into v_category from public.ticket_categories
  where id=p_ticket_category_id and event_id=p_event_id and is_active=true;
  if not found then
    raise exception 'Categoria de acesso invalida ou pertencente a outro evento.';
  end if;

  select * into v_pricing
  from public.get_registration_pricing_preview(
    p_gender,nullif(trim(coalesce(p_coupon_code,'')),''),p_event_id,p_ticket_category_id
  ) limit 1;
  if v_pricing.batch_id is null then raise exception 'Lote/preco nao configurado para a categoria.'; end if;
  if not exists(select 1 from public.registration_batches rb
    where rb.id=v_pricing.batch_id and rb.event_id=p_event_id) then
    raise exception 'Lote calculado nao pertence ao evento.';
  end if;

  v_paid:=lower(trim(coalesce(p_payment_method,'')))='courtesy';
  v_expires_at:=case when v_paid then null else now()+interval '2 hours' end;

  select * into v_participant from public.participants p
  where p.event_id=p_event_id
    and regexp_replace(coalesce(p.cpf,''),'\D','','g')=v_cpf
  order by p.created_at limit 1 for update;

  if not found then
    insert into public.participants(
      event_id,organization_id,full_name,cpf,birth_date,gender,phone,email,city,
      registration_status,reservation_status
    ) values(
      p_event_id,v_event.organization_id,trim(p_full_name),v_cpf,p_birth_date,
      nullif(trim(coalesce(p_gender,'')),''),v_phone,lower(trim(p_email)),
      nullif(trim(coalesce(p_city,'')),''),'pending','pending'
    ) returning * into v_participant;
  else
    update public.participants set
      full_name=trim(p_full_name),birth_date=p_birth_date,
      gender=nullif(trim(coalesce(p_gender,'')),''),phone=v_phone,
      email=lower(trim(p_email)),city=nullif(trim(coalesce(p_city,'')),''),updated_at=now()
    where id=v_participant.id returning * into v_participant;
  end if;

  insert into public.orders(
    user_id,participant_id,event_id,payment_id,order_number,status,
    base_amount,discount_amount,final_amount,buyer_type,confirmed_at
  ) values(
    v_actor,v_participant.id,p_event_id,null,public.generate_order_number(),
    case when v_paid then 'confirmed' else 'pending' end,
    v_pricing.base_amount,v_pricing.discount_amount,v_pricing.final_amount,
    'account',case when v_paid then now() end
  ) returning * into v_order;

  insert into public.order_items(
    order_id,event_id,participant_id,ownership_status,holder_full_name,
    ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,
    discount_amount,final_amount,status,reservation_expires_at,notes
  ) values(
    v_order.id,p_event_id,v_participant.id,'assigned',v_participant.full_name,
    p_ticket_category_id,v_pricing.batch_id,nullif(trim(coalesce(p_shirt_type,'')),''),
    nullif(trim(coalesce(p_shirt_size,'')),''),1,v_pricing.base_amount,
    v_pricing.discount_amount,v_pricing.final_amount,
    case when v_paid then 'confirmed' else 'reserved' end,v_expires_at,
    nullif(trim(coalesce(p_notes,'')),'')
  ) returning * into v_item;

  if v_item.shirt_type is not null and v_item.shirt_size is not null then
    select * into v_inventory from public.shirt_inventory
    where event_id=p_event_id and shirt_type=v_item.shirt_type and shirt_size=v_item.shirt_size
    for update;
    if not found or v_inventory.total_quantity-v_inventory.reserved_quantity-v_inventory.delivered_quantity<1 then
      raise exception 'Estoque indisponivel para o modelo/tamanho selecionado.';
    end if;
    update public.shirt_inventory set reserved_quantity=reserved_quantity+1,updated_at=now()
    where id=v_inventory.id;
  end if;

  insert into public.payments(
    participant_id,event_id,organization_id,order_id,amount,discount_amount,
    final_amount,payment_method,payment_status,paid_at,expires_at
  ) values(
    v_participant.id,p_event_id,v_event.organization_id,v_order.id,
    v_pricing.base_amount,v_pricing.discount_amount,v_pricing.final_amount,
    lower(trim(p_payment_method)),case when v_paid then 'paid' else 'pending' end,
    case when v_paid then now() end,v_expires_at
  ) returning * into v_payment;
  update public.orders set payment_id=v_payment.id where id=v_order.id;

  if v_paid then
    v_ticket_id:=public.confirm_order_item_and_issue_ticket(v_item.id);
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('manual_registration_order_created','orders',v_order.id,p_event_id,
    jsonb_build_object('actor_user_id',v_actor,'participant_id',v_participant.id,
      'order_item_id',v_item.id,'ticket_category_id',p_ticket_category_id,
      'batch_id',v_pricing.batch_id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
      'category_owner','order_items'));

  return query select v_participant.id,v_order.id,v_item.id,v_payment.id,v_ticket_id,
    v_participant.full_name,v_pricing.batch_name,v_pricing.base_amount,
    v_pricing.discount_amount,v_pricing.final_amount,v_payment.payment_status,
    v_expires_at,coalesce(v_item.shirt_type,''),coalesce(v_item.shirt_size,'');
end;
$$;

revoke all on function public.create_manual_registration_order(
  uuid,uuid,text,text,date,text,text,text,text,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.create_manual_registration_order(
  uuid,uuid,text,text,date,text,text,text,text,text,text,text,text,text
) to authenticated;

-- Compatibilidade para consumidores antigos que ainda confirmam por pessoa. O
-- wrapper nunca escolhe silenciosamente entre duas unidades compradas.
create or replace function public.confirm_order_and_issue_ticket(p_participant_id uuid)
returns uuid
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_item_ids uuid[];
  v_ticket_ids uuid[];
begin
  select array_agg(oi.id order by oi.created_at,oi.id) into v_item_ids
  from public.order_items oi
  join public.orders o on o.id=oi.order_id
  where oi.participant_id=p_participant_id
    and oi.status not in ('cancelled','expired','refunded')
    and exists(select 1 from public.payments pay
      where pay.order_id=o.id and pay.payment_status='paid')
    and not exists(select 1 from public.tickets t where t.order_item_id=oi.id);

  if cardinality(v_item_ids)=1 then
    return public.confirm_order_item_and_issue_ticket(v_item_ids[1]);
  end if;
  if coalesce(cardinality(v_item_ids),0)>1 then
    raise exception 'Mais de um item pago sem ingresso; informe order_item_id.';
  end if;

  select array_agg(t.id order by t.issued_at,t.id) into v_ticket_ids
  from public.tickets t where t.participant_id=p_participant_id and t.status<>'cancelled';
  if cardinality(v_ticket_ids)=1 then return v_ticket_ids[1]; end if;
  if coalesce(cardinality(v_ticket_ids),0)>1 then
    raise exception 'Mais de um ingresso para o participante; informe ticket_id.';
  end if;
  raise exception 'Nenhum item pago encontrado para emissao.';
end;
$$;

commit;
