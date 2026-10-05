-- P1: troca de camiseta e writers residuais passam a usar o contrato
-- canonico 20261120 (canonical_shirt_available_for_new_reservation).
-- Nao edita 20261120/20261121. Nao altera checkout publico nem emissao admin.
-- Nao contem DML de estoque/ticket/order.

begin;

create or replace function public.assert_canonical_shirt_stock_for_shirt_change(
  p_event_id uuid,
  p_shirt_type text,
  p_shirt_size text,
  p_quantity integer,
  p_current_order_item_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit boolean := false;
  v_has_shirt boolean := false;
  v_type text := nullif(trim(coalesce(p_shirt_type, '')), '');
  v_size text := nullif(trim(coalesce(p_shirt_size, '')), '');
  v_qty integer := greatest(coalesce(p_quantity, 0), 0);
  v_available integer := 0;
  v_current_type text;
  v_current_size text;
begin
  if p_event_id is null then
    return;
  end if;

  select coalesce(e.limit_shirt_selection_to_stock, false)
    into v_limit
  from public.events e
  where e.id = p_event_id;

  if not found or not v_limit then
    return;
  end if;

  select exists(
    select 1
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.item_type = 'shirt'
      and eki.is_active
  ) into v_has_shirt;

  if not v_has_shirt then
    return;
  end if;

  if v_type is null or v_size is null then
    raise exception 'Camiseta obrigatoria para este evento.';
  end if;

  v_size := upper(v_size);

  if p_current_order_item_id is not null then
    select nullif(trim(coalesce(oi.shirt_type, '')), ''),
           nullif(upper(trim(coalesce(oi.shirt_size, ''))), '')
      into v_current_type, v_current_size
    from public.order_items oi
    where oi.id = p_current_order_item_id;
    if found
       and lower(coalesce(v_current_type, '')) = lower(v_type)
       and v_current_size is not distinct from v_size then
      return;
    end if;
  end if;

  if v_qty < 1 then
    return;
  end if;

  v_available := public.canonical_shirt_available_for_new_reservation(
    p_event_id, v_type, v_size, p_current_order_item_id
  );

  if v_available < v_qty then
    perform public.raise_shirt_out_of_stock(v_type, v_size, v_available);
  end if;
end;
$$;

revoke all on function public.assert_canonical_shirt_stock_for_shirt_change(uuid, text, text, integer, uuid) from public, anon, authenticated;

create or replace function public.admin_change_ticket_shirt(p_ticket_id uuid, p_new_shirt_type text, p_new_shirt_size text) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_link public.participant_kit_items%rowtype; v_old_inv public.event_kit_item_variant_inventory%rowtype;
  v_new_inv public.event_kit_item_variant_inventory%rowtype; v_qty integer; v_old_variant uuid; v_available integer; v_limit boolean := false;
begin
  if v_actor is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para trocar camiseta.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into strict v_oi from public.order_items where id=v_ticket.order_item_id for update;
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'admin_change_ticket_shirt');
  select * into strict v_item from public.event_kit_items where event_id=v_ticket.event_id and item_type='shirt' and is_active;
  if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Fornecimento de camiseta indisponivel.'; end if;
  select * into strict v_variant from public.event_kit_item_variants where kit_item_id=v_item.id and is_active and name=trim(p_new_shirt_type) and value=trim(p_new_shirt_size);
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id for update;

  if (v_ticket.status='used' or v_ticket.used_at is not null) or (found and v_link.status='delivered') then
    raise exception using errcode='P0001', message='SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION',
      detail=jsonb_build_object('code','SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION',
        'message','O tamanho não pode mais ser alterado porque este ingresso já teve kit entregue ou check-in realizado.')::text;
  end if;

  v_qty:=greatest(coalesce(v_link.quantity,v_item.quantity_per_participant),1);
  v_old_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  select coalesce(e.limit_shirt_selection_to_stock, false) into v_limit from public.events e where e.id=v_ticket.event_id;

  if v_old_variant is distinct from v_variant.id then
    -- Destino canonico ANTES de criar/soltar qualquer linha. Falha = origem intacta.
    -- Nao inserir kit inventory do destino antes do assert: linha nova com
    -- total=0 faria o helper achar linha canonica e usar shirt_inventory.total.
    perform public.assert_canonical_shirt_stock_for_shirt_change(
      v_ticket.event_id, v_variant.name, v_variant.value, v_qty, v_oi.id
    );

    select * into v_new_inv from public.event_kit_item_variant_inventory
      where kit_item_id=v_item.id and variant_id=v_variant.id for update;
    if not found then
      insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
      values(v_ticket.organization_id,v_ticket.event_id,v_item.id,v_variant.id,0)
      on conflict(kit_item_id,variant_id) do nothing;
      select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;
    end if;

    -- Evento nao limitado: preserva o gate antigo (kit.total - delivered)
    -- quando shirt_supply_mode='stock'. Evento limitado ja passou no canonico.
    if not v_limit and v_item.shirt_supply_mode='stock' then
      v_available:=greatest(coalesce(v_new_inv.total_quantity,0)-coalesce(v_new_inv.delivered_quantity,0),0);
      if v_available<v_qty then
        perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,v_available);
      end if;
    end if;

    if v_old_variant is not null then
      insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
      values(v_ticket.organization_id,v_ticket.event_id,v_item.id,v_old_variant,0)
      on conflict(kit_item_id,variant_id) do nothing;
      select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
      if found then update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
    end if;
    update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
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

create or replace function public.admin_correct_ticket_shirt_after_operation(
  p_ticket_id uuid, p_new_shirt_type text, p_new_shirt_size text, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_link public.participant_kit_items%rowtype;
  v_old_inv public.event_kit_item_variant_inventory%rowtype; v_new_inv public.event_kit_item_variant_inventory%rowtype;
  v_qty integer; v_old_variant uuid; v_was_delivered boolean; v_available integer; v_limit boolean := false;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if v_actor is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para corrigir camiseta.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into strict v_oi from public.order_items where id=v_ticket.order_item_id for update;
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'admin_correct_ticket_shirt_after_operation');
  select * into strict v_item from public.event_kit_items where event_id=v_ticket.event_id and item_type='shirt' and is_active;
  if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Fornecimento de camiseta indisponivel.'; end if;
  select * into strict v_variant from public.event_kit_item_variants where kit_item_id=v_item.id and is_active and name=trim(p_new_shirt_type) and value=trim(p_new_shirt_size);
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id for update;

  if not ((v_ticket.status='used' or v_ticket.used_at is not null) or (found and v_link.status='delivered')) then
    raise exception 'Este ingresso ainda nao teve kit entregue nem check-in; use a troca normal de tamanho.';
  end if;

  v_qty:=greatest(coalesce(v_link.quantity,v_item.quantity_per_participant),1);
  v_old_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  v_was_delivered:=found and v_link.status='delivered';
  select coalesce(e.limit_shirt_selection_to_stock, false) into v_limit from public.events e where e.id=v_ticket.event_id;

  if v_old_variant is distinct from v_variant.id then
    -- Evento limitado: destino canonico ANTES de devolver delivered/reserved
    -- da origem. Entregue continua consumindo estoque se o destino falhar.
    perform public.assert_canonical_shirt_stock_for_shirt_change(
      v_ticket.event_id, v_variant.name, v_variant.value, v_qty, v_oi.id
    );

    select * into v_new_inv from public.event_kit_item_variant_inventory
      where kit_item_id=v_item.id and variant_id=v_variant.id for update;
    if not found then
      insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
      values(v_ticket.organization_id,v_ticket.event_id,v_item.id,v_variant.id,0)
      on conflict(kit_item_id,variant_id) do nothing;
      select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;
    end if;

    if v_was_delivered then
      -- Correcao fisica preservada: origem delivered-- / destino delivered++.
      -- Evento nao limitado mantem o gate fisico antigo (kit.total-delivered).
      if not v_limit then
        v_available:=greatest(coalesce(v_new_inv.total_quantity,0)-coalesce(v_new_inv.delivered_quantity,0),0);
        if v_available<v_qty then
          perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,v_available);
        end if;
      end if;
      if v_old_variant is not null then
        select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
        if found then update public.event_kit_item_variant_inventory set delivered_quantity=greatest(delivered_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
      end if;
      update public.event_kit_item_variant_inventory set delivered_quantity=delivered_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
    else
      -- Check-in sem entrega: so reserva. Evento limitado ja validou destino.
      if v_old_variant is not null then
        insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
        values(v_ticket.organization_id,v_ticket.event_id,v_item.id,v_old_variant,0)
        on conflict(kit_item_id,variant_id) do nothing;
        select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
        if found then update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
      end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
    end if;
  end if;

  update public.order_items set shirt_type=v_variant.name,shirt_size=v_variant.value,updated_at=now() where id=v_oi.id;
  update public.participant_kit_items set variant_data=jsonb_build_object('variant_id',v_variant.id,'shirt_type',v_variant.name,'shirt_size',v_variant.value,'supply_mode',v_item.shirt_supply_mode)
    where id=v_link.id;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_shirt_admin_corrected_after_operation','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',v_actor,'actor_email',v_actor_email,'ticket_id',v_ticket.id,'kit_item_id',v_item.id,
      'previous_variant_id',v_old_variant,'new_variant_id',v_variant.id,'previous_shirt_type',v_oi.shirt_type,'previous_shirt_size',v_oi.shirt_size,
      'new_shirt_type',v_variant.name,'new_shirt_size',v_variant.value,'was_delivered',v_was_delivered,
      'reason_code',p_reason_code,'reason_text',nullif(trim(coalesce(p_reason_text,'')),'')));
  return true;
end; $$;

create or replace function public.get_admin_ticket_shirt_options(p_ticket_id uuid)
returns table(
  kit_item_id uuid,
  variant_id uuid,
  shirt_type text,
  shirt_size text,
  supply_mode text,
  physical_available integer,
  option_label text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_ticket public.tickets%rowtype;
  v_oi public.order_items%rowtype;
  v_limit boolean := false;
  v_qty integer := 1;
begin
  if auth.uid() is null or not public.current_user_has_permission('inventory.change_participant_shirt') then
    raise exception 'Sem permissao para configurar camiseta.';
  end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso.';
  end if;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id;
  select coalesce(e.limit_shirt_selection_to_stock, false) into v_limit
  from public.events e where e.id=v_ticket.event_id;
  v_qty := greatest(coalesce(v_oi.quantity, 1), 1);

  return query
  select
    eki.id,
    v.id,
    v.name,
    v.value,
    eki.shirt_supply_mode,
    case
      when not v_limit then null
      else greatest(
        coalesce(stock.available_quantity, 0)
        + case
            when lower(trim(v.name)) = lower(trim(coalesce(v_oi.shirt_type, '')))
             and upper(trim(v.value)) = upper(trim(coalesce(v_oi.shirt_size, '')))
            then v_qty else 0
          end,
        0
      )
    end,
    case
      when eki.shirt_supply_mode='made_to_order' then v.name||' / '||v.value||' - Sob encomenda'
      else v.name||' / '||v.value
    end
  from public.event_kit_items eki
  join public.event_kit_item_variants v on v.kit_item_id=eki.id and v.is_active
  left join public.get_event_shirt_stock_for_selection(v_ticket.event_id) stock
    on lower(trim(stock.shirt_type)) = lower(trim(v.name))
   and upper(trim(stock.shirt_size)) = upper(trim(v.value))
  where eki.event_id=v_ticket.event_id
    and eki.item_type='shirt'
    and eki.is_active
    and eki.shirt_supply_mode in('stock','made_to_order')
    and (
      not v_limit
      or (
        lower(trim(v.name)) = lower(trim(coalesce(v_oi.shirt_type, '')))
        and upper(trim(v.value)) = upper(trim(coalesce(v_oi.shirt_size, '')))
      )
      or coalesce(stock.available_quantity, 0) > 0
    )
  order by v.sort_order, v.name, v.value;
end;
$$;

create or replace function public.import_current_event_contact_first(
  p_import_batch_id uuid,p_import_batch_row_id uuid,p_expected_registration_contact_id uuid,
  p_full_name text,p_cpf text,p_birth_date date,p_gender text,p_phone text,p_email text,p_city text,
  p_shirt_type text,p_shirt_size text,p_registration_batch_id uuid,p_ticket_category_id uuid,
  p_payment_method text default null,p_import_issues jsonb default '[]'::jsonb,
  p_assign_holder boolean default true,p_intended_owner_contact_id uuid default null,
  p_identity_mode text default 'cadastro'
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_batch public.import_batches%rowtype; v_row public.import_batch_rows%rowtype;
  v_event public.events%rowtype; v_contact public.registration_contacts%rowtype;
  v_participant public.participants%rowtype; v_order public.orders%rowtype; v_item public.order_items%rowtype;
  v_payment public.payments%rowtype; v_ticket_id uuid; v_count integer; v_issue jsonb;
  v_cpf text:=nullif(regexp_replace(coalesce(p_cpf,''),'\D','','g'),'');
  v_email text:=lower(nullif(trim(coalesce(p_email,'')),''));
  v_phone text:=nullif(regexp_replace(coalesce(p_phone,''),'\D','','g'),'');
  v_amount numeric:=0; v_created_contact boolean:=false; v_created_participant boolean:=false;
  v_assign_holder boolean:=coalesce(p_assign_holder,true);
  v_intended uuid:=p_intended_owner_contact_id;
  v_source_amount numeric; v_price_origin text;
  v_identity_mode text;
  v_owner_user uuid;
  v_holder_name text;
begin
  if v_actor is null or not public.current_user_has_permission('imports.view') then raise exception 'Sem permissao para importar cadastros.'; end if;
  select * into v_batch from public.import_batches where id=p_import_batch_id for update;
  if not found or v_batch.import_type<>'current_event_registrations' or v_batch.imported_by<>v_actor then raise exception 'Lote de importacao invalido.'; end if;
  select * into v_event from public.events where id=v_batch.event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  select * into v_row from public.import_batch_rows where id=p_import_batch_row_id and import_batch_id=v_batch.id for update;
  if not found then raise exception 'Linha de importacao invalida.'; end if;

  if v_row.order_item_id is not null then
    select * into v_item from public.order_items where id=v_row.order_item_id;
    if found then
      select * into v_order from public.orders where id=v_item.order_id;
      select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
      return jsonb_build_object('registration_contact_id',v_item.registration_contact_id,'participant_id',v_item.participant_id,
        'order_id',v_item.order_id,'order_item_id',v_item.id,'payment_id',v_order.payment_id,'ticket_id',v_ticket_id,
        'created_contact',false,'created_participant_projection',false,'holder_assigned',v_item.ownership_status='assigned',
        'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_item.participant_id),
        'identity_mode',coalesce(v_row.identity_match_details->>'identity_mode','cadastro'));
    end if;
  end if;

  if nullif(trim(p_full_name),'') is null then raise exception 'Nome obrigatorio ausente.'; end if;
  if p_registration_batch_id is not null and not exists(select 1 from public.registration_batches where id=p_registration_batch_id and event_id=v_event.id) then raise exception 'Lote nao pertence ao evento.'; end if;
  if p_ticket_category_id is not null and not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=v_event.id) then raise exception 'Categoria nao pertence ao evento.'; end if;

  v_identity_mode:=lower(nullif(trim(coalesce(p_identity_mode,'')),''));
  v_identity_mode:=coalesce(nullif(v_identity_mode,''),nullif(v_row.identity_match_details->>'identity_mode',''),'cadastro');
  if v_row.resolution='textual_holder' then v_identity_mode:='textual_holder'; end if;

  begin
    v_source_amount := nullif(btrim(coalesce(v_row.normalized_data->>'amount','')),'')::numeric;
  exception when invalid_text_representation then
    v_source_amount := null;
  end;
  v_price_origin := coalesce(nullif(btrim(coalesce(v_row.normalized_data->>'price_origin','')),''),
    case when v_source_amount is null then 'legacy_unknown' else 'legacy_provided' end);
  if v_price_origin not in ('legacy_unknown','legacy_provided','catalog') then
    v_price_origin := case when v_source_amount is null then 'legacy_unknown' else 'legacy_provided' end;
  end if;
  if v_price_origin = 'legacy_unknown' then v_amount := 0; else v_amount := coalesce(v_source_amount, 0); end if;

  if nullif(trim(coalesce(p_shirt_type,'')),'') is not null
     or nullif(trim(coalesce(p_shirt_size,'')),'') is not null then
    perform public.assert_canonical_shirt_stock_for_manual_issue(v_event.id, p_shirt_type, p_shirt_size, 1);
  end if;

  if v_identity_mode='textual_holder' then
    v_intended:=coalesce(v_intended,v_row.intended_owner_contact_id);
    if v_intended is null then
      raise exception 'Titular textual exige a conta proprietaria (Cadastro) escolhida na revisao.';
    end if;
    select * into v_contact from public.registration_contacts
      where id=v_intended and organization_id=v_event.organization_id;
    if not found then raise exception 'Conta proprietaria indicada nao pertence a organizacao.'; end if;
    v_owner_user:=v_contact.user_id;
    v_holder_name:=trim(p_full_name);
    select * into v_participant from public.participants
      where event_id=v_event.id and registration_contact_id=v_contact.id limit 1;
    if v_participant.id is null then
      raise exception 'Importe primeiro o Cadastro proprietario antes do titular textual.';
    end if;
    insert into public.payments(participant_id,event_id,organization_id,amount,discount_amount,final_amount,payment_method,payment_status,price_origin)
    values(v_participant.id,v_event.id,v_event.organization_id,v_amount,0,v_amount,nullif(btrim(coalesce(p_payment_method,'')),''),'pending',v_price_origin)
    returning * into v_payment;
    insert into public.orders(user_id,participant_id,event_id,organization_id,payment_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,import_batch_id,price_origin)
    values(v_owner_user,v_participant.id,v_event.id,v_event.organization_id,v_payment.id,public.generate_order_number(),'pending',v_amount,0,v_amount,'imported_holder',v_batch.id,v_price_origin)
    returning * into v_order;
    update public.payments set order_id=v_order.id where id=v_payment.id;
    insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,intended_owner_contact_id,ownership_status,holder_full_name,
      ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status,price_origin)
    values(v_order.id,v_event.id,null,null,v_intended,'assigned',v_holder_name,
      p_ticket_category_id,p_registration_batch_id,nullif(trim(p_shirt_type),''),nullif(upper(trim(p_shirt_size)),''),1,v_amount,0,v_amount,'reserved',v_price_origin)
    returning * into v_item;
    update public.import_batch_rows set registration_contact_id=null,matched_participant_id=null,
      matched_user_id=null,order_item_id=v_item.id,ticket_id=null,intended_owner_contact_id=v_intended,
      identity_match_details=coalesce(identity_match_details,'{}'::jsonb)||jsonb_build_object('identity_mode','textual_holder')
      where id=v_row.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('import_textual_holder_created','order_items',v_item.id,v_event.id,jsonb_build_object(
      'actor_user_id',v_actor,'import_batch_id',v_batch.id,'import_batch_row_id',v_row.id,
      'order_id',v_order.id,'order_item_id',v_item.id,'holder_full_name',v_holder_name,
      'intended_owner_contact_id',v_intended,'created_contact',false,'identity_mode','textual_holder'));
    return jsonb_build_object('registration_contact_id',null,'participant_id',null,
      'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
      'created_contact',false,'created_participant_projection',false,'holder_assigned',true,
      'has_issuance_blockers',false,'price_origin',v_price_origin,'identity_mode','textual_holder');
  end if;

  if p_expected_registration_contact_id is not null then
    select * into v_contact from public.registration_contacts where id=p_expected_registration_contact_id and organization_id=v_event.organization_id for update;
    if not found then raise exception 'Cadastro indicado nao pertence a organizacao.'; end if;
    if public.is_valid_cpf(v_contact.cpf) and public.is_valid_cpf(v_cpf)
      and regexp_replace(v_contact.cpf,'\D','','g')<>v_cpf then raise exception 'CPF do cadastro indicado diverge da linha.'; end if;
  elsif public.is_valid_cpf(v_cpf) then
    select count(*),(array_agg(rc.id order by rc.id))[1] into v_count,v_contact.id
    from public.registration_contacts rc where rc.organization_id=v_event.organization_id
      and regexp_replace(coalesce(rc.cpf,''),'\D','','g')=v_cpf;
    if v_count>1 then raise exception 'Conflito de identidade: CPF possui mais de um cadastro. Revise a linha.'; end if;
    if v_count=1 then select * into v_contact from public.registration_contacts where id=v_contact.id for update; end if;
  end if;

  if v_contact.id is null then
    insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city,created_by)
    values(v_event.organization_id,trim(p_full_name),case when public.is_valid_cpf(v_cpf) then v_cpf end,p_birth_date,
      nullif(trim(p_gender),''),v_phone,v_email,nullif(trim(p_city),''),v_actor) returning * into v_contact;
    v_created_contact:=true;
  else
    update public.registration_contacts set
      full_name=case when nullif(trim(full_name),'') is null then trim(p_full_name) else full_name end,
      cpf=case when public.is_valid_cpf(cpf) then cpf when public.is_valid_cpf(v_cpf) then v_cpf else cpf end,
      birth_date=coalesce(birth_date,p_birth_date),gender=coalesce(gender,nullif(trim(p_gender),'')),
      phone=coalesce(phone,v_phone),email=coalesce(email,v_email),city=coalesce(city,nullif(trim(p_city),'')),updated_at=now()
    where id=v_contact.id returning * into v_contact;
  end if;

  v_intended:=coalesce(v_intended,v_row.intended_owner_contact_id,v_contact.id);
  if v_intended is not null and not exists(
    select 1 from public.registration_contacts rc where rc.id=v_intended and rc.organization_id=v_event.organization_id
  ) then raise exception 'Conta proprietaria indicada nao pertence a organizacao.'; end if;

  select * into v_participant from public.participants
  where event_id=v_event.id and registration_contact_id=v_contact.id for update;
  if not found then
    insert into public.participants(event_id,organization_id,registration_contact_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,
      registration_status,reservation_status,notes)
    values(v_event.id,v_event.organization_id,v_contact.id,null,v_contact.full_name,v_contact.cpf,v_contact.birth_date,v_contact.gender,
      v_contact.phone,v_contact.email,v_contact.city,'pending','pending','LEGACY projection created by contact-first import')
    returning * into v_participant;
    v_created_participant:=true;
  end if;

  if v_assign_holder and exists(
    select 1 from public.order_items oi
    where oi.event_id=v_event.id and oi.registration_contact_id=v_contact.id
      and coalesce(oi.ownership_status,'unassigned')='assigned'
      and oi.status not in('cancelled','expired','refunded')
  ) then v_assign_holder:=false; end if;

  insert into public.payments(participant_id,event_id,organization_id,amount,discount_amount,final_amount,payment_method,payment_status,price_origin)
  values(v_participant.id,v_event.id,v_event.organization_id,v_amount,0,v_amount,nullif(btrim(coalesce(p_payment_method,'')),''),'pending',v_price_origin) returning * into v_payment;
  insert into public.orders(user_id,participant_id,event_id,organization_id,payment_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,import_batch_id,price_origin)
  values(null,v_participant.id,v_event.id,v_event.organization_id,v_payment.id,public.generate_order_number(),'pending',v_amount,0,v_amount,'imported_holder',v_batch.id,v_price_origin) returning * into v_order;
  update public.payments set order_id=v_order.id where id=v_payment.id;
  insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,intended_owner_contact_id,ownership_status,holder_full_name,
    ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status,price_origin)
  values(v_order.id,v_event.id,case when v_assign_holder then v_participant.id end,v_contact.id,v_intended,
    case when v_assign_holder then 'assigned' else 'unassigned' end,case when v_assign_holder then v_contact.full_name end,
    p_ticket_category_id,p_registration_batch_id,nullif(trim(p_shirt_type),''),nullif(upper(trim(p_shirt_size)),''),1,v_amount,0,v_amount,'reserved',v_price_origin) returning * into v_item;

  update public.import_batch_rows set registration_contact_id=v_contact.id,matched_participant_id=v_participant.id,
    matched_user_id=v_participant.user_id,order_item_id=v_item.id,ticket_id=null,intended_owner_contact_id=v_intended where id=v_row.id;

  for v_issue in select value from jsonb_array_elements(coalesce(p_import_issues,'[]'::jsonb)) loop
    insert into public.participant_data_issues(organization_id,event_id,participant_id,registration_contact_id,import_batch_id,order_item_id,ticket_id,
      field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery,resolution_scope)
    values(v_event.organization_id,v_event.id,v_participant.id,v_contact.id,v_batch.id,v_item.id,null,
      v_issue->>'field_code',v_issue->>'issue_type',v_issue->>'message',coalesce((v_issue->>'blocks_payment')::boolean,false),
      coalesce((v_issue->>'blocks_ticket_issuance')::boolean,false),coalesce((v_issue->>'blocks_checkin')::boolean,false),
      coalesce((v_issue->>'blocks_kit_delivery')::boolean,false),
      coalesce(nullif(v_issue->>'resolution_scope',''), case when v_issue->>'field_code'='cpf' then 'user_resolvable' else 'admin_only' end))
    on conflict do nothing;
  end loop;
  update public.participant_data_issues set registration_contact_id=v_contact.id,order_item_id=v_item.id
    where participant_id=v_participant.id and import_batch_id=v_batch.id and status='open';

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values(case when v_created_contact then 'import_person_created' else 'import_person_reused' end,'registration_contacts',v_contact.id,v_event.id,
    jsonb_build_object('actor_user_id',v_actor,'import_batch_id',v_batch.id,'import_batch_row_id',v_row.id,
      'order_id',v_order.id,'order_item_id',v_item.id,'additional_purchase',not v_created_participant or not v_assign_holder,
      'holder_assigned',v_assign_holder,'intended_owner_contact_id',v_intended,'shirt_type',p_shirt_type,'shirt_size',p_shirt_size,
      'price_origin',v_price_origin,'legacy_amount',v_source_amount,'identity_mode','cadastro'));

  return jsonb_build_object('registration_contact_id',v_contact.id,'participant_id',v_participant.id,
    'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
    'created_contact',v_created_contact,'created_participant_projection',v_created_participant,'holder_assigned',v_assign_holder,
    'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_participant.id),
    'price_origin',v_price_origin,'identity_mode','cadastro');
end; $$;

-- Inner de checkout: authenticated nao pode chamar via PostgREST.
-- Wrappers create_multi_ticket_order_checkout e
-- create_multi_ticket_order_checkout_inventory_legacy sao SECURITY DEFINER
-- owner postgres; a invocacao interna continua autorizada pelo owner,
-- mesmo apos REVOKE de anon/authenticated/public.
revoke all on function public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)
  to service_role;

commit;
