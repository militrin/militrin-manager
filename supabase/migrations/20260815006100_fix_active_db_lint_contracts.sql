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

-- Corrige somente o bloco de cupons da funcao reconciliada no baseline. Os nomes
-- atuais sao notes, valid_from e valid_until.
do $migration$
declare v_definition text;
begin
  select pg_get_functiondef('public.duplicate_event_configuration(uuid,text,text,integer,boolean,boolean,boolean,boolean,boolean,boolean,boolean)'::regprocedure)
    into v_definition;
  v_definition:=replace(v_definition,E'      description,\n      coupon_type,',E'      notes,\n      coupon_type,');
  v_definition:=replace(v_definition,E'      starts_at,\n      ends_at,',E'      valid_from,\n      valid_until,');
  v_definition:=replace(v_definition,E'      c.description,\n      c.coupon_type,',E'      c.notes,\n      c.coupon_type,');
  v_definition:=replace(v_definition,E'      c.starts_at,\n      c.ends_at,',E'      c.valid_from,\n      c.valid_until,');
  if v_definition like '%c.description%' or v_definition like '%c.starts_at%' or v_definition like '%c.ends_at%' then
    raise exception 'DUPLICATE_EVENT_COUPON_CONTRACT_PATCH_FAILED';
  end if;
  execute v_definition;
end; $migration$;

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

commit;
