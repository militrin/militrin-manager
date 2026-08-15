-- Corrige contratos ativos apontados pelo plpgsql_check sem reabrir fontes legadas.
begin;

create or replace function public.set_event_shirt_stock_limit(p_event_id uuid,p_enabled boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_event public.events%rowtype; v_actor uuid:=auth.uid(); v_actor_email text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('inventory.limit_selection') then raise exception 'Sem permissao para alterar limitacao de estoque.'; end if;
  if p_event_id is null then raise exception 'Evento obrigatorio.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso a organizacao.'; end if;
  select lower(email) into v_actor_email from auth.users where id=v_actor;
  update public.events set limit_shirt_selection_to_stock=coalesce(p_enabled,false),updated_at=now() where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('inventory_limit_selection_updated','events',p_event_id,p_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'actor_email',v_actor_email,'before',coalesce(v_event.limit_shirt_selection_to_stock,false),
    'after',coalesce(p_enabled,false)));
  return true;
end; $$;

create or replace function public.reset_event_shirt_inventory(p_event_id uuid,p_clear_history boolean,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event public.events%rowtype; v_actor uuid:=auth.uid(); v_actor_email text;
  v_before_snapshot jsonb:='[]'::jsonb; v_inventory_rows integer:=0; v_movements_before integer:=0;
  v_movements_deleted integer:=0; v_active_reservations integer:=0; v_delivered_kits integer:=0;
  v_confirmed_tickets integer:=0; v_reason text:=nullif(trim(coalesce(p_reason,'')),'');
  v_mode text:=case when coalesce(p_clear_history,false) then 'full' else 'simple' end;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_event_id is null then raise exception 'Evento obrigatorio.'; end if;
  if coalesce(p_clear_history,false) then
    if not public.current_user_has_permission('inventory.clear_history') then raise exception 'Sem permissao para limpar historico de estoque.'; end if;
  elsif not public.current_user_has_permission('inventory.reset') then raise exception 'Sem permissao para zerar estoque.';
  end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso a organizacao.'; end if;
  select lower(email) into v_actor_email from auth.users where id=v_actor;
  perform 1 from public.shirt_inventory si where si.event_id=p_event_id for update;
  select coalesce(jsonb_agg(jsonb_build_object('id',si.id,'shirt_type',si.shirt_type,'shirt_size',si.shirt_size,
    'total_quantity',si.total_quantity,'reserved_quantity',si.reserved_quantity,'delivered_quantity',si.delivered_quantity)
    order by si.shirt_type,si.shirt_size),'[]'::jsonb),count(*)::integer
  into v_before_snapshot,v_inventory_rows from public.shirt_inventory si where si.event_id=p_event_id;
  select count(*)::integer into v_movements_before from public.inventory_movements where event_id=p_event_id;
  select count(*)::integer into v_active_reservations from public.order_items where event_id=p_event_id and status='reserved';
  select count(*)::integer into v_delivered_kits from public.participant_kit_items where event_id=p_event_id and status='delivered';
  select count(*)::integer into v_confirmed_tickets from public.tickets where event_id=p_event_id and status in('active','used');
  if coalesce(p_clear_history,false) and (v_delivered_kits>0 or v_confirmed_tickets>0) then
    raise exception 'Limpeza de historico bloqueada: existem entregas reais ou tickets confirmados neste evento. Use a zeragem simples.';
  end if;
  update public.shirt_inventory set total_quantity=0,reserved_quantity=0,delivered_quantity=0,updated_at=now() where event_id=p_event_id;
  if coalesce(p_clear_history,false) then
    delete from public.inventory_movements where event_id=p_event_id;
    get diagnostics v_movements_deleted=row_count;
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('inventory_event_reset','events',p_event_id,p_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'actor_email',v_actor_email,'mode',v_mode,'reason',coalesce(v_reason,'sem motivo informado'),
    'inventory_rows',v_inventory_rows,'movements_before',v_movements_before,'movements_deleted',v_movements_deleted,
    'active_reservations',v_active_reservations,'delivered_kits',v_delivered_kits,'confirmed_tickets',v_confirmed_tickets,
    'before_snapshot',v_before_snapshot,'cleared_history',coalesce(p_clear_history,false)));
  return jsonb_build_object('event_id',p_event_id,'mode',v_mode,'inventory_rows',v_inventory_rows,
    'movements_before',v_movements_before,'movements_deleted',v_movements_deleted,'active_reservations',v_active_reservations,
    'delivered_kits',v_delivered_kits,'confirmed_tickets',v_confirmed_tickets);
end; $$;

-- A rotina continua legada e sem consumidor normal; a chamada explicita elimina a
-- ambiguidade entre os overloads sem voltar a usar participant como identidade.
create or replace function public.admin_transfer_ticket_holder(p_ticket_id uuid,p_target_participant_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_contact uuid;
begin
  select p.registration_contact_id into v_contact from public.participants p where p.id=p_target_participant_id;
  if v_contact is null then raise exception 'Participante sem cadastro global vinculado.'; end if;
  return public.admin_set_ticket_holder_contact(p_ticket_id,v_contact,'legacy_unclassified'::text,
    nullif(trim(coalesce(p_reason,'')),'')::text);
end; $$;
revoke all on function public.admin_transfer_ticket_holder(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_transfer_ticket_holder(uuid,uuid,text) to service_role;

-- Recriada diretamente (sem patch textual sobre pg_get_functiondef) para corrigir o
-- bloco de cupons: os nomes atuais em public.coupons sao notes, valid_from e
-- valid_until. Todo o restante do comportamento e identico ao baseline reconciliado.
create or replace function public.duplicate_event_configuration(
  p_source_event_id uuid,p_target_name text,p_target_slug text,p_target_year integer default null,
  p_copy_categories boolean default true,p_copy_kit_items boolean default true,p_copy_benefits boolean default true,
  p_copy_batches boolean default true,p_copy_batch_prices boolean default true,p_copy_inventory_structure boolean default true,
  p_copy_coupons boolean default false
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_target_event_id uuid;
  v_item record;
  v_new_item_id uuid;
  v_new_batch_id uuid;
  v_batch record;
  v_open_bar_id uuid;
  v_target_category_id uuid;
begin
  if p_source_event_id is null then
    raise exception 'Evento de origem obrigatorio.';
  end if;

  v_target_event_id := public.create_event(
    p_target_name,
    p_target_slug,
    p_target_year,
    null,
    null,
    null,
    null,
    null,
    null,
    false,
    false,
    true
  );

  if p_copy_categories then
    insert into public.ticket_categories (
      event_id,
      name,
      slug,
      description,
      capacity,
      is_active,
      sort_order
    )
    select
      v_target_event_id,
      tc.name,
      tc.slug,
      tc.description,
      tc.capacity,
      tc.is_active,
      tc.sort_order
    from public.ticket_categories tc
    where tc.event_id = p_source_event_id
    on conflict (event_id, slug) do nothing;

    if p_copy_benefits then
      insert into public.ticket_category_benefits (
        ticket_category_id,
        name,
        description,
        sort_order
      )
      select
        tc_target.id,
        b.name,
        b.description,
        b.sort_order
      from public.ticket_category_benefits b
      join public.ticket_categories tc_source
        on tc_source.id = b.ticket_category_id
      join public.ticket_categories tc_target
        on tc_target.event_id = v_target_event_id
       and tc_target.slug = tc_source.slug
      where tc_source.event_id = p_source_event_id;
    end if;
  end if;

  if p_copy_kit_items then
    for v_item in
      select *
      from public.event_kit_items
      where event_id = p_source_event_id
      order by sort_order asc, created_at asc
    loop
      v_new_item_id := public.upsert_event_kit_item(
        null,
        v_target_event_id,
        v_item.name,
        v_item.slug,
        v_item.description,
        v_item.item_type,
        v_item.quantity_per_participant,
        v_item.requires_variant,
        v_item.is_required,
        v_item.is_active,
        v_item.sort_order
      );

      insert into public.event_kit_item_variants (
        kit_item_id,
        name,
        value,
        sort_order,
        is_active
      )
      select
        v_new_item_id,
        v.name,
        v.value,
        v.sort_order,
        v.is_active
      from public.event_kit_item_variants v
      where v.kit_item_id = v_item.id;
    end loop;
  end if;

  if p_copy_batches then
    for v_batch in
      select *
      from public.registration_batches
      where event_id = p_source_event_id
      order by sequence_number asc
    loop
      v_new_batch_id := public.create_registration_batch(
        v_target_event_id,
        v_batch.name,
        v_batch.sequence_number,
        v_batch.male_price,
        v_batch.female_price,
        v_batch.max_confirmed_registrations,
        v_batch.starts_at,
        v_batch.ends_at,
        false
      );

      if p_copy_batch_prices then
        insert into public.registration_batch_prices (
          batch_id,
          ticket_category_id,
          male_price,
          female_price
        )
        select
          v_new_batch_id,
          tc_target.id,
          rbp.male_price,
          rbp.female_price
        from public.registration_batch_prices rbp
        join public.ticket_categories tc_source
          on tc_source.id = rbp.ticket_category_id
        join public.ticket_categories tc_target
          on tc_target.event_id = v_target_event_id
         and tc_target.slug = tc_source.slug
        where rbp.batch_id = v_batch.id
        on conflict (batch_id, ticket_category_id)
        do update set
          male_price = excluded.male_price,
          female_price = excluded.female_price,
          updated_at = now();
      end if;
    end loop;
  end if;

  if p_copy_inventory_structure then
    insert into public.shirt_inventory (
      event_id,
      shirt_type,
      shirt_size,
      total_quantity,
      reserved_quantity,
      delivered_quantity
    )
    select
      v_target_event_id,
      si.shirt_type,
      si.shirt_size,
      0,
      0,
      0
    from public.shirt_inventory si
    where si.event_id = p_source_event_id
    on conflict (event_id, shirt_type, shirt_size)
    do nothing;
  end if;

  if p_copy_coupons then
    insert into public.coupons (
      event_id,
      code,
      notes,
      coupon_type,
      discount_percent,
      max_uses,
      used_count,
      valid_from,
      valid_until,
      is_active
    )
    select
      v_target_event_id,
      c.code,
      c.notes,
      c.coupon_type,
      c.discount_percent,
      c.max_uses,
      0,
      c.valid_from,
      c.valid_until,
      false
    from public.coupons c
    where c.event_id = p_source_event_id
    on conflict (event_id, code)
    do nothing;
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_configuration_duplicated',
    'events',
    v_target_event_id,
    v_target_event_id,
    jsonb_build_object(
      'source_event_id', p_source_event_id,
      'copy_categories', p_copy_categories,
      'copy_kit_items', p_copy_kit_items,
      'copy_benefits', p_copy_benefits,
      'copy_batches', p_copy_batches,
      'copy_batch_prices', p_copy_batch_prices,
      'copy_inventory_structure', p_copy_inventory_structure,
      'copy_coupons', p_copy_coupons
    )
  );

  return v_target_event_id;
end;
$$;

create or replace function public.materialize_event_ticket_kit_items(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket record; v_result jsonb; v_results jsonb:='[]'::jsonb; v_processed integer:=0; v_created integer:=0; v_skipped integer:=0; v_org uuid;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para vincular itens.'; end if;
  select organization_id into v_org from public.events where id=p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Evento invalido ou sem acesso.'; end if;
  for v_ticket in select id from public.tickets where event_id=p_event_id and status<>'cancelled' order by issued_at loop
    begin
      v_result:=public.materialize_ticket_kit_items_internal(v_ticket.id,'operations_batch');
      v_processed:=v_processed+1; v_created:=v_created+coalesce((v_result->>'created_count')::integer,0);
      v_skipped:=v_skipped+coalesce((v_result->>'skipped_count')::integer,0); v_results:=v_results||jsonb_build_array(v_result);
    exception when others then
      v_skipped:=v_skipped+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('ticket_id',v_ticket.id,'error',sqlerrm));
    end;
  end loop;
  return jsonb_build_object('event_id',p_event_id,'processed_tickets',v_processed,'created_count',v_created,'skipped_count',v_skipped,'results',v_results);
end; $$;

revoke all on function public.set_event_shirt_stock_limit(uuid,boolean),public.reset_event_shirt_inventory(uuid,boolean,text),
  public.duplicate_event_configuration(uuid,text,text,integer,boolean,boolean,boolean,boolean,boolean,boolean,boolean),
  public.materialize_event_ticket_kit_items(uuid) from public,anon;
grant execute on function public.set_event_shirt_stock_limit(uuid,boolean),public.reset_event_shirt_inventory(uuid,boolean,text),
  public.duplicate_event_configuration(uuid,text,text,integer,boolean,boolean,boolean,boolean,boolean,boolean,boolean),
  public.materialize_event_ticket_kit_items(uuid) to authenticated,service_role;

-- RPCs legadas de inventario (public.shirt_inventory) sem consumidor em src/: mesmo bug
-- de audit_logs.actor (coluna inexistente) das funcoes acima. Sem candidato ativo na
-- aplicacao, ficam restritas a service_role em vez de reabertas para authenticated/anon.

create or replace function public.create_inventory_item(p_shirt_type text,p_shirt_size text,p_total_quantity integer)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event_id uuid;
  v_item_id uuid;
  v_actor uuid:=auth.uid();
  v_actor_email text;
begin
  select id into v_event_id from public.events where is_active=true order by created_at desc limit 1;
  if v_event_id is null then raise exception 'Nenhum evento ativo encontrado.'; end if;
  if p_shirt_type not in('Camiseta','Babylook') then raise exception 'Modelo invalido. Use Camiseta ou Babylook.'; end if;
  if p_shirt_type='Camiseta' and p_shirt_size not in('PP','P','M','G','GG','EG','EXG','EXGG') then raise exception 'Tamanho invalido para Camiseta.'; end if;
  if p_shirt_type='Babylook' and p_shirt_size not in('PP','P','M','G','GG','EG') then raise exception 'Tamanho invalido para Babylook.'; end if;
  if p_total_quantity is null or p_total_quantity<0 then raise exception 'Quantidade total deve ser maior ou igual a zero.'; end if;
  if exists(select 1 from public.shirt_inventory where event_id=v_event_id and shirt_type=p_shirt_type and shirt_size=p_shirt_size) then
    raise exception 'Ja existe uma linha para este modelo e tamanho no evento ativo.';
  end if;
  insert into public.shirt_inventory(event_id,shirt_type,shirt_size,total_quantity,reserved_quantity,delivered_quantity)
  values(v_event_id,p_shirt_type,p_shirt_size,p_total_quantity,0,0) returning id into v_item_id;
  select lower(email) into v_actor_email from auth.users where id=v_actor;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('inventory_item_created','shirt_inventory',v_item_id,v_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'actor_email',v_actor_email,'shirt_type',p_shirt_type,'shirt_size',p_shirt_size,
    'total_quantity',p_total_quantity,'reserved_quantity',0,'delivered_quantity',0));
  return v_item_id;
end; $$;

create or replace function public.create_inventory_item(p_event_id uuid,p_shirt_type text,p_shirt_size text,p_total_quantity integer)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_item_id uuid;
  v_actor uuid:=auth.uid();
  v_actor_email text;
  v_event_exists boolean:=false;
begin
  if p_event_id is null then raise exception 'Evento obrigatorio.'; end if;
  if coalesce(trim(p_shirt_type),'')='' then raise exception 'Modelo obrigatorio.'; end if;
  if coalesce(trim(p_shirt_size),'')='' then raise exception 'Tamanho obrigatorio.'; end if;
  if p_total_quantity is null or p_total_quantity<0 then raise exception 'Quantidade total deve ser maior ou igual a zero.'; end if;
  select exists(select 1 from public.events where id=p_event_id) into v_event_exists;
  if not v_event_exists then raise exception 'Evento nao encontrado.'; end if;
  if exists(select 1 from public.shirt_inventory where event_id=p_event_id and shirt_type=p_shirt_type and shirt_size=p_shirt_size) then
    raise exception 'Ja existe uma linha para este modelo e tamanho neste evento.';
  end if;
  insert into public.shirt_inventory(event_id,shirt_type,shirt_size,total_quantity,reserved_quantity,delivered_quantity)
  values(p_event_id,p_shirt_type,p_shirt_size,p_total_quantity,0,0) returning id into v_item_id;
  select lower(email) into v_actor_email from auth.users where id=v_actor;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('inventory_item_created','shirt_inventory',v_item_id,p_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'actor_email',v_actor_email,'shirt_type',p_shirt_type,'shirt_size',p_shirt_size,
    'total_quantity',p_total_quantity,'reserved_quantity',0,'delivered_quantity',0));
  return v_item_id;
end; $$;

create or replace function public.delete_inventory_item(p_inventory_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event_id uuid;
  v_actor uuid:=auth.uid();
  v_actor_email text;
  v_item public.shirt_inventory%rowtype;
begin
  select id into v_event_id from public.events where is_active=true order by created_at desc limit 1;
  if v_event_id is null then raise exception 'Nenhum evento ativo encontrado.'; end if;
  if p_inventory_id is null then raise exception 'ID do item e obrigatorio.'; end if;
  select * into v_item from public.shirt_inventory where id=p_inventory_id for update;
  if not found then raise exception 'Linha de estoque nao encontrada.'; end if;
  if v_item.event_id is distinct from v_event_id then raise exception 'Apenas o estoque do evento ativo pode ser excluido.'; end if;
  delete from public.shirt_inventory where id=p_inventory_id;
  select lower(email) into v_actor_email from auth.users where id=v_actor;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('inventory_item_deleted','shirt_inventory',p_inventory_id,v_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'actor_email',v_actor_email,'shirt_type',v_item.shirt_type,'shirt_size',v_item.shirt_size,
    'total_quantity',v_item.total_quantity,'reserved_quantity',v_item.reserved_quantity,'delivered_quantity',v_item.delivered_quantity));
  return true;
end; $$;

create or replace function public.delete_inventory_item(p_event_id uuid,p_inventory_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_item public.shirt_inventory%rowtype;
  v_actor uuid:=auth.uid();
  v_actor_email text;
begin
  if p_event_id is null then raise exception 'Evento obrigatorio.'; end if;
  if p_inventory_id is null then raise exception 'ID do item e obrigatorio.'; end if;
  select * into v_item from public.shirt_inventory where id=p_inventory_id and event_id=p_event_id for update;
  if not found then raise exception 'Linha de estoque nao encontrada para o evento informado.'; end if;
  delete from public.shirt_inventory where id=p_inventory_id;
  select lower(email) into v_actor_email from auth.users where id=v_actor;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('inventory_item_deleted','shirt_inventory',p_inventory_id,p_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'actor_email',v_actor_email,'shirt_type',v_item.shirt_type,'shirt_size',v_item.shirt_size,
    'total_quantity',v_item.total_quantity,'reserved_quantity',v_item.reserved_quantity,'delivered_quantity',v_item.delivered_quantity));
  return true;
end; $$;

create or replace function public.update_inventory_item(p_inventory_id uuid,p_shirt_type text,p_shirt_size text,p_total_quantity integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event_id uuid;
  v_actor uuid:=auth.uid();
  v_actor_email text;
  v_item public.shirt_inventory%rowtype;
begin
  select id into v_event_id from public.events where is_active=true order by created_at desc limit 1;
  if v_event_id is null then raise exception 'Nenhum evento ativo encontrado.'; end if;
  if p_inventory_id is null then raise exception 'ID do item e obrigatorio.'; end if;
  if p_shirt_type not in('Camiseta','Babylook') then raise exception 'Modelo invalido. Use Camiseta ou Babylook.'; end if;
  if p_shirt_type='Camiseta' and p_shirt_size not in('PP','P','M','G','GG','EG','EXG','EXGG') then raise exception 'Tamanho invalido para Camiseta.'; end if;
  if p_shirt_type='Babylook' and p_shirt_size not in('PP','P','M','G','GG','EG') then raise exception 'Tamanho invalido para Babylook.'; end if;
  if p_total_quantity is null or p_total_quantity<0 then raise exception 'Quantidade total deve ser maior ou igual a zero.'; end if;
  select * into v_item from public.shirt_inventory where id=p_inventory_id for update;
  if not found then raise exception 'Linha de estoque nao encontrada.'; end if;
  if v_item.event_id is distinct from v_event_id then raise exception 'Apenas o estoque do evento ativo pode ser alterado.'; end if;
  if (v_item.reserved_quantity+v_item.delivered_quantity)>p_total_quantity then raise exception 'Total deve ser maior ou igual a reservadas + entregues.'; end if;
  if exists(select 1 from public.shirt_inventory where event_id=v_event_id and shirt_type=p_shirt_type and shirt_size=p_shirt_size and id<>p_inventory_id) then
    raise exception 'Ja existe outra linha para este modelo e tamanho no evento ativo.';
  end if;
  update public.shirt_inventory set shirt_type=p_shirt_type,shirt_size=p_shirt_size,total_quantity=p_total_quantity,updated_at=now() where id=p_inventory_id;
  select lower(email) into v_actor_email from auth.users where id=v_actor;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('inventory_item_updated','shirt_inventory',p_inventory_id,v_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'actor_email',v_actor_email,
    'before',jsonb_build_object('shirt_type',v_item.shirt_type,'shirt_size',v_item.shirt_size,'total_quantity',v_item.total_quantity,
      'reserved_quantity',v_item.reserved_quantity,'delivered_quantity',v_item.delivered_quantity),
    'after',jsonb_build_object('shirt_type',p_shirt_type,'shirt_size',p_shirt_size,'total_quantity',p_total_quantity,
      'reserved_quantity',v_item.reserved_quantity,'delivered_quantity',v_item.delivered_quantity)));
  return true;
end; $$;

create or replace function public.update_inventory_item(p_event_id uuid,p_inventory_id uuid,p_shirt_type text,p_shirt_size text,p_total_quantity integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid();
  v_actor_email text;
  v_item public.shirt_inventory%rowtype;
begin
  if p_event_id is null then raise exception 'Evento obrigatorio.'; end if;
  if p_inventory_id is null then raise exception 'ID do item e obrigatorio.'; end if;
  if coalesce(trim(p_shirt_type),'')='' then raise exception 'Modelo obrigatorio.'; end if;
  if coalesce(trim(p_shirt_size),'')='' then raise exception 'Tamanho obrigatorio.'; end if;
  if p_total_quantity is null or p_total_quantity<0 then raise exception 'Quantidade total deve ser maior ou igual a zero.'; end if;
  select * into v_item from public.shirt_inventory where id=p_inventory_id and event_id=p_event_id for update;
  if not found then raise exception 'Linha de estoque nao encontrada para o evento informado.'; end if;
  if (v_item.reserved_quantity+v_item.delivered_quantity)>p_total_quantity then raise exception 'Total deve ser maior ou igual a reservadas + entregues.'; end if;
  if exists(select 1 from public.shirt_inventory where event_id=p_event_id and shirt_type=p_shirt_type and shirt_size=p_shirt_size and id<>p_inventory_id) then
    raise exception 'Ja existe outra linha para este modelo e tamanho neste evento.';
  end if;
  update public.shirt_inventory set shirt_type=p_shirt_type,shirt_size=p_shirt_size,total_quantity=p_total_quantity,updated_at=now() where id=p_inventory_id;
  select lower(email) into v_actor_email from auth.users where id=v_actor;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('inventory_item_updated','shirt_inventory',p_inventory_id,p_event_id,jsonb_build_object(
    'actor_user_id',v_actor,'actor_email',v_actor_email,
    'before',jsonb_build_object('shirt_type',v_item.shirt_type,'shirt_size',v_item.shirt_size,'total_quantity',v_item.total_quantity,
      'reserved_quantity',v_item.reserved_quantity,'delivered_quantity',v_item.delivered_quantity),
    'after',jsonb_build_object('shirt_type',p_shirt_type,'shirt_size',p_shirt_size,'total_quantity',p_total_quantity,
      'reserved_quantity',v_item.reserved_quantity,'delivered_quantity',v_item.delivered_quantity)));
  return true;
end; $$;

revoke all on function public.create_inventory_item(text,text,integer),public.create_inventory_item(uuid,text,text,integer),
  public.delete_inventory_item(uuid),public.delete_inventory_item(uuid,uuid),
  public.update_inventory_item(uuid,text,text,integer),public.update_inventory_item(uuid,uuid,text,text,integer)
  from public,anon,authenticated;
grant execute on function public.create_inventory_item(text,text,integer),public.create_inventory_item(uuid,text,text,integer),
  public.delete_inventory_item(uuid),public.delete_inventory_item(uuid,uuid),
  public.update_inventory_item(uuid,text,text,integer),public.update_inventory_item(uuid,uuid,text,text,integer)
  to service_role;

commit;
