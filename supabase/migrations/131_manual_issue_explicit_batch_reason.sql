-- 131_manual_issue_explicit_batch_reason.sql
-- Reescreve as duas RPCs de emissao manual de ingresso (089/090) para: (1)
-- receber o lote escolhido explicitamente pelo admin em vez de calcular
-- automaticamente o lote ativo mais barato, e (2) nunca depender de
-- confirmacao de pagamento -- a emissao manual sempre libera o ingresso na
-- hora, guardando o motivo (cortesia / falha do sistema / outro) na coluna
-- payment_method para auditoria. Por ser uma ferramenta de override
-- administrativo, ignora deliberadamente limite de vagas e data de
-- encerramento do lote (quem decide e o admin, nao a regra automatica de
-- esgotamento do checkout publico).

begin;

drop function if exists public.create_manual_registration_order(
  uuid,uuid,text,text,date,text,text,text,text,text,text,text,text,text
);

create or replace function public.create_manual_registration_order(
  p_event_id uuid,
  p_ticket_category_id uuid,
  p_batch_id uuid,
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
  v_batch_name text;
  v_base_amount numeric;
  v_pricing_gender_key text:=lower(trim(coalesce(p_gender,'')));
  v_participant public.participants%rowtype;
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_payment public.payments%rowtype;
  v_ticket_id uuid;
  v_cpf text:=regexp_replace(coalesce(p_cpf,''),'\D','','g');
  v_phone text:=regexp_replace(coalesce(p_phone,''),'\D','','g');
  v_inventory public.shirt_inventory%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.create') then
    raise exception 'Sem permissao para criar inscricao manual.';
  end if;
  if p_event_id is null or p_ticket_category_id is null or p_batch_id is null then
    raise exception 'Evento, categoria de acesso e lote sao obrigatorios.';
  end if;

  select * into v_event from public.events where id=p_event_id for share;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then
    raise exception 'Usuario sem acesso a organizacao do evento.';
  end if;

  select * into v_category from public.ticket_categories
  where id=p_ticket_category_id and event_id=p_event_id and is_active=true;
  if not found then
    raise exception 'Categoria de acesso invalida ou pertencente a outro evento.';
  end if;

  if not exists(select 1 from public.registration_batches rb where rb.id=p_batch_id and rb.event_id=p_event_id) then
    raise exception 'Lote nao pertence ao evento selecionado.';
  end if;
  select rb.name into v_batch_name from public.registration_batches rb where rb.id=p_batch_id;

  if v_pricing_gender_key in ('feminino','female','f') then
    select round(rbp.female_price,2) into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id=p_batch_id and rbp.ticket_category_id=p_ticket_category_id;
  elsif v_pricing_gender_key in ('masculino','male','m') then
    select round(rbp.male_price,2) into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id=p_batch_id and rbp.ticket_category_id=p_ticket_category_id;
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;
  if v_base_amount is null then
    raise exception 'Nao ha preco configurado para essa combinacao de categoria e lote.';
  end if;

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
    'confirmed',v_base_amount,v_base_amount,0,'account',now()
  ) returning * into v_order;

  insert into public.order_items(
    order_id,event_id,participant_id,ownership_status,holder_full_name,
    ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,
    discount_amount,final_amount,status,reservation_expires_at,notes
  ) values(
    v_order.id,p_event_id,v_participant.id,'assigned',v_participant.full_name,
    p_ticket_category_id,p_batch_id,nullif(trim(coalesce(p_shirt_type,'')),''),
    nullif(trim(coalesce(p_shirt_size,'')),''),1,v_base_amount,
    v_base_amount,0,'confirmed',null,
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
    v_base_amount,v_base_amount,0,
    lower(trim(p_payment_method)),'paid',now(),null
  ) returning * into v_payment;
  update public.orders set payment_id=v_payment.id where id=v_order.id;

  v_ticket_id:=public.confirm_order_item_and_issue_ticket(v_item.id);

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('manual_registration_order_created','orders',v_order.id,p_event_id,
    jsonb_build_object('actor_user_id',v_actor,'participant_id',v_participant.id,
      'order_item_id',v_item.id,'ticket_category_id',p_ticket_category_id,
      'batch_id',p_batch_id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
      'reason',lower(trim(p_payment_method)),'category_owner','order_items'));

  return query select v_participant.id,v_order.id,v_item.id,v_payment.id,v_ticket_id,
    v_participant.full_name,v_batch_name,v_base_amount,
    v_base_amount,0::numeric,v_payment.payment_status,
    null::timestamptz,coalesce(v_item.shirt_type,''),coalesce(v_item.shirt_size,'');
end;
$$;

revoke all on function public.create_manual_registration_order(
  uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.create_manual_registration_order(
  uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,text,text
) to authenticated;

drop function if exists public.create_manual_unassigned_ticket_order(
  uuid,uuid,text,text,text,text,text,text
);

create or replace function public.create_manual_unassigned_ticket_order(
  p_event_id uuid,
  p_ticket_category_id uuid,
  p_batch_id uuid,
  p_pricing_gender text,
  p_shirt_type text,
  p_shirt_size text,
  p_payment_method text,
  p_notes text default null
)
returns table(order_id uuid,order_item_id uuid,payment_id uuid,ticket_id uuid)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_event public.events%rowtype;
  v_base_amount numeric;
  v_pricing_gender_key text:=lower(trim(coalesce(p_pricing_gender,'')));
  v_order_id uuid;
  v_item_id uuid;
  v_payment_id uuid;
  v_ticket_id uuid;
  v_inventory public.shirt_inventory%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.create') then raise exception 'Sem permissao para emitir ingresso.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=p_event_id and is_active) then raise exception 'Categoria invalida para o evento.'; end if;
  if not exists(select 1 from public.registration_batches where id=p_batch_id and event_id=p_event_id) then raise exception 'Lote nao pertence ao evento selecionado.'; end if;

  if v_pricing_gender_key in ('feminino','female','f') then
    select round(rbp.female_price,2) into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id=p_batch_id and rbp.ticket_category_id=p_ticket_category_id;
  elsif v_pricing_gender_key in ('masculino','male','m') then
    select round(rbp.male_price,2) into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id=p_batch_id and rbp.ticket_category_id=p_ticket_category_id;
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;
  if v_base_amount is null then
    raise exception 'Nao ha preco configurado para essa combinacao de categoria e lote.';
  end if;

  insert into public.orders(user_id,participant_id,event_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,confirmed_at)
  values(v_actor,null,p_event_id,public.generate_order_number(),'confirmed',
    v_base_amount,v_base_amount,0,'account',now()) returning id into v_order_id;
  insert into public.order_items(order_id,event_id,participant_id,ownership_status,ticket_category_id,batch_id,shirt_type,shirt_size,
    quantity,unit_price,discount_amount,final_amount,status,reservation_expires_at,notes)
  values(v_order_id,p_event_id,null,'unassigned',p_ticket_category_id,p_batch_id,nullif(trim(coalesce(p_shirt_type,'')),''),
    nullif(trim(coalesce(p_shirt_size,'')),''),1,v_base_amount,v_base_amount,0,
    'confirmed',null,nullif(trim(coalesce(p_notes,'')),'')) returning id into v_item_id;
  if nullif(trim(coalesce(p_shirt_type,'')),'') is not null and nullif(trim(coalesce(p_shirt_size,'')),'') is not null then
    select * into v_inventory from public.shirt_inventory
    where event_id=p_event_id and shirt_type=p_shirt_type and shirt_size=p_shirt_size for update;
    if not found or v_inventory.total_quantity-v_inventory.reserved_quantity-v_inventory.delivered_quantity<1 then
      raise exception 'Estoque indisponivel para o modelo/tamanho selecionado.';
    end if;
    update public.shirt_inventory set reserved_quantity=reserved_quantity+1,updated_at=now() where id=v_inventory.id;
  end if;
  insert into public.payments(participant_id,event_id,organization_id,order_id,amount,discount_amount,final_amount,payment_method,payment_status,paid_at,expires_at)
  values(null,p_event_id,v_event.organization_id,v_order_id,v_base_amount,v_base_amount,0,
    lower(trim(p_payment_method)),'paid',now(),null) returning id into v_payment_id;
  update public.orders set payment_id=v_payment_id where id=v_order_id;
  v_ticket_id:=public.confirm_order_item_and_issue_ticket(v_item_id);
  return query select v_order_id,v_item_id,v_payment_id,v_ticket_id;
end;
$$;

revoke all on function public.create_manual_unassigned_ticket_order(
  uuid,uuid,uuid,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.create_manual_unassigned_ticket_order(
  uuid,uuid,uuid,text,text,text,text,text
) to authenticated;

commit;
