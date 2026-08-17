


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."activate_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_batch public.registration_batches%rowtype;
begin
  if p_batch_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select * into v_batch
  from public.registration_batches
  where id = p_batch_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Lote nao encontrado para o evento.';
  end if;

  update public.registration_batches
  set is_active = false,
      updated_at = now()
  where event_id = p_event_id
    and id <> p_batch_id;

  update public.registration_batches
  set is_active = true,
      updated_at = now()
  where id = p_batch_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_activated',
    'registration_batches',
    p_batch_id,
    jsonb_build_object('sequence_number', v_batch.sequence_number),
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."activate_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_inventory_quantity"("p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid;
  v_item public.shirt_inventory%rowtype;
  v_new_total integer;
begin
  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantidade deve ser maior que zero.';
  end if;

  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada.';
  end if;

  if v_item.event_id is distinct from v_event_id then
    raise exception 'Apenas o estoque do evento ativo pode ser alterado.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = total_quantity + p_quantity,
    updated_at = now()
  where id = p_inventory_id
  returning total_quantity into v_new_total;

  insert into public.inventory_movements (
    event_id,
    inventory_id,
    movement_type,
    quantity,
    notes
  ) values (
    v_event_id,
    p_inventory_id,
    'purchase',
    p_quantity,
    nullif(trim(p_notes), '')
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'inventory_quantity_added',
    'shirt_inventory',
    p_inventory_id,
    jsonb_build_object(
      'movement_type', 'purchase',
      'quantity', p_quantity,
      'notes', nullif(trim(p_notes), ''),
      'previous_total', v_item.total_quantity,
      'new_total', v_new_total,
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size
    ),
    v_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."add_inventory_quantity"("p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_item public.shirt_inventory%rowtype;
  v_new_total integer;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantidade deve ser maior que zero.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada para o evento informado.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = total_quantity + p_quantity,
    updated_at = now()
  where id = p_inventory_id
  returning total_quantity into v_new_total;

  insert into public.inventory_movements (
    event_id,
    inventory_id,
    movement_type,
    quantity,
    notes
  ) values (
    p_event_id,
    p_inventory_id,
    'purchase',
    p_quantity,
    nullif(trim(p_notes), '')
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'inventory_quantity_added',
    'shirt_inventory',
    p_inventory_id,
    jsonb_build_object(
      'movement_type', 'purchase',
      'quantity', p_quantity,
      'notes', nullif(trim(p_notes), ''),
      'previous_total', v_item.total_quantity,
      'new_total', v_new_total,
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size
    ),
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."add_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."adjust_inventory_quantity"("p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid;
  v_item public.shirt_inventory%rowtype;
  v_new_total integer;
  v_min_total integer;
begin
  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_quantity_delta is null or p_quantity_delta = 0 then
    raise exception 'Quantidade de ajuste deve ser diferente de zero.';
  end if;

  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada.';
  end if;

  if v_item.event_id is distinct from v_event_id then
    raise exception 'Apenas o estoque do evento ativo pode ser alterado.';
  end if;

  v_new_total := v_item.total_quantity + p_quantity_delta;
  v_min_total := v_item.reserved_quantity + v_item.delivered_quantity;

  if v_new_total < v_min_total then
    raise exception 'Total nao pode ficar menor que reservadas + entregues.';
  end if;

  if v_new_total < 0 then
    raise exception 'Total nao pode ficar negativo.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = v_new_total,
    updated_at = now()
  where id = p_inventory_id;

  insert into public.inventory_movements (
    event_id,
    inventory_id,
    movement_type,
    quantity,
    notes
  ) values (
    v_event_id,
    p_inventory_id,
    'adjustment',
    p_quantity_delta,
    nullif(trim(p_notes), '')
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'inventory_quantity_adjusted',
    'shirt_inventory',
    p_inventory_id,
    jsonb_build_object(
      'movement_type', 'adjustment',
      'quantity', p_quantity_delta,
      'notes', nullif(trim(p_notes), ''),
      'previous_total', v_item.total_quantity,
      'new_total', v_new_total,
      'reserved_quantity', v_item.reserved_quantity,
      'delivered_quantity', v_item.delivered_quantity,
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size
    ),
    v_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."adjust_inventory_quantity"("p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."adjust_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_item public.shirt_inventory%rowtype;
  v_new_total integer;
  v_min_total integer;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_quantity_delta is null or p_quantity_delta = 0 then
    raise exception 'Quantidade de ajuste deve ser diferente de zero.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada para o evento informado.';
  end if;

  v_new_total := v_item.total_quantity + p_quantity_delta;
  v_min_total := v_item.reserved_quantity + v_item.delivered_quantity;

  if v_new_total < v_min_total then
    raise exception 'Total nao pode ficar menor que reservadas + entregues.';
  end if;

  if v_new_total < 0 then
    raise exception 'Total nao pode ficar negativo.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = v_new_total,
    updated_at = now()
  where id = p_inventory_id;

  insert into public.inventory_movements (
    event_id,
    inventory_id,
    movement_type,
    quantity,
    notes
  ) values (
    p_event_id,
    p_inventory_id,
    'adjustment',
    p_quantity_delta,
    nullif(trim(p_notes), '')
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'inventory_quantity_adjusted',
    'shirt_inventory',
    p_inventory_id,
    jsonb_build_object(
      'movement_type', 'adjustment',
      'quantity', p_quantity_delta,
      'notes', nullif(trim(p_notes), ''),
      'previous_total', v_item.total_quantity,
      'new_total', v_new_total,
      'reserved_quantity', v_item.reserved_quantity,
      'delivered_quantity', v_item.delivered_quantity,
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size
    ),
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."adjust_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_cancel_ticket"("p_ticket_id" "uuid", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype; v_link record; v_variant uuid; v_inventory public.event_kit_item_variant_inventory%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('orders.cancel') then raise exception 'Sem permissao para cancelar ingresso.'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then return jsonb_build_object('success',true,'ticket_id',v_ticket.id,'status','cancelled','changed',false); end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Ingresso com check-in; desfaça o check-in antes do cancelamento.'; end if;
  select * into strict v_order from public.orders where id=v_ticket.order_id for update;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  if v_item.order_id is distinct from v_ticket.order_id or v_item.event_id is distinct from v_ticket.event_id
    or v_order.event_id is distinct from v_ticket.event_id or v_order.organization_id is distinct from v_ticket.organization_id then
    raise exception 'Cadeia comercial inconsistente para o ingresso.';
  end if;
  if exists(select 1 from public.participant_kit_items where ticket_id=v_ticket.id and status='delivered') then raise exception 'Ingresso possui item entregue; desfaça a entrega antes do cancelamento.'; end if;
  for v_link in select pki.*,eki.item_type,eki.track_variant_inventory,eki.shirt_supply_mode from public.participant_kit_items pki join public.event_kit_items eki on eki.id=pki.kit_item_id where pki.ticket_id=v_ticket.id and pki.status<>'cancelled' order by pki.id for update of pki loop
    v_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
    if v_variant is not null and (v_link.track_variant_inventory or (v_link.item_type='shirt' and v_link.shirt_supply_mode='stock')) then
      select * into v_inventory from public.event_kit_item_variant_inventory where kit_item_id=v_link.kit_item_id and variant_id=v_variant for update;
      if not found or v_inventory.reserved_quantity<v_link.quantity then raise exception 'Reserva inconsistente para o item %.',v_link.kit_item_id; end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity-v_link.quantity,updated_at=now() where id=v_inventory.id;
    end if;
    update public.participant_kit_items set status='cancelled' where id=v_link.id;
  end loop;
  update public.tickets set status='cancelled',cancelled_at=coalesce(cancelled_at,now()) where id=v_ticket.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('admin_ticket_cancelled','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',v_actor,'reason',trim(p_reason)));
  return jsonb_build_object('success',true,'ticket_id',v_ticket.id,'status','cancelled','changed',true);
end; $$;


ALTER FUNCTION "public"."admin_cancel_ticket"("p_ticket_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_change_ticket_shirt"("p_ticket_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_link public.participant_kit_items%rowtype; v_old_inv public.event_kit_item_variant_inventory%rowtype;
  v_new_inv public.event_kit_item_variant_inventory%rowtype; v_qty integer; v_old_variant uuid;
begin
  if v_actor is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para trocar camiseta.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into strict v_oi from public.order_items where id=v_ticket.order_item_id for update;
  -- Apos a 137, esta chamada tambem enriquece vinculos legados de camiseta
  -- sem variant_id antes de ajustar os contadores agregados de reserva.
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'admin_change_ticket_shirt');
  select * into strict v_item from public.event_kit_items where event_id=v_ticket.event_id and item_type='shirt' and is_active;
  if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Fornecimento de camiseta indisponivel.'; end if;
  select * into strict v_variant from public.event_kit_item_variants where kit_item_id=v_item.id and is_active and name=trim(p_new_shirt_type) and value=trim(p_new_shirt_size);
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id for update;
  if found and v_link.status='delivered' then raise exception 'Camiseta ja entregue; use operacao explicita de troca ou estorno.'; end if;
  v_qty:=greatest(coalesce(v_link.quantity,v_item.quantity_per_participant),1);
  v_old_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  if v_item.shirt_supply_mode='stock' then
    select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;
    if not found or v_new_inv.total_quantity-v_new_inv.delivered_quantity<v_qty then
      raise exception using errcode='P0001',message='SHIRT_OUT_OF_STOCK',detail=jsonb_build_object(
        'code','SHIRT_OUT_OF_STOCK','shirt_type',v_variant.name,'shirt_size',v_variant.value,
        'physical_available',greatest(coalesce(v_new_inv.total_quantity,0)-coalesce(v_new_inv.delivered_quantity,0),0),
        'message',format('Nao ha estoque disponivel para %s %s. A troca nao foi confirmada.',v_variant.name,v_variant.value))::text;
    end if;
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


ALTER FUNCTION "public"."admin_change_ticket_shirt"("p_ticket_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_confirm_participant_payment"("p_participant_id" "uuid", "p_payment_id" "uuid", "p_reason" "text", "p_actor_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant   public.participants%rowtype;
  v_payment       public.payments%rowtype;
  v_order_id      uuid;
  v_ticket_id     uuid;
  v_actor_uid     uuid := coalesce(p_actor_user_id, auth.uid());
  v_actor_email   text := coalesce(
    (select lower(u.email) from auth.users u where u.id = v_actor_uid),
    'admin'
  );
begin
  -- ── 1. Carrega participante ─────────────────────────────────────────
  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante % não encontrado.', p_participant_id;
  end if;

  -- ── 2. Carrega e trava pagamento ────────────────────────────────────
  select * into v_payment
  from public.payments
  where id = p_payment_id
    and participant_id = p_participant_id
  for update;

  if not found then
    raise exception 'Pagamento % não encontrado para o participante.', p_payment_id;
  end if;

  if v_payment.payment_status = 'paid' then
    -- Idempotente: já está pago, apenas garante ticket
    select o.id into v_order_id
    from public.orders o where o.participant_id = p_participant_id limit 1;
    if v_order_id is not null then
      v_ticket_id := public.confirm_order_and_issue_ticket(p_participant_id);
    end if;
    return jsonb_build_object(
      'success', true,
      'already_paid', true,
      'ticket_issued', v_ticket_id is not null,
      'ticket_id', v_ticket_id
    );
  end if;

  -- ── 3. Atualiza pagamento para paid ─────────────────────────────────
  update public.payments
  set payment_status = 'paid',
      paid_at        = coalesce(paid_at, now()),
      updated_at     = now()
  where id = p_payment_id;

  -- ── 4. Atualiza participante ─────────────────────────────────────────
  update public.participants
  set registration_status    = 'confirmed',
      reservation_status     = 'confirmed',
      reservation_expires_at = null,
      reservation_released_at = null,
      updated_at             = now()
  where id = p_participant_id;

  -- ── 5. Garante pedido e emite ingresso ──────────────────────────────
  -- Usa user_id do participante ou o ator administrativo como fallback.
  begin
    v_order_id := public.ensure_order_for_participant(
      p_participant_id,
      coalesce(v_participant.user_id, v_actor_uid)
    );
  exception when others then
    -- Se não for possível criar pedido, tenta apenas emitir se já existir
    select o.id into v_order_id
    from public.orders o where o.participant_id = p_participant_id limit 1;
  end;

  if v_order_id is not null then
    begin
      v_ticket_id := public.confirm_order_and_issue_ticket(p_participant_id);
    exception when others then
      -- Ticket pode já existir ou haver impedimento — não aborta a confirmação
      v_ticket_id := null;
    end;
  end if;

  -- ── 6. Auditoria ─────────────────────────────────────────────────────
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'payment_admin_confirmed',
    'payments',
    p_payment_id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor_uid,
      'actor_email', v_actor_email,
      'organization_id', v_participant.organization_id,
      'participant_id', p_participant_id,
      'order_id', v_order_id,
      'payment_id', p_payment_id,
      'previous_status', v_payment.payment_status,
      'new_status', 'paid',
      'reason', p_reason,
      'source', 'admin_confirm',
      'administrative_override', true,
      'ticket_issued', v_ticket_id is not null,
      'ticket_id', v_ticket_id
    )
  );

  return jsonb_build_object(
    'success', true,
    'already_paid', false,
    'ticket_issued', v_ticket_id is not null,
    'ticket_id', v_ticket_id
  );
end;
$$;


ALTER FUNCTION "public"."admin_confirm_participant_payment"("p_participant_id" "uuid", "p_payment_id" "uuid", "p_reason" "text", "p_actor_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  return public.admin_set_ticket_holder_contact(p_ticket_id,p_registration_contact_id,'legacy_unclassified',nullif(trim(coalesce(p_reason,'')),''));
end; $$;


ALTER FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason_code" "text", "p_reason_text" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_item public.order_items%rowtype;
  v_contact public.registration_contacts%rowtype; v_previous public.participants%rowtype;
  v_target public.participants%rowtype; v_target_count integer; v_operation text;
  v_reason_code text:=trim(coalesce(p_reason_code,'')); v_reason_text text:=nullif(trim(coalesce(p_reason_text,'')),'');
  v_previous_contact_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao para alterar titular.'; end if;
  if v_reason_code not in('registration_correction','buyer_request','holder_request','third_party_ticket','administrative_adjustment',
    'issuance_error','system_error','data_regularization','other','legacy_unclassified') then raise exception 'Motivo de alteracao invalido.'; end if;
  if v_reason_code='other' and v_reason_text is null then raise exception 'Descreva o motivo da alteracao.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status in('cancelled','canceled','void','voided') then raise exception 'Ingresso cancelado nao pode ter titular alterado.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Ingresso ja utilizado nao pode ter titular alterado.'; end if;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  if coalesce(v_item.participant_id,v_ticket.participant_id) is not null then
    select * into v_previous from public.participants where id=coalesce(v_item.participant_id,v_ticket.participant_id);
  end if;
  v_previous_contact_id:=coalesce(v_item.registration_contact_id,v_previous.registration_contact_id);

  if p_registration_contact_id is null then
    if v_previous.id is null and v_item.registration_contact_id is null then return jsonb_build_object('success',true,'changed',false,'ticket_id',v_ticket.id); end if;
    update public.order_items set participant_id=null,registration_contact_id=null,holder_full_name=null,ownership_status='unassigned',updated_at=now() where id=v_item.id;
    update public.tickets set participant_id=null where id=v_ticket.id;
    insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,
      previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason,reason_code,reason_text)
    values(v_ticket.id,v_item.id,v_ticket.event_id,v_ticket.organization_id,'holder_removed',v_previous.id,null,
      v_previous_contact_id,null,v_previous.user_id,null,v_actor,'admin',v_reason_text,v_reason_code,v_reason_text);
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('holder_removed','tickets',v_ticket.id,v_ticket.event_id,
      jsonb_build_object('ticket_id',v_ticket.id,'previous_participant_id',v_previous.id,'new_participant_id',null,
        'previous_registration_contact_id',v_previous_contact_id,'new_registration_contact_id',null,
        'previous_user_id',v_previous.user_id,'new_user_id',null,'actor_user_id',v_actor,'reason_code',v_reason_code,'reason_text',v_reason_text));
    return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'registration_contact_id',null);
  end if;

  select * into v_contact from public.registration_contacts where id=p_registration_contact_id and organization_id=v_ticket.organization_id for update;
  if not found then raise exception 'Cadastro de destino invalido ou de outra organizacao.'; end if;
  if v_previous_contact_id=v_contact.id then return jsonb_build_object('success',true,'changed',false,'ticket_id',v_ticket.id,'registration_contact_id',v_contact.id); end if;
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
  v_operation:=case when v_previous.id is null then 'holder_assigned' else 'holder_changed' end;
  update public.order_items set participant_id=v_target.id,registration_contact_id=v_contact.id,holder_full_name=v_contact.full_name,
    ownership_status=case when v_operation='holder_assigned' then 'assigned' else 'transferred' end,updated_at=now() where id=v_item.id;
  update public.tickets set participant_id=v_target.id where id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,
    previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason,reason_code,reason_text)
  values(v_ticket.id,v_item.id,v_ticket.event_id,v_ticket.organization_id,v_operation,v_previous.id,v_target.id,
    v_previous_contact_id,v_contact.id,v_previous.user_id,v_target.user_id,v_actor,'admin',v_reason_text,v_reason_code,v_reason_text);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values(v_operation,'tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('ticket_id',v_ticket.id,'previous_participant_id',v_previous.id,'new_participant_id',v_target.id,
      'previous_registration_contact_id',v_previous_contact_id,'new_registration_contact_id',v_contact.id,
      'previous_user_id',v_previous.user_id,'new_user_id',v_target.user_id,'actor_user_id',v_actor,'reason_code',v_reason_code,'reason_text',v_reason_text));
  return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'participant_id',v_target.id,'registration_contact_id',v_contact.id);
end; $$;


ALTER FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason_code" "text", "p_reason_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text", "p_reason" "text", "p_operation" "text" DEFAULT 'ticket_transferred'::"text") RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$ select public.change_ticket_holder_by_pin_internal(p_ticket_id,p_pin,p_operation,true,p_reason); $$;


ALTER FUNCTION "public"."admin_transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text", "p_reason" "text", "p_operation" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_transfer_ticket_holder"("p_ticket_id" "uuid", "p_target_participant_id" "uuid", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_contact uuid;
begin
  select registration_contact_id into v_contact from public.participants where id=p_target_participant_id;
  if v_contact is null then raise exception 'Participante sem cadastro global vinculado.'; end if;
  return public.admin_set_ticket_holder_contact(p_ticket_id,v_contact,p_reason);
end; $$;


ALTER FUNCTION "public"."admin_transfer_ticket_holder"("p_ticket_id" "uuid", "p_target_participant_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_transfer_ticket_ownership"("p_ticket_id" "uuid", "p_expected_owner_user_id" "uuid", "p_new_owner_user_id" "uuid", "p_holder_action" "text", "p_reason_code" "text", "p_reason_text" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_operation text;
  v_reason_code text:=trim(coalesce(p_reason_code,'')); v_reason_text text:=nullif(trim(coalesce(p_reason_text,'')),'');
  v_contact_id uuid; v_contact_count integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('tickets.transfer_ownership') then raise exception 'Sem permissao para transferir propriedade.'; end if;
  if p_new_owner_user_id is null or not exists(select 1 from auth.users where id=p_new_owner_user_id) then raise exception 'Novo proprietario precisa possuir conta NEXORA valida.'; end if;
  if p_holder_action not in('keep','assign_new_owner','remove') then raise exception 'Tratamento do titular invalido.'; end if;
  if v_reason_code not in('registration_correction','buyer_request','holder_request','third_party_ticket','administrative_adjustment',
    'issuance_error','system_error','data_regularization','other','legacy_unclassified') then raise exception 'Motivo de alteracao invalido.'; end if;
  if v_reason_code='other' and v_reason_text is null then raise exception 'Descreva o motivo da alteracao.'; end if;

  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.owner_user_id is distinct from p_expected_owner_user_id then raise exception 'TICKET_OWNER_CHANGED_CONCURRENTLY'; end if;
  if v_ticket.owner_user_id=p_new_owner_user_id then raise exception 'A conta selecionada ja e proprietaria do ingresso.'; end if;

  if p_holder_action in('assign_new_owner','remove') and not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para alterar o titular durante a transferencia.';
  end if;
  if p_holder_action='assign_new_owner' then
    select count(distinct p.registration_contact_id),(array_agg(distinct p.registration_contact_id order by p.registration_contact_id))[1]
      into v_contact_count,v_contact_id
    from public.participants p
    where p.organization_id=v_ticket.organization_id and p.user_id=p_new_owner_user_id and p.registration_contact_id is not null;
    if v_contact_count=0 then raise exception 'A conta selecionada nao possui cadastro vinculado nesta organizacao.'; end if;
    if v_contact_count>1 then raise exception 'OWNER_CONTACT_AMBIGUOUS'; end if;
    perform public.admin_set_ticket_holder_contact(v_ticket.id,v_contact_id,v_reason_code,v_reason_text);
  elsif p_holder_action='remove' then
    perform public.admin_set_ticket_holder_contact(v_ticket.id,null,v_reason_code,v_reason_text);
  end if;

  v_operation:=case when v_ticket.owner_user_id is null then 'owner_assigned' else 'owner_transferred' end;
  update public.tickets set owner_user_id=p_new_owner_user_id where id=v_ticket.id;
  insert into public.ticket_owner_history(ticket_id,order_id,event_id,organization_id,operation,previous_owner_user_id,new_owner_user_id,actor_user_id,reason_code,reason_text)
  values(v_ticket.id,v_ticket.order_id,v_ticket.event_id,v_ticket.organization_id,v_operation,v_ticket.owner_user_id,p_new_owner_user_id,v_actor,v_reason_code,v_reason_text);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values(v_operation,'tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object(
    'ticket_id',v_ticket.id,'order_id',v_ticket.order_id,'previous_owner_user_id',v_ticket.owner_user_id,
    'new_owner_user_id',p_new_owner_user_id,'actor_user_id',v_actor,'holder_action',p_holder_action,
    'reason_code',v_reason_code,'reason_text',v_reason_text));
  return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'previous_owner_user_id',v_ticket.owner_user_id,
    'new_owner_user_id',p_new_owner_user_id,'holder_action',p_holder_action);
end; $$;


ALTER FUNCTION "public"."admin_transfer_ticket_ownership"("p_ticket_id" "uuid", "p_expected_owner_user_id" "uuid", "p_new_owner_user_id" "uuid", "p_holder_action" "text", "p_reason_code" "text", "p_reason_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_update_payment_status"("p_payment_id" "uuid", "p_participant_id" "uuid", "p_expected_current_status" "text", "p_new_status" "text", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant     public.participants%rowtype;
  v_payment         public.payments%rowtype;
  v_actor_uid       uuid := auth.uid();
  v_actor_email     text := coalesce(
    (select lower(u.email) from auth.users u where u.id = v_actor_uid),
    'admin'
  );
  v_valid_statuses  text[] := array['pending','paid','expired','cancelled','refunded'];
  v_order_id        uuid;
  v_confirm_result  jsonb;
begin
  -- ── Validações básicas ───────────────────────────────────────────────
  if v_actor_uid is null then
    return jsonb_build_object('success', false, 'message', 'Não autenticado.');
  end if;

  if p_new_status is null or not (p_new_status = any(v_valid_statuses)) then
    return jsonb_build_object('success', false, 'message', format('Status "%s" inválido.', p_new_status));
  end if;

  if nullif(trim(p_reason), '') is null or length(trim(p_reason)) < 3 then
    return jsonb_build_object('success', false, 'message', 'Motivo obrigatório (mínimo 3 caracteres).');
  end if;

  -- ── Permissão ────────────────────────────────────────────────────────
  if p_new_status = 'refunded' then
    if not public.resolve_user_permission(v_actor_uid, 'finance.refund') then
      return jsonb_build_object('success', false, 'message', 'Sem permissão para estornar pagamentos.');
    end if;
  else
    if not (
      public.is_active_owner(v_actor_uid)
      or public.resolve_user_permission(v_actor_uid, 'finance.confirm_payment')
    ) then
      return jsonb_build_object('success', false, 'message', 'Sem permissão para alterar status de pagamento.');
    end if;
  end if;

  -- ── Carrega participante e valida organização ────────────────────────
  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Participante não encontrado.');
  end if;

  if not public.user_can_access_organization(v_actor_uid, v_participant.organization_id) then
    return jsonb_build_object('success', false, 'message', 'Sem acesso à organização deste participante.');
  end if;

  -- ── Carrega pagamento com SELECT FOR UPDATE (concorrência) ────────────
  select * into v_payment
  from public.payments
  where id = p_payment_id
    and participant_id = p_participant_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Pagamento não encontrado.');
  end if;

  -- Verificação de concorrência
  if v_payment.payment_status <> p_expected_current_status then
    return jsonb_build_object(
      'success', false,
      'message', 'O pagamento foi alterado por outro usuário. Atualize a lista e tente novamente.'
    );
  end if;

  if v_payment.payment_status = p_new_status then
    return jsonb_build_object('success', false, 'message', 'O pagamento já está com esse status.');
  end if;

  -- ── Bloqueio de regressão com uso operacional ─────────────────────────
  if p_new_status in ('cancelled', 'expired', 'pending') then
    -- Bloqueia se ticket já foi usado no check-in
    if exists (
      select 1 from public.tickets
      where participant_id = p_participant_id and status = 'used'
    ) then
      return jsonb_build_object(
        'success', false,
        'message', format('Não é possível alterar para "%s": este participante já realizou check-in.', p_new_status)
      );
    end if;

    -- Bloqueia regressão para cancelled/expired se kit entregue
    if p_new_status in ('cancelled', 'expired') then
      if exists (
        select 1 from public.participant_kit_items
        where participant_id = p_participant_id and status = 'delivered'
        limit 1
      ) then
        return jsonb_build_object(
          'success', false,
          'message', format('Não é possível alterar para "%s": itens do kit já foram entregues.', p_new_status)
        );
      end if;
    end if;
  end if;

  -- ── Execução da transição ─────────────────────────────────────────────
  if p_new_status = 'paid' then
    -- Usa helper interno que bypassa simulate_payment_paid
    v_confirm_result := public.admin_confirm_participant_payment(
      p_participant_id, p_payment_id, p_reason, v_actor_uid
    );
    if not (v_confirm_result ->> 'success')::boolean then
      return v_confirm_result;
    end if;

  else
    -- Atualização direta para outros status
    update public.payments
    set payment_status = p_new_status,
        updated_at     = now()
    where id = p_payment_id;

    -- Sincroniza participant.registration_status
    update public.participants
    set registration_status = case p_new_status
          when 'pending'    then 'pending'
          when 'expired'    then 'pending'
          when 'cancelled'  then 'cancelled'
          when 'refunded'   then 'pending'
          else registration_status
        end,
        updated_at = now()
    where id = p_participant_id;

    -- Sincroniza order.status (sem payment_status — orders só tem status)
    select o.id into v_order_id
    from public.orders o where o.participant_id = p_participant_id limit 1;

    if v_order_id is not null then
      update public.orders
      set status = case p_new_status
            when 'pending'    then 'pending'
            when 'expired'    then 'expired'
            when 'cancelled'  then 'cancelled'
            when 'refunded'   then 'refunded'
            else status
          end,
          cancelled_at = case
            when p_new_status in ('cancelled', 'refunded') and cancelled_at is null then now()
            else cancelled_at
          end,
          updated_at = now()
      where id = v_order_id;
    end if;

    -- Auditoria
    insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
    values (
      'payment_status_changed',
      'payments',
      p_payment_id,
      v_participant.event_id,
      jsonb_build_object(
        'actor_user_id', v_actor_uid,
        'actor_email', v_actor_email,
        'organization_id', v_participant.organization_id,
        'participant_id', p_participant_id,
        'order_id', v_order_id,
        'payment_id', p_payment_id,
        'previous_status', v_payment.payment_status,
        'new_status', p_new_status,
        'reason', trim(p_reason),
        'source', 'participants_admin',
        'administrative_override', true
      )
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'message', format('Status alterado para "%s" com sucesso.', p_new_status)
  );
end;
$$;


ALTER FUNCTION "public"."admin_update_payment_status"("p_payment_id" "uuid", "p_participant_id" "uuid", "p_expected_current_status" "text", "p_new_status" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advance_registration_batch_if_needed"("p_event_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("switched" boolean, "previous_batch_id" "uuid", "new_batch_id" "uuid", "message" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid := p_event_id;
  v_current public.registration_batches%rowtype;
  v_next public.registration_batches%rowtype;
  v_fully_exhausted boolean;
begin
  if v_event_id is null then
    select id into v_event_id
    from public.events
    where is_active = true
    order by created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado para avancar lote.';
  end if;

  select * into v_current
  from public.registration_batches
  where event_id = v_event_id
    and is_active = true
  order by sequence_number asc
  limit 1
  for update;

  if not found then
    raise exception 'Nenhum lote ativo configurado para o evento.';
  end if;

  select not exists (
    select 1
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_current.id
      and (
        rbp.max_confirmed_registrations is null
        or coalesce((
          select count(*)::integer
          from public.participants part
          join public.payments pay on pay.participant_id = part.id
          where part.batch_id = v_current.id
            and part.ticket_category_id = rbp.ticket_category_id
            and coalesce(part.registration_status, 'pending') <> 'cancelled'
            and pay.payment_status = 'paid'
            and (part.reservation_status is null or part.reservation_status = 'confirmed')
        ), 0) < rbp.max_confirmed_registrations
      )
      and (v_current.ends_at is null or now() <= v_current.ends_at)
  ) into v_fully_exhausted;

  if not v_fully_exhausted then
    return query select false, v_current.id, v_current.id, 'Lote ativo ainda com vagas.';
    return;
  end if;

  select * into v_next
  from public.registration_batches
  where event_id = v_event_id
    and sequence_number > v_current.sequence_number
  order by sequence_number asc
  limit 1
  for update;

  if not found then
    return query select false, v_current.id, null::uuid, 'Lote atual esgotado e sem proximo lote.';
    return;
  end if;

  update public.registration_batches
  set is_active = false,
      updated_at = now()
  where id = v_current.id;

  update public.registration_batches
  set is_active = true,
      updated_at = now()
  where id = v_next.id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_advanced',
    'registration_batches',
    v_next.id,
    jsonb_build_object(
      'previous_batch_id', v_current.id,
      'previous_sequence', v_current.sequence_number,
      'new_batch_id', v_next.id,
      'new_sequence', v_next.sequence_number
    ),
    v_event_id
  );

  return query select true, v_current.id, v_next.id, format('Lote avancado de %s para %s.', v_current.name, v_next.name);
end;
$$;


ALTER FUNCTION "public"."advance_registration_batch_if_needed"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."archive_event"("p_event_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_now timestamptz:=now();
begin
  if v_actor is null or not public.current_user_has_permission('events.archive') then raise exception 'Permissao insuficiente para arquivar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then return true; end if;
  update public.events set is_active=false,registration_enabled=false,archived_at=v_now,archived_by=v_actor,updated_at=v_now where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_archived','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('is_active',v_event.is_active,'registration_enabled',v_event.registration_enabled,'archived_at',null),
      'new_state',jsonb_build_object('is_active',false,'registration_enabled',false,'archived_at',v_now)));
  return true;
end; $$;


ALTER FUNCTION "public"."archive_event"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_ticket_holder_contact_available"("p_ticket_id" "uuid", "p_event_id" "uuid", "p_registration_contact_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_registration_contact_id is null then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text||':'||p_registration_contact_id::text,0));
  if public.registration_contact_has_active_ticket(p_event_id,p_registration_contact_id,p_ticket_id) then
    raise exception using errcode='P0001',message='HOLDER_ALREADY_HAS_TICKET_FOR_EVENT',
      detail=jsonb_build_object('code','HOLDER_ALREADY_HAS_TICKET_FOR_EVENT',
        'message','Esta pessoa ja e titular de outro ingresso neste evento.')::text;
  end if;
end; $$;


ALTER FUNCTION "public"."assert_ticket_holder_contact_available"("p_ticket_id" "uuid", "p_event_id" "uuid", "p_registration_contact_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assign_order_item_participant"("p_order_item_id" "uuid", "p_participant_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_item public.order_items%rowtype;
  v_participant public.participants%rowtype;
  v_order public.orders%rowtype;
  v_ticket_id uuid;
  v_previous_participant_id uuid;
  v_actor_user_id uuid := auth.uid();
begin
  if p_order_item_id is null or p_participant_id is null then
    raise exception 'Order item e participante sao obrigatorios.';
  end if;

  select * into v_item
  from public.order_items
  where id = p_order_item_id
  for update;

  if not found then
    raise exception 'Order item nao encontrado.';
  end if;

  select * into v_order
  from public.orders
  where id = v_item.order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado para o order item.';
  end if;

  if v_actor_user_id is null or v_actor_user_id <> v_order.user_id then
    raise exception 'Usuario sem permissao para atribuir este ingresso.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  if v_participant.event_id <> v_item.event_id then
    raise exception 'Participante de evento diferente do ingresso.';
  end if;

  v_previous_participant_id := v_item.participant_id;

  update public.order_items
  set
    participant_id = v_participant.id,
    holder_full_name = v_participant.full_name,
    ownership_status = 'assigned',
    updated_at = now()
  where id = v_item.id
  returning * into v_item;

  select t.id
  into v_ticket_id
  from public.tickets t
  where t.order_item_id = v_item.id
  for update;

  if v_item.status = 'confirmed' then
    insert into public.tickets (
      order_id,
      order_item_id,
      participant_id,
      event_id,
      ownership_status,
      status
    ) values (
      v_order.id,
      v_item.id,
      v_participant.id,
      v_item.event_id,
      'assigned',
      'active'
    )
    on conflict (order_item_id) where order_item_id is not null
    do update set
      participant_id = excluded.participant_id,
      ownership_status = excluded.ownership_status,
      status = case
        when public.tickets.status in ('active', 'used') then public.tickets.status
        else excluded.status
      end,
      cancelled_at = case
        when public.tickets.status in ('active', 'used') then public.tickets.cancelled_at
        else null
      end
    returning id into v_ticket_id;
  elsif v_ticket_id is not null then
    update public.tickets
    set
      participant_id = v_participant.id,
      ownership_status = 'assigned'
    where id = v_ticket_id;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'ticket_holder_assigned',
    case when v_ticket_id is null then 'order_items' else 'tickets' end,
    coalesce(v_ticket_id, v_item.id),
    v_item.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'buyer_user_id', v_order.user_id,
      'order_id', v_order.id,
      'order_item_id', v_item.id,
      'ticket_id', v_ticket_id,
      'previous_participant_id', v_previous_participant_id,
      'participant_id', v_participant.id,
      'holder_full_name', v_participant.full_name
    )
  );

  return v_ticket_id;
end;
$$;


ALTER FUNCTION "public"."assign_order_item_participant"("p_order_item_id" "uuid", "p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attach_order_item_kit_items_to_new_ticket"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype; v_org uuid;
begin
  if new.order_item_id is null then return new; end if;
  select * into v_oi from public.order_items where id=new.order_item_id;
  if not found then raise exception 'Order item do ingresso nao encontrado.'; end if;
  select organization_id into v_org from public.events where id=new.event_id;
  for v_item in select * from public.event_kit_items where event_id=new.event_id and is_active order by sort_order,created_at loop
    if v_item.item_type='shirt' and (nullif(trim(v_oi.shirt_type),'') is null or nullif(trim(v_oi.shirt_size),'') is null) then continue; end if;
    insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
    values(new.id,v_oi.id,v_oi.participant_id,new.event_id,v_org,v_item.id,
      case when v_item.item_type='shirt' then jsonb_build_object('shirt_type',v_oi.shirt_type,'shirt_size',v_oi.shirt_size) end,
      v_item.quantity_per_participant,case when v_oi.status='confirmed' then 'confirmed' else 'reserved' end)
    on conflict on constraint participant_kit_items_participant_kit_unique do update set ticket_id=excluded.ticket_id;
  end loop;
  update public.participant_kit_items pki
  set ticket_id=new.id
  where pki.ticket_id is null and pki.order_item_id=new.order_item_id;
  return new;
end;
$$;


ALTER FUNCTION "public"."attach_order_item_kit_items_to_new_ticket"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."backfill_confirmed_payments_cash_111"("p_cash_account_id" "uuid", "p_revenue_account_id" "uuid", "p_revenue_category_id" "uuid", "p_created_by" "uuid", "p_apply" boolean DEFAULT false) RETURNS TABLE("payment_id" "uuid", "order_id" "uuid", "participant_id" "uuid", "event_id" "uuid", "organization_id" "uuid", "classification" "text", "amount" numeric, "competency_on" "date", "effective_at" timestamp with time zone, "idempotency_key" "text", "action" "text")
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_organization_id uuid;
  v_candidate_count integer;
  v_candidate_total numeric(14,2);
  v_sale_count integer;
  v_legacy_count integer;
  v_collision_count integer;
begin
  if p_cash_account_id is null or p_revenue_account_id is null
    or p_revenue_category_id is null or p_created_by is null then
    raise exception 'Informe conta de caixa, conta de receita, categoria de receita e usuario executor.';
  end if;

  select fa.organization_id into v_organization_id
  from public.financial_accounts fa
  where fa.id=p_cash_account_id and fa.account_type='asset' and fa.is_active;
  if v_organization_id is null then
    raise exception 'Conta financeira de destino inexistente, inativa ou nao classificada como ativo.';
  end if;
  if not exists(select 1 from public.financial_accounts fa where fa.id=p_revenue_account_id
    and fa.organization_id=v_organization_id and fa.account_type='revenue' and fa.is_active) then
    raise exception 'Conta de contrapartida inexistente, inativa, fora da organizacao ou nao classificada como receita.';
  end if;
  if not exists(select 1 from public.financial_categories fc where fc.id=p_revenue_category_id
    and fc.organization_id=v_organization_id and fc.entry_kind in('revenue','both') and fc.is_active) then
    raise exception 'Categoria inexistente, inativa, fora da organizacao ou incompativel com receita.';
  end if;
  if not exists(select 1 from auth.users au where au.id=p_created_by) then
    raise exception 'Usuario executor inexistente.';
  end if;

  select count(*),coalesce(sum(c.amount),0),
    count(*) filter(where c.classification='proven_distinct_sale'),
    count(*) filter(where c.classification='confirmed_legacy_revenue_without_order')
  into v_candidate_count,v_candidate_total,v_sale_count,v_legacy_count
  from public.confirmed_payments_cash_backfill_111_candidates c where c.organization_id=v_organization_id;

  if v_candidate_count<>19 or v_sale_count<>17 or v_legacy_count<>2 or v_candidate_total<>2250.00 then
    raise exception 'Conjunto divergente: total=% (esperado 19), vendas=% (17), legados=% (2), valor=% (2250.00).',
      v_candidate_count,v_sale_count,v_legacy_count,v_candidate_total;
  end if;
  if exists(select 1 from public.confirmed_payments_cash_backfill_111_candidates c where c.organization_id=v_organization_id and (c.amount<=0 or c.event_id is null
    or c.effective_at is null or c.competency_on is null)) then
    raise exception 'Candidato sem valor positivo, evento, paid_at ou competencia comprovada.';
  end if;
  if exists(select 1 from public.confirmed_payments_cash_backfill_111_candidates c left join public.events e on e.id=c.event_id
    and e.organization_id=c.organization_id where c.organization_id=v_organization_id and e.id is null) then
    raise exception 'Candidato referencia evento fora da organizacao.';
  end if;

  select count(*) into v_collision_count from public.confirmed_payments_cash_backfill_111_candidates c
  join public.financial_entries fe on fe.source_payment_id=c.payment_id
    or (fe.organization_id=c.organization_id and fe.idempotency_key=c.idempotency_key)
  where c.organization_id=v_organization_id;
  if v_collision_count>0 and p_apply then
    raise exception 'Ha % colisao(oes) por source_payment_id ou chave idempotente.',v_collision_count;
  end if;

  if p_apply then
    insert into public.financial_entries(
      organization_id,entry_kind,lifecycle_status,description,category_id,
      source_payment_id,source_order_id,source_participant_id,amount,due_date,occurred_on,
      posted_at,settled_at,currency,idempotency_key,created_by
    )
    select c.organization_id,'revenue','settled',
      case when c.classification='proven_distinct_sale' then 'Receita de venda - pagamento '||c.payment_id::text
        else 'Receita legada confirmada - pagamento '||c.payment_id::text end,
      p_revenue_category_id,c.payment_id,c.order_id,c.participant_id,c.amount,null,c.competency_on,
      c.effective_at,c.effective_at,'BRL',c.idempotency_key,p_created_by
    from public.confirmed_payments_cash_backfill_111_candidates c where c.organization_id=v_organization_id;

    insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo)
    select fe.id,fe.organization_id,p_cash_account_id,'debit',fe.amount,'Recebimento confirmado'
    from public.financial_entries fe join public.confirmed_payments_cash_backfill_111_candidates c on c.payment_id=fe.source_payment_id
    where c.organization_id=v_organization_id
    union all
    select fe.id,fe.organization_id,p_revenue_account_id,'credit',fe.amount,'Receita de inscricao'
    from public.financial_entries fe join public.confirmed_payments_cash_backfill_111_candidates c on c.payment_id=fe.source_payment_id
    where c.organization_id=v_organization_id;

    insert into public.financial_event_allocations(entry_id,organization_id,event_id,amount)
    select fe.id,fe.organization_id,c.event_id,fe.amount from public.financial_entries fe
    join public.confirmed_payments_cash_backfill_111_candidates c on c.payment_id=fe.source_payment_id
    where c.organization_id=v_organization_id;

    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    select 'financial_payment_cash_backfilled','financial_entries',fe.id,c.event_id,
      jsonb_build_object('actor_user_id',p_created_by,'organization_id',c.organization_id,
        'payment_id',c.payment_id,'order_id',c.order_id,'participant_id',c.participant_id,
        'classification',c.classification,'amount',c.amount,'competency_on',c.competency_on,
        'effective_at',c.effective_at,'idempotency_key',c.idempotency_key,'migration','111')
    from public.financial_entries fe join public.confirmed_payments_cash_backfill_111_candidates c on c.payment_id=fe.source_payment_id
    where c.organization_id=v_organization_id;
  end if;

  return query select c.payment_id,c.order_id,c.participant_id,c.event_id,c.organization_id,
    c.classification,c.amount,c.competency_on,c.effective_at,c.idempotency_key,
    case when p_apply then 'inserted' when exists(select 1 from public.financial_entries fe
      where fe.source_payment_id=c.payment_id or (fe.organization_id=c.organization_id and fe.idempotency_key=c.idempotency_key))
      then 'collision' else 'would_insert' end
  from public.confirmed_payments_cash_backfill_111_candidates c
  where c.organization_id=v_organization_id order by c.effective_at,c.payment_id;
end $$;


ALTER FUNCTION "public"."backfill_confirmed_payments_cash_111"("p_cash_account_id" "uuid", "p_revenue_account_id" "uuid", "p_revenue_category_id" "uuid", "p_created_by" "uuid", "p_apply" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."backfill_confirmed_payments_cash_111"("p_cash_account_id" "uuid", "p_revenue_account_id" "uuid", "p_revenue_category_id" "uuid", "p_created_by" "uuid", "p_apply" boolean) IS 'Simula (p_apply=false) ou executa explicitamente o backfill validado de 19 pagamentos/BRL 2250 da migration 111.';



CREATE OR REPLACE FUNCTION "public"."block_wristband"("p_wristband_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_wristband   public.participant_wristbands%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.block')
  ) then
    raise exception 'Sem permissao para bloquear pulseira.';
  end if;

  select pw.* into v_wristband
  from public.participant_wristbands pw
  where pw.id = p_wristband_id for update;

  if not found then
    raise exception 'Pulseira nao encontrada.';
  end if;

  -- Verifica org access
  if not public.user_can_access_organization(auth.uid(), v_wristband.organization_id) then
    raise exception 'Sem permissao para bloquear pulseira nesta organização.';
  end if;

  if v_wristband.status <> 'active' then
    raise exception 'Somente pulseira ativa pode ser bloqueada.';
  end if;

  update public.participant_wristbands pw
  set status     = 'blocked',
      notes      = nullif(trim(coalesce(p_reason, '')), ''),
      updated_at = now()
  where pw.id = p_wristband_id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'wristband_blocked', 'participant_wristbands', p_wristband_id, v_wristband.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_wristband.organization_id,
      'ticket_id', v_wristband.ticket_id,
      'participant_id', v_wristband.participant_id,
      'code', v_wristband.code,
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."block_wristband"("p_wristband_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_registration_payment"("p_participant_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_inventory public.shirt_inventory%rowtype;
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select * into v_payment
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;

  if v_payment.payment_status = 'paid' then
    raise exception 'Pagamento pago nao pode ser cancelado por esta rotina.';
  end if;

  update public.payments
  set payment_status = 'cancelled',
      expires_at = null
  where id = v_payment.id;

  if v_participant.reservation_status = 'pending' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if found and v_inventory.reserved_quantity > 0 then
      update public.shirt_inventory
      set reserved_quantity = reserved_quantity - 1,
          updated_at = now()
      where id = v_inventory.id
        and reserved_quantity > 0;

      insert into public.inventory_movements (
        event_id,
        inventory_id,
        movement_type,
        quantity,
        notes
      ) values (
        v_participant.event_id,
        v_inventory.id,
        'adjustment',
        1,
        format('Cancelamento de pagamento para participante %s.', v_participant.full_name)
      );
    end if;
  end if;

  update public.participants
  set registration_status = 'cancelled',
      reservation_status = 'released',
      reservation_released_at = now(),
      reservation_expires_at = null,
      updated_at = now()
  where id = p_participant_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'payment_cancelled',
    'participants',
    p_participant_id,
    jsonb_build_object(
      'reason', nullif(trim(coalesce(p_reason, '')), ''),
      'payment_id', v_payment.id
    ),
    v_participant.event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."cancel_registration_payment"("p_participant_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_store_order"("p_store_order_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid := auth.uid(); v_order public.store_orders%rowtype; v_line record;
begin
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.current_user_has_permission('store.manage')) then raise exception 'Sem permissao para cancelar este pedido.'; end if;
  if v_order.status = 'cancelled' then return; end if;
  if exists (select 1 from public.store_order_items where store_order_id = p_store_order_id and status = 'delivered') then
    raise exception 'Pedido possui item entregue; nao pode ser cancelado.';
  end if;

  for v_line in select * from public.store_order_items where store_order_id = p_store_order_id and status <> 'cancelled' for update loop
    update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity - v_line.quantity, 0), updated_at = now()
    where store_item_id = v_line.store_item_id and variant_id is not distinct from v_line.variant_id;
    update public.store_order_items set status = 'cancelled' where id = v_line.id;
  end loop;

  update public.store_orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = p_store_order_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_cancelled', 'store_orders', p_store_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'reason', p_reason));
end; $$;


ALTER FUNCTION "public"."cancel_store_order"("p_store_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."change_participant_shirt"("p_participant_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin return public.change_ticket_shirt(public.resolve_unique_ticket_for_participant(p_participant_id),p_new_shirt_type,p_new_shirt_size); end;
$$;


ALTER FUNCTION "public"."change_participant_shirt"("p_participant_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."change_ticket_holder_by_pin_for_owner"("p_ticket_id" "uuid", "p_pin" "text", "p_operation" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_event public.events%rowtype;
  v_profile public.customer_profiles%rowtype; v_contact_id uuid; v_contact_count integer; v_target_count integer; v_target public.participants%rowtype;
  v_previous public.participants%rowtype; v_operation text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled' for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_ticket.owner_user_id is distinct from v_actor then raise exception 'Somente o proprietario atual pode alterar o titular.'; end if;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  select * into strict v_event from public.events where id=v_ticket.event_id;
  if p_operation='holder_assigned' then
    if coalesce(v_item.participant_id,v_ticket.participant_id) is not null then raise exception 'Ingresso ja possui titular; use transferencia.'; end if;
    if not v_event.allow_holder_change then raise exception 'Definicao de titular desabilitada para o evento.'; end if;
    v_operation:='holder_assigned';
  elsif p_operation in('holder_changed','ticket_transferred') then
    if coalesce(v_item.participant_id,v_ticket.participant_id) is null then raise exception 'Ingresso sem titular; use definicao de titular.'; end if;
    if not v_event.allow_ticket_transfer then raise exception 'Alteracao de titular desabilitada para o evento.'; end if;
    v_operation:='holder_changed';
  else raise exception 'Operacao invalida.'; end if;
  select * into v_profile from public.customer_profiles
    where public_pin=upper(regexp_replace(coalesce(p_pin,''),'[^A-Za-z0-9]','','g')) and coalesce(account_status,'active')='active';
  if not found or not exists(select 1 from auth.users where id=v_profile.user_id) then raise exception 'PIN de conta NEXORA nao encontrado.'; end if;
  select count(distinct registration_contact_id),(array_agg(distinct registration_contact_id order by registration_contact_id))[1] into v_contact_count,v_contact_id
  from public.participants where organization_id=v_ticket.organization_id and user_id=v_profile.user_id and registration_contact_id is not null;
  if v_contact_count=0 then raise exception 'Conta sem cadastro vinculado nesta organizacao.'; end if;
  if v_contact_count>1 then raise exception 'Vinculo ambiguo entre conta e cadastro.'; end if;
  perform public.assert_ticket_holder_contact_available(v_ticket.id,v_ticket.event_id,v_contact_id);
  select count(*) into v_target_count from public.participants where event_id=v_ticket.event_id and registration_contact_id=v_contact_id;
  if v_target_count>1 then raise exception 'Cadastro possui multiplas projecoes no evento.'; end if;
  if v_target_count=1 then
    select * into strict v_target from public.participants where event_id=v_ticket.event_id and registration_contact_id=v_contact_id;
  else
    insert into public.participants(event_id,organization_id,registration_contact_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,
      shirt_type,shirt_size,registration_status,ticket_category_id,batch_id)
    select v_ticket.event_id,v_ticket.organization_id,rc.id,v_profile.user_id,rc.full_name,rc.cpf,rc.birth_date,rc.gender,rc.phone,rc.email,rc.city,
      nullif(trim(coalesce(v_item.shirt_type,'')),''),nullif(trim(coalesce(v_item.shirt_size,'')),''),'confirmed',v_item.ticket_category_id,v_item.batch_id
    from public.registration_contacts rc where rc.id=v_contact_id returning * into v_target;
  end if;
  if coalesce(v_item.participant_id,v_ticket.participant_id) is not null then select * into v_previous from public.participants where id=coalesce(v_item.participant_id,v_ticket.participant_id); end if;
  update public.order_items set participant_id=v_target.id,registration_contact_id=v_contact_id,holder_full_name=v_target.full_name,
    ownership_status=case when v_operation='holder_assigned' then 'assigned' else 'transferred' end,updated_at=now() where id=v_item.id;
  update public.tickets set participant_id=v_target.id where id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,
    previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason_code,reason_text)
  values(v_ticket.id,v_item.id,v_ticket.event_id,v_ticket.organization_id,v_operation,v_previous.id,v_target.id,
    coalesce(v_item.registration_contact_id,v_previous.registration_contact_id),v_contact_id,v_previous.user_id,v_target.user_id,v_actor,'portal','holder_request',null);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values(v_operation,'tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('previous_registration_contact_id',coalesce(v_item.registration_contact_id,v_previous.registration_contact_id),
      'new_registration_contact_id',v_contact_id,'previous_user_id',v_previous.user_id,'new_user_id',v_target.user_id,'actor_user_id',v_actor,'reason_code','holder_request'));
  return v_target.id;
end; $$;


ALTER FUNCTION "public"."change_ticket_holder_by_pin_for_owner"("p_ticket_id" "uuid", "p_pin" "text", "p_operation" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."change_ticket_holder_by_pin_internal"("p_ticket_id" "uuid", "p_pin" "text", "p_operation" "text", "p_admin_override" boolean DEFAULT false, "p_reason" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype; v_event public.events%rowtype;
  v_target public.customer_profiles%rowtype; v_current public.participants%rowtype; v_target_participant public.participants%rowtype;
  v_pin text:=upper(regexp_replace(coalesce(p_pin,''),'[^A-Za-z0-9]','','g')); v_admin boolean; v_origin text; v_price record; v_priced_gender text; v_target_gender text;
  v_target_email text; v_target_participant_count integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled' for update; if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update; select * into v_order from public.orders where id=v_ticket.order_id for update; select * into v_event from public.events where id=v_ticket.event_id;
  v_admin:=public.current_user_has_permission('participants.edit_basic') and public.user_can_access_organization(v_actor,v_ticket.organization_id);
  v_origin:=case when v_admin and p_admin_override then 'admin' else 'portal' end;
  if v_origin='portal' and v_actor<>v_order.user_id and not exists(select 1 from public.participants p where p.id=v_oi.participant_id and p.user_id=v_actor) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  if p_operation='holder_assigned' then
    if v_oi.participant_id is not null then raise exception 'Ingresso ja possui titular; use transferencia.'; end if;
    if not v_event.allow_holder_change and not(v_admin and p_admin_override) then raise exception 'Definicao de titular desabilitada para o evento.'; end if;
  elsif p_operation='ticket_transferred' then
    if v_oi.participant_id is null then raise exception 'Ingresso sem titular; use definicao de titular.'; end if;
    if not v_event.allow_ticket_transfer and not(v_admin and p_admin_override) then raise exception 'Transferencia desabilitada para o evento.'; end if;
  else raise exception 'Operacao invalida.'; end if;
  select * into v_target from public.customer_profiles where public_pin=v_pin and coalesce(account_status,'active')='active'; if not found then raise exception 'PIN nao encontrado.'; end if;
  if v_oi.participant_id is not null then select * into v_current from public.participants where id=v_oi.participant_id; end if;
  v_target_gender:=lower(trim(coalesce(v_target.gender,'')));
  select rbp.male_price,rbp.female_price into v_price from public.registration_batch_prices rbp where rbp.batch_id=v_oi.batch_id and rbp.ticket_category_id=v_oi.ticket_category_id;
  if v_price.male_price is distinct from v_price.female_price then
    v_priced_gender:=case when v_oi.unit_price=v_price.male_price and v_oi.unit_price is distinct from v_price.female_price then 'male' when v_oi.unit_price=v_price.female_price and v_oi.unit_price is distinct from v_price.male_price then 'female' end;
    if (v_priced_gender='male' and v_target_gender not in('male','masculino','m')) or (v_priced_gender='female' and v_target_gender not in('female','feminino','f')) or v_priced_gender is null then
      if not(v_admin and p_admin_override) then raise exception 'VALIDACAO_ADMINISTRATIVA: genero do usuario incompativel ou preco original ambiguo.'; end if;
    end if;
  end if;
  if v_current.id is not null and nullif(trim(v_oi.shirt_type),'') is not null and lower(trim(coalesce(v_current.gender,'')))<>v_target_gender and not(v_admin and p_admin_override) then
    raise exception 'VALIDACAO_ADMINISTRATIVA: camiseta existente exige revisao antes da transferencia.';
  end if;
  select count(*) into v_target_participant_count from public.participants where event_id=v_ticket.event_id and user_id=v_target.user_id;
  if v_target_participant_count>1 then
    raise exception 'VALIDACAO_ADMINISTRATIVA: usuario possui multiplos cadastros de participante neste evento.';
  elsif v_target_participant_count=1 then
    select * into strict v_target_participant from public.participants where event_id=v_ticket.event_id and user_id=v_target.user_id;
  else
    select lower(trim(au.email)) into v_target_email from auth.users au where au.id=v_target.user_id;
    if nullif(v_target_email,'') is null then raise exception 'Conta de destino sem e-mail valido para criar participante.'; end if;
    insert into public.participants(event_id,organization_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,shirt_type,shirt_size,registration_status,ticket_category_id,batch_id)
    values(v_ticket.event_id,v_ticket.organization_id,v_target.user_id,v_target.full_name,v_target.cpf,v_target.birth_date,v_target.gender,v_target.phone,v_target_email,v_target.city,
      nullif(trim(coalesce(v_oi.shirt_type,'')),''),nullif(trim(coalesce(v_oi.shirt_size,'')),''),'confirmed',v_oi.ticket_category_id,v_oi.batch_id) returning * into v_target_participant;
  end if;
  if v_current.user_id=v_target.user_id then raise exception 'Usuario ja e o titular do ingresso.'; end if;
  update public.order_items set participant_id=v_target_participant.id,holder_full_name=v_target.full_name,ownership_status=case when p_operation='ticket_transferred' then 'transferred' else 'assigned' end,updated_at=now() where id=v_oi.id;
  update public.tickets set participant_id=v_target_participant.id where id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason)
  values(v_ticket.id,v_oi.id,v_ticket.event_id,v_ticket.organization_id,p_operation,v_current.id,v_target_participant.id,v_current.user_id,v_target.user_id,v_actor,v_origin,nullif(trim(coalesce(p_reason,'')),''));
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values(p_operation,'tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object('ticket_id',v_ticket.id,'previous_user_id',v_current.user_id,'new_user_id',v_target.user_id,'actor_user_id',v_actor,'actor_origin',v_origin,'reason',nullif(trim(coalesce(p_reason,'')),'')));
  return v_target_participant.id;
end; $$;


ALTER FUNCTION "public"."change_ticket_holder_by_pin_internal"("p_ticket_id" "uuid", "p_pin" "text", "p_operation" "text", "p_admin_override" boolean, "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."change_ticket_shirt"("p_ticket_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select public.admin_change_ticket_shirt(p_ticket_id,p_new_shirt_type,p_new_shirt_size);
$$;


ALTER FUNCTION "public"."change_ticket_shirt"("p_ticket_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_participant_account_invite_eligibility"("p_participant_id" "uuid") RETURNS TABLE("eligible" boolean, "reason_code" "text", "reason_message" "text", "email" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare
  v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_email text; v_same_email integer;
  v_auth_count integer; v_auth_user auth.users%rowtype; v_inv public.participant_account_invites%rowtype;
  v_conflicting_participants integer; v_profile_cpf text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao.'; end if;
  select p.* into v_p from public.participants p where p.id=p_participant_id;
  if not found or not public.user_can_access_organization(v_actor,v_p.organization_id) then
    return query select false,'inaccessible','Cadastro invalido ou sem acesso.',null::text; return;
  end if;
  if v_p.user_id is not null then return query select false,'already_linked','Cadastro ja vinculado a uma conta.',null::text; return; end if;
  if nullif(trim(coalesce(v_p.email,'')),'') is null then return query select false,'missing_email','E-mail ausente.',null::text; return; end if;
  v_email:=lower(trim(v_p.email));
  if v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return query select false,'invalid_email','E-mail invalido.',v_email; return; end if;
  if not public.is_valid_cpf(v_p.cpf) then return query select false,'invalid_cpf','CPF invalido.',v_email; return; end if;
  select count(*) into v_same_email from public.participants p
    where p.organization_id=v_p.organization_id and p.user_id is null
      and lower(trim(coalesce(p.email,'')))=v_email;
  if v_same_email<>1 then return query select false,'shared_email','E-mail compartilhado por mais de um cadastro.',v_email; return; end if;

  select count(*) into v_auth_count from auth.users au where lower(trim(coalesce(au.email,'')))=v_email;
  if v_auth_count=0 then return query select true,'eligible','Cadastro apto para convite.',v_email; return; end if;
  if v_auth_count<>1 then return query select false,'account_conflict','E-mail pertence a outra conta NEXORA.',v_email; return; end if;
  select au.* into strict v_auth_user from auth.users au where lower(trim(coalesce(au.email,'')))=v_email;

  select pai.* into v_inv from public.participant_account_invites pai
  where pai.participant_id=v_p.id and lower(trim(pai.email))=v_email
    and pai.status='pending'
    and (pai.auth_user_id=v_auth_user.id
      or (pai.auth_user_id is null and v_auth_user.raw_user_meta_data->>'participant_invite_id'=pai.id::text))
  order by pai.created_at desc limit 1;
  if not found then return query select false,'account_conflict','E-mail pertence a outra conta NEXORA.',v_email; return; end if;

  select count(*) into v_conflicting_participants from public.participants p
    where p.user_id=v_auth_user.id and p.id<>v_p.id;
  if v_conflicting_participants>0 then return query select false,'account_conflict','E-mail pertence a outra conta NEXORA.',v_email; return; end if;

  select regexp_replace(coalesce(cp.cpf,''),'\D','','g') into v_profile_cpf
  from public.customer_profiles cp where cp.user_id=v_auth_user.id;
  if nullif(v_profile_cpf,'') is not null
    and v_profile_cpf<>regexp_replace(coalesce(v_p.cpf,''),'\D','','g') then
    return query select false,'account_conflict','E-mail pertence a outra conta NEXORA.',v_email; return;
  end if;

  if exists(
    select 1 from public.participation_history ph
    where ph.participant_id=v_p.id
      and ph.event_id=v_p.event_id
      and ph.source='import'
  ) then
    return query select true,'resend_invite_password_required','Convite importado pode ser reenviado para concluir o primeiro acesso.',v_email;
  else
    return query select true,'resend_invite_existing_account','Conta existente validada pelo convite; enviar acesso seguro para reivindicar o cadastro.',v_email;
  end if;
end; $_$;


ALTER FUNCTION "public"."check_participant_account_invite_eligibility"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."checkin_participant_entry"("p_participant_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant public.participants%rowtype;
  v_ticket public.tickets%rowtype;
  v_payment_status text := 'pending';
  v_actor_user_id uuid := auth.uid();
  v_actor_email text := coalesce(
    (
      select lower(u.email)
      from auth.users u
      where u.id = auth.uid()
    ),
    'system'
  );
begin
  if not public.current_user_has_permission('checkin.scan'::text) then
    raise exception 'Sem permissao para realizar check-in.';
  end if;

  select p.*
  into v_participant
  from public.participants p
  where p.id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select coalesce(pay.payment_status, 'pending')
  into v_payment_status
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by
    case when pay.payment_status = 'paid' then 0 else 1 end,
    pay.paid_at desc nulls last,
    pay.created_at desc
  limit 1;

  v_payment_status := coalesce(v_payment_status, 'pending');

  if v_payment_status <> 'paid' then
    raise exception 'Pagamento pendente. Check-in bloqueado.';
  end if;

  if coalesce(v_participant.registration_status, 'pending') = 'cancelled' then
    raise exception 'Inscricao cancelada. Check-in bloqueado.';
  end if;

  select t.*
  into v_ticket
  from public.tickets t
  where t.participant_id = p_participant_id
  order by t.issued_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    raise exception 'Ingresso ja utilizado anteriormente.';
  end if;

  update public.tickets t
  set status = 'used',
      used_at = now()
  where t.id = v_ticket.id;

  if v_participant.user_id is not null
     and v_participant.event_id is not null then
    insert into public.participation_history (
      event_id,
      user_id,
      participant_id,
      legacy_event_name,
      event_year,
      full_name,
      normalized_name,
      cpf,
      email,
      status,
      source,
      manually_verified,
      created_at,
      updated_at
    )
    values (
      v_participant.event_id,
      v_participant.user_id,
      v_participant.id,
      null,
      extract(year from coalesce(v_participant.created_at, now()))::integer,
      coalesce(nullif(trim(v_participant.full_name), ''), 'Participante'),
      public.normalize_text_for_match(v_participant.full_name),
      v_participant.cpf,
      v_participant.email,
      'confirmed',
      'system',
      false,
      now(),
      now()
    )
    on conflict do nothing;

    if to_regprocedure('public.recalculate_customer_loyalty(uuid)') is not null then
      perform public.recalculate_customer_loyalty(v_participant.user_id);
    end if;
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  )
  values (
    'participant_checkin_entry',
    'participants',
    p_participant_id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'actor_email', v_actor_email,
      'ticket_id', v_ticket.id,
      'used_at', now()
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."checkin_participant_entry"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."checkin_ticket_entry"("p_ticket_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype; v_participant public.participants%rowtype; v_paid boolean; v_actor_email text;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para realizar check-in.'; end if;
  if p_ticket_id is null then raise exception 'Ingresso obrigatorio.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Sem acesso a organizacao do ingresso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado. Check-in bloqueado.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Este ingresso ja foi utilizado.'; end if;
  if v_ticket.order_item_id is null then raise exception 'Ingresso sem order_item vinculado.'; end if;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update;
  if not found or v_oi.status in ('cancelled','expired','refunded') then raise exception 'Item de pedido invalido para check-in.'; end if;
  select * into v_order from public.orders where id=v_ticket.order_id;
  if not found then raise exception 'Pedido do ingresso nao encontrado.'; end if;
  select exists(
    select 1 from public.payments p
    where (p.order_id=v_ticket.order_id or p.id=v_order.payment_id)
      and p.payment_status='paid'
  ) into v_paid;
  if not v_paid then raise exception 'Pagamento pendente. Check-in bloqueado.'; end if;
  update public.tickets set status='used',used_at=now() where id=v_ticket.id;
  if v_oi.participant_id is not null then
    select * into v_participant from public.participants where id=v_oi.participant_id;
    if found and coalesce(v_participant.registration_status,'pending')='cancelled' then raise exception 'Inscricao cancelada. Check-in bloqueado.'; end if;
    if found and v_participant.user_id is not null then
      insert into public.participation_history(event_id,user_id,participant_id,legacy_event_name,event_year,full_name,normalized_name,cpf,email,status,source,manually_verified,created_at,updated_at)
      values(v_participant.event_id,v_participant.user_id,v_participant.id,null,extract(year from coalesce(v_participant.created_at,now()))::integer,
        coalesce(nullif(trim(v_participant.full_name),''),'Participante'),public.normalize_text_for_match(v_participant.full_name),v_participant.cpf,v_participant.email,'confirmed','system',false,now(),now())
      on conflict do nothing;
      if to_regprocedure('public.recalculate_customer_loyalty(uuid)') is not null then
        perform public.recalculate_customer_loyalty(v_participant.user_id);
      end if;
    end if;
  end if;
  select lower(email) into v_actor_email from auth.users where id=auth.uid();
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('ticket_checkin_entry','tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object('actor_user_id',auth.uid(),'actor_email',v_actor_email,'organization_id',v_ticket.organization_id,'ticket_id',v_ticket.id,'order_item_id',v_ticket.order_item_id,'participant_id',v_oi.participant_id,'used_at',now()));
  return true;
end;
$$;


ALTER FUNCTION "public"."checkin_ticket_entry"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_participant_account_invite"("p_invite_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid:=auth.uid();
  v_auth_email text;
  v_inv public.participant_account_invites%rowtype;
  v_p public.participants%rowtype;
  v_canonical_history_id uuid;
  v_canonical_participant_id uuid;
  v_duplicate_history_ids uuid[]:='{}'::uuid[];
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;

  select lower(trim(email)) into v_auth_email from auth.users where id=v_actor;
  select * into v_inv
  from public.participant_account_invites
  where id=p_invite_id
  for update;

  if not found then raise exception 'Convite invalido ou expirado.'; end if;

  -- O claim pode ser repetido depois que uma etapa posterior do primeiro acesso
  -- falhar. A repeticao nunca reabre nem transfere um convite ja reivindicado.
  if v_inv.status='claimed' then
    if v_inv.claimed_user_id is distinct from v_actor then
      raise exception 'Convite ja reivindicado por outra conta.';
    end if;
    select * into v_p from public.participants where id=v_inv.participant_id for update;
    if not found or v_p.user_id is distinct from v_actor then
      raise exception 'Estado inconsistente do convite reivindicado.';
    end if;
    return v_p.id;
  end if;

  if v_inv.status<>'pending' or v_inv.expires_at<=now() then
    raise exception 'Convite invalido ou expirado.';
  end if;
  if v_inv.auth_user_id is distinct from v_actor then
    raise exception 'O convite nao esta correlacionado a esta conta.';
  end if;
  if v_auth_email is distinct from lower(trim(v_inv.email)) then
    raise exception 'O convite nao pertence a esta conta.';
  end if;

  select * into v_p
  from public.participants
  where id=v_inv.participant_id
  for update;

  if not found or v_p.event_id is distinct from v_inv.event_id then
    raise exception 'Cadastro invalido para o evento do convite.';
  end if;
  if v_p.user_id is not null and v_p.user_id<>v_actor then
    raise exception 'Cadastro ja vinculado a outra conta.';
  end if;

  -- Serializa todos os candidatos capazes de participar da reconciliacao.
  perform ph.id
  from public.participation_history ph
  where ph.event_id=v_inv.event_id
    and (ph.user_id=v_actor or ph.participant_id=v_p.id)
  order by ph.created_at,ph.id
  for update;

  -- Um history explicitamente ligado a outro user nunca e apropriado pelo
  -- convite, ainda que compartilhe participant_id, e-mail ou CPF.
  if exists(
    select 1 from public.participation_history ph
    where ph.event_id=v_inv.event_id
      and ph.participant_id=v_p.id
      and ph.user_id is not null
      and ph.user_id<>v_actor
  ) then
    raise exception 'Historico do cadastro vinculado a outra conta; revisao manual obrigatoria.';
  end if;

  -- Se o ator ja possui um confirmado no evento, ele e o unico candidato
  -- canonico. So pode ser reconciliado quando nao pertence a outro participant.
  select ph.id,ph.participant_id
  into v_canonical_history_id,v_canonical_participant_id
  from public.participation_history ph
  where ph.user_id=v_actor
    and ph.event_id=v_inv.event_id
    and ph.status='confirmed'
  order by ph.created_at,ph.id
  limit 1;

  if v_canonical_history_id is not null
    and v_canonical_participant_id is not null
    and v_canonical_participant_id<>v_p.id then
    raise exception 'A conta ja possui participacao confirmada de outro cadastro neste evento.';
  end if;

  -- Sem confirmado previo do ator, preserva como canonico o primeiro history
  -- confirmado criado para o participant. O criterio e estavel entre retries.
  if v_canonical_history_id is null then
    select ph.id into v_canonical_history_id
    from public.participation_history ph
    where ph.participant_id=v_p.id
      and ph.event_id=v_inv.event_id
      and ph.status='confirmed'
    order by ph.created_at,ph.id
    limit 1;
  end if;

  if v_canonical_history_id is not null then
    with demoted as (
      update public.participation_history ph
      set status='duplicate',updated_at=now()
      where ph.participant_id=v_p.id
        and ph.event_id=v_inv.event_id
        and ph.status='confirmed'
        and ph.id<>v_canonical_history_id
      returning ph.id
    )
    select coalesce(array_agg(id order by id),'{}'::uuid[])
    into v_duplicate_history_ids
    from demoted;

    update public.participation_history
    set participant_id=v_p.id,updated_at=now()
    where id=v_canonical_history_id
      and participant_id is null;
  end if;

  -- Depois da desduplicacao, no maximo um row confirmed recebe o par
  -- (v_actor,event_id); os demais dados permanecem preservados como duplicate.
  update public.participation_history ph
  set user_id=v_actor,updated_at=now()
  where ph.participant_id=v_p.id
    and ph.event_id=v_inv.event_id
    and (ph.user_id is null or ph.user_id=v_actor);

  update public.participants
  set user_id=v_actor,updated_at=now()
  where id=v_p.id;

  update public.participant_account_invites
  set status='claimed',claimed_user_id=v_actor,claimed_at=now(),updated_at=now()
  where id=v_inv.id;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values(
    'participant_account_invite_claimed',
    'participants',
    v_p.id,
    v_p.event_id,
    jsonb_build_object(
      'invite_id',v_inv.id,
      'user_id',v_actor,
      'canonical_history_id',v_canonical_history_id,
      'duplicate_history_ids',to_jsonb(v_duplicate_history_ids)
    )
  );

  return v_p.id;
end;
$$;


ALTER FUNCTION "public"."claim_participant_account_invite"("p_invite_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_order_and_issue_ticket"("p_participant_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."confirm_order_and_issue_ticket"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_order_item_and_issue_ticket"("p_order_item_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."confirm_order_item_and_issue_ticket"("p_order_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_order_payment_and_issue_tickets"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "payment_id" "uuid", "payment_status" "text", "issued_tickets" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_item record;
  v_ticket_id uuid;
  v_count integer := 0;
begin
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;

  select * into v_payment
  from public.payments
  where public.payments.order_id = p_order_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;

  if v_payment.payment_status <> 'paid' then
    raise exception 'Pagamento ainda nao confirmado.';
  end if;

  update public.orders
  set status = 'confirmed',
      confirmed_at = coalesce(confirmed_at, now()),
      cancelled_at = null,
      payment_id = v_payment.id
  where id = p_order_id;

  for v_item in
    select oi.id
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.status not in ('cancelled', 'expired', 'refunded', 'transferred')
    order by coalesce(oi.item_position, 999999), oi.created_at
  loop
    select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id;
    if v_ticket_id is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return query
  select
    v_order.id,
    v_order.order_number,
    v_payment.id,
    v_payment.payment_status,
    v_count;
end;
$$;


ALTER FUNCTION "public"."confirm_order_payment_and_issue_tickets"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_registration_payment"("p_participant_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_inventory public.shirt_inventory%rowtype;
  v_available integer;
  v_re_reserved boolean := false;
  v_batch public.registration_batches%rowtype;
  v_batch_category_limit integer;
  v_confirmed_count integer;
  v_category_capacity integer;
  v_category_confirmed_count integer;
  v_category_reserved_count integer;
begin
  if p_participant_id is null then
    raise exception 'ID do participante e obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select * into v_payment
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;

  if v_participant.ticket_category_id is not null then
    select tc.capacity into v_category_capacity
    from public.ticket_categories tc
    where tc.id = v_participant.ticket_category_id
      and tc.event_id = v_participant.event_id
    limit 1;

    select count(*)::integer into v_category_confirmed_count
    from public.participants p
    where p.event_id = v_participant.event_id
      and p.ticket_category_id = v_participant.ticket_category_id
      and coalesce(p.registration_status, 'pending') <> 'cancelled'
      and p.reservation_status = 'confirmed'
      and p.id <> v_participant.id;

    if v_category_capacity is not null and v_category_confirmed_count >= v_category_capacity then
      raise exception 'Capacidade da categoria de acesso atingida para confirmacao.';
    end if;
  end if;

  if v_payment.payment_status = 'paid'
     and v_participant.reservation_status = 'confirmed' then
    perform * from public.advance_registration_batch_if_needed(v_participant.event_id);
    return true;
  end if;

  if v_participant.batch_id is not null and v_participant.ticket_category_id is not null then
    select * into v_batch
    from public.registration_batches
    where id = v_participant.batch_id
    for update;

    if found then
      select rbp.max_confirmed_registrations into v_batch_category_limit
      from public.registration_batch_prices rbp
      where rbp.batch_id = v_batch.id
        and rbp.ticket_category_id = v_participant.ticket_category_id;

      if v_batch_category_limit is not null or v_batch.ends_at is not null then
        select count(*)::integer into v_confirmed_count
        from public.participants part
        join public.payments pay
          on pay.participant_id = part.id
        where part.batch_id = v_batch.id
          and part.ticket_category_id = v_participant.ticket_category_id
          and coalesce(part.registration_status, 'pending') <> 'cancelled'
          and pay.payment_status = 'paid'
          and (part.reservation_status is null or part.reservation_status = 'confirmed');

        if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
           or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
          perform * from public.advance_registration_batch_if_needed(v_participant.event_id);
          raise exception 'Categoria esgotada no lote % para confirmacao de novas inscricoes.', v_batch.name;
        end if;
      end if;
    end if;
  end if;

  if v_participant.reservation_status in ('expired', 'released') then
    if v_participant.ticket_category_id is not null then
      select tc.capacity into v_category_capacity
      from public.ticket_categories tc
      where tc.id = v_participant.ticket_category_id
        and tc.event_id = v_participant.event_id
      limit 1;

      select count(*)::integer into v_category_reserved_count
      from public.participants p
      where p.event_id = v_participant.event_id
        and p.ticket_category_id = v_participant.ticket_category_id
        and coalesce(p.registration_status, 'pending') <> 'cancelled'
        and p.reservation_status in ('pending', 'confirmed');

      if v_category_capacity is not null and v_category_reserved_count >= v_category_capacity then
        raise exception 'Categoria sem vagas disponiveis para reativar reserva.';
      end if;
    end if;

    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para o modelo/tamanho do participante.';
    end if;

    v_available := v_inventory.total_quantity - v_inventory.reserved_quantity - v_inventory.delivered_quantity;
    if v_available <= 0 then
      raise exception 'Reserva expirada e sem estoque disponivel para reativar. Revisao manual necessaria.';
    end if;

    update public.shirt_inventory
    set reserved_quantity = reserved_quantity + 1,
        updated_at = now()
    where id = v_inventory.id;

    v_re_reserved := true;
  end if;

  update public.participants
  set registration_status = 'confirmed',
      reservation_status = 'confirmed',
      reservation_expires_at = null,
      reservation_released_at = null,
      updated_at = now()
  where id = p_participant_id;

  update public.payments
  set payment_status = 'paid',
      paid_at = now(),
      expires_at = null
  where participant_id = p_participant_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_payment_confirmed',
    'participants',
    p_participant_id,
    jsonb_build_object(
      're_reserved', v_re_reserved,
      'shirt_type', v_participant.shirt_type,
      'shirt_size', v_participant.shirt_size,
      'batch_id', v_participant.batch_id,
      'ticket_category_id', v_participant.ticket_category_id
    ),
    v_participant.event_id
  );

  perform * from public.advance_registration_batch_if_needed(v_participant.event_id);

  return true;
end;
$$;


ALTER FUNCTION "public"."confirm_registration_payment"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_store_order_payment"("p_store_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_order public.store_orders%rowtype;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para confirmar pagamentos da lojinha.'; end if;
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_order.status = 'cancelled' then raise exception 'Pedido cancelado nao pode ser confirmado.'; end if;
  if v_order.status = 'confirmed' then return; end if;

  update public.store_orders set status = 'confirmed', payment_status = 'paid', confirmed_at = now(), updated_at = now() where id = p_store_order_id;
  update public.store_order_items set status = 'confirmed' where store_order_id = p_store_order_id and status = 'reserved';
end; $$;


ALTER FUNCTION "public"."confirm_store_order_payment"("p_store_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_coupon"("p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_coupon_id uuid;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_coupon_type text := lower(trim(coalesce(p_coupon_type, '')));
  v_discount numeric := coalesce(p_discount_percent, 0);
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio para criacao de cupom.';
  end if;

  if v_code = '' then
    raise exception 'Codigo do cupom obrigatorio.';
  end if;

  if v_coupon_type = 'courtesy' then
    v_discount := 100;
  elsif v_coupon_type = 'percentage' then
    if v_discount <= 0 or v_discount > 100 then
      raise exception 'Cupom percentual deve ter desconto maior que 0 e menor ou igual a 100.';
    end if;
  else
    raise exception 'Tipo de cupom invalido.';
  end if;

  if p_max_uses is not null and p_max_uses <= 0 then
    raise exception 'Limite de usos deve ser maior que zero.';
  end if;

  insert into public.coupons (
    event_id,
    code,
    coupon_type,
    discount_percent,
    max_uses,
    valid_from,
    valid_until,
    notes,
    is_active
  ) values (
    p_event_id,
    v_code,
    v_coupon_type,
    v_discount,
    p_max_uses,
    p_valid_from,
    p_valid_until,
    nullif(trim(p_notes), ''),
    coalesce(p_is_active, true)
  ) returning id into v_coupon_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'coupon_created',
    'coupons',
    v_coupon_id,
    jsonb_build_object(
      'code', v_code,
      'coupon_type', v_coupon_type,
      'discount_percent', v_discount,
      'max_uses', p_max_uses
    ),
    p_event_id
  );

  return v_coupon_id;
end;
$$;


ALTER FUNCTION "public"."create_coupon"("p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_event"("p_name" "text", "p_slug" "text", "p_year" integer DEFAULT NULL::integer, "p_description" "text" DEFAULT NULL::"text", "p_starts_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_ends_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_registration_open_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_registration_close_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_location" "text" DEFAULT NULL::"text", "p_is_active" boolean DEFAULT false, "p_registration_enabled" boolean DEFAULT false, "p_kit_enabled" boolean DEFAULT false, "p_organization_id" "uuid" DEFAULT NULL::"uuid", "p_min_age" integer DEFAULT 18, "p_banner_hero_url" "text" DEFAULT NULL::"text", "p_banner_card_url" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_org uuid; v_id uuid; v_base_slug text; v_slug text; v_suffix integer:=1;
begin
  if v_actor is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if not public.current_user_has_permission('events.edit') then raise exception 'Permissao insuficiente para criar evento.'; end if;
  v_org:=coalesce(p_organization_id,public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor,v_org) then raise exception 'Acesso negado a organizacao.'; end if;
  if coalesce(p_is_active,false) or coalesce(p_registration_enabled,false) then
    if not public.current_user_has_permission('events.publish') then raise exception 'Permissao insuficiente para publicar evento.'; end if;
  end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nome do evento obrigatorio.'; end if;
  if coalesce(p_min_age,0) < 0 then raise exception 'Idade minima invalida.'; end if;
  v_base_slug:=public.slugify_text(coalesce(nullif(trim(p_slug),''),p_name||'-'||coalesce(p_year::text,extract(year from now())::text)));
  if v_base_slug='' then raise exception 'Slug do evento invalido.'; end if;
  v_slug:=v_base_slug;
  while exists(select 1 from public.events where slug=v_slug) loop
    v_suffix:=v_suffix+1;
    v_slug:=v_base_slug||'-'||v_suffix::text;
  end loop;
  insert into public.events(name,slug,year,description,starts_at,ends_at,registration_open_at,
    registration_close_at,location,is_active,registration_enabled,kit_enabled,organization_id,archived_at,archived_by,min_age,
    banner_hero_url,banner_card_url)
  values(trim(p_name),v_slug,p_year,nullif(trim(coalesce(p_description,'')),''),p_starts_at,p_ends_at,
    p_registration_open_at,p_registration_close_at,nullif(trim(coalesce(p_location,'')),''),
    coalesce(p_is_active,false),coalesce(p_registration_enabled,false),coalesce(p_kit_enabled,false),v_org,null,null,coalesce(p_min_age,18),
    nullif(trim(coalesce(p_banner_hero_url,'')),''),nullif(trim(coalesce(p_banner_card_url,'')),''))
  returning id into v_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_created','events',v_id,v_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_org,
      'previous_state',null,'new_state',jsonb_build_object('is_active',coalesce(p_is_active,false),
      'registration_enabled',coalesce(p_registration_enabled,false),'archived_at',null)));
  return v_id;
end; $$;


ALTER FUNCTION "public"."create_event"("p_name" "text", "p_slug" "text", "p_year" integer, "p_description" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_registration_open_at" timestamp with time zone, "p_registration_close_at" timestamp with time zone, "p_location" "text", "p_is_active" boolean, "p_registration_enabled" boolean, "p_kit_enabled" boolean, "p_organization_id" "uuid", "p_min_age" integer, "p_banner_hero_url" "text", "p_banner_card_url" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_financial_entry"("p_organization_id" "uuid", "p_entry_kind" "text", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_source_payment_id" "uuid", "p_lines" "jsonb", "p_allocations" "jsonb", "p_idempotency_key" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_debits numeric; v_credits numeric; v_allocated numeric; v_item jsonb;
begin
  if v_actor is null then raise exception 'Nao autenticado.'; end if;
  if not public.current_user_has_permission('finance.manage_entries') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_entry_kind='expense' and not public.current_user_has_permission('finance.manage_expenses') then raise exception 'Sem permissao para criar despesas.'; end if;
  if p_entry_kind='revenue' and not public.current_user_has_permission('finance.manage_income') then raise exception 'Sem permissao para criar receitas.'; end if;
  if p_entry_kind not in('revenue','expense','transfer','adjustment') or p_amount<=0 or nullif(trim(p_description),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Dados do lancamento invalidos.'; end if;
  select id into v_id from public.financial_entries where organization_id=p_organization_id and idempotency_key=trim(p_idempotency_key);
  if v_id is not null then return v_id; end if;
  if p_source_payment_id is not null and not exists(select 1 from public.payments where id=p_source_payment_id and organization_id=p_organization_id) then raise exception 'Pagamento fora da organizacao.'; end if;
  insert into public.financial_entries(organization_id,entry_kind,description,category_id,supplier_id,source_payment_id,amount,due_date,occurred_on,idempotency_key,created_by)
  values(p_organization_id,p_entry_kind,trim(p_description),p_category_id,p_supplier_id,p_source_payment_id,p_amount,p_due_date,coalesce(p_occurred_on,current_date),trim(p_idempotency_key),v_actor) returning id into v_id;
  for v_item in select value from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
    insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo)
    values(v_id,p_organization_id,(v_item->>'account_id')::uuid,v_item->>'side',(v_item->>'amount')::numeric,nullif(v_item->>'memo',''));
  end loop;
  select coalesce(sum(amount) filter(where line_side='debit'),0),coalesce(sum(amount) filter(where line_side='credit'),0) into v_debits,v_credits from public.financial_entry_lines where entry_id=v_id;
  if v_debits<>p_amount or v_credits<>p_amount then raise exception 'Partida dobrada desequilibrada: debitos e creditos devem coincidir com o total.'; end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_allocations,'[]'::jsonb)) loop
    if not exists(select 1 from public.events where id=(v_item->>'event_id')::uuid and organization_id=p_organization_id) then raise exception 'Evento do rateio fora da organizacao.'; end if;
    insert into public.financial_event_allocations(entry_id,organization_id,event_id,amount) values(v_id,p_organization_id,(v_item->>'event_id')::uuid,(v_item->>'amount')::numeric);
  end loop;
  select coalesce(sum(amount),0) into v_allocated from public.financial_event_allocations where entry_id=v_id;
  if v_allocated>p_amount then raise exception 'Rateio excede o valor do lancamento.'; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_entry_created','financial_entries',v_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'entry_kind',p_entry_kind,'amount',p_amount,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
exception when unique_violation then select id into v_id from public.financial_entries where organization_id=p_organization_id and idempotency_key=trim(p_idempotency_key); return v_id;
end $$;


ALTER FUNCTION "public"."create_financial_entry"("p_organization_id" "uuid", "p_entry_kind" "text", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_source_payment_id" "uuid", "p_lines" "jsonb", "p_allocations" "jsonb", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_imported_order_and_issue_ticket"("p_participant_id" "uuid", "p_import_batch_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_email text;
  v_batch public.import_batches%rowtype;
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_order_id uuid;
  v_order_item_id uuid;
  v_ticket_id uuid;
  v_previous_user_id uuid;
begin
  if v_actor_user_id is null then raise exception 'Usuario nao autenticado.'; end if;

  select * into v_batch from public.import_batches where id = p_import_batch_id for update;
  if not found or v_batch.import_type <> 'current_event_registrations' then
    raise exception 'Lote de importacao de inscritos invalido.';
  end if;
  if v_batch.imported_by <> v_actor_user_id then
    raise exception 'Somente o operador do lote pode emitir seus ingressos importados.';
  end if;

  select * into v_participant from public.participants where id = p_participant_id for update;
  if not found or v_participant.event_id is distinct from v_batch.event_id then
    raise exception 'Participante nao pertence ao evento do lote.';
  end if;

  select * into v_payment from public.payments
  where participant_id = p_participant_id order by created_at desc limit 1 for update;
  if not found then raise exception 'Pagamento do participante nao encontrado.'; end if;

  select o.id, o.user_id into v_order_id, v_previous_user_id
  from public.orders o
  where o.participant_id = v_participant.id
    and o.event_id = v_batch.event_id
    and o.user_id = v_actor_user_id
    and o.buyer_type = 'account'
    and o.created_at >= v_batch.created_at
    and o.created_at <= coalesce(v_batch.completed_at, now())
  order by o.created_at desc
  limit 1
  for update;

  if v_order_id is null then
    insert into public.orders (
      user_id, participant_id, event_id, payment_id, order_number, status,
      base_amount, discount_amount, final_amount, buyer_type, import_batch_id, confirmed_at
    ) values (
      null, v_participant.id, v_participant.event_id, v_payment.id, public.generate_order_number(),
      case when v_payment.payment_status = 'paid' then 'confirmed' else 'pending' end,
      coalesce(v_payment.amount, 0), coalesce(v_payment.discount_amount, 0),
      coalesce(v_payment.final_amount, v_payment.amount, 0), 'imported_holder', v_batch.id,
      case when v_payment.payment_status = 'paid' then now() else null end
    ) returning id into v_order_id;
  else
    update public.orders
    set user_id = null,
        buyer_type = 'imported_holder',
        import_batch_id = v_batch.id
    where id = v_order_id;
  end if;

  update public.payments set order_id = v_order_id where id = v_payment.id;

  -- create_registration pode ter vinculado o operador ao participante.
  -- Mantem o vinculo somente quando CPF e e-mail realmente identificam a mesma conta.
  update public.participants p
  set user_id = null, updated_at = now()
  where p.id = v_participant.id
    and p.user_id = v_actor_user_id
    and (
      nullif(regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g'), '')
        is distinct from (
          select nullif(regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g'), '')
          from public.customer_profiles cp where cp.user_id = v_actor_user_id
        )
      or lower(nullif(trim(p.email), '')) is distinct from (
          select lower(nullif(trim(au.email), ''))
          from auth.users au where au.id = v_actor_user_id
        )
    );

  select oi.id into v_order_item_id
  from public.order_items oi
  where oi.order_id = v_order_id
  order by oi.created_at asc
  limit 1
  for update;

  if v_order_item_id is null then
    insert into public.order_items (
    order_id, event_id, participant_id, ownership_status, holder_full_name,
    ticket_category_id, batch_id, shirt_type, shirt_size, quantity,
    unit_price, discount_amount, final_amount, status, reservation_expires_at
  ) values (
    v_order_id, v_participant.event_id, v_participant.id, 'assigned', v_participant.full_name,
    v_participant.ticket_category_id, v_participant.batch_id, v_participant.shirt_type,
    v_participant.shirt_size, 1, coalesce(v_payment.amount, 0),
    coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount, 0),
    case when v_payment.payment_status = 'paid' then 'confirmed' else 'reserved' end,
    v_participant.reservation_expires_at
    ) returning id into v_order_item_id;
  end if;

  if v_payment.payment_status = 'paid' then
    select t.id into v_ticket_id
    from public.tickets t
    where t.order_item_id = v_order_item_id
    limit 1;

    if v_ticket_id is null then
      select public.confirm_order_item_and_issue_ticket(v_order_item_id) into v_ticket_id;
    end if;
  end if;

  select lower(email) into v_actor_email from auth.users where id = v_actor_user_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('imported_registration_order_created', 'orders', v_order_id, v_participant.event_id,
    jsonb_build_object(
      'imported_by_user_id', v_actor_user_id,
      'imported_by_email', v_actor_email,
      'import_batch_id', v_batch.id,
      'participant_id', v_participant.id,
      'ticket_id', v_ticket_id,
      'order_id', v_order_id,
      'previous_user_id', v_previous_user_id,
      'source', 'import',
      'correction_reason', case
        when v_previous_user_id is null then 'pedido criado sem comprador para inscricao importada'
        else 'operador do lote removido da propriedade do pedido importado'
      end
    ));

  return v_ticket_id;
end;
$$;


ALTER FUNCTION "public"."create_imported_order_and_issue_ticket"("p_participant_id" "uuid", "p_import_batch_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_inventory_item"("p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid;
  v_item_id uuid;
  v_actor text := coalesce(auth.role(), 'anon');
begin
  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  if p_shirt_type not in ('Camiseta', 'Babylook') then
    raise exception 'Modelo invalido. Use Camiseta ou Babylook.';
  end if;

  if p_shirt_type = 'Camiseta' and p_shirt_size not in ('PP', 'P', 'M', 'G', 'GG', 'EG', 'EXG', 'EXGG') then
    raise exception 'Tamanho invalido para Camiseta.';
  end if;

  if p_shirt_type = 'Babylook' and p_shirt_size not in ('PP', 'P', 'M', 'G', 'GG', 'EG') then
    raise exception 'Tamanho invalido para Babylook.';
  end if;

  if p_total_quantity is null or p_total_quantity < 0 then
    raise exception 'Quantidade total deve ser maior ou igual a zero.';
  end if;

  if exists (
    select 1
    from public.shirt_inventory
    where event_id = v_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
  ) then
    raise exception 'Ja existe uma linha para este modelo e tamanho no evento ativo.';
  end if;

  insert into public.shirt_inventory (
    event_id,
    shirt_type,
    shirt_size,
    total_quantity,
    reserved_quantity,
    delivered_quantity
  ) values (
    v_event_id,
    p_shirt_type,
    p_shirt_size,
    p_total_quantity,
    0,
    0
  )
  returning id into v_item_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_created',
    'shirt_inventory',
    v_item_id,
    v_event_id,
    jsonb_build_object(
      'shirt_type', p_shirt_type,
      'shirt_size', p_shirt_size,
      'total_quantity', p_total_quantity,
      'reserved_quantity', 0,
      'delivered_quantity', 0
    )
  );

  return v_item_id;
end;
$$;


ALTER FUNCTION "public"."create_inventory_item"("p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_inventory_item"("p_event_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_item_id uuid;
  v_actor text := coalesce(auth.role(), 'anon');
  v_event_exists boolean := false;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(trim(p_shirt_type), '') = '' then
    raise exception 'Modelo obrigatorio.';
  end if;

  if coalesce(trim(p_shirt_size), '') = '' then
    raise exception 'Tamanho obrigatorio.';
  end if;

  if p_total_quantity is null or p_total_quantity < 0 then
    raise exception 'Quantidade total deve ser maior ou igual a zero.';
  end if;

  select exists (
    select 1
    from public.events
    where id = p_event_id
  ) into v_event_exists;

  if not v_event_exists then
    raise exception 'Evento nao encontrado.';
  end if;

  if exists (
    select 1
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
  ) then
    raise exception 'Ja existe uma linha para este modelo e tamanho neste evento.';
  end if;

  insert into public.shirt_inventory (
    event_id,
    shirt_type,
    shirt_size,
    total_quantity,
    reserved_quantity,
    delivered_quantity
  ) values (
    p_event_id,
    p_shirt_type,
    p_shirt_size,
    p_total_quantity,
    0,
    0
  ) returning id into v_item_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_created',
    'shirt_inventory',
    v_item_id,
    p_event_id,
    jsonb_build_object(
      'shirt_type', p_shirt_type,
      'shirt_size', p_shirt_size,
      'total_quantity', p_total_quantity,
      'reserved_quantity', 0,
      'delivered_quantity', 0
    )
  );

  return v_item_id;
end;
$$;


ALTER FUNCTION "public"."create_inventory_item"("p_event_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_manual_registration_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS TABLE("participant_id" "uuid", "order_id" "uuid", "order_item_id" "uuid", "payment_id" "uuid", "ticket_id" "uuid", "full_name" "text", "batch_name" "text", "base_amount" numeric, "discount_amount" numeric, "final_amount" numeric, "payment_status" "text", "reservation_expires_at" timestamp with time zone, "shirt_type" "text", "shirt_size" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  v_has_shirt_item boolean;
  v_enforce_physical_stock boolean;
  v_shirt_type text;
  v_shirt_size text;
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
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

  select exists(
    select 1 from public.event_kit_items eki
    where eki.event_id=p_event_id and eki.item_type='shirt' and eki.is_active=true
  ) into v_has_shirt_item;
  v_enforce_physical_stock := coalesce(v_event.limit_shirt_selection_to_stock,false);

  if v_has_shirt_item then
    v_shirt_type := nullif(trim(coalesce(p_shirt_type,'')),'');
    v_shirt_size := nullif(trim(coalesce(p_shirt_size,'')),'');
    if v_shirt_type is null or v_shirt_size is null then
      raise exception 'Camiseta obrigatoria para este evento.';
    end if;
  else
    v_shirt_type := null;
    v_shirt_size := null;
  end if;

  select * into v_participant from public.participants p
  where p.event_id=p_event_id
    and regexp_replace(coalesce(p.cpf,''),'\D','','g')=v_cpf
  order by p.created_at limit 1 for update;

  if not found then
    insert into public.participants(
      event_id,organization_id,full_name,cpf,birth_date,gender,phone,email,city,
      registration_status,reservation_status,notes
    ) values(
      p_event_id,v_event.organization_id,trim(p_full_name),v_cpf,p_birth_date,
      nullif(trim(coalesce(p_gender,'')),''),v_phone,lower(trim(p_email)),
      nullif(trim(coalesce(p_city,'')),''),'pending','pending',v_notes
    ) returning * into v_participant;
  else
    update public.participants set
      full_name=trim(p_full_name),birth_date=p_birth_date,
      gender=nullif(trim(coalesce(p_gender,'')),''),phone=v_phone,
      email=lower(trim(p_email)),city=nullif(trim(coalesce(p_city,'')),''),updated_at=now(),
      notes=coalesce(v_notes,v_participant.notes)
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
    discount_amount,final_amount,status,reservation_expires_at
  ) values(
    v_order.id,p_event_id,v_participant.id,'assigned',v_participant.full_name,
    p_ticket_category_id,p_batch_id,v_shirt_type,v_shirt_size,1,v_base_amount,
    v_base_amount,0,'confirmed',null
  ) returning * into v_item;

  if v_has_shirt_item and v_enforce_physical_stock then
    select * into v_inventory from public.shirt_inventory
    where event_id=p_event_id and shirt_type=v_shirt_type and shirt_size=v_shirt_size
    for update;
    if not found or v_inventory.total_quantity-v_inventory.reserved_quantity-v_inventory.delivered_quantity<=0 then
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
      'reason',lower(trim(p_payment_method)),'notes',v_notes,'category_owner','order_items'));

  return query select v_participant.id,v_order.id,v_item.id,v_payment.id,v_ticket_id,
    v_participant.full_name,v_batch_name,v_base_amount,
    v_base_amount,0::numeric,v_payment.payment_status,
    null::timestamptz,coalesce(v_item.shirt_type,''),coalesce(v_item.shirt_size,'');
end;
$$;


ALTER FUNCTION "public"."create_manual_registration_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_manual_unassigned_ticket_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_item_id" "uuid", "payment_id" "uuid", "ticket_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  v_has_shirt_item boolean;
  v_enforce_physical_stock boolean;
  v_shirt_type text;
  v_shirt_size text;
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
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

  select exists(
    select 1 from public.event_kit_items eki
    where eki.event_id=p_event_id and eki.item_type='shirt' and eki.is_active=true
  ) into v_has_shirt_item;
  v_enforce_physical_stock := coalesce(v_event.limit_shirt_selection_to_stock,false);

  if v_has_shirt_item then
    v_shirt_type := nullif(trim(coalesce(p_shirt_type,'')),'');
    v_shirt_size := nullif(trim(coalesce(p_shirt_size,'')),'');
    if v_shirt_type is null or v_shirt_size is null then
      raise exception 'Camiseta obrigatoria para este evento.';
    end if;
  else
    v_shirt_type := null;
    v_shirt_size := null;
  end if;

  insert into public.orders(user_id,participant_id,event_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,confirmed_at)
  values(v_actor,null,p_event_id,public.generate_order_number(),'confirmed',
    v_base_amount,v_base_amount,0,'account',now()) returning id into v_order_id;
  insert into public.order_items(order_id,event_id,participant_id,ownership_status,ticket_category_id,batch_id,shirt_type,shirt_size,
    quantity,unit_price,discount_amount,final_amount,status,reservation_expires_at)
  values(v_order_id,p_event_id,null,'unassigned',p_ticket_category_id,p_batch_id,v_shirt_type,v_shirt_size,
    1,v_base_amount,v_base_amount,0,
    'confirmed',null) returning id into v_item_id;

  if v_has_shirt_item and v_enforce_physical_stock then
    select * into v_inventory from public.shirt_inventory
    where event_id=p_event_id and shirt_type=v_shirt_type and shirt_size=v_shirt_size for update;
    if not found or v_inventory.total_quantity-v_inventory.reserved_quantity-v_inventory.delivered_quantity<=0 then
      raise exception 'Estoque indisponivel para o modelo/tamanho selecionado.';
    end if;
    update public.shirt_inventory set reserved_quantity=reserved_quantity+1,updated_at=now() where id=v_inventory.id;
  end if;

  insert into public.payments(participant_id,event_id,organization_id,order_id,amount,discount_amount,final_amount,payment_method,payment_status,paid_at,expires_at)
  values(null,p_event_id,v_event.organization_id,v_order_id,v_base_amount,v_base_amount,0,
    lower(trim(p_payment_method)),'paid',now(),null) returning id into v_payment_id;
  update public.orders set payment_id=v_payment_id where id=v_order_id;
  v_ticket_id:=public.confirm_order_item_and_issue_ticket(v_item_id);

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('manual_unassigned_ticket_order_created','orders',v_order_id,p_event_id,
    jsonb_build_object('actor_user_id',v_actor,'order_item_id',v_item_id,
      'ticket_category_id',p_ticket_category_id,'batch_id',p_batch_id,
      'payment_id',v_payment_id,'ticket_id',v_ticket_id,
      'reason',lower(trim(p_payment_method)),'notes',v_notes));

  return query select v_order_id,v_item_id,v_payment_id,v_ticket_id;
end;
$$;


ALTER FUNCTION "public"."create_manual_unassigned_ticket_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_multi_ticket_order_checkout"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text" DEFAULT NULL::"text", "p_shirt_type" "text" DEFAULT NULL::"text", "p_shirt_size" "text" DEFAULT NULL::"text", "p_buyer_full_name" "text" DEFAULT NULL::"text", "p_buyer_cpf" "text" DEFAULT NULL::"text", "p_buyer_birth_date" "date" DEFAULT NULL::"date", "p_buyer_gender" "text" DEFAULT NULL::"text", "p_buyer_phone" "text" DEFAULT NULL::"text", "p_buyer_email" "text" DEFAULT NULL::"text", "p_buyer_city" "text" DEFAULT NULL::"text", "p_assign_first_to_buyer" boolean DEFAULT true, "p_items" "jsonb" DEFAULT '[]'::"jsonb", "p_limit_per_order" integer DEFAULT 10, "p_notes" "text" DEFAULT NULL::"text", "p_client_request_id" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "payment_id" "uuid", "order_number" "text", "payment_status" "text", "reservation_expires_at" timestamp with time zone, "item_count" integer, "amount" numeric, "discount_amount" numeric, "final_amount" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event public.events%rowtype;
  v_limit_stock boolean := false;
  v_item_index integer;
  v_item_payload jsonb;
  v_raw_type text;
  v_raw_size text;
  v_norm_type text;
  v_norm_size text;
  v_variant record;
  v_inventory public.shirt_inventory%rowtype;
  v_required_total integer;
  v_result record;
begin
  if to_regprocedure('public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)') is null then
    raise exception 'Funcao legacy de checkout nao encontrada.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  v_limit_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

  if v_limit_stock then
    return query
    select *
    from public.create_multi_ticket_order_checkout_legacy(
      p_event_id,
      p_ticket_category_id,
      p_gender,
      p_quantity,
      p_payment_method,
      p_coupon_code,
      p_shirt_type,
      p_shirt_size,
      p_buyer_full_name,
      p_buyer_cpf,
      p_buyer_birth_date,
      p_buyer_gender,
      p_buyer_phone,
      p_buyer_email,
      p_buyer_city,
      p_assign_first_to_buyer,
      p_items,
      p_limit_per_order,
      p_notes,
      p_client_request_id
    );
    return;
  end if;

  create temporary table if not exists pg_temp.tmp_inventory_checkout_boost (
    inventory_id uuid primary key,
    original_total integer not null
  ) on commit drop;

  if to_regclass('pg_temp.tmp_inventory_checkout_boost') is not null then
    execute 'truncate table pg_temp.tmp_inventory_checkout_boost';
end if;

  for v_item_index in 1..greatest(coalesce(p_quantity, 0), 0) loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    v_raw_type := nullif(trim(coalesce(v_item_payload ->> 'shirt_type', p_shirt_type, '')), '');
    v_raw_size := nullif(trim(coalesce(v_item_payload ->> 'shirt_size', p_shirt_size, '')), '');

    if v_raw_type is null or v_raw_size is null then
      continue;
    end if;

    if lower(v_raw_type) = 'camiseta' then
      v_norm_type := 'Camiseta';
    elsif lower(v_raw_type) = 'babylook' then
      v_norm_type := 'Babylook';
    else
      v_norm_type := initcap(lower(v_raw_type));
    end if;

    v_norm_size := upper(v_raw_size);

    select * into v_inventory
    from public.shirt_inventory si
    where si.event_id = p_event_id
      and upper(trim(si.shirt_type)) = upper(trim(v_norm_type))
      and upper(trim(si.shirt_size)) = upper(trim(v_norm_size))
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para variante % / %.', v_norm_type, v_norm_size;
    end if;

    insert into pg_temp.tmp_inventory_checkout_boost (inventory_id, original_total)
    values (v_inventory.id, coalesce(v_inventory.total_quantity, 0))
    on conflict (inventory_id) do nothing;
  end loop;

  for v_variant in
    select
      v.inventory_id,
      count(*)::integer as requested_qty
    from (
      select
        si.id as inventory_id
      from generate_series(1, greatest(coalesce(p_quantity, 0), 0)) gs(idx)
      cross join lateral (
        select case
          when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (gs.idx - 1), '{}'::jsonb)
          else '{}'::jsonb
        end as payload
      ) item
      cross join lateral (
        select nullif(trim(coalesce(item.payload ->> 'shirt_type', p_shirt_type, '')), '') as raw_type,
               nullif(trim(coalesce(item.payload ->> 'shirt_size', p_shirt_size, '')), '') as raw_size
      ) raw
      cross join lateral (
        select case
          when raw.raw_type is null then null
          when lower(raw.raw_type) = 'camiseta' then 'Camiseta'
          when lower(raw.raw_type) = 'babylook' then 'Babylook'
          else initcap(lower(raw.raw_type))
        end as norm_type,
        case when raw.raw_size is null then null else upper(raw.raw_size) end as norm_size
      ) normalized
      join public.shirt_inventory si
        on si.event_id = p_event_id
       and upper(trim(si.shirt_type)) = upper(trim(normalized.norm_type))
       and upper(trim(si.shirt_size)) = upper(trim(normalized.norm_size))
      where normalized.norm_type is not null
        and normalized.norm_size is not null
    ) v
    group by v.inventory_id
  loop
    select * into v_inventory
    from public.shirt_inventory
    where id = v_variant.inventory_id
    for update;

    v_required_total := coalesce(v_inventory.reserved_quantity, 0)
      + coalesce(v_inventory.delivered_quantity, 0)
      + coalesce(v_variant.requested_qty, 0);

    if coalesce(v_inventory.total_quantity, 0) < v_required_total then
      update public.shirt_inventory
      set total_quantity = v_required_total,
          updated_at = now()
      where id = v_inventory.id;
    end if;
  end loop;

  begin
    select * into v_result
    from public.create_multi_ticket_order_checkout_legacy(
      p_event_id,
      p_ticket_category_id,
      p_gender,
      p_quantity,
      p_payment_method,
      p_coupon_code,
      p_shirt_type,
      p_shirt_size,
      p_buyer_full_name,
      p_buyer_cpf,
      p_buyer_birth_date,
      p_buyer_gender,
      p_buyer_phone,
      p_buyer_email,
      p_buyer_city,
      p_assign_first_to_buyer,
      p_items,
      p_limit_per_order,
      p_notes,
      p_client_request_id
    )
    limit 1;
  exception
    when others then
      update public.shirt_inventory si
      set total_quantity = boost.original_total,
          updated_at = now()
      from pg_temp.tmp_inventory_checkout_boost boost
      where si.id = boost.inventory_id;
      raise;
  end;

  update public.shirt_inventory si
  set total_quantity = boost.original_total,
      updated_at = now()
  from pg_temp.tmp_inventory_checkout_boost boost
  where si.id = boost.inventory_id;

  return query
  select
    v_result.order_id,
    v_result.payment_id,
    v_result.order_number,
    v_result.payment_status,
    v_result.reservation_expires_at,
    v_result.item_count,
    v_result.amount,
    v_result.discount_amount,
    v_result.final_amount;
end;
$$;


ALTER FUNCTION "public"."create_multi_ticket_order_checkout"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_buyer_full_name" "text", "p_buyer_cpf" "text", "p_buyer_birth_date" "date", "p_buyer_gender" "text", "p_buyer_phone" "text", "p_buyer_email" "text", "p_buyer_city" "text", "p_assign_first_to_buyer" boolean, "p_items" "jsonb", "p_limit_per_order" integer, "p_notes" "text", "p_client_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_multi_ticket_order_checkout_legacy"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text" DEFAULT NULL::"text", "p_shirt_type" "text" DEFAULT NULL::"text", "p_shirt_size" "text" DEFAULT NULL::"text", "p_buyer_full_name" "text" DEFAULT NULL::"text", "p_buyer_cpf" "text" DEFAULT NULL::"text", "p_buyer_birth_date" "date" DEFAULT NULL::"date", "p_buyer_gender" "text" DEFAULT NULL::"text", "p_buyer_phone" "text" DEFAULT NULL::"text", "p_buyer_email" "text" DEFAULT NULL::"text", "p_buyer_city" "text" DEFAULT NULL::"text", "p_assign_first_to_buyer" boolean DEFAULT true, "p_items" "jsonb" DEFAULT '[]'::"jsonb", "p_limit_per_order" integer DEFAULT 10, "p_notes" "text" DEFAULT NULL::"text", "p_client_request_id" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "payment_id" "uuid", "order_number" "text", "payment_status" "text", "reservation_expires_at" timestamp with time zone, "item_count" integer, "amount" numeric, "discount_amount" numeric, "final_amount" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_user_id uuid := auth.uid();
  v_event public.events%rowtype;
  v_pricing record;
  v_batch_id uuid;
  v_batch_name text;
  v_order_id uuid;
  v_order_number text;
  v_payment_id uuid;
  v_anchor_participant_id uuid;
  v_reservation_expires_at timestamptz;
  v_item_index integer;
  v_item_payload jsonb;
  v_ownership_status text;
  v_holder_name text;
  v_holder_email text;
  v_holder_phone text;
  v_status text := 'reserved';
  v_payment_status text := 'pending';
  v_total_amount numeric := 0;
  v_total_discount numeric := 0;
  v_total_final numeric := 0;
  v_available_category integer;
  v_unassigned_in_category integer := 0;
  v_required_shirt boolean := false;
  v_inventory public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_existing_order public.orders%rowtype;
begin
  if v_user_id is null then
    raise exception 'Sessao autenticada obrigatoria.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(p_quantity, 0) < 1 then
    raise exception 'Quantidade minima de ingressos: 1.';
  end if;

  if p_limit_per_order is not null and p_quantity > p_limit_per_order then
    raise exception 'Limite maximo por pedido excedido (%).', p_limit_per_order;
  end if;

  if coalesce(trim(coalesce(p_payment_method, '')), '') not in ('pix', 'credit_card', 'cash', 'courtesy') then
    raise exception 'Metodo de pagamento invalido.';
  end if;

  if coalesce(trim(coalesce(p_buyer_full_name, '')), '') = '' then
    raise exception 'Nome do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_cpf, '')), '') = '' then
    raise exception 'CPF do comprador obrigatorio.';
  end if;

  if p_buyer_birth_date is null then
    raise exception 'Data de nascimento do comprador obrigatoria.';
  end if;

  if coalesce(trim(coalesce(p_buyer_gender, '')), '') = '' then
    raise exception 'Genero do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_phone, '')), '') = '' then
    raise exception 'Telefone do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_city, '')), '') = '' then
    raise exception 'Cidade do comprador obrigatoria.';
  end if;

  if coalesce(trim(coalesce(p_buyer_email, '')), '') = '' then
    raise exception 'E-mail do comprador obrigatorio.';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.registration_enabled, false) then
    raise exception 'Inscricoes fechadas para este evento.';
  end if;

  if v_event.registration_open_at is not null and v_event.registration_open_at > now() then
    raise exception 'Inscricoes ainda nao abertas para este evento.';
  end if;

  if v_event.registration_close_at is not null and v_event.registration_close_at < now() then
    raise exception 'Inscricoes encerradas para este evento.';
  end if;

  if p_client_request_id is not null and trim(p_client_request_id) <> '' then
    select * into v_existing_order
    from public.orders
    where user_id = v_user_id
      and client_request_id = trim(p_client_request_id)
    limit 1;

    if found then
      select pay.id, pay.payment_status, pay.expires_at, pay.amount, pay.discount_amount, pay.final_amount
      into v_payment_id, v_payment_status, v_reservation_expires_at, v_total_amount, v_total_discount, v_total_final
      from public.payments pay
      where pay.order_id = v_existing_order.id
      order by pay.created_at desc
      limit 1;

      return query
      select
        v_existing_order.id,
        v_payment_id,
        v_existing_order.order_number,
        coalesce(v_payment_status, 'pending'),
        v_reservation_expires_at,
        coalesce((select count(*)::integer from public.order_items oi where oi.order_id = v_existing_order.id), 0),
        coalesce(v_total_amount, 0),
        coalesce(v_total_discount, 0),
        coalesce(v_total_final, 0);
      return;
    end if;
  end if;

  select * into v_pricing
  from public.get_registration_pricing_preview(
    p_gender,
    nullif(trim(coalesce(p_coupon_code, '')), ''),
    p_event_id,
    p_ticket_category_id
  )
  limit 1;

  if v_pricing.batch_id is null then
    raise exception 'Nao foi possivel calcular o preco para a categoria.';
  end if;

  v_batch_id := v_pricing.batch_id;
  v_batch_name := v_pricing.batch_name;

  select tc.available_slots
  into v_available_category
  from public.get_event_ticket_categories(p_event_id) tc
  where tc.id = p_ticket_category_id
  limit 1;

  if v_available_category is null then
    v_available_category := 2147483647;
  end if;

  select count(*)::integer into v_unassigned_in_category
  from public.order_items oi
  where oi.event_id = p_event_id
    and oi.ticket_category_id = p_ticket_category_id
    and oi.participant_id is null
    and oi.status in ('reserved', 'confirmed');

  if (v_available_category - v_unassigned_in_category) < p_quantity then
    raise exception 'Capacidade da categoria insuficiente para % ingressos.', p_quantity;
  end if;

  select exists (
    select 1
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.item_type = 'shirt'
      and eki.is_active = true
      and eki.is_required = true
  ) into v_required_shirt;

  if v_required_shirt and (coalesce(trim(coalesce(p_shirt_type, '')), '') = '' or coalesce(trim(coalesce(p_shirt_size, '')), '') = '') then
    raise exception 'Camiseta obrigatoria para este evento.';
  end if;

  if coalesce(trim(coalesce(p_shirt_type, '')), '') <> '' and coalesce(trim(coalesce(p_shirt_size, '')), '') <> '' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para este modelo e tamanho.';
    end if;

    v_available_stock := coalesce(v_inventory.total_quantity, 0) - coalesce(v_inventory.reserved_quantity, 0) - coalesce(v_inventory.delivered_quantity, 0);
    if v_available_stock < p_quantity then
      raise exception 'Estoque insuficiente para a quantidade solicitada (%).', p_quantity;
    end if;
  end if;

  v_total_amount := round(coalesce(v_pricing.base_amount, 0) * p_quantity, 2);
  v_total_discount := round(coalesce(v_pricing.discount_amount, 0) * p_quantity, 2);
  v_total_final := round(coalesce(v_pricing.final_amount, 0) * p_quantity, 2);

  if lower(trim(coalesce(p_payment_method, ''))) = 'courtesy' or v_total_final <= 0 then
    v_payment_status := 'paid';
    v_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_payment_status := 'pending';
    v_status := 'reserved';
    v_reservation_expires_at := now() + interval '2 hours';
  end if;

  select p.id into v_anchor_participant_id
  from public.participants p
  where p.event_id = p_event_id
    and regexp_replace(coalesce(p.cpf, ''), '\\D', '', 'g') = regexp_replace(coalesce(p_buyer_cpf, ''), '\\D', '', 'g')
    and p.user_id = v_user_id
  order by p.created_at asc
  limit 1
  for update;

  if v_anchor_participant_id is null then
    insert into public.participants (
      event_id,
      full_name,
      cpf,
      birth_date,
      gender,
      phone,
      email,
      city,
      shirt_type,
      shirt_size,
      registration_status,
      notes,
      reservation_status,
      reservation_expires_at,
      batch_id,
      base_amount,
      discount_amount,
      final_amount,
      ticket_category_id,
      user_id
    ) values (
      p_event_id,
      trim(p_buyer_full_name),
      regexp_replace(coalesce(p_buyer_cpf, ''), '\\D', '', 'g'),
      p_buyer_birth_date,
      trim(p_buyer_gender),
      regexp_replace(coalesce(p_buyer_phone, ''), '\\D', '', 'g'),
      lower(trim(p_buyer_email)),
      trim(p_buyer_city),
      coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), 'Sem camiseta'),
      coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), 'N/A'),
      case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      coalesce(
      nullif(trim(coalesce(p_notes, '')), ''),
      'Anchor participante do checkout multi-ingressos'
    ),
      case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      v_reservation_expires_at,
      v_batch_id,
      coalesce(v_pricing.base_amount, 0),
      coalesce(v_pricing.discount_amount, 0),
      coalesce(v_pricing.final_amount, 0),
      p_ticket_category_id,
      v_user_id
    ) returning id into v_anchor_participant_id;
  else
    update public.participants
    set
      full_name = trim(p_buyer_full_name),
      birth_date = p_buyer_birth_date,
      gender = trim(p_buyer_gender),
      phone = regexp_replace(coalesce(p_buyer_phone, ''), '\\D', '', 'g'),
      email = lower(trim(p_buyer_email)),
      city = trim(p_buyer_city),
      shirt_type = coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), shirt_type),
      shirt_size = coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), shirt_size),
      
      registration_status = case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      reservation_status = case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      reservation_expires_at = v_reservation_expires_at,
      batch_id = v_batch_id,
      base_amount = coalesce(v_pricing.base_amount, 0),
      discount_amount = coalesce(v_pricing.discount_amount, 0),
      final_amount = coalesce(v_pricing.final_amount, 0),
      ticket_category_id = p_ticket_category_id,
      updated_at = now()
    where id = v_anchor_participant_id;
  end if;

  v_order_number := public.generate_order_number();

  insert into public.orders (
    user_id,
    participant_id,
    event_id,
    payment_id,
    order_number,
    status,
    base_amount,
    discount_amount,
    final_amount,
    confirmed_at,
    cancelled_at,
    client_request_id
  ) values (
    v_user_id,
    v_anchor_participant_id,
    p_event_id,
    null,
    v_order_number,
    case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
    v_total_amount,
    v_total_discount,
    v_total_final,
    case when v_payment_status = 'paid' then now() else null end,
    null,
    nullif(trim(coalesce(p_client_request_id, '')), '')
  ) returning id into v_order_id;

  insert into public.payments (
    participant_id,
    event_id,
    amount,
    discount_amount,
    final_amount,
    payment_method,
    payment_status,
    paid_at,
    expires_at,
    order_id
  ) values (
    v_anchor_participant_id,
    p_event_id,
    v_total_amount,
    v_total_discount,
    v_total_final,
    trim(p_payment_method),
    v_payment_status,
    case when v_payment_status = 'paid' then now() else null end,
    v_reservation_expires_at,
    v_order_id
  ) returning id into v_payment_id;

  for v_item_index in 1..p_quantity loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    v_ownership_status := lower(trim(coalesce(v_item_payload ->> 'ownership_status', case when p_assign_first_to_buyer and v_item_index = 1 then 'assigned' else 'unassigned' end)));
    v_holder_name := nullif(trim(coalesce(v_item_payload ->> 'holder_full_name', '')), '');
    v_holder_email := nullif(lower(trim(coalesce(v_item_payload ->> 'holder_email', ''))), '');
    v_holder_phone := nullif(regexp_replace(coalesce(v_item_payload ->> 'holder_phone', ''), '\\D', '', 'g'), '');

    if v_ownership_status not in ('unassigned', 'assigned', 'transferred', 'cancelled') then
      v_ownership_status := 'unassigned';
    end if;

    if v_ownership_status = 'assigned' and not (p_assign_first_to_buyer and v_item_index = 1) then
      v_ownership_status := 'unassigned';
    end if;

    insert into public.order_items (
      order_id,
      event_id,
      participant_id,
      ownership_status,
      ticket_category_id,
      batch_id,
      shirt_type,
      shirt_size,
      quantity,
      unit_price,
      discount_amount,
      final_amount,
      status,
      reservation_expires_at,
      item_position,
      holder_full_name,
      holder_email,
      holder_phone
    ) values (
      v_order_id,
      p_event_id,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then v_anchor_participant_id else null end,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then 'assigned' else 'unassigned' end,
      p_ticket_category_id,
      v_batch_id,
      nullif(trim(coalesce(p_shirt_type, '')), ''),
      nullif(trim(coalesce(p_shirt_size, '')), ''),
      1,
      coalesce(v_pricing.base_amount, 0),
      coalesce(v_pricing.discount_amount, 0),
      coalesce(v_pricing.final_amount, 0),
      v_status,
      v_reservation_expires_at,
      v_item_index,
      v_holder_name,
      v_holder_email,
      v_holder_phone
    );
  end loop;

  if coalesce(trim(coalesce(p_shirt_type, '')), '') <> '' and coalesce(trim(coalesce(p_shirt_size, '')), '') <> '' then
    update public.shirt_inventory
    set reserved_quantity = reserved_quantity + p_quantity,
        updated_at = now()
    where id = v_inventory.id;

    insert into public.inventory_movements (
      event_id,
      inventory_id,
      movement_type,
      quantity,
      notes
    ) values (
      p_event_id,
      v_inventory.id,
      'adjustment',
      -p_quantity,
      format('Reserva checkout multi (%s) pedido %s.', p_quantity, v_order_number)
    );
  end if;

  if coalesce(v_event.kit_enabled, false) then
    insert into public.participant_kit_items (
      participant_id,
      event_id,
      kit_item_id,
      variant_data,
      quantity,
      status
    )
    select
      v_anchor_participant_id,
      p_event_id,
      eki.id,
      case
        when eki.item_type = 'shirt' then jsonb_build_object('shirt_type', coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), 'Sem camiseta'), 'shirt_size', coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), 'N/A'))
        else null
      end,
      eki.quantity_per_participant,
      case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.is_active = true
    on conflict (order_item_id, kit_item_id)
    do update set
      quantity = excluded.quantity,
      status = excluded.status,
      variant_data = excluded.variant_data;
  end if;

  if v_payment_status = 'paid' then
    perform public.confirm_order_payment_and_issue_tickets(v_order_id);
  end if;

  return query
  select
    v_order_id,
    v_payment_id,
    v_order_number,
    v_payment_status,
    v_reservation_expires_at,
    p_quantity,
    v_total_amount,
    v_total_discount,
    v_total_final;
end;
$$;


ALTER FUNCTION "public"."create_multi_ticket_order_checkout_legacy"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_buyer_full_name" "text", "p_buyer_cpf" "text", "p_buyer_birth_date" "date", "p_buyer_gender" "text", "p_buyer_phone" "text", "p_buyer_email" "text", "p_buyer_city" "text", "p_assign_first_to_buyer" boolean, "p_items" "jsonb", "p_limit_per_order" integer, "p_notes" "text", "p_client_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_pending_imported_participant"("p_import_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text" DEFAULT NULL::"text", "p_birth_date" "date" DEFAULT NULL::"date", "p_gender" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_email" "text" DEFAULT NULL::"text", "p_city" "text" DEFAULT NULL::"text", "p_shirt_type" "text" DEFAULT NULL::"text", "p_shirt_size" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_batch public.import_batches%rowtype;
  v_event public.events%rowtype;
  v_registration_batch_id uuid;
  v_category_id uuid;
  v_participant_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if nullif(trim(p_full_name), '') is null then raise exception 'Nome obrigatorio ausente.'; end if;

  select * into v_batch from public.import_batches where id = p_import_batch_id for update;
  if not found or v_batch.import_type <> 'current_event_registrations' or v_batch.imported_by <> v_actor then
    raise exception 'Lote de importacao invalido.';
  end if;

  select * into v_event from public.events where id = v_batch.event_id;
  if not found or not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  select id into v_registration_batch_id from public.registration_batches
  where event_id = v_event.id and is_active = true order by sequence_number asc limit 1;
  select id into v_category_id from public.ticket_categories
  where event_id = v_event.id and is_active = true order by sort_order asc, name asc limit 1;

  insert into public.participants (
    event_id, full_name, cpf, birth_date, gender, phone, email, city,
    shirt_type, shirt_size, registration_status, reservation_status,
    batch_id, ticket_category_id, notes
  ) values (
    v_event.id, trim(p_full_name), nullif(trim(p_cpf), ''), p_birth_date,
    nullif(trim(p_gender), ''), nullif(trim(p_phone), ''), lower(nullif(trim(p_email), '')),
    nullif(trim(p_city), ''), nullif(trim(p_shirt_type), ''), nullif(trim(p_shirt_size), ''),
    'pending', 'pending', v_registration_batch_id, v_category_id, 'Importacao administrativa com dados pendentes'
  ) returning id into v_participant_id;

  perform public.reevaluate_participant_data_issues(v_participant_id, p_import_batch_id);
  return v_participant_id;
end;
$$;


ALTER FUNCTION "public"."create_pending_imported_participant"("p_import_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_registration"("p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_status" "text", "p_notes" "text", "p_payment_method" "text", "p_payment_status" "text", "p_event_id" "uuid", "p_coupon_code" "text" DEFAULT NULL::"text", "p_ticket_category_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("participant_id" "uuid", "full_name" "text", "batch_name" "text", "base_amount" numeric, "discount_amount" numeric, "final_amount" numeric, "payment_status" "text", "reservation_expires_at" timestamp with time zone, "shirt_type" "text", "shirt_size" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_inventory public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_participant_id uuid;
  v_event_id uuid := p_event_id;
  v_event public.events%rowtype;
  v_payment_status text := coalesce(nullif(trim(p_payment_status), ''), 'pending');
  v_payment_method text := coalesce(nullif(trim(p_payment_method), ''), 'pix');
  v_reservation_status text;
  v_reservation_expires_at timestamptz;
  v_batch public.registration_batches%rowtype;
  v_batch_category_limit integer;
  v_confirmed_count integer;
  v_gender_key text := lower(trim(coalesce(p_gender, '')));
  v_base_amount numeric;
  v_discount_amount numeric := 0;
  v_final_amount numeric;
  v_coupon record;
  v_coupon_type text;
  v_ticket_category_id uuid;
  v_ticket_category_capacity integer;
  v_category_reserved_count integer;
  v_has_shirt_item boolean := false;
  v_enforce_physical_stock boolean := false;
  v_shirt_type text;
  v_shirt_size text;
  v_kit_item public.event_kit_items%rowtype;
begin
  if v_event_id is null then
    select e.id
      into v_event_id
    from public.events e
    where e.is_active = true
    order by e.created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  select e.*
    into v_event
  from public.events e
  where e.id = v_event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.registration_enabled, false) then
    raise exception 'Inscricoes fechadas para este evento.';
  end if;

  if coalesce(v_event.min_age, 0) > 0
     and date_part('year', age(p_birth_date)) < v_event.min_age then
    raise exception 'Idade minima de % anos exigida para este evento.', v_event.min_age;
  end if;

  v_enforce_physical_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

  select exists (
    select 1
    from public.event_kit_items eki
    where eki.event_id = v_event_id
      and eki.item_type = 'shirt'
      and eki.is_active = true
  )
  into v_has_shirt_item;

  select p.id
    into v_participant_id
  from public.participants p
  where p.cpf = p_cpf
    and p.event_id = v_event_id
  order by p.created_at asc
  limit 1
  for update;

  if p_ticket_category_id is not null then
    select tc.id, tc.capacity
      into v_ticket_category_id, v_ticket_category_capacity
    from public.ticket_categories tc
    where tc.id = p_ticket_category_id
      and tc.event_id = v_event_id
      and tc.is_active = true
    limit 1;

    if v_ticket_category_id is null then
      raise exception 'Categoria de acesso invalida para o evento ativo.';
    end if;
  else
    select tc.id, tc.capacity
      into v_ticket_category_id, v_ticket_category_capacity
    from public.ticket_categories tc
    where tc.event_id = v_event_id
      and tc.slug = 'open-bar'
      and tc.is_active = true
    limit 1;

    if v_ticket_category_id is null then
      select tc.id, tc.capacity
        into v_ticket_category_id, v_ticket_category_capacity
      from public.ticket_categories tc
      where tc.event_id = v_event_id
        and tc.is_active = true
      order by tc.sort_order asc, tc.name asc
      limit 1;
    end if;
  end if;

  if v_ticket_category_id is null then
    raise exception 'Nenhuma categoria de acesso ativa para o evento.';
  end if;

  select count(*)::integer
    into v_category_reserved_count
  from public.participants p
  where p.event_id = v_event_id
    and p.ticket_category_id = v_ticket_category_id
    and coalesce(p.registration_status, 'pending') <> 'cancelled'
    and p.reservation_status in ('pending', 'confirmed');

  if v_ticket_category_capacity is not null
     and v_category_reserved_count >= v_ticket_category_capacity then
    raise exception 'Capacidade da categoria de acesso atingida.';
  end if;

  v_shirt_type := coalesce(nullif(trim(p_shirt_type), ''), 'Sem camiseta');
  v_shirt_size := coalesce(nullif(trim(p_shirt_size), ''), 'N/A');

  if v_has_shirt_item then
    if coalesce(trim(p_shirt_type), '') = ''
       or coalesce(trim(p_shirt_size), '') = '' then
      raise exception 'Camiseta obrigatoria para este evento.';
    end if;

    if v_enforce_physical_stock then
      select si.*
        into v_inventory
      from public.shirt_inventory si
      where si.event_id = v_event_id
        and si.shirt_type = v_shirt_type
        and si.shirt_size = v_shirt_size
      for update;

      if not found then
        raise exception 'Estoque nao encontrado para este modelo e tamanho.';
      end if;

      v_available_stock :=
        coalesce(v_inventory.total_quantity, 0)
        - coalesce(v_inventory.reserved_quantity, 0)
        - coalesce(v_inventory.delivered_quantity, 0);

      if v_available_stock <= 0 then
        raise exception 'Estoque indisponivel para este modelo e tamanho.';
      end if;
    end if;
  end if;

  select * into v_batch
  from public.registration_batches
  where event_id = v_event_id
    and is_active = true
  order by sequence_number asc
  limit 1
  for update;

  if not found then
    raise exception 'Inscricoes encerradas ou lotes esgotados.';
  end if;

  select rbp.max_confirmed_registrations into v_batch_category_limit
  from public.registration_batch_prices rbp
  where rbp.batch_id = v_batch.id
    and rbp.ticket_category_id = v_ticket_category_id;

  if not found then
    raise exception 'Categoria indisponivel no lote atual.';
  end if;

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_batch.id
    and part.ticket_category_id = v_ticket_category_id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
     or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
    perform * from public.advance_registration_batch_if_needed(v_event_id);

    select * into v_batch
    from public.registration_batches
    where event_id = v_event_id
      and is_active = true
    order by sequence_number asc
    limit 1
    for update;

    if not found then
      raise exception 'Inscricoes encerradas ou lotes esgotados.';
    end if;

    select rbp.max_confirmed_registrations into v_batch_category_limit
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id;

    if not found then
      raise exception 'Categoria indisponivel no lote atual.';
    end if;

    select count(*)::integer into v_confirmed_count
    from public.participants part
    join public.payments pay
      on pay.participant_id = part.id
    where part.batch_id = v_batch.id
      and part.ticket_category_id = v_ticket_category_id
      and coalesce(part.registration_status, 'pending') <> 'cancelled'
      and pay.payment_status = 'paid'
      and (part.reservation_status is null or part.reservation_status = 'confirmed');

    if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
       or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
      raise exception 'Categoria esgotada neste lote.';
    end if;
  end if;

  if v_gender_key in ('feminino', 'female', 'f') then
    select round(rbp.female_price, 2)
      into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  elsif v_gender_key in ('masculino', 'male', 'm') then
    select round(rbp.male_price, 2)
      into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;

  if v_base_amount is null then
    raise exception 'Preco nao configurado para esta categoria e lote.';
  end if;

  v_final_amount := v_base_amount;

  if lower(v_payment_method) = 'courtesy' then
    v_payment_status := 'paid';
    v_payment_method := 'courtesy';
  end if;

  if coalesce(trim(p_coupon_code), '') <> '' then
    select vc.*
      into v_coupon
    from public.validate_coupon(trim(p_coupon_code), v_event_id, v_base_amount) vc
    limit 1;

    v_coupon_type := v_coupon.coupon_type;
    v_discount_amount := round(coalesce(v_coupon.discount_amount, 0), 2);
    v_final_amount := round(coalesce(v_coupon.final_amount, v_base_amount), 2);

    if coalesce(v_coupon_type, '') = 'courtesy' then
      v_payment_status := 'paid';
      v_payment_method := 'courtesy';
    end if;
  end if;

  if v_has_shirt_item and v_enforce_physical_stock then
    update public.shirt_inventory si
    set reserved_quantity = coalesce(si.reserved_quantity, 0) + 1,
        updated_at = now()
    where si.id = v_inventory.id;

    insert into public.inventory_movements (
      event_id,
      inventory_id,
      movement_type,
      quantity,
      notes
    ) values (
      v_event_id,
      v_inventory.id,
      'adjustment',
      -1,
      format('Reserva de inscricao %s (%s).', p_full_name, p_cpf)
    );
  end if;

  if v_payment_status = 'paid' then
    v_reservation_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_reservation_status := 'pending';
    v_reservation_expires_at := now() + interval '2 hours';
  end if;

  if v_participant_id is null then
    insert into public.participants (
      event_id,
      full_name,
      cpf,
      birth_date,
      gender,
      phone,
      email,
      city,
      shirt_type,
      shirt_size,
      registration_status,
      notes,
      reservation_status,
      reservation_expires_at,
      reservation_released_at,
      batch_id,
      base_amount,
      discount_amount,
      final_amount,
      ticket_category_id
    ) values (
      v_event_id,
      p_full_name,
      p_cpf,
      p_birth_date,
      p_gender,
      p_phone,
      p_email,
      p_city,
      v_shirt_type,
      v_shirt_size,
      coalesce(
        nullif(trim(p_registration_status), ''),
        case when v_payment_status = 'paid' then 'confirmed' else 'pending' end
      ),
      p_notes,
      v_reservation_status,
      v_reservation_expires_at,
      null,
      v_batch.id,
      v_base_amount,
      v_discount_amount,
      v_final_amount,
      v_ticket_category_id
    )
    returning public.participants.id into v_participant_id;
  else
    update public.participants p
    set full_name = p_full_name,
        cpf = p_cpf,
        birth_date = p_birth_date,
        gender = p_gender,
        phone = p_phone,
        email = p_email,
        city = p_city,
        shirt_type = v_shirt_type,
        shirt_size = v_shirt_size,
        registration_status = coalesce(
          nullif(trim(p_registration_status), ''),
          case when v_payment_status = 'paid' then 'confirmed' else 'pending' end
        ),
        notes = p_notes,
        reservation_status = v_reservation_status,
        reservation_expires_at = v_reservation_expires_at,
        reservation_released_at = null,
        batch_id = v_batch.id,
        base_amount = v_base_amount,
        discount_amount = v_discount_amount,
        final_amount = v_final_amount,
        ticket_category_id = v_ticket_category_id,
        updated_at = now()
    where p.id = v_participant_id;
  end if;

  insert into public.payments (
    participant_id,
    event_id,
    amount,
    discount_amount,
    final_amount,
    payment_method,
    payment_status,
    paid_at,
    expires_at
  ) values (
    v_participant_id,
    v_event_id,
    v_base_amount,
    v_discount_amount,
    v_final_amount,
    v_payment_method,
    v_payment_status,
    case when v_payment_status = 'paid' then now() else null end,
    case when v_payment_status = 'paid' then null else v_reservation_expires_at end
  );

  if coalesce(v_event.kit_enabled, false) then
    for v_kit_item in
      select eki.*
      from public.event_kit_items eki
      where eki.event_id = v_event_id
        and eki.is_active = true
      order by eki.sort_order asc, eki.created_at asc
    loop
      insert into public.participant_kit_items (
        participant_id,
        event_id,
        kit_item_id,
        variant_data,
        quantity,
        status
      ) values (
        v_participant_id,
        v_event_id,
        v_kit_item.id,
        case
          when v_kit_item.item_type = 'shirt'
            then jsonb_build_object(
              'shirt_type', v_shirt_type,
              'shirt_size', v_shirt_size
            )
          else null
        end,
        v_kit_item.quantity_per_participant,
        case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end
      )
      on conflict on constraint participant_kit_items_participant_kit_unique
      do update set
        event_id = excluded.event_id,
        quantity = excluded.quantity,
        status = excluded.status,
        variant_data = excluded.variant_data;
    end loop;
  end if;

  return query
  select
    v_participant_id,
    p_full_name,
    v_batch.name,
    v_base_amount,
    v_discount_amount,
    v_final_amount,
    v_payment_status,
    v_reservation_expires_at,
    v_shirt_type,
    v_shirt_size;
end;
$$;


ALTER FUNCTION "public"."create_registration"("p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_status" "text", "p_notes" "text", "p_payment_method" "text", "p_payment_status" "text", "p_event_id" "uuid", "p_coupon_code" "text", "p_ticket_category_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_registration_batch"("p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do lote obrigatorio.';
  end if;

  if p_sequence_number is null then
    raise exception 'Numero de sequencia obrigatorio.';
  end if;

  if p_male_price is null or p_male_price < 0 or p_female_price is null or p_female_price < 0 then
    raise exception 'Precos do lote devem ser maiores ou iguais a zero.';
  end if;

  if p_max_confirmed_registrations is null or p_max_confirmed_registrations <= 0 then
    raise exception 'Limite do lote deve ser maior que zero.';
  end if;

  if p_starts_at is not null and p_ends_at is not null and p_starts_at > p_ends_at then
    raise exception 'Janela de datas invalida para o lote.';
  end if;

  if coalesce(p_is_active, false) then
    update public.registration_batches
    set is_active = false,
        updated_at = now()
    where event_id = p_event_id;
  end if;

  insert into public.registration_batches (
    event_id,
    name,
    sequence_number,
    male_price,
    female_price,
    max_confirmed_registrations,
    starts_at,
    ends_at,
    is_active
  ) values (
    p_event_id,
    trim(p_name),
    p_sequence_number,
    round(p_male_price, 2),
    round(p_female_price, 2),
    p_max_confirmed_registrations,
    p_starts_at,
    p_ends_at,
    coalesce(p_is_active, false)
  ) returning id into v_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_created',
    'registration_batches',
    v_id,
    jsonb_build_object(
      'name', trim(p_name),
      'sequence_number', p_sequence_number,
      'male_price', round(p_male_price, 2),
      'female_price', round(p_female_price, 2),
      'max_confirmed_registrations', p_max_confirmed_registrations,
      'is_active', coalesce(p_is_active, false)
    ),
    p_event_id
  );

  return v_id;
end;
$$;


ALTER FUNCTION "public"."create_registration_batch"("p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_registration_batch_with_prices"("p_event_id" "uuid", "p_name" "text" DEFAULT NULL::"text", "p_starts_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_ends_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_is_active" boolean DEFAULT false, "p_prices" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_batch_id uuid;
  v_sequence_number integer;
  v_name text;
  v_item jsonb;
  v_ticket_category_id uuid;
  v_enabled boolean;
  v_male_price numeric;
  v_female_price numeric;
  v_max_confirmed integer;
  v_enabled_count integer := 0;
  v_sum_max_confirmed integer := 0;
  v_legacy_male_price numeric := null;
  v_legacy_female_price numeric := null;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  perform 1
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if p_starts_at is not null and p_ends_at is not null and p_ends_at < p_starts_at then
    raise exception 'Data final nao pode ser anterior a data inicial.';
  end if;

  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then
    raise exception 'Lista de precos por categoria invalida.';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_prices)
  loop
    begin
      v_ticket_category_id := (v_item->>'ticket_category_id')::uuid;
    exception
      when others then
        raise exception 'Categoria invalida na lista de precos.';
    end;

    v_enabled := coalesce((v_item->>'enabled')::boolean, false);
    v_male_price := nullif(v_item->>'male_price', '')::numeric;
    v_female_price := nullif(v_item->>'female_price', '')::numeric;
    v_max_confirmed := nullif(v_item->>'max_confirmed_registrations', '')::integer;

    if not exists (
      select 1
      from public.ticket_categories tc
      where tc.id = v_ticket_category_id
        and tc.event_id = p_event_id
        and tc.is_active = true
    ) then
      raise exception 'Categoria % nao pertence ao evento ativo.', v_ticket_category_id;
    end if;

    if not v_enabled then
      continue;
    end if;

    if v_male_price is null or v_female_price is null then
      raise exception 'Toda categoria ativa deve possuir preco masculino e feminino.';
    end if;

    if v_male_price < 0 or v_female_price < 0 then
      raise exception 'Precos devem ser maiores ou iguais a zero.';
    end if;

    if v_max_confirmed is not null and v_max_confirmed <= 0 then
      raise exception 'Limite de confirmados deve ser maior que zero quando informado.';
    end if;

    if v_max_confirmed is null and p_ends_at is null then
      raise exception 'Toda categoria ativa deve possuir um limite de confirmados, uma data de encerramento do lote, ou os dois.';
    end if;

    v_enabled_count := v_enabled_count + 1;
    v_sum_max_confirmed := v_sum_max_confirmed + coalesce(v_max_confirmed, 0);

    if v_enabled_count = 1 then
      v_legacy_male_price := round(v_male_price, 2);
      v_legacy_female_price := round(v_female_price, 2);
    end if;
  end loop;

  if v_enabled_count = 0 then
    raise exception 'Ative pelo menos uma categoria no lote.';
  end if;

  perform 1
  from public.registration_batches
  where event_id = p_event_id
  for update;

  select coalesce(max(sequence_number), 0) + 1
    into v_sequence_number
  from public.registration_batches
  where event_id = p_event_id;

  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), format('%sº Lote', v_sequence_number));

  if coalesce(p_is_active, false) then
    update public.registration_batches
    set is_active = false,
        updated_at = now()
    where event_id = p_event_id;
  end if;

  insert into public.registration_batches (
    event_id,
    name,
    sequence_number,
    male_price,
    female_price,
    max_confirmed_registrations,
    starts_at,
    ends_at,
    is_active
  ) values (
    p_event_id,
    v_name,
    v_sequence_number,
    v_legacy_male_price,
    v_legacy_female_price,
    v_sum_max_confirmed,
    p_starts_at,
    p_ends_at,
    coalesce(p_is_active, false)
  ) returning id into v_batch_id;

  perform public.upsert_registration_batch_prices(
    v_batch_id,
    p_event_id,
    p_prices
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_created',
    'registration_batches',
    v_batch_id,
    jsonb_build_object(
      'name', v_name,
      'sequence_number', v_sequence_number,
      'male_price', v_legacy_male_price,
      'female_price', v_legacy_female_price,
      'max_confirmed_registrations_sum', v_sum_max_confirmed,
      'is_active', coalesce(p_is_active, false),
      'enabled_categories', v_enabled_count,
      'auto_sequence', true,
      'per_category_limits', true,
      'optional_limit_with_dates', true
    ),
    p_event_id
  );

  return v_batch_id;
exception
  when unique_violation then
    raise exception 'Conflito de concorrencia ao gerar sequencia do lote. Tente novamente.';
end;
$$;


ALTER FUNCTION "public"."create_registration_batch_with_prices"("p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_registration_contact"("p_organization_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_cpf text:=regexp_replace(coalesce(p_cpf,''),'\D','','g');
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.create') then raise exception 'Sem permissao para criar cadastro.'; end if;
  if not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if length(v_cpf)<>11 or nullif(trim(p_full_name),'') is null or p_birth_date is null then raise exception 'Dados cadastrais invalidos.'; end if;
  insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city,created_by)
  values(p_organization_id,trim(p_full_name),v_cpf,p_birth_date,nullif(trim(coalesce(p_gender,'')),''),
    regexp_replace(coalesce(p_phone,''),'\D','','g'),lower(trim(p_email)),nullif(trim(coalesce(p_city,'')),''),v_actor)
  on conflict(organization_id,cpf) do update set full_name=excluded.full_name,birth_date=excluded.birth_date,
    gender=excluded.gender,phone=excluded.phone,email=excluded.email,city=excluded.city,updated_at=now()
  returning id into v_id;
  return v_id;
end; $$;


ALTER FUNCTION "public"."create_registration_contact"("p_organization_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_simple_financial_expense"("p_organization_id" "uuid", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_event_id" "uuid", "p_idempotency_key" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_expense uuid; v_payable uuid;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_entries')
    or not public.current_user_has_permission('finance.manage_expenses')
    or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_amount<=0 or p_due_date is null or nullif(trim(p_description),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Descricao, valor e vencimento sao obrigatorios.'; end if;
  select id into v_id from public.financial_entries where organization_id=p_organization_id and idempotency_key=trim(p_idempotency_key); if v_id is not null then return v_id; end if;
  select id into v_expense from public.financial_accounts where organization_id=p_organization_id and code='SYS_DESPESAS' and account_type='expense' and is_active;
  select id into v_payable from public.financial_accounts where organization_id=p_organization_id and code='SYS_A_PAGAR' and account_type='liability' and is_active;
  if v_expense is null or v_payable is null then raise exception 'Inicialize as configuracoes financeiras antes de cadastrar despesas.'; end if;
  if p_category_id is not null and not exists(select 1 from public.financial_categories where id=p_category_id and organization_id=p_organization_id and entry_kind in('expense','both') and is_active) then raise exception 'Categoria de despesa invalida.'; end if;
  if p_supplier_id is not null and not exists(select 1 from public.financial_suppliers where id=p_supplier_id and organization_id=p_organization_id and is_active) then raise exception 'Fornecedor invalido.'; end if;
  if p_event_id is not null and not exists(select 1 from public.events where id=p_event_id and organization_id=p_organization_id) then raise exception 'Evento fora da organizacao.'; end if;
  insert into public.financial_entries(organization_id,entry_kind,lifecycle_status,description,category_id,supplier_id,amount,due_date,occurred_on,posted_at,idempotency_key,created_by)
  values(p_organization_id,'expense','open',trim(p_description),p_category_id,p_supplier_id,p_amount,p_due_date,coalesce(p_occurred_on,current_date),now(),trim(p_idempotency_key),v_actor) returning id into v_id;
  insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo) values
    (v_id,p_organization_id,v_expense,'debit',p_amount,'Despesa reconhecida'),
    (v_id,p_organization_id,v_payable,'credit',p_amount,'Obrigacao a pagar');
  if p_event_id is not null then insert into public.financial_event_allocations(entry_id,organization_id,event_id,amount) values(v_id,p_organization_id,p_event_id,p_amount); end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_expense_created','financial_entries',v_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'amount',p_amount,'due_date',p_due_date,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;


ALTER FUNCTION "public"."create_simple_financial_expense"("p_organization_id" "uuid", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_event_id" "uuid", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_store_order"("p_event_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS TABLE("store_order_id" "uuid", "order_number" "text", "final_amount" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid := auth.uid(); v_event public.events%rowtype; v_order_id uuid; v_order_number text;
  v_item record; v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype; v_inv public.store_item_inventory%rowtype;
  v_unit_price numeric; v_line_total numeric; v_total numeric := 0; v_paid boolean; v_participant_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Evento invalido.'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Nenhum item selecionado.'; end if;

  v_paid := lower(trim(coalesce(p_payment_method, ''))) = 'courtesy';
  select id into v_participant_id from public.participants where user_id = v_actor and event_id = p_event_id order by created_at desc limit 1;
  v_order_number := 'LOJA-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.store_orders (event_id, user_id, participant_id, order_number, status, payment_method, payment_status, base_amount, final_amount, notes, confirmed_at)
  values (p_event_id, v_actor, v_participant_id, v_order_number, case when v_paid then 'confirmed' else 'pending' end,
    nullif(trim(coalesce(p_payment_method, '')), ''), case when v_paid then 'paid' else 'pending' end,
    0, 0, nullif(trim(coalesce(p_notes, '')), ''), case when v_paid then now() end)
  returning id into v_order_id;

  for v_item in select * from jsonb_to_recordset(p_items) as x(store_item_id uuid, variant_id uuid, quantity integer) loop
    if coalesce(v_item.quantity, 0) <= 0 then raise exception 'Quantidade invalida para item %.', v_item.store_item_id; end if;
    select * into v_store_item from public.store_items where id = v_item.store_item_id and (event_id = p_event_id or event_id is null) and is_active;
    if not found then raise exception 'Item % indisponivel para este evento.', v_item.store_item_id; end if;
    if v_store_item.requires_variant and v_item.variant_id is null then raise exception 'Item % exige selecao de variante.', v_store_item.name; end if;

    v_unit_price := v_store_item.price;
    if v_item.variant_id is not null then
      select * into v_variant from public.store_item_variants where id = v_item.variant_id and store_item_id = v_store_item.id and is_active;
      if not found then raise exception 'Variante invalida para o item %.', v_store_item.name; end if;
      v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
    end if;

    if v_store_item.supply_mode = 'stock' then
      select * into v_inv from public.store_item_inventory where store_item_id = v_store_item.id and variant_id is not distinct from v_item.variant_id for update;
      if not found or (v_inv.total_quantity - v_inv.reserved_quantity - v_inv.delivered_quantity) < v_item.quantity then
        raise exception 'Estoque insuficiente para %.', v_store_item.name;
      end if;
      update public.store_item_inventory set reserved_quantity = reserved_quantity + v_item.quantity, updated_at = now() where id = v_inv.id;
    end if;

    v_line_total := v_unit_price * v_item.quantity;
    v_total := v_total + v_line_total;
    insert into public.store_order_items (store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status)
    values (v_order_id, v_store_item.id, v_item.variant_id, v_item.quantity, v_unit_price, v_line_total, case when v_paid then 'confirmed' else 'reserved' end);
  end loop;

  update public.store_orders set base_amount = v_total, final_amount = v_total, updated_at = now() where id = v_order_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_created', 'store_orders', v_order_id, p_event_id, jsonb_build_object('actor_user_id', v_actor, 'final_amount', v_total, 'payment_method', p_payment_method));

  return query select v_order_id, v_order_number, v_total;
end; $$;


ALTER FUNCTION "public"."create_store_order"("p_event_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_ticket_category"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text" DEFAULT NULL::"text", "p_capacity" integer DEFAULT NULL::integer, "p_is_active" boolean DEFAULT true, "p_sort_order" integer DEFAULT 0) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_category_id uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_slug text := trim(coalesce(p_slug, ''));
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if v_name = '' then
    raise exception 'Nome da categoria obrigatorio.';
  end if;

  if v_slug = '' then
    v_slug := lower(regexp_replace(v_name, '[^a-z0-9]+', '-', 'g'));
  end if;

  if p_capacity is not null and p_capacity <= 0 then
    raise exception 'Capacidade deve ser maior que zero.';
  end if;

  insert into public.ticket_categories (
    event_id,
    name,
    slug,
    description,
    capacity,
    is_active,
    sort_order
  )
  values (
    p_event_id,
    v_name,
    v_slug,
    nullif(trim(coalesce(p_description, '')), ''),
    p_capacity,
    coalesce(p_is_active, true),
    coalesce(p_sort_order, 0)
  )
  returning id into v_category_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'ticket_category_created',
    'ticket_categories',
    v_category_id,
    jsonb_build_object(
      'name', v_name,
      'slug', v_slug,
      'capacity', p_capacity,
      'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0)
    ),
    p_event_id
  );

  return v_category_id;
end;
$$;


ALTER FUNCTION "public"."create_ticket_category"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_ticket_category_benefit"("p_ticket_category_id" "uuid", "p_name" "text", "p_description" "text" DEFAULT NULL::"text", "p_sort_order" integer DEFAULT 0) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid;
begin
  if p_ticket_category_id is null then
    raise exception 'Categoria obrigatoria.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do beneficio obrigatorio.';
  end if;

  insert into public.ticket_category_benefits (
    ticket_category_id,
    name,
    description,
    sort_order
  ) values (
    p_ticket_category_id,
    trim(p_name),
    nullif(trim(coalesce(p_description, '')), ''),
    coalesce(p_sort_order, 0)
  ) returning id into v_id;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."create_ticket_category_benefit"("p_ticket_category_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_organization_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select organization_id
  from public.organization_members
  where user_id  = auth.uid()
    and is_active = true
  order by joined_at asc
  limit 1;
$$;


ALTER FUNCTION "public"."current_organization_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_has_permission"("p_permission_code" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
begin
  if v_actor_user_id is null then
    return false;
  end if;

  return public.resolve_user_permission(v_actor_user_id, p_permission_code);
end;
$$;


ALTER FUNCTION "public"."current_user_has_permission"("p_permission_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."define_ticket_holder_by_pin"("p_ticket_id" "uuid", "p_pin" "text") RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select public.change_ticket_holder_by_pin_for_owner(p_ticket_id,p_pin,'holder_assigned');
$$;


ALTER FUNCTION "public"."define_ticket_holder_by_pin"("p_ticket_id" "uuid", "p_pin" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_event_addon_option"("p_event_id" "uuid", "p_option_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_event_id is null or p_option_id is null then
    raise exception 'Evento e adicional obrigatorios.';
  end if;

  delete from public.event_addon_options
  where id = p_option_id
    and event_id = p_event_id;
end;
$$;


ALTER FUNCTION "public"."delete_event_addon_option"("p_event_id" "uuid", "p_option_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_event_attraction"("p_event_id" "uuid", "p_attraction_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
begin
  if v_actor is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  if not public.current_user_has_permission('events.edit') then
    raise exception 'Permissao insuficiente para gerenciar atracoes.';
  end if;

  if p_event_id is null or p_attraction_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Acesso negado a organizacao.';
  end if;

  delete from public.event_attractions
  where id = p_attraction_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Atracao nao encontrada para o evento.';
  end if;

  insert into public.audit_logs (
    action, entity_type, entity_id, event_id, details
  ) values (
    'event_attraction_deleted', 'event_attractions', p_attraction_id, p_event_id, '{}'::jsonb
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."delete_event_attraction"("p_event_id" "uuid", "p_attraction_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_event_kit_item"("p_event_id" "uuid", "p_kit_item_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_in_use boolean;
begin
  if p_event_id is null or p_kit_item_id is null then
    raise exception 'Evento e item obrigatorios.';
  end if;

  select exists (
    select 1
    from public.participant_kit_items pki
    where pki.kit_item_id = p_kit_item_id
  ) into v_in_use;

  if v_in_use then
    raise exception 'Nao e permitido excluir item ja vinculado a inscricoes/entregas.';
  end if;

  delete from public.event_kit_item_variants where kit_item_id = p_kit_item_id;
  delete from public.event_kit_items where id = p_kit_item_id and event_id = p_event_id;

  if not found then
    raise exception 'Item nao encontrado.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_kit_item_deleted',
    'event_kit_items',
    p_kit_item_id,
    p_event_id,
    '{}'::jsonb
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."delete_event_kit_item"("p_event_id" "uuid", "p_kit_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_event_kit_item_variant"("p_variant_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_variant_id is null then
    raise exception 'Variacao obrigatoria.';
  end if;

  delete from public.event_kit_item_variants
  where id = p_variant_id;

  if not found then
    raise exception 'Variacao nao encontrada.';
  end if;

  return true;
end;
$$;


ALTER FUNCTION "public"."delete_event_kit_item_variant"("p_variant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_event_schedule_item"("p_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_event uuid; v_org uuid;
begin
  select event_id into v_event from public.kit_delivery_schedule where id=p_id;
  select organization_id into v_org from public.events where id=v_event;
  if auth.uid() is null or not public.current_user_has_permission('events.edit') or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Sem permissao.'; end if;
  delete from public.kit_delivery_schedule where id=p_id;
end; $$;


ALTER FUNCTION "public"."delete_event_schedule_item"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_inventory_item"("p_inventory_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid;
  v_actor text := coalesce(auth.role(), 'anon');
  v_item public.shirt_inventory%rowtype;
begin
  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada.';
  end if;

  if v_item.event_id is distinct from v_event_id then
    raise exception 'Apenas o estoque do evento ativo pode ser excluido.';
  end if;

  delete from public.shirt_inventory
  where id = p_inventory_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_deleted',
    'shirt_inventory',
    p_inventory_id,
    v_event_id,
    jsonb_build_object(
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size,
      'total_quantity', v_item.total_quantity,
      'reserved_quantity', v_item.reserved_quantity,
      'delivered_quantity', v_item.delivered_quantity
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."delete_inventory_item"("p_inventory_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_item public.shirt_inventory%rowtype;
  v_actor text := coalesce(auth.role(), 'anon');
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada para o evento informado.';
  end if;

  delete from public.shirt_inventory
  where id = p_inventory_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_deleted',
    'shirt_inventory',
    p_inventory_id,
    p_event_id,
    jsonb_build_object(
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size,
      'total_quantity', v_item.total_quantity,
      'reserved_quantity', v_item.reserved_quantity,
      'delivered_quantity', v_item.delivered_quantity
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."delete_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_kit_delivery_schedule"("p_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_id is null then
    raise exception 'Identificador obrigatorio.';
  end if;

  delete from public.kit_delivery_schedule where id = p_id;
end;
$$;


ALTER FUNCTION "public"."delete_kit_delivery_schedule"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_has_registrations boolean;
begin
  if p_batch_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select exists (
    select 1
    from public.participants p
    where p.batch_id = p_batch_id
  ) into v_has_registrations;

  if v_has_registrations then
    raise exception 'Nao e permitido apagar lote com inscricoes vinculadas.';
  end if;

  delete from public.registration_batches
  where id = p_batch_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Lote nao encontrado para o evento.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_deleted',
    'registration_batches',
    p_batch_id,
    '{}'::jsonb,
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."delete_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_used boolean;
begin
  if p_category_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select exists (
    select 1
    from public.participants p
    where p.ticket_category_id = p_category_id
      and p.event_id = p_event_id
  ) into v_used;

  if v_used then
    raise exception 'Nao e permitido apagar categoria ja utilizada por inscricoes.';
  end if;

  delete from public.ticket_category_benefits
  where ticket_category_id = p_category_id;

  delete from public.registration_batch_prices
  where ticket_category_id = p_category_id;

  delete from public.ticket_categories
  where id = p_category_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Categoria nao encontrada para o evento.';
  end if;

  return true;
end;
$$;


ALTER FUNCTION "public"."delete_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_ticket_category_benefit"("p_benefit_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_benefit_id is null then
    raise exception 'Beneficio obrigatorio.';
  end if;

  delete from public.ticket_category_benefits
  where id = p_benefit_id;

  if not found then
    raise exception 'Beneficio nao encontrado.';
  end if;

  return true;
end;
$$;


ALTER FUNCTION "public"."delete_ticket_category_benefit"("p_benefit_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deliver_items_and_checkin"("p_ticket_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ok boolean;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') or not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para entrega e check-in.'; end if;
  perform 1 from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  perform public.deliver_ticket_full_kit(p_ticket_id);
  select public.checkin_ticket_entry(p_ticket_id) into v_ok;
  if v_ok is distinct from true then raise exception 'Nao foi possivel realizar o check-in; a entrega foi revertida.'; end if;
  return true;
end; $$;


ALTER FUNCTION "public"."deliver_items_and_checkin"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deliver_kit"("p_participant_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  return public.deliver_participant_full_kit(p_participant_id);
end;
$$;


ALTER FUNCTION "public"."deliver_kit"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deliver_kit_and_checkin"("p_ticket_id" "uuid") RETURNS TABLE("success" boolean, "kit_delivered" boolean, "checkin_done" boolean, "message" "text", "participant_id" "uuid", "event_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ticket public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_pending_kit_count integer := 0;
  v_actor text := coalesce((select email from auth.users where id = auth.uid()), 'system');
begin
  if not public.current_user_has_permission('kits.deliver'::text) then
    raise exception 'Sem permissao para entregar kit.';
  end if;

  if not public.current_user_has_permission('checkin.scan'::text) then
    raise exception 'Sem permissao para realizar check-in.';
  end if;

  if p_ticket_id is null then
    raise exception 'Ticket obrigatorio.';
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
  for update;

  if not found then
    raise exception 'Ticket nao encontrado.';
  end if;

  if v_ticket.participant_id is null then
    return query
    select
      false,
      false,
      false,
      'Ticket sem titular definido. Associe um participante antes da operacao combinada.',
      null,
      v_ticket.event_id;
    return;
  end if;

  select * into v_participant
  from public.participants
  where id = v_ticket.participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado para o ticket.';
  end if;

  select * into v_event
  from public.events
  where id = v_participant.event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.allow_checkin_during_kit_delivery, false) then
    return query
    select
      false,
      false,
      false,
      'Operacao combinada desativada para este evento.',
      v_participant.id,
      v_participant.event_id;
    return;
  end if;

  if coalesce(v_participant.payment_status, 'pending') <> 'paid' then
    return query
    select
      false,
      false,
      false,
      'Pagamento pendente. Nao e possivel liberar entrada ou entregar o kit.',
      v_participant.id,
      v_participant.event_id;
    return;
  end if;

  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    return query
    select
      false,
      false,
      true,
      format('Entrada ja registrada em %s.', to_char(coalesce(v_ticket.used_at, now()), 'DD/MM/YYYY HH24:MI')),
      v_participant.id,
      v_participant.event_id;
    return;
  end if;

  select count(*)::integer into v_pending_kit_count
  from public.participant_kit_items pki
  where pki.participant_id = v_participant.id
    and pki.status <> 'delivered';

  if v_pending_kit_count = 0 then
    return query
    select
      false,
      true,
      false,
      'Kit ja entregue. Utilize apenas a acao de check-in.',
      v_participant.id,
      v_participant.event_id;
    return;
  end if;

  perform public.deliver_participant_full_kit(v_participant.id);
  perform public.checkin_participant_entry(v_participant.id);

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'combined_kit_delivery_and_checkin',
    'tickets',
    v_ticket.id,
    v_participant.event_id,
    jsonb_build_object(
      'origin', 'combined_operation',
      'participant_id', v_participant.id,
      'ticket_id', v_ticket.id
    )
  );

  return query
  select
    true,
    true,
    true,
    'Operador confirmou entrega do kit e entrada em uma unica operacao.',
    v_participant.id,
    v_participant.event_id;
end;
$$;


ALTER FUNCTION "public"."deliver_kit_and_checkin"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deliver_participant_full_kit"("p_participant_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin return public.deliver_ticket_full_kit(public.resolve_unique_ticket_for_participant(p_participant_id)); end;
$$;


ALTER FUNCTION "public"."deliver_participant_full_kit"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deliver_participant_kit_item"("p_participant_id" "uuid", "p_kit_item_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin return public.deliver_ticket_kit_item(public.resolve_unique_ticket_for_participant(p_participant_id),p_kit_item_id); end;
$$;


ALTER FUNCTION "public"."deliver_participant_kit_item"("p_participant_id" "uuid", "p_kit_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deliver_store_order_item"("p_store_order_item_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype; v_item public.store_items%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para entregar itens da loja.'; end if;
  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_line.status = 'delivered' then return true; end if;
  if v_line.status <> 'confirmed' then raise exception 'Item precisa estar confirmado (pago) para ser entregue.'; end if;
  select * into v_item from public.store_items where id = v_line.store_item_id;

  if v_item.supply_mode = 'stock' then
    update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity - v_line.quantity, 0),
      delivered_quantity = delivered_quantity + v_line.quantity, updated_at = now()
    where store_item_id = v_line.store_item_id and variant_id is not distinct from v_line.variant_id;
  end if;
  update public.store_order_items set status = 'delivered', delivered_at = now() where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivered', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;


ALTER FUNCTION "public"."deliver_store_order_item"("p_store_order_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deliver_ticket_full_kit"("p_ticket_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_row record; v_ticket public.tickets%rowtype; v_available integer;
begin
  if auth.uid() is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'full_delivery');
  if exists(select 1 from public.event_kit_items eki where eki.event_id=v_ticket.event_id and eki.is_active
    and not exists(select 1 from public.participant_kit_items pki where pki.ticket_id=p_ticket_id and pki.kit_item_id=eki.id)) then
    raise exception 'Existem itens aplicaveis com configuracao pendente.';
  end if;

  -- Bloqueia e valida todas as variantes antes de alterar qualquer item.
  for v_row in
    select pki.kit_item_id,pki.quantity,v.id as variant_id,v.name as shirt_type,v.value as shirt_size
    from public.participant_kit_items pki
    join public.event_kit_items eki on eki.id=pki.kit_item_id
    left join public.event_kit_item_variants v on v.id=nullif(pki.variant_data->>'variant_id','')::uuid
    where pki.ticket_id=p_ticket_id and pki.status not in('delivered','cancelled')
      and eki.item_type='shirt' and eki.shirt_supply_mode='stock'
    order by pki.kit_item_id
    for update of pki
  loop
    select greatest(inv.total_quantity-inv.delivered_quantity,0)
      into v_available
    from public.event_kit_item_variant_inventory inv
    where inv.kit_item_id=v_row.kit_item_id and inv.variant_id=v_row.variant_id for update;
    if not found then v_available:=0; end if;
    if v_available<v_row.quantity then
      perform public.raise_shirt_out_of_stock(v_row.shirt_type,v_row.shirt_size,v_available);
    end if;
  end loop;

  for v_row in select kit_item_id from public.participant_kit_items
    where ticket_id=p_ticket_id and status not in('delivered','cancelled') order by kit_item_id
  loop
    perform public.deliver_ticket_kit_item(p_ticket_id,v_row.kit_item_id);
  end loop;
  return true;
end; $$;


ALTER FUNCTION "public"."deliver_ticket_full_kit"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deliver_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_link public.participant_kit_items%rowtype;
  v_ticket public.tickets%rowtype;
  v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype;
  v_inv public.event_kit_item_variant_inventory%rowtype;
  v_variant_id uuid;
  v_available integer;
begin
  if auth.uid() is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado nao permite entrega de kit.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update;
  if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
  if v_link.status='delivered' then return true; end if;
  if v_link.status='cancelled' then raise exception 'Item cancelado nao pode ser entregue.'; end if;
  if not exists(select 1 from public.payments where order_id=v_ticket.order_id and payment_status='paid') then raise exception 'Pagamento pendente. Entrega bloqueada.'; end if;
  select * into strict v_item from public.event_kit_items where id=p_kit_item_id and event_id=v_ticket.event_id and is_active;

  if v_item.item_type='shirt' then
    if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Camiseta indisponivel para entrega.'; end if;
    v_variant_id:=nullif(v_link.variant_data->>'variant_id','')::uuid;
    if v_variant_id is null then raise exception 'Camiseta nao vinculada.'; end if;
    select * into strict v_variant from public.event_kit_item_variants where id=v_variant_id and kit_item_id=v_item.id;
    if v_item.shirt_supply_mode='stock' then
      select * into v_inv from public.event_kit_item_variant_inventory
      where kit_item_id=v_item.id and variant_id=v_variant_id for update;
      v_available:=case when found then greatest(v_inv.total_quantity-v_inv.delivered_quantity,0) else 0 end;
      if v_inv.id is null or v_available<v_link.quantity then
        perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,v_available);
      end if;
      update public.event_kit_item_variant_inventory
      set reserved_quantity=greatest(reserved_quantity-v_link.quantity,0),
          delivered_quantity=delivered_quantity+v_link.quantity,updated_at=now()
      where id=v_inv.id
        and total_quantity-delivered_quantity>=v_link.quantity;
      if not found then perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,0); end if;
    end if;
  end if;

  update public.participant_kit_items set status='delivered',delivered_at=now() where id=v_link.id and status<>'delivered';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('ticket_kit_item_delivered','participant_kit_items',v_link.id,v_link.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'kit_item_id',p_kit_item_id,
      'supply_mode',v_item.shirt_supply_mode,'variant_id',v_variant_id));
  return true;
end; $$;


ALTER FUNCTION "public"."deliver_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."duplicate_event_configuration"("p_source_event_id" "uuid", "p_target_name" "text", "p_target_slug" "text", "p_target_year" integer DEFAULT NULL::integer, "p_copy_categories" boolean DEFAULT true, "p_copy_kit_items" boolean DEFAULT true, "p_copy_benefits" boolean DEFAULT true, "p_copy_batches" boolean DEFAULT true, "p_copy_batch_prices" boolean DEFAULT true, "p_copy_inventory_structure" boolean DEFAULT true, "p_copy_coupons" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
      description,
      coupon_type,
      discount_percent,
      max_uses,
      used_count,
      starts_at,
      ends_at,
      is_active
    )
    select
      v_target_event_id,
      c.code,
      c.description,
      c.coupon_type,
      c.discount_percent,
      c.max_uses,
      0,
      c.starts_at,
      c.ends_at,
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


ALTER FUNCTION "public"."duplicate_event_configuration"("p_source_event_id" "uuid", "p_target_name" "text", "p_target_slug" "text", "p_target_year" integer, "p_copy_categories" boolean, "p_copy_kit_items" boolean, "p_copy_benefits" boolean, "p_copy_batches" boolean, "p_copy_batch_prices" boolean, "p_copy_inventory_structure" boolean, "p_copy_coupons" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_explicit_shirt_supply_mode"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if new.item_type='shirt' and new.is_active and new.shirt_supply_mode is null then
    raise exception 'Camiseta ativa exige modo stock, made_to_order ou disabled.';
  end if;
  if new.item_type='shirt' then new.allow_participant_change:=false; end if;
  return new;
end; $$;


ALTER FUNCTION "public"."enforce_explicit_shirt_supply_mode"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_order_for_participant"("p_participant_id" "uuid", "p_user_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_order_id uuid;
  v_order_number text;
  v_user_id uuid;
  v_order_status text;
  v_order_item_id uuid;
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  v_user_id := coalesce(p_user_id, v_participant.user_id);
  if v_user_id is null then
    raise exception 'Usuario da conta obrigatorio para criar pedido.';
  end if;

  if v_participant.user_id is null then
    update public.participants
    set user_id = v_user_id,
        updated_at = now()
    where id = v_participant.id;
  elsif v_participant.user_id <> v_user_id then
    raise exception 'Participante ja vinculado a outro usuario.';
  end if;

  select * into v_payment
  from public.payments
  where participant_id = p_participant_id
  order by created_at desc
  limit 1;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;

  select o.id into v_order_id
  from public.orders o
  where o.payment_id = v_payment.id
  limit 1
  for update;

  v_order_status := case
    when v_payment.payment_status = 'paid' then 'confirmed'
    when v_payment.payment_status = 'cancelled' then 'cancelled'
    when v_payment.payment_status = 'expired' then 'expired'
    when v_payment.payment_status = 'refunded' then 'refunded'
    else 'pending'
  end;

  if v_order_id is null then
    v_order_number := public.generate_order_number();

    insert into public.orders (
      user_id,
      participant_id,
      event_id,
      payment_id,
      order_number,
      status,
      base_amount,
      discount_amount,
      final_amount
    ) values (
      v_user_id,
      p_participant_id,
      v_participant.event_id,
      v_payment.id,
      v_order_number,
      v_order_status,
      coalesce(v_payment.amount, 0),
      coalesce(v_payment.discount_amount, 0),
      coalesce(v_payment.final_amount, v_payment.amount, 0)
    ) returning id into v_order_id;
  else
    update public.orders
    set
      user_id = v_user_id,
      event_id = v_participant.event_id,
      payment_id = v_payment.id,
      status = case
        when v_payment.payment_status = 'paid' and status <> 'refunded' then 'confirmed'
        when v_payment.payment_status = 'cancelled' then 'cancelled'
        when v_payment.payment_status = 'expired' then 'expired'
        when v_payment.payment_status = 'refunded' then 'refunded'
        else status
      end,
      base_amount = coalesce(v_payment.amount, 0),
      discount_amount = coalesce(v_payment.discount_amount, 0),
      final_amount = coalesce(v_payment.final_amount, v_payment.amount, 0),
      confirmed_at = case
        when v_payment.payment_status = 'paid' and confirmed_at is null then now()
        else confirmed_at
      end,
      cancelled_at = case
        when v_payment.payment_status in ('cancelled', 'refunded') and cancelled_at is null then now()
        else cancelled_at
      end
    where id = v_order_id;
  end if;

  update public.payments
  set order_id = v_order_id
  where id = v_payment.id;

  insert into public.order_items (
    order_id,
    event_id,
    participant_id,
    ticket_category_id,
    batch_id,
    shirt_type,
    shirt_size,
    quantity,
    unit_price,
    discount_amount,
    final_amount,
    status,
    reservation_expires_at
  ) values (
    v_order_id,
    v_participant.event_id,
    p_participant_id,
    v_participant.ticket_category_id,
    v_participant.batch_id,
    v_participant.shirt_type,
    v_participant.shirt_size,
    1,
    coalesce(v_payment.amount, 0),
    coalesce(v_payment.discount_amount, 0),
    coalesce(v_payment.final_amount, v_payment.amount, 0),
    case
      when v_order_status = 'confirmed' then 'confirmed'
      when v_order_status = 'cancelled' then 'cancelled'
      when v_order_status = 'expired' then 'expired'
      when v_order_status = 'refunded' then 'refunded'
      else 'reserved'
    end,
    v_participant.reservation_expires_at
  )
  on conflict (order_id, participant_id)
  do update set
    event_id = excluded.event_id,
    ticket_category_id = excluded.ticket_category_id,
    batch_id = excluded.batch_id,
    shirt_type = excluded.shirt_type,
    shirt_size = excluded.shirt_size,
    quantity = 1,
    unit_price = excluded.unit_price,
    discount_amount = excluded.discount_amount,
    final_amount = excluded.final_amount,
    status = excluded.status,
    reservation_expires_at = excluded.reservation_expires_at,
    updated_at = now()
  returning id into v_order_item_id;

  update public.tickets t
  set order_item_id = v_order_item_id
  where t.order_id = v_order_id
    and t.participant_id = p_participant_id
    and t.order_item_id is null;

  return v_order_id;
end;
$$;


ALTER FUNCTION "public"."ensure_order_for_participant"("p_participant_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_simple_financial_accounts"("p_organization_id" "uuid", "p_idempotency_key" "text") RETURNS TABLE("cash_account_id" "uuid", "revenue_account_id" "uuid", "expense_account_id" "uuid", "payable_account_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_accounts')
    or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Referencia da configuracao obrigatoria.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':simple-finance',0));
  insert into public.financial_accounts(organization_id,code,name,account_type,is_active) values
    (p_organization_id,'SYS_CAIXA','Caixa Militrin','asset',true),
    (p_organization_id,'SYS_RECEITAS','Receitas de vendas','revenue',true),
    (p_organization_id,'SYS_DESPESAS','Despesas operacionais','expense',true),
    (p_organization_id,'SYS_A_PAGAR','Contas a pagar','liability',true)
  on conflict(organization_id,code) do nothing;
  if (select count(*) from public.financial_accounts where organization_id=p_organization_id and is_active and (
    (code='SYS_CAIXA' and account_type='asset') or (code='SYS_RECEITAS' and account_type='revenue')
    or (code='SYS_DESPESAS' and account_type='expense') or (code='SYS_A_PAGAR' and account_type='liability')
  ))<>4 then raise exception 'As contas internas existem com configuracao incompativel ou inativa.'; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  select 'simple_finance_initialized','organizations',p_organization_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'idempotency_key',trim(p_idempotency_key))
  where not exists(select 1 from public.audit_logs where action='simple_finance_initialized' and entity_id=p_organization_id);
  return query select
    (select id from public.financial_accounts where organization_id=p_organization_id and code='SYS_CAIXA'),
    (select id from public.financial_accounts where organization_id=p_organization_id and code='SYS_RECEITAS'),
    (select id from public.financial_accounts where organization_id=p_organization_id and code='SYS_DESPESAS'),
    (select id from public.financial_accounts where organization_id=p_organization_id and code='SYS_A_PAGAR');
end $$;


ALTER FUNCTION "public"."ensure_simple_financial_accounts"("p_organization_id" "uuid", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_ticket_kit_items"("p_ticket_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."ensure_ticket_kit_items"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_cadastro_payment_and_ticket"("p_participant_id" "uuid", "p_payment_id" "uuid", "p_event_id" "uuid", "p_organization_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid:=auth.uid(); v_result jsonb; v_payment public.payments%rowtype;
  v_payment_id uuid; v_order_id uuid; v_order_item_id uuid; v_ticket_id uuid;
  v_payment_count integer; v_order_count integer; v_item_count integer; v_ticket_count integer;
begin
  if v_actor is null or not public.current_user_has_permission('finance.confirm_payment') then
    raise exception 'Usuario sem permissao para confirmar pagamento.';
  end if;
  if not public.user_can_access_organization(v_actor,p_organization_id) then
    raise exception 'Usuario sem acesso a organizacao.';
  end if;

  perform 1 from public.participants p
  where p.id=p_participant_id and p.event_id=p_event_id and p.organization_id=p_organization_id
  for update;
  if not found then raise exception 'Cadastro nao corresponde ao evento e organizacao.'; end if;

  select count(*) into v_payment_count from public.payments p
  where p.participant_id=p_participant_id and p.event_id=p_event_id and p.organization_id=p_organization_id;
  if v_payment_count<>1 then raise exception 'Contexto exige exatamente um pagamento; encontrados %.',v_payment_count; end if;
  select p.* into strict v_payment from public.payments p
  where p.id=p_payment_id and p.participant_id=p_participant_id
    and p.event_id=p_event_id and p.organization_id=p_organization_id for update;

  select count(*),(array_agg(o.id order by o.id))[1] into v_order_count,v_order_id
  from public.orders o where o.participant_id=p_participant_id and o.payment_id=p_payment_id
    and o.event_id=p_event_id and o.organization_id=p_organization_id;
  if v_order_count>1 then raise exception 'Contexto possui mais de um pedido para o mesmo pagamento.'; end if;
  if v_order_count=1 then
    select count(*),(array_agg(oi.id order by oi.id))[1] into v_item_count,v_order_item_id
    from public.order_items oi where oi.order_id=v_order_id and oi.participant_id=p_participant_id and oi.event_id=p_event_id;
    if v_item_count>1 then raise exception 'Pedido possui mais de um item para o participante e evento.'; end if;
  else v_item_count:=0; end if;
  if v_item_count=1 then
    select count(*),(array_agg(t.id order by t.id))[1] into v_ticket_count,v_ticket_id
    from public.tickets t where t.order_item_id=v_order_item_id and t.order_id=v_order_id
      and t.participant_id=p_participant_id and t.event_id=p_event_id;
    if v_ticket_count>1 then raise exception 'Item possui mais de um ingresso para o mesmo contexto.'; end if;
  else v_ticket_count:=0; end if;

  -- Retry completo: devolve os mesmos IDs sem repetir pagamento, pedido ou emissao.
  if v_order_count=1 and v_item_count=1 and v_ticket_count=1 and v_payment.payment_status='paid' then
    return jsonb_build_object('success',true,'payment_id',p_payment_id,'order_id',v_order_id,
      'order_item_id',v_order_item_id,'ticket_id',v_ticket_id);
  end if;

  if exists(select 1 from public.participant_data_issues i where i.participant_id=p_participant_id
    and i.status='open' and (i.blocks_payment or i.blocks_ticket_issuance)) then
    raise exception 'Existem pendencias bloqueadoras para pagamento ou ingresso.';
  end if;

  if exists(select 1 from public.participation_history ph
    where ph.participant_id=p_participant_id and ph.event_id=p_event_id
      and ph.source='import' and ph.status='confirmed') then
    v_result:=public.finalize_imported_participant_after_issue_resolution(
      p_participant_id,array[]::text[],true
    );
    if not coalesce((v_result->>'success')::boolean,false) then
      raise exception 'Finalizacao importada nao retornou sucesso.';
    end if;
  else
    if v_payment.payment_status<>'paid' then
      perform public.simulate_payment_paid(p_participant_id,
        case when v_payment.payment_method='credit_card' then 'credit_card' else 'pix' end);
    end if;
    v_ticket_id:=public.confirm_order_and_issue_ticket(p_participant_id);
    select o.payment_id,o.id,oi.id into v_payment_id,v_order_id,v_order_item_id
    from public.tickets t join public.order_items oi on oi.id=t.order_item_id
    join public.orders o on o.id=oi.order_id
    where t.id=v_ticket_id;
    v_result:=jsonb_build_object('success',true,'payment_id',v_payment_id,
      'order_id',v_order_id,'order_item_id',v_order_item_id,'ticket_id',v_ticket_id);
  end if;

  v_payment_id:=nullif(v_result->>'payment_id','')::uuid;
  v_order_id:=nullif(v_result->>'order_id','')::uuid;
  v_order_item_id:=nullif(v_result->>'order_item_id','')::uuid;
  v_ticket_id:=nullif(v_result->>'ticket_id','')::uuid;
  if v_payment_id is distinct from p_payment_id or v_order_id is null
    or v_order_item_id is null or v_ticket_id is null then
    raise exception 'Finalizacao retornou identificadores incompletos ou pagamento divergente.';
  end if;

  select count(*) into v_payment_count from public.payments p where p.id=v_payment_id
    and p.participant_id=p_participant_id and p.event_id=p_event_id and p.organization_id=p_organization_id;
  if v_payment_count<>1 then raise exception 'Finalizacao nao preservou exatamente um pagamento canonico.'; end if;
  select count(*) into v_order_count from public.orders o where o.id=v_order_id and o.payment_id=v_payment_id
    and o.participant_id=p_participant_id and o.event_id=p_event_id and o.organization_id=p_organization_id;
  if v_order_count<>1 or (select count(*) from public.orders o where o.payment_id=v_payment_id and o.participant_id=p_participant_id and o.event_id=p_event_id and o.organization_id=p_organization_id)<>1 then
    raise exception 'Finalizacao nao preservou exatamente um pedido canonico.'; end if;
  select count(*) into v_item_count from public.order_items oi where oi.id=v_order_item_id
    and oi.order_id=v_order_id and oi.participant_id=p_participant_id and oi.event_id=p_event_id;
  if v_item_count<>1 or (select count(*) from public.order_items oi where oi.order_id=v_order_id and oi.participant_id=p_participant_id and oi.event_id=p_event_id)<>1 then
    raise exception 'Finalizacao nao preservou exatamente um item canonico.'; end if;
  select count(*) into v_ticket_count from public.tickets t where t.id=v_ticket_id
    and t.order_item_id=v_order_item_id and t.order_id=v_order_id and t.participant_id=p_participant_id and t.event_id=p_event_id;
  if v_ticket_count<>1 or (select count(*) from public.tickets t where t.order_item_id=v_order_item_id and t.order_id=v_order_id and t.participant_id=p_participant_id and t.event_id=p_event_id)<>1 then
    raise exception 'Finalizacao nao preservou exatamente um ingresso canonico.'; end if;

  return jsonb_build_object('success',true,'payment_id',v_payment_id,'order_id',v_order_id,
    'order_item_id',v_order_item_id,'ticket_id',v_ticket_id);
end; $$;


ALTER FUNCTION "public"."finalize_cadastro_payment_and_ticket"("p_participant_id" "uuid", "p_payment_id" "uuid", "p_event_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_import_batch"("p_import_batch_id" "uuid", "p_payment_mode" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_batch        record;
  v_event        public.events%rowtype;
  v_actor_uid    uuid := auth.uid();
  v_actor_email  text := coalesce(
    (select lower(u.email) from auth.users u where u.id = v_actor_uid),
    'admin'
  );
  v_reason       text := coalesce(
    nullif(trim(p_reason), ''),
    format('Pagamento confirmado na importação %s', p_import_batch_id)
  );
  v_confirmed    integer := 0;
  v_pending      integer := 0;
  v_skipped      integer := 0;
  v_failed       integer := 0;
  v_row          record;
  v_payment      public.payments%rowtype;
  v_result       jsonb;
begin
  -- ── Validações básicas ───────────────────────────────────────────────
  if v_actor_uid is null then
    return jsonb_build_object('success', false, 'message', 'Não autenticado.');
  end if;

  if p_payment_mode not in ('pending', 'confirm_all') then
    return jsonb_build_object('success', false, 'message', format('Modo "%s" inválido.', p_payment_mode));
  end if;

  if p_payment_mode = 'confirm_all' then
    if not (
      public.is_active_owner(v_actor_uid)
      or public.resolve_user_permission(v_actor_uid, 'finance.confirm_payment')
    ) then
      return jsonb_build_object('success', false, 'message', 'Sem permissão para confirmar pagamentos em lote.');
    end if;
  end if;

  -- ── Valida lote ──────────────────────────────────────────────────────
  select * into v_batch
  from public.import_batches
  where id = p_import_batch_id;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Importação não encontrada.');
  end if;

  if v_batch.import_type <> 'current_event_registrations' then
    return jsonb_build_object('success', false, 'message', 'finalize_import_batch aplicável somente a importações de inscritos.');
  end if;

  -- Valida acesso à organização do evento
  select * into v_event
  from public.events
  where id = v_batch.event_id;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Evento não encontrado.');
  end if;

  if not public.user_can_access_organization(v_actor_uid, v_event.organization_id) then
    return jsonb_build_object('success', false, 'message', 'Sem acesso à organização deste evento.');
  end if;

  -- ── Modo 'pending': nada a fazer nos pagamentos ───────────────────────
  if p_payment_mode = 'pending' then
    return jsonb_build_object(
      'success', true,
      'payment_mode', 'pending',
      'confirmed', 0,
      'pending', 0,
      'skipped', 0,
      'failed', 0,
      'message', 'Importação mantida com pagamentos pendentes.'
    );
  end if;

  -- ── Modo 'confirm_all': confirma cada participante do lote ────────────
  for v_row in
    select distinct ibr.matched_participant_id as participant_id
    from public.import_batch_rows ibr
    where ibr.import_batch_id = p_import_batch_id
      and ibr.matched_participant_id is not null
      and ibr.resolution in ('create_new', 'link_existing')
      and ibr.status = 'imported'
  loop
    -- Pega o pagamento mais recente do participante
    select * into v_payment
    from public.payments
    where participant_id = v_row.participant_id
      and event_id = v_batch.event_id
    order by created_at desc
    limit 1;

    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_payment.payment_status = 'paid' then
      -- Já pago: apenas garante ticket
      begin
        perform public.confirm_order_and_issue_ticket(v_row.participant_id);
        v_confirmed := v_confirmed + 1;
      exception when others then
        v_confirmed := v_confirmed + 1; -- conta como confirmado mesmo se ticket existia
      end;
      continue;
    end if;

    if v_payment.payment_status in ('refunded') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Confirma via helper interno
    begin
      v_result := public.admin_confirm_participant_payment(
        v_row.participant_id,
        v_payment.id,
        v_reason,
        v_actor_uid
      );

      if (v_result ->> 'success')::boolean then
        v_confirmed := v_confirmed + 1;
      else
        v_failed := v_failed + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  -- ── Auditoria do lote ─────────────────────────────────────────────────
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'import_batch_payments_confirmed',
    'import_batches',
    p_import_batch_id,
    v_batch.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor_uid,
      'actor_email', v_actor_email,
      'organization_id', v_event.organization_id,
      'event_id', v_batch.event_id,
      'import_batch_id', p_import_batch_id,
      'payment_mode', p_payment_mode,
      'confirmed_count', v_confirmed,
      'pending_count', v_pending,
      'skipped_count', v_skipped,
      'failed_count', v_failed,
      'reason', v_reason
    )
  );

  return jsonb_build_object(
    'success', true,
    'payment_mode', p_payment_mode,
    'confirmed', v_confirmed,
    'pending', v_pending,
    'skipped', v_skipped,
    'failed', v_failed,
    'message', format(
      'Concluído: %s confirmados, %s ignorados, %s falhas.',
      v_confirmed, v_skipped, v_failed
    )
  );
end;
$$;


ALTER FUNCTION "public"."finalize_import_batch"("p_import_batch_id" "uuid", "p_payment_mode" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_imported_participant_after_issue_resolution"("p_participant_id" "uuid", "p_resolved_fields" "text"[] DEFAULT ARRAY[]::"text"[], "p_force_confirm" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_participant public.participants%rowtype; v_batch public.import_batches%rowtype;
  v_payment public.payments%rowtype; v_order public.orders%rowtype; v_item public.order_items%rowtype;
  v_ticket_id uuid; v_batch_count integer; v_batch_id uuid; v_finalization text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_participant from public.participants where id=p_participant_id for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;
  if v_actor is distinct from v_participant.user_id and not public.user_can_access_organization(v_actor,v_participant.organization_id) then raise exception 'Usuario sem acesso ao cadastro.'; end if;

  select count(distinct ib.id),(array_agg(distinct ib.id order by ib.id))[1] into v_batch_count,v_batch_id
  from public.participation_history ph join public.import_batches ib on ib.id=ph.import_batch_id
    and ib.event_id=v_participant.event_id and ib.import_type='current_event_registrations'
  where ph.participant_id=p_participant_id and ph.source='import' and ph.status='confirmed';
  if v_batch_count=0 then return jsonb_build_object('success',true,'applicable',false,'finalization','not_imported'); end if;
  if v_batch_count<>1 then raise exception 'Mais de um lote de importacao comprovado para o participante.'; end if;
  select * into v_batch from public.import_batches where id=v_batch_id for update;

  if public.import_participant_has_issuance_blockers(p_participant_id) then
    v_finalization:='issues_remaining';
  else
    select * into v_payment from public.payments where participant_id=p_participant_id and event_id=v_participant.event_id
    order by created_at desc limit 1 for update;
    if not found or v_payment.amount is null or v_payment.final_amount is null then raise exception 'Pagamento real nao foi criado apos o recalculo.'; end if;
    if coalesce(v_batch.payment_mode_original,'pending')='pending' and not p_force_confirm then
      v_finalization:='payment_pending';
    else
      if not(public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'finance.confirm_payment')) then
        raise exception 'Sem permissao para confirmar o pagamento originalmente solicitado.';
      end if;
      update public.payments set payment_status='paid',paid_at=coalesce(paid_at,now()),updated_at=now() where id=v_payment.id;
      select * into v_order from public.orders where participant_id=p_participant_id and event_id=v_participant.event_id
        and buyer_type='imported_holder' and user_id is null and import_batch_id=v_batch.id for update;
      if not found then
        if exists(select 1 from public.orders where participant_id=p_participant_id and event_id=v_participant.event_id) then
          raise exception 'Existe pedido de outra origem; regularizacao automatica bloqueada.';
        end if;
        insert into public.orders(user_id,participant_id,event_id,payment_id,order_number,status,base_amount,
          discount_amount,final_amount,buyer_type,import_batch_id,confirmed_at)
        values(null,p_participant_id,v_participant.event_id,v_payment.id,public.generate_order_number(),'confirmed',
          v_payment.amount,coalesce(v_payment.discount_amount,0),v_payment.final_amount,'imported_holder',v_batch.id,now()) returning * into v_order;
      else
        update public.orders set payment_id=v_payment.id,status='confirmed',confirmed_at=coalesce(confirmed_at,now()),
          base_amount=v_payment.amount,discount_amount=coalesce(v_payment.discount_amount,0),final_amount=v_payment.final_amount
        where id=v_order.id returning * into v_order;
      end if;
      update public.payments set order_id=v_order.id where id=v_payment.id;
      select * into v_item from public.order_items where order_id=v_order.id and participant_id=p_participant_id for update;
      if not found then
        insert into public.order_items(order_id,event_id,participant_id,ownership_status,holder_full_name,
          ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status)
        values(v_order.id,v_participant.event_id,p_participant_id,'assigned',v_participant.full_name,
          v_participant.ticket_category_id,v_participant.batch_id,v_participant.shirt_type,v_participant.shirt_size,
          1,v_payment.amount,coalesce(v_payment.discount_amount,0),v_payment.final_amount,'confirmed') returning * into v_item;
      else
        update public.order_items set status='confirmed',unit_price=v_payment.amount,
          discount_amount=coalesce(v_payment.discount_amount,0),final_amount=v_payment.final_amount
        where id=v_item.id returning * into v_item;
      end if;
      select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
      if v_ticket_id is null then select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id; end if;
      update public.participants set registration_status='confirmed',updated_at=now() where id=p_participant_id;
      v_finalization:='paid_and_ticket_issued';
    end if;
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('imported_participant_issue_finalized','participants',p_participant_id,v_participant.event_id,
    jsonb_build_object('participant_id',p_participant_id,'import_batch_id',v_batch.id,
      'payment_mode_original',coalesce(v_batch.payment_mode_original,'pending'),'fields_resolved',coalesce(p_resolved_fields,array[]::text[]),
      'payment_id',v_payment.id,'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id,
      'actor_user_id',v_actor,'source','participant_issue_resolution','finalization',v_finalization));
  return jsonb_build_object('success',true,'applicable',true,'finalization',v_finalization,
    'payment_id',v_payment.id,'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id,
    'payment_mode_original',coalesce(v_batch.payment_mode_original,'pending'));
end; $$;


ALTER FUNCTION "public"."finalize_imported_participant_after_issue_resolution"("p_participant_id" "uuid", "p_resolved_fields" "text"[], "p_force_confirm" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."find_user_by_public_pin"("p_ticket_id" "uuid", "p_pin" "text") RETURNS TABLE("full_name" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare v_actor uuid:=auth.uid(); v_pin text:=upper(regexp_replace(coalesce(p_pin,''),'[^A-Za-z0-9]','','g'));
  v_ticket public.tickets%rowtype; v_found boolean:=false;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if (select count(*) from public.user_pin_lookup_attempts where actor_user_id=v_actor and attempted_at>now()-interval '10 minutes')>=15 then raise exception 'Limite de buscas atingido. Tente novamente mais tarde.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled';
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_ticket.owner_user_id is distinct from v_actor
    and not(public.current_user_has_permission('participants.edit_basic') and public.user_can_access_organization(v_actor,v_ticket.organization_id))
  then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  if v_pin ~ '^[A-Z0-9]{10}$' then select exists(select 1 from public.customer_profiles cp where cp.public_pin=v_pin and coalesce(cp.account_status,'active')='active') into v_found; end if;
  insert into public.user_pin_lookup_attempts(actor_user_id,found) values(v_actor,v_found);
  return query select cp.full_name from public.customer_profiles cp where v_found and cp.public_pin=v_pin and coalesce(cp.account_status,'active')='active' limit 1;
end; $_$;


ALTER FUNCTION "public"."find_user_by_public_pin"("p_ticket_id" "uuid", "p_pin" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_customer_public_pin"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_pin text;
begin
  perform pg_advisory_xact_lock(hashtext('public.customer_profiles.public_pin'));
  loop
    v_pin:=upper(encode(extensions.gen_random_bytes(5),'hex'));
    exit when not exists(select 1 from public.customer_profiles where public_pin=v_pin);
  end loop;
  return v_pin;
end; $$;


ALTER FUNCTION "public"."generate_customer_public_pin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_order_number"() RETURNS "text"
    LANGUAGE "sql"
    AS $$
  select 'MIL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.order_number_seq')::text, 8, '0');
$$;


ALTER FUNCTION "public"."generate_order_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_registration_contact_public_pin"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_pin text;
begin
  perform pg_advisory_xact_lock(hashtext('public.registration_contacts.public_pin'));
  loop
    v_pin:=upper(encode(extensions.gen_random_bytes(5),'hex'));
    exit when not exists(select 1 from public.registration_contacts where public_pin=v_pin);
  end loop;
  return v_pin;
end; $$;


ALTER FUNCTION "public"."generate_registration_contact_public_pin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_active_registration_batch"() RETURNS TABLE("batch_id" "uuid", "batch_name" "text", "sequence_number" integer, "male_price" numeric, "female_price" numeric, "confirmed_count" integer, "max_confirmed_registrations" integer, "remaining_slots" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid;
  v_batch public.registration_batches%rowtype;
  v_confirmed_count integer;
begin
  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  select * into v_batch
  from public.registration_batches
  where event_id = v_event_id
    and is_active = true
  order by sequence_number asc
  limit 1;

  if not found then
    raise exception 'Nenhum lote ativo configurado para o evento.';
  end if;

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_batch.id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  return query
  select
    v_batch.id,
    v_batch.name,
    v_batch.sequence_number,
    v_batch.male_price,
    v_batch.female_price,
    v_confirmed_count,
    v_batch.max_confirmed_registrations,
    greatest(v_batch.max_confirmed_registrations - v_confirmed_count, 0)::integer;
end;
$$;


ALTER FUNCTION "public"."get_active_registration_batch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_ticket_audit_timeline"("p_ticket_id" "uuid") RETURNS TABLE("id" "uuid", "action" "text", "entity_type" "text", "entity_id" "uuid", "event_id" "uuid", "details" "jsonb", "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_order_item_id uuid; v_order_id uuid; v_payment_id uuid;
begin
  if v_actor is null or not (
    public.current_user_has_permission('participants.view')
    or public.current_user_has_permission('orders.view')
  ) then raise exception 'Sem permissao para consultar o historico do ingresso.'; end if;
  select * into v_ticket from public.tickets where tickets.id=p_ticket_id;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso a organizacao.';
  end if;
  v_order_item_id:=v_ticket.order_item_id;
  select oi.order_id into v_order_id from public.order_items oi
    where oi.id=v_order_item_id and oi.event_id=v_ticket.event_id;
  if v_order_id is null then v_order_id:=v_ticket.order_id; end if;
  select o.payment_id into v_payment_id from public.orders o
    where o.id=v_order_id and o.event_id=v_ticket.event_id and o.organization_id=v_ticket.organization_id;
  return query
  select al.id,al.action,al.entity_type,al.entity_id,al.event_id,al.details,al.created_at
  from public.audit_logs al
  where al.event_id=v_ticket.event_id and (
    (al.entity_type='tickets' and al.entity_id=v_ticket.id)
    or al.entity_id in(v_ticket.participant_id,v_order_item_id,v_order_id,v_payment_id)
    or exists(select 1 from public.participant_kit_items pki where pki.ticket_id=v_ticket.id and pki.id=al.entity_id)
  )
  order by al.created_at,al.id;
end; $$;


ALTER FUNCTION "public"."get_admin_ticket_audit_timeline"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_ticket_shirt_options"("p_ticket_id" "uuid") RETURNS TABLE("kit_item_id" "uuid", "variant_id" "uuid", "shirt_type" "text", "shirt_size" "text", "supply_mode" "text", "physical_available" integer, "option_label" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ticket public.tickets%rowtype;
begin
  if auth.uid() is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para configurar camiseta.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  return query select eki.id,v.id,v.name,v.value,eki.shirt_supply_mode,
    case when eki.shirt_supply_mode='stock' then greatest(coalesce(inv.total_quantity,0)-coalesce(inv.delivered_quantity,0),0) end,
    case when eki.shirt_supply_mode='made_to_order' then v.name||' / '||v.value||' - Sob encomenda' else v.name||' / '||v.value end
  from public.event_kit_items eki join public.event_kit_item_variants v on v.kit_item_id=eki.id and v.is_active
  left join public.event_kit_item_variant_inventory inv on inv.kit_item_id=eki.id and inv.variant_id=v.id
  where eki.event_id=v_ticket.event_id and eki.item_type='shirt' and eki.is_active
    and eki.shirt_supply_mode in('stock','made_to_order')
    and (eki.shirt_supply_mode='made_to_order' or greatest(coalesce(inv.total_quantity,0)-coalesce(inv.delivered_quantity,0),0)>0)
  order by v.sort_order,v.name,v.value;
end; $$;


ALTER FUNCTION "public"."get_admin_ticket_shirt_options"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_user_profile"("p_user_id" "uuid") RETURNS TABLE("user_id" "uuid", "full_name" "text", "email" "text", "role_id" "uuid", "role_name" "text", "is_active" boolean, "last_access_at" timestamp with time zone, "internal_note" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar perfil administrativo.';
  end if;

  return query
  select
    u.id as user_id,
    coalesce(nullif(trim(cp.full_name), ''), nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)) as full_name,
    lower(u.email) as email,
    au.role_id,
    ar.name as role_name,
    coalesce(au.is_active, false) as is_active,
    u.last_sign_in_at,
    au.internal_note
  from auth.users u
  left join public.admin_users au on au.user_id = u.id
  left join public.admin_roles ar on ar.id = au.role_id
  left join public.customer_profiles cp on cp.user_id = u.id
  where u.id = p_user_id;
end;
$$;


ALTER FUNCTION "public"."get_admin_user_profile"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_cadastro_payment_ticket_context"("p_participant_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_payment public.payments%rowtype;
  v_order public.orders%rowtype; v_item public.order_items%rowtype; v_ticket public.tickets%rowtype;
  v_payment_count integer; v_order_count integer; v_item_count integer; v_ticket_count integer;
begin
  if v_actor is null or not public.current_user_has_permission('participants.view') then
    raise exception 'Usuario sem permissao para consultar cadastro.';
  end if;
  select * into v_p from public.participants where id=p_participant_id;
  if not found or not public.user_can_access_organization(v_actor,v_p.organization_id) then
    raise exception 'Cadastro inexistente ou sem acesso.';
  end if;

  select count(*) into v_payment_count from public.payments p
  where p.participant_id=v_p.id and p.event_id=v_p.event_id and p.organization_id=v_p.organization_id;
  if v_payment_count=0 then return '{}'::jsonb; end if;
  if v_payment_count>1 then raise exception 'Cadastro possui mais de um pagamento no mesmo contexto.'; end if;
  select * into strict v_payment from public.payments p
  where p.participant_id=v_p.id and p.event_id=v_p.event_id and p.organization_id=v_p.organization_id;

  select count(*) into v_order_count from public.orders o where o.payment_id=v_payment.id
    and o.participant_id=v_p.id and o.event_id=v_p.event_id and o.organization_id=v_p.organization_id;
  if v_order_count>1 then raise exception 'Cadastro possui mais de um pedido para o mesmo pagamento.'; end if;
  if v_order_count=1 then
    select * into strict v_order from public.orders o where o.payment_id=v_payment.id
      and o.participant_id=v_p.id and o.event_id=v_p.event_id and o.organization_id=v_p.organization_id;
    select count(*) into v_item_count from public.order_items oi
    where oi.order_id=v_order.id and oi.participant_id=v_p.id and oi.event_id=v_p.event_id;
    if v_item_count>1 then raise exception 'Pedido possui mais de um item para o cadastro.'; end if;
  else v_item_count:=0; end if;
  if v_item_count=1 then
    select * into strict v_item from public.order_items oi
    where oi.order_id=v_order.id and oi.participant_id=v_p.id and oi.event_id=v_p.event_id;
    select count(*) into v_ticket_count from public.tickets t where t.order_item_id=v_item.id
      and t.order_id=v_order.id and t.participant_id=v_p.id and t.event_id=v_p.event_id;
    if v_ticket_count>1 then raise exception 'Item possui mais de um ingresso para o cadastro.'; end if;
  else v_ticket_count:=0; end if;
  if v_ticket_count=1 then
    select * into strict v_ticket from public.tickets t where t.order_item_id=v_item.id
      and t.order_id=v_order.id and t.participant_id=v_p.id and t.event_id=v_p.event_id;
  end if;

  return jsonb_build_object(
    'payment_id',v_payment.id,'payment_status',v_payment.payment_status,
    'order_id',v_order.id,'order_status',v_order.status,
    'order_item_id',v_item.id,'commercial_batch_id',v_item.batch_id,
    'ticket_id',v_ticket.id,'ticket_status',v_ticket.status
  );
end; $$;


ALTER FUNCTION "public"."get_cadastro_payment_ticket_context"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_customer_profile"("p_user_id" "uuid" DEFAULT "auth"."uid"()) RETURNS TABLE("user_id" "uuid", "full_name" "text", "cpf" "text", "birth_date" "date", "gender" "text", "phone" "text", "city" "text", "created_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select
    cp.user_id,
    cp.full_name,
    cp.cpf,
    cp.birth_date,
    cp.gender,
    cp.phone,
    cp.city,
    cp.created_at,
    cp.updated_at
  from public.customer_profiles cp
  where cp.user_id = p_user_id;
$$;


ALTER FUNCTION "public"."get_customer_profile"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_event_addons_dynamic_setup"("p_event_id" "uuid") RETURNS TABLE("apply_to_all_batches" boolean, "option_id" "uuid", "option_name" "text", "option_description" "text", "option_sort_order" integer, "option_is_active" boolean, "batch_id" "uuid", "batch_name" "text", "batch_sequence_number" integer, "batch_option_enabled" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with model as (
    select coalesce(m.apply_to_all_batches, true) as apply_to_all_batches
    from public.events e
    left join public.event_addons_model m on m.event_id = e.id
    where e.id = p_event_id
  )
  select
    m.apply_to_all_batches,
    o.id as option_id,
    o.name as option_name,
    o.description as option_description,
    o.sort_order as option_sort_order,
    o.is_active as option_is_active,
    b.id as batch_id,
    b.name as batch_name,
    b.sequence_number as batch_sequence_number,
    coalesce(ba.enabled, false) as batch_option_enabled
  from model m
  left join public.event_addon_options o
    on o.event_id = p_event_id
   and o.is_active = true
  left join public.registration_batches b
    on b.event_id = p_event_id
  left join public.event_batch_addon_options ba
    on ba.batch_id = b.id
   and ba.option_id = o.id
  order by o.sort_order asc nulls last, o.created_at asc, b.sequence_number asc nulls last, b.created_at asc;
$$;


ALTER FUNCTION "public"."get_event_addons_dynamic_setup"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_event_addons_setup"("p_event_id" "uuid") RETURNS TABLE("event_id" "uuid", "apply_to_all_batches" boolean, "default_kit_enabled" boolean, "default_custom_cup_enabled" boolean, "default_gifts_enabled" boolean, "batch_id" "uuid", "batch_name" "text", "batch_sequence_number" integer, "batch_kit_enabled" boolean, "batch_custom_cup_enabled" boolean, "batch_gifts_enabled" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with cfg as (
    select
      e.id as event_id,
      coalesce(c.apply_to_all_batches, true) as apply_to_all_batches,
      coalesce(c.kit_enabled, false) as default_kit_enabled,
      coalesce(c.custom_cup_enabled, false) as default_custom_cup_enabled,
      coalesce(c.gifts_enabled, false) as default_gifts_enabled
    from public.events e
    left join public.event_addons_config c on c.event_id = e.id
    where e.id = p_event_id
  )
  select
    cfg.event_id,
    cfg.apply_to_all_batches,
    cfg.default_kit_enabled,
    cfg.default_custom_cup_enabled,
    cfg.default_gifts_enabled,
    b.id as batch_id,
    b.name as batch_name,
    b.sequence_number as batch_sequence_number,
    coalesce(a.kit_enabled, cfg.default_kit_enabled) as batch_kit_enabled,
    coalesce(a.custom_cup_enabled, cfg.default_custom_cup_enabled) as batch_custom_cup_enabled,
    coalesce(a.gifts_enabled, cfg.default_gifts_enabled) as batch_gifts_enabled
  from cfg
  left join public.registration_batches b on b.event_id = cfg.event_id
  left join public.registration_batch_addons a on a.batch_id = b.id
  order by b.sequence_number asc nulls last, b.created_at asc;
$$;


ALTER FUNCTION "public"."get_event_addons_setup"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_event_kit_items"("p_event_id" "uuid") RETURNS TABLE("id" "uuid", "event_id" "uuid", "name" "text", "slug" "text", "description" "text", "item_type" "text", "quantity_per_participant" integer, "requires_variant" boolean, "is_required" boolean, "is_active" boolean, "sort_order" integer, "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "variants" "jsonb")
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select
    i.id,
    i.event_id,
    i.name,
    i.slug,
    i.description,
    i.item_type,
    i.quantity_per_participant,
    i.requires_variant,
    i.is_required,
    i.is_active,
    i.sort_order,
    i.created_at,
    i.updated_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', v.id,
            'name', v.name,
            'value', v.value,
            'sort_order', v.sort_order,
            'is_active', v.is_active,
            'created_at', v.created_at
          )
          order by v.sort_order asc, v.created_at asc
        )
        from public.event_kit_item_variants v
        where v.kit_item_id = i.id
      ),
      '[]'::jsonb
    ) as variants
  from public.event_kit_items i
  where i.event_id = p_event_id
  order by i.sort_order asc, i.created_at asc;
$$;


ALTER FUNCTION "public"."get_event_kit_items"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_event_payment_methods_setup"("p_event_id" "uuid") RETURNS TABLE("event_id" "uuid", "pix_enabled" boolean, "credit_card_single_enabled" boolean, "credit_card_installments_enabled" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    e.id as event_id,
    coalesce(epm.pix_enabled, true) as pix_enabled,
    coalesce(epm.credit_card_single_enabled, true) as credit_card_single_enabled,
    coalesce(epm.credit_card_installments_enabled, true) as credit_card_installments_enabled
  from public.events e
  left join public.event_payment_methods epm on epm.event_id = e.id
  where e.id = p_event_id;
$$;


ALTER FUNCTION "public"."get_event_payment_methods_setup"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_event_ticket_categories"("p_event_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "event_id" "uuid", "name" "text", "slug" "text", "description" "text", "capacity" integer, "is_active" boolean, "sort_order" integer, "confirmed_count" integer, "pending_count" integer, "reserved_count" integer, "available_slots" integer, "current_batch_id" "uuid", "current_batch_name" "text", "current_batch_sequence" integer, "current_male_price" numeric, "current_female_price" numeric, "created_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid := p_event_id;
begin
  if v_event_id is null then
    select e.id into v_event_id
    from public.events e
    where e.is_active = true
    order by e.created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  return query
  with stats as (
    select
      p.ticket_category_id,
      count(*) filter (
        where coalesce(p.registration_status, 'pending') <> 'cancelled'
          and p.reservation_status = 'confirmed'
      )::integer as confirmed_count,
      count(*) filter (
        where coalesce(p.registration_status, 'pending') <> 'cancelled'
          and p.reservation_status = 'pending'
      )::integer as pending_count,
      count(*) filter (
        where coalesce(p.registration_status, 'pending') <> 'cancelled'
          and p.reservation_status in ('pending', 'confirmed')
      )::integer as reserved_count
    from public.participants p
    where p.event_id = v_event_id
      and p.ticket_category_id is not null
    group by p.ticket_category_id
  ),
  current_batch as (
    select distinct on (rbp.ticket_category_id)
      rbp.ticket_category_id,
      rb.id as batch_id,
      rb.name as batch_name,
      rb.sequence_number,
      rbp.male_price,
      rbp.female_price
    from public.registration_batch_prices rbp
    join public.registration_batches rb on rb.id = rbp.batch_id
    where rb.event_id = v_event_id
      and rb.is_active = true
      and (
        rbp.max_confirmed_registrations is null
        or coalesce((
          select count(*)::integer
          from public.participants part
          join public.payments pay on pay.participant_id = part.id
          where part.batch_id = rb.id
            and part.ticket_category_id = rbp.ticket_category_id
            and coalesce(part.registration_status, 'pending') <> 'cancelled'
            and pay.payment_status = 'paid'
            and (part.reservation_status is null or part.reservation_status = 'confirmed')
        ), 0) < rbp.max_confirmed_registrations
      )
      and (rb.ends_at is null or now() <= rb.ends_at)
    order by rbp.ticket_category_id, rb.sequence_number asc
  )
  select
    tc.id,
    tc.event_id,
    tc.name,
    tc.slug,
    tc.description,
    tc.capacity,
    tc.is_active,
    tc.sort_order,
    coalesce(s.confirmed_count, 0),
    coalesce(s.pending_count, 0),
    coalesce(s.reserved_count, 0),
    case
      when tc.capacity is null then null::integer
      else greatest(tc.capacity - coalesce(s.reserved_count, 0), 0)
    end::integer,
    cb.batch_id,
    cb.batch_name,
    cb.sequence_number,
    cb.male_price,
    cb.female_price,
    tc.created_at,
    tc.updated_at
  from public.ticket_categories tc
  left join stats s
    on s.ticket_category_id = tc.id
  left join current_batch cb
    on cb.ticket_category_id = tc.id
  where tc.event_id = v_event_id
  order by tc.sort_order asc, tc.name asc;
end;
$$;


ALTER FUNCTION "public"."get_event_ticket_categories"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_events_overview"() RETURNS TABLE("id" "uuid", "name" "text", "slug" "text", "year" integer, "description" "text", "starts_at" timestamp with time zone, "ends_at" timestamp with time zone, "registration_open_at" timestamp with time zone, "registration_close_at" timestamp with time zone, "location" "text", "registration_enabled" boolean, "kit_enabled" boolean, "is_active" boolean, "min_age" integer, "participants_count" integer, "created_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select
    e.id,
    e.name,
    e.slug,
    e.year,
    e.description,
    e.starts_at,
    e.ends_at,
    e.registration_open_at,
    e.registration_close_at,
    e.location,
    e.registration_enabled,
    e.kit_enabled,
    e.is_active,
    e.min_age,
    count(p.id)::integer as participants_count,
    e.created_at,
    e.updated_at
  from public.events e
  left join public.participants p
    on p.event_id = e.id
   and coalesce(p.registration_status, 'pending') <> 'cancelled'
  where
    public.is_platform_owner(auth.uid())
    or
    e.organization_id in (select public.user_organization_ids(auth.uid()))
  group by e.id
  order by e.year desc nulls last, e.created_at desc;
$$;


ALTER FUNCTION "public"."get_events_overview"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_featured_events_for_dashboard"() RETURNS TABLE("event_id" "uuid", "sort_order" integer, "name" "text", "slug" "text", "starts_at" timestamp with time zone, "ends_at" timestamp with time zone, "location" "text", "registration_enabled" boolean, "registration_open_at" timestamp with time zone, "registration_close_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select
    e.id as event_id,
    coalesce(h.sort_order, 0) as sort_order,
    e.name,
    e.slug,
    e.starts_at,
    e.ends_at,
    e.location,
    e.registration_enabled,
    e.registration_open_at,
    e.registration_close_at
  from public.event_highlights h
  join public.events e on e.id = h.event_id
  where coalesce(h.is_active, true) = true
  order by coalesce(h.sort_order, 0) asc,
           e.starts_at asc nulls last,
           e.created_at desc;
$$;


ALTER FUNCTION "public"."get_featured_events_for_dashboard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_public_pin"() RETURNS TABLE("full_name" "text", "public_pin" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select cp.full_name,cp.public_pin from public.customer_profiles cp where cp.user_id=auth.uid();
$$;


ALTER FUNCTION "public"."get_my_public_pin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_operation_buyers"("p_event_id" "uuid") RETURNS TABLE("user_id" "uuid", "full_name" "text", "cpf" "text", "phone" "text", "email" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
  v_organization_id uuid;
begin
  if v_actor_user_id is null then raise exception 'Usuario nao autenticado.'; end if;

  select e.organization_id into v_organization_id
  from public.events e where e.id = p_event_id;
  if v_organization_id is null then raise exception 'Evento nao encontrado.'; end if;

  if not public.user_can_access_organization(v_actor_user_id, v_organization_id)
    or not (
      public.is_active_owner(v_actor_user_id)
      or public.resolve_user_permission(v_actor_user_id, 'participants.view')
    ) then
    raise exception 'Usuario sem permissao para consultar compradores deste evento.';
  end if;

  return query
  select distinct cp.user_id, cp.full_name, cp.cpf, cp.phone, lower(au.email)
  from public.orders o
  join public.customer_profiles cp on cp.user_id = o.user_id
  join auth.users au on au.id = o.user_id
  where o.event_id = p_event_id
    and o.buyer_type = 'account';
end;
$$;


ALTER FUNCTION "public"."get_operation_buyers"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_order_checkout_snapshot"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "order_status" "text", "payment_id" "uuid", "payment_status" "text", "payment_method" "text", "amount" numeric, "discount_amount" numeric, "final_amount" numeric, "expires_at" timestamp with time zone, "pix_code" "text", "pix_qrcode" "text", "gateway_payment_id" "text", "paid_at" timestamp with time zone, "event_id" "uuid", "event_name" "text", "item_id" "uuid", "item_position" integer, "item_status" "text", "ownership_status" "text", "participant_id" "uuid", "participant_name" "text", "holder_full_name" "text", "ticket_id" "uuid", "ticket_status" "text", "ticket_token" "uuid", "shirt_type" "text", "shirt_size" "text", "category_name" "text", "batch_name" "text")
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select
    o.id as order_id,
    o.order_number,
    o.status as order_status,
    pay.id as payment_id,
    pay.payment_status,
    pay.payment_method,
    pay.amount,
    pay.discount_amount,
    pay.final_amount,
    pay.expires_at,
    pay.pix_code,
    pay.pix_qrcode,
    pay.gateway_payment_id,
    pay.paid_at,
    o.event_id,
    e.name as event_name,
    oi.id as item_id,
    oi.item_position,
    oi.status as item_status,
    oi.ownership_status,
    oi.participant_id,
    p.full_name as participant_name,
    oi.holder_full_name,
    t.id as ticket_id,
    t.status as ticket_status,
    t.token as ticket_token,
    oi.shirt_type,
    oi.shirt_size,
    tc.name as category_name,
    rb.name as batch_name
  from public.orders o
  join public.payments pay
    on pay.order_id = o.id
  join public.order_items oi
    on oi.order_id = o.id
  join public.events e
    on e.id = o.event_id
  left join public.participants p
    on p.id = oi.participant_id
  left join public.tickets t
    on t.order_item_id = oi.id
  left join public.ticket_categories tc
    on tc.id = oi.ticket_category_id
  left join public.registration_batches rb
    on rb.id = oi.batch_id
  where o.id = p_order_id
    and (
      auth.uid() = o.user_id
      or public.current_user_has_permission('participants.view'::text)
    )
  order by coalesce(oi.item_position, 999999), oi.created_at;
$$;


ALTER FUNCTION "public"."get_order_checkout_snapshot"("p_order_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."shirt_inventory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "shirt_type" "text" NOT NULL,
    "shirt_size" "text" NOT NULL,
    "total_quantity" integer DEFAULT 0 NOT NULL,
    "reserved_quantity" integer DEFAULT 0 NOT NULL,
    "delivered_quantity" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "event_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "shirt_inventory_delivered_quantity_check" CHECK (("delivered_quantity" >= 0)),
    CONSTRAINT "shirt_inventory_reserved_quantity_check" CHECK (("reserved_quantity" >= 0)),
    CONSTRAINT "shirt_inventory_total_quantity_check" CHECK (("total_quantity" >= 0))
);


ALTER TABLE "public"."shirt_inventory" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ordered_shirt_inventory"("p_event_id" "uuid") RETURNS SETOF "public"."shirt_inventory"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select si.*
  from public.shirt_inventory si
  where si.event_id = p_event_id
  order by
    case
      when si.shirt_type = 'Camiseta' then 1
      when si.shirt_type = 'Babylook' then 2
      else 99
    end,
    case
      when si.shirt_size = 'PP' then 1
      when si.shirt_size = 'P' then 2
      when si.shirt_size = 'M' then 3
      when si.shirt_size = 'G' then 4
      when si.shirt_size = 'GG' then 5
      when si.shirt_size = 'EG' then 6
      when si.shirt_size = 'EXG' then 7
      when si.shirt_size = 'EXGG' then 8
      else 99
    end;
$$;


ALTER FUNCTION "public"."get_ordered_shirt_inventory"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_participant_kit_items"("p_participant_id" "uuid") RETURNS TABLE("participant_id" "uuid", "event_id" "uuid", "event_name" "text", "kit_item_id" "uuid", "item_name" "text", "item_type" "text", "quantity" integer, "status" "text", "delivered_at" timestamp with time zone, "variant_data" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ticket_id uuid;
begin
  v_ticket_id := public.resolve_unique_ticket_for_participant(p_participant_id);
  return query
  select pki.participant_id,pki.event_id,e.name,pki.kit_item_id,eki.name,eki.item_type,
    pki.quantity,pki.status,pki.delivered_at,pki.variant_data
  from public.participant_kit_items pki
  join public.event_kit_items eki on eki.id=pki.kit_item_id
  join public.events e on e.id=pki.event_id
  where pki.ticket_id=v_ticket_id order by eki.sort_order,eki.created_at;
end;
$$;


ALTER FUNCTION "public"."get_participant_kit_items"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_participant_payment_details"("p_participant_id" "uuid") RETURNS TABLE("payment_id" "uuid", "participant_id" "uuid", "event_id" "uuid", "event_name" "text", "amount" numeric, "discount_amount" numeric, "final_amount" numeric, "payment_method" "text", "payment_status" "text", "pix_code" "text", "pix_qrcode" "text", "gateway_payment_id" "text", "expires_at" timestamp with time zone, "paid_at" timestamp with time zone, "created_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  return query
  select
    pay.id,
    pay.participant_id,
    pay.event_id,
    e.name,
    pay.amount,
    coalesce(pay.discount_amount, 0),
    coalesce(pay.final_amount, pay.amount),
    pay.payment_method,
    pay.payment_status,
    pay.pix_code,
    pay.pix_qrcode,
    pay.gateway_payment_id,
    pay.expires_at,
    pay.paid_at,
    pay.created_at,
    pay.updated_at
  from public.payments pay
  left join public.events e
    on e.id = pay.event_id
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1;
end;
$$;


ALTER FUNCTION "public"."get_participant_payment_details"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_account_email_status"("p_email" "text") RETURNS TABLE("has_account" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
    from public.participants p
    where lower(p.email) = lower(trim(coalesce(p_email, '')))
      and p.user_id is not null
  ) as has_account;
$$;


ALTER FUNCTION "public"."get_public_account_email_status"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_registration_batches"("p_event_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "event_id" "uuid", "name" "text", "sequence_number" integer, "ticket_category_id" "uuid", "category_name" "text", "male_price" numeric, "female_price" numeric, "max_confirmed_registrations" integer, "starts_at" timestamp with time zone, "ends_at" timestamp with time zone, "is_active" boolean, "confirmed_count" integer, "remaining_slots" integer, "created_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid := p_event_id;
begin
  if v_event_id is null then
    select e.id into v_event_id
    from public.events e
    where e.is_active = true
    order by e.created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  return query
  with confirmed as (
    select part.batch_id, part.ticket_category_id, count(*)::integer as confirmed_count
    from public.participants part
    join public.payments pay on pay.participant_id = part.id
    where part.event_id = v_event_id
      and part.batch_id is not null
      and part.ticket_category_id is not null
      and coalesce(part.registration_status, 'pending') <> 'cancelled'
      and pay.payment_status = 'paid'
      and (part.reservation_status is null or part.reservation_status = 'confirmed')
    group by part.batch_id, part.ticket_category_id
  )
  select
    batch.id,
    batch.event_id,
    batch.name,
    batch.sequence_number,
    rbp.ticket_category_id,
    tc.name,
    rbp.male_price,
    rbp.female_price,
    rbp.max_confirmed_registrations,
    batch.starts_at,
    batch.ends_at,
    batch.is_active,
    coalesce(c.confirmed_count, 0) as confirmed_count,
    case
      when rbp.max_confirmed_registrations is null then null
      else greatest(rbp.max_confirmed_registrations - coalesce(c.confirmed_count, 0), 0)
    end::integer as remaining_slots,
    batch.created_at,
    batch.updated_at
  from public.registration_batches batch
  join public.registration_batch_prices rbp on rbp.batch_id = batch.id
  join public.ticket_categories tc on tc.id = rbp.ticket_category_id
  left join confirmed c on c.batch_id = batch.id and c.ticket_category_id = rbp.ticket_category_id
  where batch.event_id = v_event_id
  order by batch.sequence_number asc, tc.sort_order asc, tc.name asc;
end;
$$;


ALTER FUNCTION "public"."get_registration_batches"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_registration_pricing_preview"("p_gender" "text", "p_coupon_code" "text" DEFAULT NULL::"text", "p_event_id" "uuid" DEFAULT NULL::"uuid", "p_ticket_category_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("batch_id" "uuid", "batch_name" "text", "sequence_number" integer, "base_amount" numeric, "discount_amount" numeric, "final_amount" numeric, "remaining_slots" integer, "coupon_message" "text", "coupon_type" "text", "discount_percent" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid := p_event_id;
  v_batch public.registration_batches%rowtype;
  v_batch_category_limit integer;
  v_confirmed_count integer;
  v_gender_key text := lower(trim(coalesce(p_gender, '')));
  v_base numeric;
  v_discount numeric := 0;
  v_final numeric;
  v_coupon record;
  v_ticket_category_id uuid;
  v_open_bar_id uuid;
begin
  if v_event_id is null then
    select id into v_event_id
    from public.events
    where is_active = true
    order by created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  if p_ticket_category_id is not null then
    select tc.id into v_ticket_category_id
    from public.ticket_categories tc
    where tc.id = p_ticket_category_id
      and tc.event_id = v_event_id
      and tc.is_active = true
    limit 1;

    if v_ticket_category_id is null then
      raise exception 'Categoria de acesso invalida para o evento ativo.';
    end if;
  else
    select tc.id into v_open_bar_id
    from public.ticket_categories tc
    where tc.event_id = v_event_id
      and tc.slug = 'open-bar'
      and tc.is_active = true
    limit 1;

    if v_open_bar_id is not null then
      v_ticket_category_id := v_open_bar_id;
    else
      select tc.id into v_ticket_category_id
      from public.ticket_categories tc
      where tc.event_id = v_event_id
        and tc.is_active = true
      order by tc.sort_order asc, tc.name asc
      limit 1;
    end if;
  end if;

  if v_ticket_category_id is null then
    raise exception 'Nenhuma categoria de acesso ativa para o evento.';
  end if;

  select * into v_batch
  from public.registration_batches
  where event_id = v_event_id
    and is_active = true
  order by sequence_number asc
  limit 1;

  if not found then
    raise exception 'Nenhum lote ativo configurado para o evento.';
  end if;

  select rbp.max_confirmed_registrations into v_batch_category_limit
  from public.registration_batch_prices rbp
  where rbp.batch_id = v_batch.id
    and rbp.ticket_category_id = v_ticket_category_id;

  if not found then
    raise exception 'Categoria indisponivel no lote atual.';
  end if;

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_batch.id
    and part.ticket_category_id = v_ticket_category_id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
     or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
    perform * from public.advance_registration_batch_if_needed(v_event_id);

    select * into v_batch
    from public.registration_batches
    where event_id = v_event_id
      and is_active = true
    order by sequence_number asc
    limit 1;

    if not found then
      raise exception 'Inscricoes encerradas ou lotes esgotados.';
    end if;

    select rbp.max_confirmed_registrations into v_batch_category_limit
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id;

    if not found then
      raise exception 'Categoria indisponivel no lote atual.';
    end if;

    select count(*)::integer into v_confirmed_count
    from public.participants part
    join public.payments pay
      on pay.participant_id = part.id
    where part.batch_id = v_batch.id
      and part.ticket_category_id = v_ticket_category_id
      and coalesce(part.registration_status, 'pending') <> 'cancelled'
      and pay.payment_status = 'paid'
      and (part.reservation_status is null or part.reservation_status = 'confirmed');

    if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
       or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
      raise exception 'Categoria esgotada neste lote.';
    end if;
  end if;

  if v_gender_key in ('feminino', 'female', 'f') then
    select round(rbp.female_price, 2) into v_base
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  elsif v_gender_key in ('masculino', 'male', 'm') then
    select round(rbp.male_price, 2) into v_base
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;

  if v_base is null then
    raise exception 'Preco nao configurado para esta categoria e lote.';
  end if;

  v_final := v_base;

  if coalesce(trim(p_coupon_code), '') <> '' then
    select * into v_coupon
    from public.validate_coupon(trim(p_coupon_code), v_event_id, v_base)
    limit 1;

    v_discount := round(coalesce(v_coupon.discount_amount, 0), 2);
    v_final := round(coalesce(v_coupon.final_amount, v_base), 2);

    return query
    select
      v_batch.id,
      v_batch.name,
      v_batch.sequence_number,
      v_base,
      v_discount,
      v_final,
      case when v_batch_category_limit is null then null::integer else greatest(v_batch_category_limit - v_confirmed_count, 0) end,
      coalesce(v_coupon.message, 'Cupom aplicado.'),
      coalesce(v_coupon.coupon_type, ''),
      coalesce(v_coupon.discount_percent, 0);

    return;
  end if;

  return query
  select
    v_batch.id,
    v_batch.name,
    v_batch.sequence_number,
    v_base,
    0::numeric,
    v_final,
    case when v_batch_category_limit is null then null::integer else greatest(v_batch_category_limit - v_confirmed_count, 0) end,
    null::text,
    null::text,
    0::numeric;
end;
$$;


ALTER FUNCTION "public"."get_registration_pricing_preview"("p_gender" "text", "p_coupon_code" "text", "p_event_id" "uuid", "p_ticket_category_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ticket_kit_items"("p_ticket_id" "uuid") RETURNS TABLE("id" "uuid", "kit_item_id" "uuid", "item_name" "text", "item_type" "text", "quantity" integer, "status" "text", "variant_data" "jsonb", "delivered_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ticket public.tickets%rowtype;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where tickets.id=p_ticket_id;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_ticket.owner_user_id is distinct from auth.uid()
    and not public.user_can_access_organization(auth.uid(),v_ticket.organization_id)
  then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  return query select pki.id,eki.id,eki.name,eki.item_type,coalesce(pki.quantity,eki.quantity_per_participant),
    coalesce(pki.status,'not_linked'),pki.variant_data,pki.delivered_at
  from public.event_kit_items eki left join public.participant_kit_items pki
    on pki.ticket_id=p_ticket_id and pki.kit_item_id=eki.id
  where eki.event_id=v_ticket.event_id and eki.is_active
    and not(eki.item_type='shirt' and eki.shirt_supply_mode='disabled')
  order by eki.sort_order,eki.created_at;
end; $$;


ALTER FUNCTION "public"."get_ticket_kit_items"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ticket_shirt_stock"("p_ticket_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ticket public.tickets%rowtype; v_row record; v_available integer;
begin
  if auth.uid() is null or not public.current_user_has_permission('participants.view') then raise exception 'Sem permissao para consultar ingresso.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select pki.status,pki.quantity,eki.shirt_supply_mode,v.name as shirt_type,v.value as shirt_size,
    inv.total_quantity,inv.delivered_quantity
  into v_row
  from public.participant_kit_items pki
  join public.event_kit_items eki on eki.id=pki.kit_item_id and eki.item_type='shirt'
  left join public.event_kit_item_variants v on v.id=nullif(pki.variant_data->>'variant_id','')::uuid
  left join public.event_kit_item_variant_inventory inv on inv.kit_item_id=pki.kit_item_id and inv.variant_id=v.id
  where pki.ticket_id=p_ticket_id order by pki.created_at limit 1;
  if not found then return null; end if;
  v_available:=case when v_row.shirt_supply_mode='stock' then greatest(coalesce(v_row.total_quantity,0)-coalesce(v_row.delivered_quantity,0),0) else null end;
  return jsonb_build_object('shirt_type',coalesce(v_row.shirt_type,''),'shirt_size',coalesce(v_row.shirt_size,''),
    'supply_mode',coalesce(v_row.shirt_supply_mode,''),'physical_available',v_available,
    'status',case when v_row.status='delivered' or v_row.shirt_supply_mode<>'stock' then 'not_applicable'
      when v_available=0 then 'out_of_stock' when v_available=1 then 'last_unit' else 'available' end);
end; $$;


ALTER FUNCTION "public"."get_ticket_shirt_stock"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_upcoming_kit_deliveries"("p_limit" integer DEFAULT 6) RETURNS TABLE("id" "uuid", "delivery_at" timestamp with time zone, "city" "text", "location" "text", "sort_order" integer)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select
    k.id,
    k.delivery_at,
    k.city,
    k.location,
    k.sort_order
  from public.kit_delivery_schedule k
  where coalesce(k.is_active, true) = true
    and k.delivery_at >= now() - interval '12 hours'
  order by coalesce(k.sort_order, 0) asc,
           k.delivery_at asc
  limit greatest(coalesce(p_limit, 6), 1);
$$;


ALTER FUNCTION "public"."get_upcoming_kit_deliveries"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."import_participant_has_issuance_blockers"("p_participant_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists(select 1 from public.participant_data_issues
    where participant_id=p_participant_id and status='open'
      and (blocks_payment or blocks_ticket_issuance));
$$;


ALTER FUNCTION "public"."import_participant_has_issuance_blockers"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."initialize_event_inventory"("p_event_id" "uuid", "p_source_event_id" "uuid" DEFAULT NULL::"uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_source_event_id uuid;
  v_inserted_count integer := 0;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio para inicializacao do estoque.';
  end if;

  select id
    into v_source_event_id
  from public.events
  where id = coalesce(p_source_event_id, (
    select id
    from public.events
    where is_active = true
      and id <> p_event_id
    order by updated_at desc, created_at desc
    limit 1
  ))
  limit 1;

  if v_source_event_id is null then
    with default_variants as (
      select *
      from (
        values
          ('Camiseta', 'PP'),
          ('Camiseta', 'P'),
          ('Camiseta', 'M'),
          ('Camiseta', 'G'),
          ('Camiseta', 'GG'),
          ('Camiseta', 'EG'),
          ('Camiseta', 'EXG'),
          ('Camiseta', 'EXGG'),
          ('Babylook', 'PP'),
          ('Babylook', 'P'),
          ('Babylook', 'M'),
          ('Babylook', 'G'),
          ('Babylook', 'GG'),
          ('Babylook', 'EG')
      ) as v(shirt_type, shirt_size)
    ), inserted as (
      insert into public.shirt_inventory (
        event_id,
        shirt_type,
        shirt_size,
        total_quantity,
        reserved_quantity,
        delivered_quantity
      )
      select
        p_event_id,
        dv.shirt_type,
        dv.shirt_size,
        0,
        0,
        0
      from default_variants dv
      where not exists (
        select 1
        from public.shirt_inventory existing
        where existing.event_id = p_event_id
          and existing.shirt_type = dv.shirt_type
          and existing.shirt_size = dv.shirt_size
      )
      returning 1
    )
    select count(*)::integer into v_inserted_count from inserted;

    return v_inserted_count;
  end if;

  with source_variants as (
    select distinct
      si.shirt_type,
      si.shirt_size
    from public.shirt_inventory si
    where si.event_id = v_source_event_id
  ), inserted as (
    insert into public.shirt_inventory (
      event_id,
      shirt_type,
      shirt_size,
      total_quantity,
      reserved_quantity,
      delivered_quantity
    )
    select
      p_event_id,
      sv.shirt_type,
      sv.shirt_size,
      0,
      0,
      0
    from source_variants sv
    where not exists (
      select 1
      from public.shirt_inventory existing
      where existing.event_id = p_event_id
        and existing.shirt_type = sv.shirt_type
        and existing.shirt_size = sv.shirt_size
    )
    returning 1
  )
  select count(*)::integer into v_inserted_count from inserted;

  return v_inserted_count;
end;
$$;


ALTER FUNCTION "public"."initialize_event_inventory"("p_event_id" "uuid", "p_source_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_active_owner"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
    from public.admin_users au
    join public.admin_roles ar on ar.id = au.role_id
    where au.user_id = p_user_id
      and au.is_active = true
      and ar.is_active = true
      and ar.code = 'owner'
  );
$$;


ALTER FUNCTION "public"."is_active_owner"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_event_payment_method_allowed"("p_event_id" "uuid", "p_payment_method" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_method text := lower(trim(coalesce(p_payment_method, '')));
  v_pix_enabled boolean := true;
  v_credit_single_enabled boolean := true;
  v_credit_installments_enabled boolean := true;
begin
  select
    coalesce(epm.pix_enabled, true),
    coalesce(epm.credit_card_single_enabled, true),
    coalesce(epm.credit_card_installments_enabled, true)
  into
    v_pix_enabled,
    v_credit_single_enabled,
    v_credit_installments_enabled
  from public.events e
  left join public.event_payment_methods epm on epm.event_id = e.id
  where e.id = p_event_id;

  if v_method = 'pix' then
    return v_pix_enabled;
  end if;

  if v_method = 'credit_card_single' then
    return v_credit_single_enabled;
  end if;

  if v_method = 'credit_card_installments' then
    return v_credit_installments_enabled;
  end if;

  if v_method = 'credit_card' then
    return v_credit_single_enabled or v_credit_installments_enabled;
  end if;

  if v_method = 'courtesy' then
    return true;
  end if;

  return false;
end;
$$;


ALTER FUNCTION "public"."is_event_payment_method_allowed"("p_event_id" "uuid", "p_payment_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_organization_member"("p_user_id" "uuid", "p_organization_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
    from public.organization_members om
    where om.user_id         = p_user_id
      and om.organization_id = p_organization_id
      and om.is_active = true
  );
$$;


ALTER FUNCTION "public"."is_organization_member"("p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_organization_owner"("p_user_id" "uuid", "p_organization_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
    from public.organization_members om
    where om.user_id         = p_user_id
      and om.organization_id = p_organization_id
      and om.is_owner  = true
      and om.is_active = true
  );
$$;


ALTER FUNCTION "public"."is_organization_owner"("p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_platform_owner"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
    from public.platform_users pu
    where pu.user_id = p_user_id
      and pu.role = 'owner'
      and pu.is_active = true
  );
$$;


ALTER FUNCTION "public"."is_platform_owner"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_platform_user"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
    from public.platform_users pu
    where pu.user_id = p_user_id
      and pu.is_active = true
  );
$$;


ALTER FUNCTION "public"."is_platform_user"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_valid_cpf"("p_value" "text") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare v text:=regexp_replace(coalesce(p_value,''),'\D','','g'); v_sum integer; v_digit integer;
begin
  if v !~ '^\d{11}$' or v ~ '^(\d)\1{10}$' then return false; end if;
  v_sum:=0; for i in 1..9 loop v_sum:=v_sum+substring(v,i,1)::integer*(11-i); end loop;
  v_digit:=(v_sum*10)%11; if v_digit=10 then v_digit:=0; end if;
  if v_digit<>substring(v,10,1)::integer then return false; end if;
  v_sum:=0; for i in 1..10 loop v_sum:=v_sum+substring(v,i,1)::integer*(12-i); end loop;
  v_digit:=(v_sum*10)%11; if v_digit=10 then v_digit:=0; end if;
  return v_digit=substring(v,11,1)::integer;
end; $_$;


ALTER FUNCTION "public"."is_valid_cpf"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."issue_manual_ticket_batch"("p_registration_contact_id" "uuid", "p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_quantity" integer, "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS TABLE("ticket_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_contact public.registration_contacts%rowtype;
  v_event_organization_id uuid;
  v_first record;
  v_extra record;
  v_index integer;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'Quantidade deve estar entre 1 e 20.';
  end if;

  select organization_id into v_event_organization_id
  from public.events where id=p_event_id;
  if v_event_organization_id is null then raise exception 'Evento nao encontrado.'; end if;

  select * into v_contact from public.registration_contacts
  where id=p_registration_contact_id and organization_id=v_event_organization_id;
  if not found then raise exception 'Cadastro nao pertence a organizacao do evento.'; end if;

  select * into v_first from public.create_manual_registration_order(
    p_event_id,p_ticket_category_id,p_batch_id,v_contact.full_name,v_contact.cpf,
    v_contact.birth_date,p_pricing_gender,v_contact.phone,v_contact.email,v_contact.city,
    p_shirt_type,p_shirt_size,p_payment_method,p_notes
  );

  update public.participants set registration_contact_id=v_contact.id where id=v_first.participant_id;
  if not found then raise exception 'Falha ao vincular participante ao cadastro.'; end if;
  update public.order_items set registration_contact_id=v_contact.id where id=v_first.order_item_id;
  if not found then raise exception 'Falha ao vincular item ao cadastro.'; end if;
  ticket_id:=v_first.ticket_id;
  return next;

  for v_index in 2..p_quantity loop
    select * into v_extra from public.create_manual_unassigned_ticket_order(
      p_event_id,p_ticket_category_id,p_batch_id,p_pricing_gender,p_shirt_type,
      p_shirt_size,p_payment_method,p_notes
    );
    ticket_id:=v_extra.ticket_id;
    return next;
  end loop;
end;
$$;


ALTER FUNCTION "public"."issue_manual_ticket_batch"("p_registration_contact_id" "uuid", "p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_quantity" integer, "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."issue_manual_ticket_batch"("p_registration_contact_id" "uuid", "p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_quantity" integer, "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text" DEFAULT NULL::"text", "p_assign_holder" boolean DEFAULT true) RETURNS TABLE("ticket_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."issue_manual_ticket_batch"("p_registration_contact_id" "uuid", "p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_quantity" integer, "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text", "p_assign_holder" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."link_wristband_to_ticket"("p_ticket_id" "uuid", "p_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ticket    public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_event     public.events%rowtype;
  v_existing  public.participant_wristbands%rowtype;
  v_wristband public.participant_wristbands%rowtype;
  v_code      text := nullif(trim(p_code), '');
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.link')
  ) then
    raise exception 'Sem permissao para vincular pulseira.';
  end if;

  if p_ticket_id is null then
    raise exception 'Ingresso obrigatorio.';
  end if;
  if v_code is null then
    raise exception 'Codigo da pulseira obrigatorio.';
  end if;

  select t.* into v_ticket from public.tickets t
  where t.id = p_ticket_id for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  -- Verifica org access via ticket
  if not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Sem permissao para vincular pulseira nesta organização.';
  end if;

  if v_ticket.participant_id is null then
    raise exception 'Ingresso ainda nao possui participante vinculado.';
  end if;

  select p.* into v_participant from public.participants p
  where p.id = v_ticket.participant_id;
  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select e.* into v_event from public.events e
  where e.id = v_participant.event_id;
  if not found then
    raise exception 'Evento nao encontrado.';
  end if;
  if not coalesce(v_event.wristband_enabled, false) then
    raise exception 'Este evento nao utiliza pulseiras vinculadas.';
  end if;

  select pw.* into v_existing
  from public.participant_wristbands pw
  where pw.event_id = v_participant.event_id
    and lower(pw.code) = lower(v_code)
    and pw.status = 'active'
  limit 1 for update;

  if found then
    if v_existing.ticket_id = p_ticket_id then
      return jsonb_build_object(
        'success', true, 'already_linked', true,
        'wristband_id', v_existing.id, 'code', v_existing.code
      );
    end if;
    raise exception 'Pulseira ja vinculada a outro ingresso.';
  end if;

  if exists (
    select 1 from public.participant_wristbands pw
    where pw.ticket_id = p_ticket_id and pw.status = 'active'
  ) then
    raise exception 'Este ingresso ja possui uma pulseira ativa.';
  end if;

  insert into public.participant_wristbands (
    event_id, ticket_id, participant_id, code, status, linked_at, linked_by
  ) values (
    v_participant.event_id, p_ticket_id, v_participant.id,
    v_code, 'active', now(), auth.uid()
  )
  returning * into v_wristband;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'wristband_linked', 'participant_wristbands', v_wristband.id, v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_wristband.organization_id,
      'ticket_id', p_ticket_id,
      'participant_id', v_participant.id,
      'code', v_code
    )
  );

  return jsonb_build_object(
    'success', true, 'already_linked', false,
    'wristband_id', v_wristband.id, 'code', v_wristband.code
  );
end;
$$;


ALTER FUNCTION "public"."link_wristband_to_ticket"("p_ticket_id" "uuid", "p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_admin_roles"() RETURNS TABLE("id" "uuid", "name" "text", "description" "text", "is_active" boolean, "is_system" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar funcoes.';
  end if;

  return query
  select ar.id, ar.name, ar.description, ar.is_active, ar.is_system
  from public.admin_roles ar
  where ar.is_active = true
  order by case when ar.code = 'owner' then 0 else 1 end, ar.name;
end;
$$;


ALTER FUNCTION "public"."list_admin_roles"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_admin_team"("p_search" "text" DEFAULT NULL::"text", "p_role_name" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("user_id" "uuid", "full_name" "text", "email" "text", "role_name" "text", "is_active" boolean, "effective_permission_count" integer, "last_access_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
  v_search text := lower(trim(coalesce(p_search, '')));
  v_role_filter text := lower(trim(coalesce(p_role_name, '')));
  v_status_filter text := lower(trim(coalesce(p_status, '')));
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar equipe.';
  end if;

  return query
  with base as (
    select
      u.id as user_id,
      coalesce(nullif(trim(cp.full_name), ''), nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)) as full_name,
      lower(u.email) as email,
      ar.name as role_name,
      coalesce(au.is_active, false) as is_active,
      u.last_sign_in_at as last_access_at
    from auth.users u
    left join public.admin_users au on au.user_id = u.id
    left join public.admin_roles ar on ar.id = au.role_id
    left join public.customer_profiles cp on cp.user_id = u.id
  )
  select
    b.user_id,
    b.full_name,
    b.email,
    b.role_name,
    b.is_active,
    (
      select count(*)::integer
      from public.admin_permissions p
      where p.is_active = true
        and public.resolve_user_permission(b.user_id, p.code)
    ) as effective_permission_count,
    b.last_access_at
  from base b
  where (
      v_search = ''
      or lower(coalesce(b.full_name, '')) like '%' || v_search || '%'
      or lower(coalesce(b.email, '')) like '%' || v_search || '%'
    )
    and (
      v_role_filter = ''
      or lower(coalesce(b.role_name, '')) = v_role_filter
    )
    and (
      v_status_filter = ''
      or (v_status_filter = 'active' and b.is_active = true)
      or (v_status_filter = 'inactive' and b.is_active = false)
    )
  order by b.full_name nulls last, b.email;
end;
$$;


ALTER FUNCTION "public"."list_admin_team"("p_search" "text", "p_role_name" "text", "p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_override_state_for_user"("p_user_id" "uuid") RETURNS TABLE("permission_code" "text", "effect" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar overrides.';
  end if;

  return query
  select p.code, uo.effect
  from public.admin_user_permission_overrides uo
  join public.admin_permissions p on p.id = uo.permission_id
  where uo.user_id = p_user_id
  order by p.module, p.sort_order, p.code;
end;
$$;


ALTER FUNCTION "public"."list_override_state_for_user"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_store_items_for_event"("p_event_id" "uuid") RETURNS TABLE("store_item_id" "uuid", "event_id" "uuid", "name" "text", "slug" "text", "description" "text", "image_url" "text", "price" numeric, "requires_variant" boolean, "supply_mode" "text", "sort_order" integer, "variant_id" "uuid", "variant_name" "text", "variant_value" "text", "price_adjustment" numeric, "total_quantity" integer, "reserved_quantity" integer, "delivered_quantity" integer, "available_quantity" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select si.id, si.event_id, si.name, si.slug, si.description, si.image_url, si.price, si.requires_variant, si.supply_mode, si.sort_order,
    siv.id, siv.name, siv.value, siv.price_adjustment,
    coalesce(inv.total_quantity, 0), coalesce(inv.reserved_quantity, 0), coalesce(inv.delivered_quantity, 0),
    case when si.supply_mode = 'made_to_order' then null
      else greatest(coalesce(inv.total_quantity, 0) - coalesce(inv.reserved_quantity, 0) - coalesce(inv.delivered_quantity, 0), 0)
    end
  from public.store_items si
  left join public.store_item_variants siv on siv.store_item_id = si.id and siv.is_active
  left join public.store_item_inventory inv on inv.store_item_id = si.id and inv.variant_id is not distinct from siv.id
  where (si.event_id = p_event_id or si.event_id is null) and si.is_active
  order by si.sort_order, si.name, siv.sort_order, siv.name;
$$;


ALTER FUNCTION "public"."list_store_items_for_event"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_user_effective_permissions"("p_user_id" "uuid") RETURNS TABLE("code" "text", "module" "text", "name" "text", "state" "text", "origin" "text", "is_effective" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
  v_target_role_id uuid;
  v_target_active boolean := false;
  v_target_is_owner boolean := false;
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if p_user_id is null then
    raise exception 'Usuario alvo obrigatorio.';
  end if;

  if v_actor_user_id <> p_user_id and not public.current_user_has_permission('team.view') then
    raise exception 'Sem permissao para visualizar permissoes deste usuario.';
  end if;

  select au.role_id, au.is_active
    into v_target_role_id, v_target_active
  from public.admin_users au
  where au.user_id = p_user_id;

  v_target_is_owner := public.is_active_owner(p_user_id);

  return query
  with role_permissions as (
    select arp.permission_id
    from public.admin_role_permissions arp
    where arp.role_id = v_target_role_id
  ), overrides as (
    select uo.permission_id, uo.effect
    from public.admin_user_permission_overrides uo
    where uo.user_id = p_user_id
  )
  select
    p.code,
    p.module,
    p.name,
    case
      when o.effect = 'allow' then 'allow'
      when o.effect = 'deny' then 'deny'
      else 'inherit'
    end as state,
    case
      when coalesce(v_target_active, false) = false then 'inactive_user'
      when v_target_is_owner then 'owner'
      when o.effect = 'deny' then 'denied_individual'
      when o.effect = 'allow' then 'allowed_individual'
      when rp.permission_id is not null then 'inherited_role'
      else 'no_access'
    end as origin,
    case
      when coalesce(v_target_active, false) = false then false
      when v_target_is_owner then true
      when o.effect = 'deny' then false
      when o.effect = 'allow' then true
      when rp.permission_id is not null then true
      else false
    end as is_effective
  from public.admin_permissions p
  left join role_permissions rp on rp.permission_id = p.id
  left join overrides o on o.permission_id = p.id
  where p.is_active = true
  order by p.module asc, p.sort_order asc, p.code asc;
end;
$$;


ALTER FUNCTION "public"."list_user_effective_permissions"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."materialize_event_participant_kit_items"("p_event_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select public.materialize_event_ticket_kit_items(p_event_id);
$$;


ALTER FUNCTION "public"."materialize_event_participant_kit_items"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."materialize_event_ticket_kit_items"("p_event_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ticket record; v_result jsonb; v_results jsonb := '[]'; v_processed integer:=0; v_created integer:=0; v_skipped integer:=0; v_org uuid;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para vincular itens.'; end if;
  select organization_id into v_org from public.events where id=p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Evento invalido ou sem acesso.'; end if;
  for v_ticket in select id from public.tickets where event_id=p_event_id and status<>'cancelled' order by issued_at loop
    begin
      v_result := public.materialize_ticket_kit_items_internal(v_ticket.id,'operations_batch');
      v_processed:=v_processed+1; v_created:=v_created+coalesce((v_result->>'created_count')::int,0); v_skipped:=v_skipped+coalesce((v_result->>'skipped_count')::int,0);
      v_results:=v_results||jsonb_build_array(v_result);
    exception when others then v_skipped:=v_skipped+1; v_results:=v_results||jsonb_build_array(jsonb_build_object('ticket_id',v_ticket.id,'error',sqlerrm)); end;
  end loop;
  return jsonb_build_object('event_id',p_event_id,'processed_tickets',v_processed,'created_count',v_created,'skipped_count',v_skipped,'results',v_results);
end;
$$;


ALTER FUNCTION "public"."materialize_event_ticket_kit_items"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."materialize_order_item_kit_reservations"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_item public.event_kit_items%rowtype; v_org uuid;
begin
  if new.status in ('cancelled','expired','refunded') then return new; end if;
  select organization_id into v_org from public.events where id=new.event_id;
  for v_item in select * from public.event_kit_items where event_id=new.event_id and is_active order by sort_order,created_at loop
    if v_item.item_type='shirt' and (nullif(trim(new.shirt_type),'') is null or nullif(trim(new.shirt_size),'') is null) then continue; end if;
    insert into public.participant_kit_items(order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
    values(new.id,new.participant_id,new.event_id,v_org,v_item.id,
      case when v_item.item_type='shirt' then jsonb_build_object('shirt_type',new.shirt_type,'shirt_size',new.shirt_size) end,
      v_item.quantity_per_participant,case when new.status='confirmed' then 'confirmed' else 'reserved' end)
    on conflict on constraint participant_kit_items_participant_kit_unique do nothing;
  end loop;
  return new;
end;
$$;


ALTER FUNCTION "public"."materialize_order_item_kit_reservations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."materialize_participant_kit_items"("p_ticket_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select public.materialize_ticket_kit_items(p_ticket_id);
$$;


ALTER FUNCTION "public"."materialize_participant_kit_items"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."materialize_participant_kit_items_internal"("p_ticket_id" "uuid", "p_source" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_ticket public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_order_item public.order_items%rowtype;
  v_item public.event_kit_items%rowtype;
  v_shirt_type text;
  v_shirt_size text;
  v_status text := 'reserved';
  v_created_ids uuid[] := array[]::uuid[];
  v_existing_ids uuid[] := array[]::uuid[];
  v_skipped jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_link_id uuid;
  v_was_created boolean;
  v_organization_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') then
    raise exception 'Sem permissao para vincular itens.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;

  if v_ticket.order_item_id is not null then
    select * into v_order_item from public.order_items where id = v_ticket.order_item_id for update;
  end if;

  select * into v_participant
  from public.participants
  where id = coalesce(v_ticket.participant_id, v_order_item.participant_id)
  for update;
  if not found then raise exception 'Ingresso sem participante vinculado.'; end if;

  select e.organization_id into v_organization_id from public.events e where e.id = v_ticket.event_id;
  if v_organization_id is null
    or not public.user_can_access_organization(v_actor, v_organization_id) then
    raise exception 'Usuario sem acesso a organizacao do evento.';
  end if;

  v_shirt_type := nullif(trim(coalesce(v_participant.shirt_type, v_order_item.shirt_type)), '');
  v_shirt_size := nullif(trim(coalesce(v_participant.shirt_size, v_order_item.shirt_size)), '');

  if exists (
    select 1 from public.payments p
    where p.participant_id = v_participant.id and p.payment_status = 'paid'
  ) then
    v_status := 'confirmed';
  end if;

  for v_item in
    select * from public.event_kit_items
    where event_id = v_ticket.event_id and is_active = true
    order by sort_order, created_at
  loop
    select pki.id into v_link_id
    from public.participant_kit_items pki
    where pki.participant_id = v_participant.id and pki.kit_item_id = v_item.id;

    if v_link_id is not null then
      v_existing_ids := array_append(v_existing_ids, v_link_id);
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'kit_item_id', v_item.id, 'name', v_item.name, 'item_type', v_item.item_type,
        'result', 'existing', 'link_id', v_link_id
      ));
      v_link_id := null;
      continue;
    end if;

    if v_item.item_type = 'shirt' and (v_shirt_type is null or v_shirt_size is null) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'kit_item_id', v_item.id, 'name', v_item.name, 'item_type', v_item.item_type,
        'reason', 'Informe modelo e tamanho antes de vincular os itens.'
      ));
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'kit_item_id', v_item.id, 'name', v_item.name, 'item_type', v_item.item_type,
        'result', 'skipped', 'reason', 'Informe modelo e tamanho antes de vincular os itens.'
      ));
      continue;
    end if;

    v_was_created := false;
    insert into public.participant_kit_items (
      participant_id, event_id, kit_item_id, variant_data, quantity, status
    ) values (
      v_participant.id, v_ticket.event_id, v_item.id,
      case when v_item.item_type = 'shirt'
        then jsonb_build_object('shirt_type', v_shirt_type, 'shirt_size', v_shirt_size)
        else null end,
      v_item.quantity_per_participant, v_status
    )
    on conflict on constraint participant_kit_items_participant_kit_unique do nothing
    returning id into v_link_id;

    if v_link_id is not null then
      v_was_created := true;
      v_created_ids := array_append(v_created_ids, v_link_id);
    else
      select pki.id into v_link_id from public.participant_kit_items pki
      where pki.participant_id = v_participant.id and pki.kit_item_id = v_item.id;
      v_existing_ids := array_append(v_existing_ids, v_link_id);
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'kit_item_id', v_item.id, 'name', v_item.name, 'item_type', v_item.item_type,
      'result', case when v_was_created then 'created' else 'existing' end,
      'link_id', v_link_id,
      'variant_data', case when v_item.item_type = 'shirt'
        then jsonb_build_object('shirt_type', v_shirt_type, 'shirt_size', v_shirt_size)
        else null end
    ));
  end loop;

  select lower(email) into v_actor_email from auth.users where id = v_actor;
  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('participant_kit_items_materialized', 'participants', v_participant.id, v_ticket.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor, 'actor_email', v_actor_email,
      'organization_id', v_organization_id, 'event_id', v_ticket.event_id,
      'participant_id', v_participant.id, 'ticket_id', p_ticket_id,
      'created_item_ids', v_created_ids, 'existing_item_ids', v_existing_ids,
      'source', p_source, 'timestamp', now()
    ));

  return jsonb_build_object(
    'participant_id', v_participant.id, 'ticket_id', p_ticket_id,
    'created_count', cardinality(v_created_ids),
    'existing_count', cardinality(v_existing_ids),
    'skipped_count', jsonb_array_length(v_skipped),
    'items', v_items, 'skipped', v_skipped
  );
end;
$$;


ALTER FUNCTION "public"."materialize_participant_kit_items_internal"("p_ticket_id" "uuid", "p_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."materialize_ticket_kit_items"("p_ticket_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select public.materialize_ticket_kit_items_internal(p_ticket_id,'operations_manual');
$$;


ALTER FUNCTION "public"."materialize_ticket_kit_items"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."materialize_ticket_kit_items_internal"("p_ticket_id" "uuid", "p_source" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_result jsonb;
begin
  v_result:=public.ensure_ticket_kit_items(p_ticket_id);
  return v_result||jsonb_build_object('source',p_source);
end; $$;


ALTER FUNCTION "public"."materialize_ticket_kit_items_internal"("p_ticket_id" "uuid", "p_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_coupon_code"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.code := upper(trim(new.code));
  return new;
end;
$$;


ALTER FUNCTION "public"."normalize_coupon_code"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_cpf"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select nullif(regexp_replace(coalesce(p_value, ''), '\D', '', 'g'), '');
$$;


ALTER FUNCTION "public"."normalize_cpf"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_email"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select nullif(lower(trim(coalesce(p_value, ''))), '');
$$;


ALTER FUNCTION "public"."normalize_email"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_events_before_write"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.name := trim(new.name);
  new.slug := public.slugify_text(coalesce(nullif(new.slug, ''), new.name || '-' || coalesce(new.year::text, extract(year from now())::text)));
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."normalize_events_before_write"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_text_for_match"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select regexp_replace(
    translate(lower(trim(coalesce(p_value, ''))), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
    '\s+',
    ' ',
    'g'
  );
$$;


ALTER FUNCTION "public"."normalize_text_for_match"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_ticket_category_slug"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $_$
begin
  new.name := trim(new.name);
  new.slug := lower(regexp_replace(trim(new.slug), '[^a-z0-9]+', '-', 'g'));
  new.slug := regexp_replace(new.slug, '^-+|-+$', '', 'g');
  new.updated_at := now();
  return new;
end;
$_$;


ALTER FUNCTION "public"."normalize_ticket_category_slug"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."post_financial_entry"("p_entry_id" "uuid", "p_reason" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_entry public.financial_entries%rowtype; v_d numeric; v_c numeric;
begin
  select * into v_entry from public.financial_entries where id=p_entry_id for update;
  if not found then raise exception 'Lancamento nao encontrado.'; end if;
  if v_actor is null or not public.current_user_has_permission('finance.confirm_payment') or not public.user_can_access_organization(v_actor,v_entry.organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if v_entry.lifecycle_status<>'draft' then return v_entry.id; end if;
  select coalesce(sum(amount) filter(where line_side='debit'),0),coalesce(sum(amount) filter(where line_side='credit'),0) into v_d,v_c from public.financial_entry_lines where entry_id=p_entry_id;
  if v_d<>v_entry.amount or v_c<>v_entry.amount then raise exception 'Lancamento desequilibrado.'; end if;
  update public.financial_entries set lifecycle_status=case when due_date is null or due_date<=current_date then 'settled' else 'open' end,posted_at=now(),settled_at=case when due_date is null or due_date<=current_date then now() end,updated_at=now() where id=p_entry_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_entry_posted','financial_entries',p_entry_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_entry.organization_id,'previous_status','draft','reason',nullif(trim(p_reason),'')));
  return p_entry_id;
end $$;


ALTER FUNCTION "public"."post_financial_entry"("p_entry_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prepare_participant_account_invite"("p_participant_id" "uuid") RETURNS TABLE("invite_id" "uuid", "email" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_email text;
  v_id uuid; v_check record; v_requires_password_setup boolean;
begin
  select * into v_check from public.check_participant_account_invite_eligibility(p_participant_id);
  if not coalesce(v_check.eligible,false) then raise exception '%',coalesce(v_check.reason_message,'Cadastro nao elegivel.'); end if;
  select * into v_p from public.participants where id=p_participant_id for update;
  v_email:=v_check.email;
  select exists(
    select 1 from public.participation_history ph
    where ph.participant_id=v_p.id and ph.event_id=v_p.event_id and ph.source='import'
  ) into v_requires_password_setup;
  update public.participant_account_invites set status='revoked',updated_at=now()
    where participant_id=v_p.id and status='pending' and expires_at<=now();
  insert into public.participant_account_invites(
    organization_id,event_id,participant_id,email,invited_by,requires_password_setup
  ) values(
    v_p.organization_id,v_p.event_id,v_p.id,v_email,v_actor,v_requires_password_setup
  )
  on conflict(participant_id) where status='pending' do update set
    email=excluded.email,invited_by=excluded.invited_by,
    expires_at=now()+interval '7 days',updated_at=now(),
    requires_password_setup=public.participant_account_invites.requires_password_setup
      or excluded.requires_password_setup
  returning id into v_id;
  return query select v_id,v_email;
end; $$;


ALTER FUNCTION "public"."prepare_participant_account_invite"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_last_owner_admin_user_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_old_is_owner_active boolean := false;
  v_new_is_owner_active boolean := false;
  v_remaining_active_owner_count integer := 0;
begin
  if tg_op = 'DELETE' then
    select exists (
      select 1
      from public.admin_roles ar
      where ar.id = old.role_id
        and ar.code = 'owner'
        and ar.is_active = true
    ) and coalesce(old.is_active, false)
    into v_old_is_owner_active;

    if v_old_is_owner_active then
      select count(*)::integer
        into v_remaining_active_owner_count
      from public.admin_users au
      join public.admin_roles ar on ar.id = au.role_id
      where au.user_id <> old.user_id
        and au.is_active = true
        and ar.is_active = true
        and ar.code = 'owner';

      if v_remaining_active_owner_count = 0 then
        raise exception 'Nao e permitido remover o ultimo Owner ativo.';
      end if;
    end if;

    return old;
  end if;

  select exists (
    select 1
    from public.admin_roles ar
    where ar.id = old.role_id
      and ar.code = 'owner'
      and ar.is_active = true
  ) and coalesce(old.is_active, false)
  into v_old_is_owner_active;

  select exists (
    select 1
    from public.admin_roles ar
    where ar.id = new.role_id
      and ar.code = 'owner'
      and ar.is_active = true
  ) and coalesce(new.is_active, false)
  into v_new_is_owner_active;

  if v_old_is_owner_active and not v_new_is_owner_active then
    select count(*)::integer
      into v_remaining_active_owner_count
    from public.admin_users au
    join public.admin_roles ar on ar.id = au.role_id
    where au.user_id <> old.user_id
      and au.is_active = true
      and ar.is_active = true
      and ar.code = 'owner';

    if v_remaining_active_owner_count = 0 then
      raise exception 'Nao e permitido desativar ou rebaixar o ultimo Owner ativo.';
    end if;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."prevent_last_owner_admin_user_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_owner_role_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if tg_op = 'DELETE' then
    if old.code = 'owner' then
      raise exception 'A funcao Owner nao pode ser removida.';
    end if;
    return old;
  end if;

  if old.code = 'owner' and coalesce(new.is_active, true) = false then
    raise exception 'A funcao Owner nao pode ser desativada.';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."prevent_owner_role_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."raise_shirt_out_of_stock"("p_shirt_type" "text", "p_shirt_size" "text", "p_physical_available" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  raise exception using
    errcode='P0001',
    message='SHIRT_OUT_OF_STOCK',
    detail=jsonb_build_object(
      'code','SHIRT_OUT_OF_STOCK',
      'shirt_type',coalesce(p_shirt_type,''),
      'shirt_size',coalesce(p_shirt_size,''),
      'physical_available',greatest(coalesce(p_physical_available,0),0),
      'message',format('Nao ha estoque disponivel para %s %s. A entrega nao foi confirmada.',coalesce(p_shirt_type,'Camiseta'),coalesce(p_shirt_size,''))
    )::text;
end; $$;


ALTER FUNCTION "public"."raise_shirt_out_of_stock"("p_shirt_type" "text", "p_shirt_size" "text", "p_physical_available" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_financial_entry"("p_entry_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_reconciled_on" "date", "p_external_reference" "text", "p_idempotency_key" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_entry public.financial_entries%rowtype; v_id uuid; v_total numeric;
begin
  select * into v_entry from public.financial_entries where id=p_entry_id for update;
  if not found then raise exception 'Lancamento nao encontrado.'; end if;
  if v_actor is null or not public.current_user_has_permission('finance.reconcile') or not public.user_can_access_organization(v_actor,v_entry.organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  select id into v_id from public.financial_reconciliations where organization_id=v_entry.organization_id and idempotency_key=trim(p_idempotency_key); if v_id is not null then return v_id; end if;
  if v_entry.lifecycle_status not in('open','partially_settled','settled') or p_amount<=0 then raise exception 'Conciliação invalida para o estado atual.'; end if;
  insert into public.financial_reconciliations(entry_id,organization_id,account_id,amount,reconciled_on,external_reference,idempotency_key,reconciled_by) values(p_entry_id,v_entry.organization_id,p_account_id,p_amount,p_reconciled_on,nullif(trim(p_external_reference),''),trim(p_idempotency_key),v_actor) returning id into v_id;
  select sum(amount) into v_total from public.financial_reconciliations where entry_id=p_entry_id;
  if v_total>v_entry.amount then raise exception 'Conciliacao excede o valor do lancamento.'; end if;
  update public.financial_entries set lifecycle_status=case when v_total=v_entry.amount then 'settled' else 'partially_settled' end,settled_at=case when v_total=v_entry.amount then now() else null end,updated_at=now() where id=p_entry_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_entry_reconciled','financial_entries',p_entry_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_entry.organization_id,'reconciliation_id',v_id,'amount',p_amount,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;


ALTER FUNCTION "public"."reconcile_financial_entry"("p_entry_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_reconciled_on" "date", "p_external_reference" "text", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_import_field_inference_audit"("p_import_batch_id" "uuid", "p_participant_id" "uuid", "p_inferred_field" "text", "p_inferred_value" "text", "p_inference_source" "text", "p_original_value" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_event_id uuid;
begin
  if v_actor is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select ib.event_id
  into v_event_id
  from public.import_batches ib
  join public.participants p
    on p.id = p_participant_id
   and p.event_id = ib.event_id
  where ib.id = p_import_batch_id
    and ib.imported_by = v_actor
    and ib.import_type = 'current_event_registrations';

  if v_event_id is null then
    raise exception 'Lote ou participante invalido para auditoria de inferencia.';
  end if;

  select lower(au.email)
  into v_actor_email
  from auth.users au
  where au.id = v_actor;

  begin
    insert into public.audit_logs (
      action,
      entity_type,
      entity_id,
      event_id,
      details
    ) values (
      'import_field_inferred',
      'participants',
      p_participant_id,
      v_event_id,
      jsonb_build_object(
        'import_batch_id', p_import_batch_id,
        'imported_by_user_id', v_actor,
        'imported_by_email', v_actor_email,
        'participant_id', p_participant_id,
        'inferred_field', p_inferred_field,
        'inferred_value', p_inferred_value,
        'inference_source', p_inference_source,
        'original_value', p_original_value
      )
    );

    return true;
  exception when others then
    raise warning 'Falha ao registrar auditoria import_field_inferred (batch %, participant %): [%] %',
      p_import_batch_id,
      p_participant_id,
      sqlstate,
      sqlerrm;
    return false;
  end;
end;
$$;


ALTER FUNCTION "public"."record_import_field_inference_audit"("p_import_batch_id" "uuid", "p_participant_id" "uuid", "p_inferred_field" "text", "p_inferred_value" "text", "p_inference_source" "text", "p_original_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_ticket_history_export"("p_ticket_id" "uuid", "p_format" "text", "p_scope" "text", "p_from" "date" DEFAULT NULL::"date", "p_to" "date" DEFAULT NULL::"date", "p_type" "text" DEFAULT NULL::"text", "p_filter_event_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("audit_id" "uuid", "audited_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare
  v_actor uuid:=auth.uid();
  v_ticket public.tickets%rowtype;
  v_audit_id uuid:=gen_random_uuid();
  v_audited_at timestamptz:=now();
  v_format text:=lower(trim(coalesce(p_format,'')));
  v_scope text:=lower(trim(coalesce(p_scope,'')));
  v_type text:=nullif(trim(coalesce(p_type,'')),'');
  v_filters jsonb;
begin
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;
  if not (
    public.current_user_has_permission('participants.view')
    or public.current_user_has_permission('orders.view')
  ) then raise exception 'Sem permissao para exportar o historico do ingresso.'; end if;
  if v_format not in('pdf','csv','xlsx') then raise exception 'Formato de exportacao invalido.'; end if;
  if v_scope not in('ticket','account') then raise exception 'Escopo de exportacao invalido.'; end if;
  if p_from is not null and p_to is not null and p_from>p_to then raise exception 'Periodo de exportacao invalido.'; end if;
  if v_type is not null and (length(v_type)>100 or v_type!~'^[a-z0-9_.:-]+$') then raise exception 'Filtro de tipo invalido.'; end if;
  if v_type='__technical__' and not public.current_user_has_permission('audit.view') then raise exception 'Sem permissao para exportar auditoria tecnica.'; end if;

  select * into v_ticket from public.tickets t where t.id=p_ticket_id;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso a organizacao.';
  end if;
  if v_scope='ticket' and p_filter_event_id is not null then raise exception 'Filtro de evento nao se aplica ao escopo do ingresso.'; end if;
  if p_filter_event_id is not null and not exists(
    select 1 from public.events e where e.id=p_filter_event_id and e.organization_id=v_ticket.organization_id
  ) then raise exception 'Evento filtrado invalido ou sem acesso a organizacao.'; end if;

  v_filters:=jsonb_strip_nulls(jsonb_build_object(
    'from',p_from,'to',p_to,'type',v_type,
    'event_id',case when v_scope='account' then p_filter_event_id end
  ));
  insert into public.audit_logs(id,action,entity_type,entity_id,event_id,details,created_at)
  values(
    v_audit_id,'ticket_history_exported','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object(
      'actor_user_id',v_actor,'format',v_format,'scope',v_scope,
      'filters',v_filters,'organization_id',v_ticket.organization_id
    ),v_audited_at
  );
  return query select v_audit_id,v_audited_at;
end;
$_$;


ALTER FUNCTION "public"."record_ticket_history_export"("p_ticket_id" "uuid", "p_format" "text", "p_scope" "text", "p_from" "date", "p_to" "date", "p_type" "text", "p_filter_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."redeem_coupon"("p_coupon_id" "uuid", "p_participant_id" "uuid", "p_event_id" "uuid", "p_original_amount" numeric) RETURNS TABLE("discount_amount" numeric, "final_amount" numeric, "payment_status" "text", "message" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_coupon public.coupons%rowtype;
  v_participant public.participants%rowtype;
  v_discount numeric;
  v_final numeric;
  v_now timestamptz := now();
begin
  if p_coupon_id is null or p_participant_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes para resgate de cupom.';
  end if;

  if p_original_amount is null or p_original_amount < 0 then
    raise exception 'Valor original invalido para resgate.';
  end if;

  select * into v_coupon
  from public.coupons
  where id = p_coupon_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Cupom nao encontrado para o evento.';
  end if;

  if not v_coupon.is_active then
    raise exception 'Cupom inativo.';
  end if;

  if v_coupon.valid_from is not null and v_now < v_coupon.valid_from then
    raise exception 'Cupom ainda nao esta vigente.';
  end if;

  if v_coupon.valid_until is not null and v_now > v_coupon.valid_until then
    raise exception 'Cupom expirado.';
  end if;

  if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
    raise exception 'Limite de usos do cupom atingido.';
  end if;

  if exists (
    select 1
    from public.coupon_redemptions
    where coupon_id = p_coupon_id
      and participant_id = p_participant_id
  ) then
    raise exception 'Este participante ja utilizou este cupom.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado para resgate do cupom.';
  end if;

  if v_coupon.coupon_type = 'courtesy' then
    v_discount := round(p_original_amount, 2);
    v_final := 0;
  else
    v_discount := round((p_original_amount * v_coupon.discount_percent) / 100.0, 2);
    v_final := round(greatest(0, p_original_amount - v_discount), 2);
  end if;

  update public.coupons
  set used_count = used_count + 1,
      updated_at = now()
  where id = p_coupon_id;

  insert into public.coupon_redemptions (
    coupon_id,
    participant_id,
    event_id,
    original_amount,
    discount_amount,
    final_amount
  ) values (
    p_coupon_id,
    p_participant_id,
    p_event_id,
    p_original_amount,
    v_discount,
    v_final
  );

  update public.participants
  set amount = v_final,
      payment_method = case when v_coupon.coupon_type = 'courtesy' then 'courtesy' else payment_method end,
      payment_status = case when v_coupon.coupon_type = 'courtesy' then 'paid' else 'pending' end,
      reservation_status = case when v_coupon.coupon_type = 'courtesy' then 'confirmed' else reservation_status end,
      reservation_expires_at = case when v_coupon.coupon_type = 'courtesy' then null else reservation_expires_at end,
      updated_at = now()
  where id = p_participant_id;

  update public.payments
  set amount = v_final,
      payment_method = case when v_coupon.coupon_type = 'courtesy' then 'courtesy' else payment_method end,
      payment_status = case when v_coupon.coupon_type = 'courtesy' then 'paid' else 'pending' end,
      paid_at = case when v_coupon.coupon_type = 'courtesy' then now() else paid_at end
  where participant_id = p_participant_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'coupon_redeemed',
    'participants',
    p_participant_id,
    jsonb_build_object(
      'coupon_id', p_coupon_id,
      'coupon_code', v_coupon.code,
      'coupon_type', v_coupon.coupon_type,
      'discount_percent', v_coupon.discount_percent,
      'original_amount', p_original_amount,
      'discount_amount', v_discount,
      'final_amount', v_final
    ),
    p_event_id
  );

  return query
  select
    v_discount,
    v_final,
    case when v_coupon.coupon_type = 'courtesy' then 'paid' else 'pending' end,
    case when v_coupon.coupon_type = 'courtesy' then 'Cortesia aplicada e pagamento confirmado.' else 'Cupom aplicado com sucesso.' end;
end;
$$;


ALTER FUNCTION "public"."redeem_coupon"("p_coupon_id" "uuid", "p_participant_id" "uuid", "p_event_id" "uuid", "p_original_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reevaluate_participant_data_issues"("p_participant_id" "uuid", "p_import_batch_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_e public.events%rowtype;
  v_price public.registration_batch_prices%rowtype; v_gender text; v_base numeric;
  v_age integer; v_open integer; v_issue record;
begin
  select * into v_p from public.participants where id=p_participant_id for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;
  select * into v_e from public.events where id=v_p.event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if v_actor is not null and v_actor is distinct from v_p.user_id
    and not public.user_can_access_organization(v_actor,v_e.organization_id) then
    raise exception 'Usuario sem acesso ao participante.';
  end if;

  create temporary table if not exists pg_temp.expected_import_issues(
    field_code text,issue_type text,message text,blocks_payment boolean,
    blocks_ticket_issuance boolean,blocks_checkin boolean,blocks_kit_delivery boolean,
    primary key(field_code,issue_type)
  ) on commit drop;
  truncate pg_temp.expected_import_issues;

  if nullif(trim(coalesce(v_p.cpf,'')),'') is null then
    insert into pg_temp.expected_import_issues values('cpf','missing_required_identity','CPF obrigatorio ausente.',false,true,false,false);
  elsif not public.is_valid_cpf(v_p.cpf) then
    insert into pg_temp.expected_import_issues values('cpf','invalid_identity','CPF invalido.',false,true,false,false);
  end if;

  if nullif(trim(coalesce(v_p.email,'')),'') is not null
    and v_p.email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    insert into pg_temp.expected_import_issues values('email','invalid_format','E-mail informado e invalido.',false,false,false,false);
  end if;
  if nullif(regexp_replace(coalesce(v_p.phone,''),'\D','','g'),'') is not null
    and length(regexp_replace(v_p.phone,'\D','','g')) not in(10,11) then
    insert into pg_temp.expected_import_issues values('phone','invalid_format','Telefone informado e invalido.',false,false,false,false);
  end if;

  if v_p.birth_date is null then
    insert into pg_temp.expected_import_issues values('birth_date','missing_required_age','Data de nascimento obrigatoria ausente.',false,true,false,false);
  elsif v_e.starts_at is null then
    insert into pg_temp.expected_import_issues values('event_date','missing_required_for_age','Evento sem data de inicio para validar maioridade.',false,true,false,false);
  elsif v_p.birth_date>v_e.starts_at::date then
    insert into pg_temp.expected_import_issues values('birth_date','invalid_date','Nascimento posterior a data do evento.',false,true,false,false);
  else
    v_age:=extract(year from age(v_e.starts_at::date,v_p.birth_date));
    if v_age<18 then
      insert into pg_temp.expected_import_issues values('birth_date','underage_at_event','Pessoa menor de 18 anos na data do evento.',false,true,false,false);
    end if;
  end if;

  if v_p.batch_id is null or not exists(select 1 from public.registration_batches rb where rb.id=v_p.batch_id and rb.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('batch','unresolved','Lote nao resolvido de forma deterministica.',true,true,false,false);
  end if;
  if v_p.ticket_category_id is null or not exists(select 1 from public.ticket_categories tc where tc.id=v_p.ticket_category_id and tc.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('category','unresolved','Categoria nao resolvida de forma deterministica.',true,true,false,false);
  end if;

  if v_p.batch_id is not null and v_p.ticket_category_id is not null then
    select * into v_price from public.registration_batch_prices
    where batch_id=v_p.batch_id and ticket_category_id=v_p.ticket_category_id;
    if not found then
      insert into pg_temp.expected_import_issues values('price','unresolved','Preco nao encontrado para lote e categoria.',true,true,false,false);
    end if;
  end if;

  v_gender:=lower(trim(coalesce(v_p.gender,'')));
  if v_price.id is not null and v_price.male_price is distinct from v_price.female_price
    and v_gender not in('masculino','male','m','feminino','female','f') then
    insert into pg_temp.expected_import_issues values('gender','missing_required_for_pricing','Informe o genero para calcular o valor.',true,true,false,false);
  end if;

  if coalesce(v_e.limit_shirt_selection_to_stock,false)
    and exists(select 1 from public.event_kit_items where event_id=v_e.id and item_type='shirt' and is_active=true)
    and (nullif(trim(v_p.shirt_type),'') is null or nullif(trim(v_p.shirt_size),'') is null) then
    insert into pg_temp.expected_import_issues values('shirt_selection','missing_required_for_inventory','Modelo e tamanho da camiseta pendentes para o kit.',false,false,false,true);
  end if;

  update public.participant_data_issues i set status='resolved',resolved_at=now(),resolved_by=v_actor,updated_at=now()
  where i.participant_id=v_p.id and i.status='open'
    and i.field_code in('cpf','email','phone','birth_date','event_date','batch','category','price','gender','shirt_selection')
    and not exists(select 1 from pg_temp.expected_import_issues e where e.field_code=i.field_code and e.issue_type=i.issue_type);

  for v_issue in select * from pg_temp.expected_import_issues loop
    insert into public.participant_data_issues(organization_id,event_id,participant_id,import_batch_id,
      field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery)
    values(v_e.organization_id,v_e.id,v_p.id,p_import_batch_id,v_issue.field_code,v_issue.issue_type,
      v_issue.message,v_issue.blocks_payment,v_issue.blocks_ticket_issuance,v_issue.blocks_checkin,v_issue.blocks_kit_delivery)
    on conflict do nothing;
  end loop;

  if v_price.id is not null then
    v_base:=case when v_gender in('feminino','female','f') then v_price.female_price
      when v_gender in('masculino','male','m') then v_price.male_price
      when v_price.male_price=v_price.female_price then v_price.male_price end;
    if v_base is not null then
      update public.payments set amount=round(v_base,2),discount_amount=0,final_amount=round(v_base,2),updated_at=now()
      where participant_id=v_p.id and payment_status<>'paid';
      if not exists(select 1 from public.payments where participant_id=v_p.id and event_id=v_p.event_id) then
        insert into public.payments(participant_id,event_id,amount,discount_amount,final_amount,payment_method,payment_status)
        values(v_p.id,v_p.event_id,round(v_base,2),0,round(v_base,2),'pix','pending');
      end if;
    end if;
  end if;

  select count(*) into v_open from public.participant_data_issues where participant_id=v_p.id and status='open';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('participant_data_issues_reevaluated','participants',v_p.id,v_e.id,
    jsonb_build_object('actor_user_id',v_actor,'import_batch_id',p_import_batch_id,'open_issue_count',v_open,'source',case when p_import_batch_id is null then 'edit' else 'import' end));
  return jsonb_build_object('participant_id',v_p.id,'open_issue_count',v_open,'price_defined',v_base is not null);
end; $_$;


ALTER FUNCTION "public"."reevaluate_participant_data_issues"("p_participant_id" "uuid", "p_import_batch_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."registration_contact_has_active_ticket"("p_event_id" "uuid", "p_registration_contact_id" "uuid", "p_exclude_ticket_id" "uuid" DEFAULT NULL::"uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists(
    select 1 from public.tickets t
    left join public.order_items oi on oi.id=t.order_item_id
    left join public.participants p on p.id=coalesce(oi.participant_id,t.participant_id)
    where t.event_id=p_event_id and t.id is distinct from p_exclude_ticket_id
      and t.status not in('cancelled','canceled','void','voided')
      and coalesce(oi.registration_contact_id,p.registration_contact_id)=p_registration_contact_id
  );
$$;


ALTER FUNCTION "public"."registration_contact_has_active_ticket"("p_event_id" "uuid", "p_registration_contact_id" "uuid", "p_exclude_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_expired_reservations"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant public.participants%rowtype;
  v_inventory public.shirt_inventory%rowtype;
  v_payment public.payments%rowtype;
  v_released_count integer := 0;
begin
  for v_participant in
    select *
    from public.participants
    where reservation_status = 'pending'
      and reservation_expires_at is not null
      and reservation_expires_at <= now()
    for update skip locked
  loop
    select * into v_payment
    from public.payments pay
    where pay.participant_id = v_participant.id
    order by pay.created_at desc
    limit 1
    for update;

    if not found then
      continue;
    end if;

    if v_payment.payment_status <> 'pending' then
      continue;
    end if;

    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if found and v_inventory.reserved_quantity > 0 then
      update public.shirt_inventory
      set reserved_quantity = reserved_quantity - 1,
          updated_at = now()
      where id = v_inventory.id
        and reserved_quantity > 0;

      insert into public.inventory_movements (
        event_id,
        inventory_id,
        movement_type,
        quantity,
        notes
      ) values (
        v_participant.event_id,
        v_inventory.id,
        'adjustment',
        1,
        format('Reserva expirada para participante %s.', v_participant.full_name)
      );
    end if;

    update public.payments
    set payment_status = 'expired',
        expires_at = null
    where id = v_payment.id;

    update public.participants
    set registration_status = 'cancelled',
        reservation_status = 'expired',
        reservation_released_at = now(),
        reservation_expires_at = null,
        updated_at = now()
    where id = v_participant.id
      and reservation_status = 'pending';

    if found then
      v_released_count := v_released_count + 1;

      insert into public.audit_logs (
        action,
        entity_type,
        entity_id,
        details,
        event_id
      ) values (
        'reservation_expired_released',
        'participants',
        v_participant.id,
        jsonb_build_object(
          'shirt_type', v_participant.shirt_type,
          'shirt_size', v_participant.shirt_size,
          'reservation_expires_at', v_participant.reservation_expires_at,
          'payment_id', v_payment.id
        ),
        v_participant.event_id
      );
    end if;
  end loop;

  return v_released_count;
end;
$$;


ALTER FUNCTION "public"."release_expired_reservations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_event_highlight"("p_event_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  delete from public.event_highlights
  where event_id = p_event_id;
end;
$$;


ALTER FUNCTION "public"."remove_event_highlight"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_category public.financial_categories%rowtype; v_result text;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_categories') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_category_id is null or nullif(trim(p_reason),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Categoria, motivo e referencia sao obrigatorios.'; end if;
  if exists(select 1 from public.audit_logs where action='financial_category_removed' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key)) then return 'already_processed'; end if;
  select * into v_category from public.financial_categories where id=p_category_id and organization_id=p_organization_id for update;
  if not found then return 'already_absent'; end if;
  if exists(select 1 from public.financial_entries where category_id=p_category_id and organization_id=p_organization_id) then update public.financial_categories set is_active=false,updated_at=now() where id=p_category_id; v_result:='deactivated';
  else delete from public.financial_categories where id=p_category_id and organization_id=p_organization_id; v_result:='deleted'; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_category_removed','financial_categories',p_category_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'result',v_result,'reason',trim(p_reason),'idempotency_key',trim(p_idempotency_key)));
  return v_result;
end $$;


ALTER FUNCTION "public"."remove_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_supplier public.financial_suppliers%rowtype; v_result text;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_suppliers') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_supplier_id is null or nullif(trim(p_reason),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Fornecedor, motivo e referencia sao obrigatorios.'; end if;
  if exists(select 1 from public.audit_logs where action='financial_supplier_removed' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key)) then return 'already_processed'; end if;
  select * into v_supplier from public.financial_suppliers where id=p_supplier_id and organization_id=p_organization_id for update;
  if not found then return 'already_absent'; end if;
  if exists(select 1 from public.financial_entries where supplier_id=p_supplier_id and organization_id=p_organization_id) then update public.financial_suppliers set is_active=false,updated_at=now() where id=p_supplier_id; v_result:='deactivated';
  else delete from public.financial_suppliers where id=p_supplier_id and organization_id=p_organization_id; v_result:='deleted'; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_supplier_removed','financial_suppliers',p_supplier_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'result',v_result,'reason',trim(p_reason),'idempotency_key',trim(p_idempotency_key)));
  return v_result;
end $$;


ALTER FUNCTION "public"."remove_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_wristband_for_ticket"("p_ticket_id" "uuid", "p_new_code" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_old        public.participant_wristbands%rowtype;
  v_new_result jsonb;
  v_new_id     uuid;
  v_ticket_org uuid;
begin
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.replace')
  ) then
    raise exception 'Sem permissao para substituir pulseira.';
  end if;

  -- Verifica org access via ticket antes de qualquer operação
  select t.organization_id into v_ticket_org
  from public.tickets t where t.id = p_ticket_id;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;
  if not public.user_can_access_organization(auth.uid(), v_ticket_org) then
    raise exception 'Sem permissao para substituir pulseira nesta organização.';
  end if;

  select pw.* into v_old
  from public.participant_wristbands pw
  where pw.ticket_id = p_ticket_id and pw.status = 'active'
  limit 1 for update;

  if found then
    update public.participant_wristbands pw
    set status      = 'replaced',
        unlinked_at = now(),
        unlinked_by = auth.uid(),
        notes       = nullif(trim(coalesce(p_reason, '')), ''),
        updated_at  = now()
    where pw.id = v_old.id;
  end if;

  v_new_result := public.link_wristband_to_ticket(p_ticket_id, p_new_code);
  v_new_id := nullif(v_new_result ->> 'wristband_id', '')::uuid;

  if v_old.id is not null and v_new_id is not null then
    update public.participant_wristbands
    set replaced_by_wristband_id = v_new_id, updated_at = now()
    where id = v_old.id;
  end if;

  return v_new_result || jsonb_build_object('replaced_wristband_id', v_old.id);
end;
$$;


ALTER FUNCTION "public"."replace_wristband_for_ticket"("p_ticket_id" "uuid", "p_new_code" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_ticket_item_change"("p_ticket_id" "uuid", "p_kit_item_id" "uuid", "p_requested_variant_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_event public.events%rowtype;
  v_item public.event_kit_items%rowtype; v_link public.participant_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_current uuid; v_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled';
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_ticket.owner_user_id is distinct from v_actor then raise exception 'Somente o proprietario atual pode solicitar alteracao de item.'; end if;
  select * into v_event from public.events where id=v_ticket.event_id;
  select * into v_item from public.event_kit_items where id=p_kit_item_id and event_id=v_ticket.event_id and is_active;
  if not found then raise exception 'Item invalido para o ingresso.'; end if;
  if not v_item.requires_variant then raise exception 'Item de opcao unica nao possui variante alteravel.'; end if;
  if not v_event.allow_participant_item_changes or not v_item.allow_participant_change then raise exception 'Alteracao desabilitada para este item.'; end if;
  if v_item.item_type='shirt' and v_event.shirt_order_deadline is not null and now()>v_event.shirt_order_deadline then raise exception 'Prazo para solicitar alteracao encerrado.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id;
  if not found then raise exception 'Item ainda nao materializado para este ingresso.'; end if;
  select * into v_variant from public.event_kit_item_variants where id=p_requested_variant_id and kit_item_id=p_kit_item_id and is_active;
  if not found then raise exception 'Variante invalida para o item.'; end if;
  v_current:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  if v_current is null and v_item.item_type='shirt' then
    select id into v_current from public.event_kit_item_variants where kit_item_id=p_kit_item_id and is_active
      and value=coalesce(v_link.variant_data->>'shirt_size',(select shirt_size from public.order_items where id=v_ticket.order_item_id)) limit 1;
  end if;
  if v_current=p_requested_variant_id then raise exception 'A variante solicitada e igual a atual.'; end if;
  insert into public.ticket_item_change_requests(ticket_id,kit_item_id,participant_kit_item_id,organization_id,event_id,
    current_variant_id,requested_variant_id,current_variant,requested_variant,requested_by,reason)
  values(p_ticket_id,p_kit_item_id,v_link.id,v_ticket.organization_id,v_ticket.event_id,v_current,p_requested_variant_id,
    v_link.variant_data,jsonb_build_object('id',v_variant.id,'name',v_variant.name,'value',v_variant.value),v_actor,nullif(trim(coalesce(p_reason,'')),'')) returning id into v_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_item_change_requested','tickets',p_ticket_id,v_ticket.event_id,
    jsonb_build_object('request_id',v_id,'kit_item_id',p_kit_item_id,'current_variant_id',v_current,'requested_variant_id',p_requested_variant_id,'actor_user_id',v_actor));
  return v_id;
end; $$;


ALTER FUNCTION "public"."request_ticket_item_change"("p_ticket_id" "uuid", "p_kit_item_id" "uuid", "p_requested_variant_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reset_event_shirt_inventory"("p_event_id" "uuid", "p_clear_history" boolean, "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event public.events%rowtype;
  v_actor text := coalesce((select email from auth.users where id = auth.uid()), auth.role(), 'system');
  v_before_snapshot jsonb := '[]'::jsonb;
  v_inventory_rows integer := 0;
  v_movements_before integer := 0;
  v_movements_deleted integer := 0;
  v_active_reservations integer := 0;
  v_delivered_kits integer := 0;
  v_confirmed_tickets integer := 0;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_mode text := case when coalesce(p_clear_history, false) then 'full' else 'simple' end;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(p_clear_history, false) then
    if not public.current_user_has_permission('inventory.clear_history'::text) then
      raise exception 'Sem permissao para limpar historico de estoque.';
    end if;
  else
    if not public.current_user_has_permission('inventory.reset'::text) then
      raise exception 'Sem permissao para zerar estoque.';
    end if;
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  perform 1
  from public.shirt_inventory si
  where si.event_id = p_event_id
  for update;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', si.id,
          'shirt_type', si.shirt_type,
          'shirt_size', si.shirt_size,
          'total_quantity', si.total_quantity,
          'reserved_quantity', si.reserved_quantity,
          'delivered_quantity', si.delivered_quantity
        )
        order by si.shirt_type, si.shirt_size
      ),
      '[]'::jsonb
    ),
    count(*)::integer
  into v_before_snapshot, v_inventory_rows
  from public.shirt_inventory si
  where si.event_id = p_event_id;

  select count(*)::integer
  into v_movements_before
  from public.inventory_movements im
  where im.event_id = p_event_id;

  select count(*)::integer
  into v_active_reservations
  from public.order_items oi
  where oi.event_id = p_event_id
    and oi.status = 'reserved';

  select count(*)::integer
  into v_delivered_kits
  from public.participant_kit_items pki
  where pki.event_id = p_event_id
    and pki.status = 'delivered';

  select count(*)::integer
  into v_confirmed_tickets
  from public.tickets t
  where t.event_id = p_event_id
    and t.status in ('active', 'used');

  if coalesce(p_clear_history, false) and (v_delivered_kits > 0 or v_confirmed_tickets > 0) then
    raise exception 'Limpeza de historico bloqueada: existem entregas reais ou tickets confirmados neste evento. Use a zeragem simples.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = 0,
    reserved_quantity = 0,
    delivered_quantity = 0,
    updated_at = now()
  where event_id = p_event_id;

  if coalesce(p_clear_history, false) then
    delete from public.inventory_movements
    where event_id = p_event_id;

    get diagnostics v_movements_deleted = row_count;
  end if;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_event_reset',
    'events',
    p_event_id,
    p_event_id,
    jsonb_build_object(
      'mode', v_mode,
      'reason', coalesce(v_reason, 'sem motivo informado'),
      'inventory_rows', v_inventory_rows,
      'movements_before', v_movements_before,
      'movements_deleted', v_movements_deleted,
      'active_reservations', v_active_reservations,
      'delivered_kits', v_delivered_kits,
      'confirmed_tickets', v_confirmed_tickets,
      'before_snapshot', v_before_snapshot,
      'cleared_history', coalesce(p_clear_history, false)
    )
  );

  return jsonb_build_object(
    'event_id', p_event_id,
    'mode', v_mode,
    'inventory_rows', v_inventory_rows,
    'movements_before', v_movements_before,
    'movements_deleted', v_movements_deleted,
    'active_reservations', v_active_reservations,
    'delivered_kits', v_delivered_kits,
    'confirmed_tickets', v_confirmed_tickets
  );
end;
$$;


ALTER FUNCTION "public"."reset_event_shirt_inventory"("p_event_id" "uuid", "p_clear_history" boolean, "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_administrative_ticket_owner"("p_organization_id" "uuid", "p_registration_contact_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."resolve_administrative_ticket_owner"("p_organization_id" "uuid", "p_registration_contact_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_participant_data_issues"("p_participant_id" "uuid", "p_expected_issue_ids" "uuid"[], "p_values" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_participant public.participants%rowtype;
  v_organization_id uuid;
  v_current_issue_ids uuid[];
  v_allowed_fields text[];
  v_requested_field text;
  v_previous_values jsonb := '{}'::jsonb;
  v_new_values jsonb := '{}'::jsonb;
  v_reevaluation jsonb;
  v_remaining jsonb;
  v_payment_status text;
  v_payment_amount numeric;
  v_payment_final_amount numeric;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  perform 1;

  select p.* into v_participant
  from public.participants p
  where p.id = p_participant_id
  for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;

  select e.organization_id into v_organization_id
  from public.events e where e.id = v_participant.event_id;
  if v_organization_id is null or not (
      v_participant.user_id=v_actor
      or (public.user_can_access_organization(v_actor,v_organization_id)
        and (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'participants.edit_basic')))
    ) then raise exception 'Usuario sem acesso ao cadastro.'; end if;

  perform 1
  from public.participant_data_issues i
  where i.participant_id = p_participant_id
  for update;

  select coalesce(array_agg(i.id order by i.id), array[]::uuid[]),
         coalesce(array_agg(distinct i.field_code), array[]::text[])
  into v_current_issue_ids, v_allowed_fields
  from public.participant_data_issues i
  where i.participant_id = p_participant_id and i.status = 'open';

  if v_current_issue_ids is distinct from (
    select coalesce(array_agg(x order by x), array[]::uuid[])
    from unnest(coalesce(p_expected_issue_ids, array[]::uuid[])) x
  ) then
    return jsonb_build_object(
      'success', false,
      'conflict', true,
      'message', 'As pendencias foram atualizadas por outro usuario. Recarregue e tente novamente.'
    );
  end if;

  if coalesce(array_length(v_current_issue_ids, 1), 0) = 0 then
    return jsonb_build_object(
      'success', false,
      'conflict', true,
      'message', 'As pendencias foram atualizadas por outro usuario. Recarregue e tente novamente.'
    );
  end if;

  for v_requested_field in
    select jsonb_object_keys(coalesce(p_values, '{}'::jsonb))
  loop
    if v_requested_field not in (
      'gender', 'birth_date', 'cpf', 'shirt_type', 'shirt_size', 'city', 'phone', 'email'
    ) then
      raise exception 'Campo nao permitido: %.', v_requested_field;
    end if;
    if not (
      v_requested_field = any(v_allowed_fields)
      or (
        v_requested_field in ('shirt_type', 'shirt_size')
        and 'shirt_selection' = any(v_allowed_fields)
      )
    ) then
      raise exception 'Campo % nao corresponde a uma pendencia aberta.', v_requested_field;
    end if;
  end loop;

  if p_values ? 'gender'
    and lower(trim(p_values ->> 'gender')) not in ('male', 'female') then
    raise exception 'Genero invalido.';
  end if;

  v_previous_values := jsonb_strip_nulls(jsonb_build_object(
    'gender', case when p_values ? 'gender' then v_participant.gender end,
    'birth_date', case when p_values ? 'birth_date' then v_participant.birth_date end,
    'cpf', case when p_values ? 'cpf' then v_participant.cpf end,
    'shirt_type', case when p_values ? 'shirt_type' then v_participant.shirt_type end,
    'shirt_size', case when p_values ? 'shirt_size' then v_participant.shirt_size end,
    'city', case when p_values ? 'city' then v_participant.city end,
    'phone', case when p_values ? 'phone' then v_participant.phone end,
    'email', case when p_values ? 'email' then v_participant.email end
  ));

  update public.participants p
  set gender = case when p_values ? 'gender' then nullif(trim(p_values ->> 'gender'), '') else p.gender end,
      birth_date = case when p_values ? 'birth_date' then nullif(trim(p_values ->> 'birth_date'), '')::date else p.birth_date end,
      cpf = case when p_values ? 'cpf' then nullif(regexp_replace(p_values ->> 'cpf', '\D', '', 'g'), '') else p.cpf end,
      shirt_type = case when p_values ? 'shirt_type' then nullif(trim(p_values ->> 'shirt_type'), '') else p.shirt_type end,
      shirt_size = case when p_values ? 'shirt_size' then nullif(upper(trim(p_values ->> 'shirt_size')), '') else p.shirt_size end,
      city = case when p_values ? 'city' then nullif(trim(p_values ->> 'city'), '') else p.city end,
      phone = case when p_values ? 'phone' then nullif(regexp_replace(p_values ->> 'phone', '\D', '', 'g'), '') else p.phone end,
      email = case when p_values ? 'email' then lower(nullif(trim(p_values ->> 'email'), '')) else p.email end,
      updated_at = now()
  where p.id = p_participant_id
  returning jsonb_strip_nulls(jsonb_build_object(
    'gender', case when p_values ? 'gender' then p.gender end,
    'birth_date', case when p_values ? 'birth_date' then p.birth_date end,
    'cpf', case when p_values ? 'cpf' then p.cpf end,
    'shirt_type', case when p_values ? 'shirt_type' then p.shirt_type end,
    'shirt_size', case when p_values ? 'shirt_size' then p.shirt_size end,
    'city', case when p_values ? 'city' then p.city end,
    'phone', case when p_values ? 'phone' then p.phone end,
    'email', case when p_values ? 'email' then p.email end
  )) into v_new_values;

  v_reevaluation := public.reevaluate_participant_data_issues(p_participant_id, null);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'field_code', i.field_code,
    'issue_type', i.issue_type,
    'message', i.message,
    'blocks_payment', i.blocks_payment,
    'blocks_ticket_issuance', i.blocks_ticket_issuance,
    'blocks_checkin', i.blocks_checkin,
    'blocks_kit_delivery', i.blocks_kit_delivery
  ) order by i.created_at), '[]'::jsonb)
  into v_remaining
  from public.participant_data_issues i
  where i.participant_id = p_participant_id and i.status = 'open';

  select pay.payment_status, pay.amount, pay.final_amount
  into v_payment_status, v_payment_amount, v_payment_final_amount
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1;

  select lower(au.email) into v_actor_email
  from auth.users au
  where au.id = v_actor;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('participant_data_issues_resolved', 'participants', p_participant_id, v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'actor_email', v_actor_email,
      'organization_id', v_organization_id,
      'event_id', v_participant.event_id,
      'participant_id', p_participant_id,
      'issue_ids', p_expected_issue_ids,
      'fields_updated', (
        select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_values) k
      ),
      'previous_values', v_previous_values,
      'new_values', v_new_values,
      'remaining_issues', v_remaining,
      'source', 'participant_issue_resolution'
    ));

  return jsonb_build_object(
    'success', true,
    'message', case when jsonb_array_length(v_remaining) = 0
      then 'Dados atualizados. Valor recalculado. Pagamento permanece pendente.'
      else 'Dados atualizados. Ainda existem pendencias.' end,
    'base_amount', v_payment_amount,
    'final_amount', v_payment_final_amount,
    'payment_status', coalesce(v_payment_status, 'pending'),
    'remaining_issues', v_remaining,
    'reevaluation', v_reevaluation
  );
end;
$$;


ALTER FUNCTION "public"."resolve_participant_data_issues"("p_participant_id" "uuid", "p_expected_issue_ids" "uuid"[], "p_values" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_unique_ticket_for_participant"("p_participant_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ids uuid[];
begin
  select array_agg(id order by id) into v_ids from public.tickets where participant_id=p_participant_id and status<>'cancelled';
  if cardinality(v_ids)=1 then return v_ids[1]; end if;
  if coalesce(cardinality(v_ids),0)=0 then raise exception 'Nenhum ingresso encontrado para o participante.'; end if;
  raise exception 'Mais de um ingresso encontrado para o participante; informe ticket_id.';
end;
$$;


ALTER FUNCTION "public"."resolve_unique_ticket_for_participant"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_user_permission"("p_user_id" "uuid", "p_permission_code" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_role_id uuid;
  v_is_active boolean := false;
  v_is_owner boolean := false;
  v_permission_id uuid;
  v_has_deny boolean := false;
  v_has_allow boolean := false;
  v_has_role_permission boolean := false;
begin
  if p_user_id is null then
    return false;
  end if;

  if p_permission_code is null or btrim(p_permission_code) = '' then
    return false;
  end if;

  select au.role_id, au.is_active
    into v_role_id, v_is_active
  from public.admin_users au
  where au.user_id = p_user_id;

  if not coalesce(v_is_active, false) then
    return false;
  end if;

  select exists (
    select 1
    from public.admin_roles ar
    where ar.id = v_role_id
      and ar.is_active = true
      and ar.code = 'owner'
  ) into v_is_owner;

  if v_is_owner then
    return true;
  end if;

  select ap.id
    into v_permission_id
  from public.admin_permissions ap
  where ap.code = p_permission_code
    and ap.is_active = true
  limit 1;

  if v_permission_id is null then
    return false;
  end if;

  select exists (
    select 1
    from public.admin_user_permission_overrides uo
    where uo.user_id = p_user_id
      and uo.permission_id = v_permission_id
      and uo.effect = 'deny'
  ) into v_has_deny;

  if v_has_deny then
    return false;
  end if;

  select exists (
    select 1
    from public.admin_user_permission_overrides uo
    where uo.user_id = p_user_id
      and uo.permission_id = v_permission_id
      and uo.effect = 'allow'
  ) into v_has_allow;

  if v_has_allow then
    return true;
  end if;

  select exists (
    select 1
    from public.admin_role_permissions arp
    join public.admin_roles ar on ar.id = arp.role_id and ar.is_active = true
    where arp.role_id = v_role_id
      and arp.permission_id = v_permission_id
  ) into v_has_role_permission;

  return v_has_role_permission;
end;
$$;


ALTER FUNCTION "public"."resolve_user_permission"("p_user_id" "uuid", "p_permission_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."restore_event"("p_event_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.archive') then raise exception 'Permissao insuficiente para restaurar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is null then return true; end if;
  update public.events set is_active=false,registration_enabled=false,archived_at=null,archived_by=null,updated_at=now() where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_restored','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('is_active',false,'registration_enabled',false,'archived_at',v_event.archived_at),
      'new_state',jsonb_build_object('is_active',false,'registration_enabled',false,'archived_at',null)));
  return true;
end; $$;


ALTER FUNCTION "public"."restore_event"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reverse_financial_entry"("p_entry_id" "uuid", "p_amount" numeric, "p_reason" "text", "p_idempotency_key" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_entry public.financial_entries%rowtype; v_reversal uuid; v_reversed numeric; v_line record; v_line_amount numeric; v_debit_remaining numeric:=p_amount; v_credit_remaining numeric:=p_amount;
begin
  select * into v_entry from public.financial_entries where id=p_entry_id for update;
  if not found then raise exception 'Lancamento nao encontrado.'; end if;
  if v_actor is null or not (public.current_user_has_permission('finance.refund') or public.current_user_has_permission('finance.approve_refund')) or not public.user_can_access_organization(v_actor,v_entry.organization_id) then raise exception 'Acesso a estorno negado.'; end if;
  select reversal_entry_id into v_reversal from public.financial_reversals where organization_id=v_entry.organization_id and idempotency_key=trim(p_idempotency_key); if v_reversal is not null then return v_reversal; end if;
  if p_amount<=0 or nullif(trim(p_reason),'') is null or v_entry.lifecycle_status in('draft','cancelled','reversed') then raise exception 'Estorno invalido.'; end if;
  select coalesce(sum(amount),0) into v_reversed from public.financial_reversals where original_entry_id=p_entry_id;
  if v_reversed+p_amount>v_entry.amount then raise exception 'Estorno excede o saldo do lancamento.'; end if;
  insert into public.financial_entries(organization_id,entry_kind,lifecycle_status,description,original_entry_id,amount,occurred_on,posted_at,settled_at,idempotency_key,created_by) values(v_entry.organization_id,'reversal','settled','Estorno: '||v_entry.description,p_entry_id,p_amount,current_date,now(),now(),'reversal:'||trim(p_idempotency_key),v_actor) returning id into v_reversal;
  for v_line in select l.*,row_number() over(partition by line_side order by id) line_number,count(*) over(partition by line_side) line_count from public.financial_entry_lines l where entry_id=p_entry_id order by line_side,id loop
    v_line_amount:=case
      when v_line.line_side='debit' and v_line.line_number=v_line.line_count then v_debit_remaining
      when v_line.line_side='credit' and v_line.line_number=v_line.line_count then v_credit_remaining
      else round(v_line.amount*p_amount/v_entry.amount,2)
    end;
    if v_line_amount<=0 then raise exception 'Estorno parcial pequeno demais para o rateio contabil.'; end if;
    insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo) values(v_reversal,v_entry.organization_id,v_line.account_id,case v_line.line_side when 'debit' then 'credit' else 'debit' end,v_line_amount,'Estorno proporcional');
    if v_line.line_side='debit' then v_debit_remaining:=v_debit_remaining-v_line_amount; else v_credit_remaining:=v_credit_remaining-v_line_amount; end if;
  end loop;
  if v_debit_remaining<>0 or v_credit_remaining<>0 then raise exception 'Rateio contabil do estorno produziu arredondamento nao balanceado.'; end if;
  insert into public.financial_reversals(organization_id,original_entry_id,reversal_entry_id,amount,reason,idempotency_key,reversed_by) values(v_entry.organization_id,p_entry_id,v_reversal,p_amount,trim(p_reason),trim(p_idempotency_key),v_actor);
  update public.financial_entries set lifecycle_status=case when v_reversed+p_amount=v_entry.amount then 'reversed' else 'partially_reversed' end,updated_at=now() where id=p_entry_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_entry_reversed','financial_entries',p_entry_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_entry.organization_id,'reversal_entry_id',v_reversal,'amount',p_amount,'reason',trim(p_reason),'idempotency_key',trim(p_idempotency_key)));
  return v_reversal;
end $$;


ALTER FUNCTION "public"."reverse_financial_entry"("p_entry_id" "uuid", "p_amount" numeric, "p_reason" "text", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."review_ticket_item_change_request"("p_request_id" "uuid", "p_decision" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_req public.ticket_item_change_requests%rowtype; v_item public.event_kit_items%rowtype;
  v_link public.participant_kit_items%rowtype; v_variant public.event_kit_item_variants%rowtype; v_event public.events%rowtype;
  v_old_inv public.event_kit_item_variant_inventory%rowtype; v_new_inv public.event_kit_item_variant_inventory%rowtype;
  v_decision text:=lower(trim(p_decision)); v_qty integer; v_delivered boolean; v_shirt_type text;
begin
  if v_actor is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para revisar solicitacao.'; end if;
  if v_decision not in('approved','rejected') then raise exception 'Decisao invalida.'; end if;
  select * into v_req from public.ticket_item_change_requests where id=p_request_id for update;
  if not found or v_req.status<>'pending' then raise exception 'Solicitacao inexistente ou ja revisada.'; end if;
  if not public.user_can_access_organization(v_actor,v_req.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_decision='approved' then
    select * into v_event from public.events where id=v_req.event_id;
    select * into v_item from public.event_kit_items where id=v_req.kit_item_id and event_id=v_req.event_id and is_active for update;
    if not found or not v_event.allow_participant_item_changes or not v_item.allow_participant_change or not v_item.requires_variant then raise exception 'Alteracao nao esta mais habilitada para o item.'; end if;
    select * into v_variant from public.event_kit_item_variants where id=v_req.requested_variant_id and kit_item_id=v_req.kit_item_id and is_active;
    if not found then raise exception 'Variante solicitada nao esta mais disponivel.'; end if;
    select * into v_link from public.participant_kit_items where id=v_req.participant_kit_item_id and ticket_id=v_req.ticket_id and kit_item_id=v_req.kit_item_id for update;
    if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
    v_qty:=greatest(v_link.quantity,1); v_delivered:=v_link.status='delivered';
    if v_item.item_type='shirt' then
      select shirt_type into v_shirt_type from public.order_items where id=(select order_item_id from public.tickets where id=v_req.ticket_id);
      perform public.change_ticket_shirt(v_req.ticket_id,v_shirt_type,v_variant.value);
      update public.participant_kit_items set variant_data=coalesce(variant_data,'{}'::jsonb)||jsonb_build_object('variant_id',v_variant.id,'variant_name',v_variant.name,'variant_value',v_variant.value) where id=v_link.id;
    else
      if v_item.track_variant_inventory then
        select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_req.kit_item_id and variant_id=v_req.current_variant_id for update;
        select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_req.kit_item_id and variant_id=v_req.requested_variant_id for update;
        if v_new_inv.id is null then raise exception 'Estoque nao configurado para a variante.'; end if;
        if v_new_inv.total_quantity-v_new_inv.reserved_quantity-v_new_inv.delivered_quantity<v_qty then raise exception 'Variante sem saldo disponivel.'; end if;
        if v_old_inv.id is not null then
          if v_delivered then update public.event_kit_item_variant_inventory set delivered_quantity=greatest(delivered_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id;
          else update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
        end if;
        if v_delivered then update public.event_kit_item_variant_inventory set delivered_quantity=delivered_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
        else update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id; end if;
      end if;
      update public.participant_kit_items set variant_data=jsonb_build_object('variant_id',v_variant.id,'variant_name',v_variant.name,'variant_value',v_variant.value) where id=v_link.id;
    end if;
  end if;
  update public.ticket_item_change_requests set status=v_decision,reviewed_by=v_actor,reviewed_at=now(),review_notes=nullif(trim(coalesce(p_notes,'')),''),updated_at=now() where id=p_request_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_item_change_'||v_decision,'tickets',v_req.ticket_id,v_req.event_id,
    jsonb_build_object('request_id',v_req.id,'kit_item_id',v_req.kit_item_id,'current_variant_id',v_req.current_variant_id,'requested_variant_id',v_req.requested_variant_id,'actor_user_id',v_actor));
  return true;
end; $$;


ALTER FUNCTION "public"."review_ticket_item_change_request"("p_request_id" "uuid", "p_decision" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_admin_ticket_holder_candidates"("p_ticket_id" "uuid", "p_term" "text") RETURNS TABLE("participant_id" "uuid", "full_name" "text", "masked_email" "text", "masked_cpf" "text", "pin_match" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_term text:=trim(coalesce(p_term,'')); v_digits text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao para buscar titulares.'; end if;
  if length(v_term)<3 then raise exception 'Informe ao menos 3 caracteres para buscar.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  v_digits:=regexp_replace(v_term,'\D','','g');
  return query select p.id,p.full_name,
    case when position('@' in coalesce(p.email,''))>1 then left(p.email,2)||'***@'||split_part(p.email,'@',2) end,
    case when length(regexp_replace(coalesce(p.cpf,''),'\D','','g'))=11 then '***.***.***-'||right(regexp_replace(p.cpf,'\D','','g'),2) end,
    upper(coalesce(cp.public_pin,''))=upper(regexp_replace(v_term,'[^A-Za-z0-9]','','g'))
  from public.participants p left join public.customer_profiles cp on cp.user_id=p.user_id
  where p.organization_id=v_ticket.organization_id and p.event_id=v_ticket.event_id
    and (p.full_name ilike '%'||v_term||'%' or p.email ilike '%'||v_term||'%'
      or (length(v_digits)>=3 and regexp_replace(coalesce(p.cpf,''),'\D','','g') like '%'||v_digits||'%')
      or upper(coalesce(cp.public_pin,''))=upper(regexp_replace(v_term,'[^A-Za-z0-9]','','g')))
  order by p.full_name,p.id limit 20;
end; $$;


ALTER FUNCTION "public"."search_admin_ticket_holder_candidates"("p_ticket_id" "uuid", "p_term" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_admin_ticket_holder_contacts"("p_ticket_id" "uuid", "p_term" "text") RETURNS TABLE("registration_contact_id" "uuid", "full_name" "text", "masked_email" "text", "masked_cpf" "text", "has_account" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."search_admin_ticket_holder_contacts"("p_ticket_id" "uuid", "p_term" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_admin_ticket_owner_accounts"("p_ticket_id" "uuid", "p_term" "text") RETURNS TABLE("user_id" "uuid", "full_name" "text", "masked_email" "text", "registration_contact_id" "uuid", "registration_contact_count" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_term text:=trim(coalesce(p_term,''));
begin
  if v_actor is null or not public.current_user_has_permission('tickets.transfer_ownership') then raise exception 'Sem permissao para buscar proprietarios.'; end if;
  if length(v_term)<3 then raise exception 'Informe ao menos 3 caracteres para buscar.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  return query
  with organization_accounts as (
    select o.user_id from public.orders o where o.organization_id=v_ticket.organization_id and o.user_id is not null
    union
    select p.user_id from public.participants p where p.organization_id=v_ticket.organization_id and p.user_id is not null
  ), contacts as (
    select p.user_id,count(distinct p.registration_contact_id)::integer contact_count,
      case when count(distinct p.registration_contact_id)=1 then (array_agg(distinct p.registration_contact_id order by p.registration_contact_id))[1] end contact_id
    from public.participants p
    where p.organization_id=v_ticket.organization_id and p.user_id is not null and p.registration_contact_id is not null
    group by p.user_id
  )
  select au.id,coalesce(nullif(trim(cp.full_name),''),nullif(trim(au.raw_user_meta_data->>'full_name'),''),'Conta NEXORA'),
    case when position('@' in coalesce(au.email,''))>1 then left(au.email,2)||'***@'||split_part(au.email,'@',2) end,
    c.contact_id,coalesce(c.contact_count,0)
  from organization_accounts oa
  join auth.users au on au.id=oa.user_id
  left join public.customer_profiles cp on cp.user_id=au.id
  left join contacts c on c.user_id=au.id
  where au.id is distinct from v_ticket.owner_user_id
    and (coalesce(cp.full_name,au.raw_user_meta_data->>'full_name','') ilike '%'||v_term||'%' or coalesce(au.email,'') ilike '%'||v_term||'%')
  order by 2,au.id limit 20;
end; $$;


ALTER FUNCTION "public"."search_admin_ticket_owner_accounts"("p_ticket_id" "uuid", "p_term" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_active"("p_event_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.publish') then raise exception 'Permissao insuficiente para ativar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then raise exception 'Evento arquivado nao pode ser ativado.'; end if;
  if v_event.is_active then return true; end if;
  update public.events set is_active=true,updated_at=now() where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_activated','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('is_active',false),'new_state',jsonb_build_object('is_active',true)));
  return true;
end; $$;


ALTER FUNCTION "public"."set_event_active"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_inactive"("p_event_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.publish') then raise exception 'Permissao insuficiente para desativar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then raise exception 'Evento arquivado nao aceita alteracao operacional.'; end if;
  if not v_event.is_active then return true; end if;
  update public.events set is_active=false,updated_at=now() where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_deactivated','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('is_active',true),'new_state',jsonb_build_object('is_active',false)));
  return true;
end; $$;


ALTER FUNCTION "public"."set_event_inactive"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_kit_item_change_rules"("p_kit_item_id" "uuid", "p_allow_change" boolean, "p_track_inventory" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$ declare v_event uuid; v_org uuid; begin
  if auth.uid() is null or not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao para configurar o item.'; end if;
  select eki.event_id,e.organization_id into v_event,v_org from public.event_kit_items eki join public.events e on e.id=eki.event_id where eki.id=p_kit_item_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Item invalido ou sem acesso.'; end if;
  update public.event_kit_items set allow_participant_change=coalesce(p_allow_change,false),track_variant_inventory=coalesce(p_track_inventory,false),updated_at=now() where id=p_kit_item_id; return true;
end; $$;


ALTER FUNCTION "public"."set_event_kit_item_change_rules"("p_kit_item_id" "uuid", "p_allow_change" boolean, "p_track_inventory" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_kit_item_variant_stock"("p_variant_id" "uuid", "p_total_quantity" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_item uuid; v_event uuid; v_org uuid; v_delivered integer;
begin
  if auth.uid() is null or not public.current_user_has_permission('inventory.adjust') then raise exception 'Sem permissao para ajustar estoque.'; end if;
  if p_total_quantity<0 then raise exception 'Quantidade invalida.'; end if;
  select v.kit_item_id,eki.event_id,e.organization_id into v_item,v_event,v_org
  from public.event_kit_item_variants v join public.event_kit_items eki on eki.id=v.kit_item_id
  join public.events e on e.id=eki.event_id where v.id=p_variant_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Variante invalida ou sem acesso.'; end if;
  select delivered_quantity into v_delivered from public.event_kit_item_variant_inventory
    where kit_item_id=v_item and variant_id=p_variant_id for update;
  if coalesce(v_delivered,0)>p_total_quantity then raise exception 'Estoque fisico nao pode ser menor que a quantidade ja entregue.'; end if;
  insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
  values(v_org,v_event,v_item,p_variant_id,p_total_quantity)
  on conflict(kit_item_id,variant_id) do update set total_quantity=excluded.total_quantity,updated_at=now();
  return true;
end; $$;


ALTER FUNCTION "public"."set_event_kit_item_variant_stock"("p_variant_id" "uuid", "p_total_quantity" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_min_age"("p_event_id" "uuid", "p_min_age" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid := auth.uid(); v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.edit') then raise exception 'Permissao insuficiente para editar evento.'; end if;
  if coalesce(p_min_age, 0) < 0 then raise exception 'Idade minima invalida.'; end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  update public.events set min_age = coalesce(p_min_age, 18), updated_at = now() where id = p_event_id;
  return true;
end; $$;


ALTER FUNCTION "public"."set_event_min_age"("p_event_id" "uuid", "p_min_age" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_participant_item_changes"("p_event_id" "uuid", "p_enabled" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$ declare v_org uuid; begin
  if auth.uid() is null or not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao para configurar o evento.'; end if;
  select organization_id into v_org from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Evento invalido ou sem acesso.'; end if;
  update public.events set allow_participant_item_changes=coalesce(p_enabled,false),updated_at=now() where id=p_event_id; return true;
end; $$;


ALTER FUNCTION "public"."set_event_participant_item_changes"("p_event_id" "uuid", "p_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_registration_enabled"("p_event_id" "uuid", "p_enabled" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_enabled boolean:=coalesce(p_enabled,false);
begin
  if v_actor is null or not public.current_user_has_permission('events.publish') then raise exception 'Permissao insuficiente para alterar vendas.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then raise exception 'Evento arquivado nao pode abrir vendas.'; end if;
  if v_event.registration_enabled=v_enabled then return true; end if;
  update public.events set registration_enabled=v_enabled,updated_at=now() where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    (case when v_enabled then 'event_sales_opened' else 'event_sales_closed' end,'events',p_event_id,p_event_id,
      jsonb_build_object('actor_user_id',v_actor,'organization_id',v_event.organization_id,
      'previous_state',jsonb_build_object('registration_enabled',v_event.registration_enabled),
      'new_state',jsonb_build_object('registration_enabled',v_enabled)));
  return true;
end; $$;


ALTER FUNCTION "public"."set_event_registration_enabled"("p_event_id" "uuid", "p_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_shirt_stock_limit"("p_event_id" "uuid", "p_enabled" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event public.events%rowtype;
  v_actor text := coalesce((select email from auth.users where id = auth.uid()), auth.role(), 'system');
begin
  if not public.current_user_has_permission('inventory.limit_selection'::text) then
    raise exception 'Sem permissao para alterar limitacao de estoque.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  update public.events
  set
    limit_shirt_selection_to_stock = coalesce(p_enabled, false),
    updated_at = now()
  where id = p_event_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_limit_selection_updated',
    'events',
    p_event_id,
    p_event_id,
    jsonb_build_object(
      'before', coalesce(v_event.limit_shirt_selection_to_stock, false),
      'after', coalesce(p_enabled, false)
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."set_event_shirt_stock_limit"("p_event_id" "uuid", "p_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_ticket_holder_rules"("p_event_id" "uuid", "p_allow_holder_change" boolean, "p_allow_ticket_transfer" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_org uuid; begin if auth.uid() is null or not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao.'; end if; select organization_id into v_org from public.events where id=p_event_id; if not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Sem acesso.'; end if;
update public.events set allow_holder_change=coalesce(p_allow_holder_change,false),allow_ticket_transfer=coalesce(p_allow_ticket_transfer,false),updated_at=now() where id=p_event_id; return true; end; $$;


ALTER FUNCTION "public"."set_event_ticket_holder_rules"("p_event_id" "uuid", "p_allow_holder_change" boolean, "p_allow_ticket_transfer" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_platform_brand_theme"("p_theme" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if not public.current_user_has_permission('settings.manage') then
    raise exception 'Sem permissao para alterar configuracoes da plataforma.';
  end if;
  if p_theme not in (
    'pink', 'red', 'rose', 'fuchsia', 'purple', 'violet', 'indigo',
    'blue', 'sky', 'cyan', 'teal', 'emerald', 'green', 'lime',
    'yellow', 'amber', 'orange'
  ) then
    raise exception 'Tema invalido: %', p_theme;
  end if;

  update public.platform_settings
  set brand_theme = p_theme, updated_at = now(), updated_by = auth.uid()
  where id = true;
end;
$$;


ALTER FUNCTION "public"."set_platform_brand_theme"("p_theme" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_store_item_stock"("p_store_item_id" "uuid", "p_variant_id" "uuid", "p_total_quantity" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_item public.store_items%rowtype; v_committed integer;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_item.organization_id) then raise exception 'Item invalido ou sem acesso.'; end if;
  if p_total_quantity < 0 then raise exception 'Quantidade invalida.'; end if;
  if p_variant_id is not null and not exists (select 1 from public.store_item_variants where id = p_variant_id and store_item_id = p_store_item_id) then
    raise exception 'Variante nao pertence ao item.';
  end if;

  select coalesce(reserved_quantity, 0) + coalesce(delivered_quantity, 0) into v_committed
  from public.store_item_inventory where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id;
  if v_committed is not null and p_total_quantity < v_committed then
    raise exception 'Quantidade total nao pode ser menor que o ja reservado/entregue (%).', v_committed;
  end if;

  insert into public.store_item_inventory (event_id, store_item_id, variant_id, total_quantity)
  values (v_item.event_id, p_store_item_id, p_variant_id, p_total_quantity)
  on conflict (store_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set total_quantity = excluded.total_quantity, updated_at = now();
end; $$;


ALTER FUNCTION "public"."set_store_item_stock"("p_store_item_id" "uuid", "p_variant_id" "uuid", "p_total_quantity" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_ticket_category_active"("p_category_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_category_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  update public.ticket_categories
  set
    is_active = coalesce(p_is_active, true),
    updated_at = now()
  where id = p_category_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Categoria nao encontrada para o evento.';
  end if;

  return true;
end;
$$;


ALTER FUNCTION "public"."set_ticket_category_active"("p_category_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_simple_financial_expense"("p_entry_id" "uuid", "p_amount" numeric, "p_paid_on" "date", "p_reason" "text", "p_idempotency_key" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_expense public.financial_entries%rowtype; v_settlement uuid; v_paid numeric; v_cash uuid; v_payable uuid;
begin
  select * into v_expense from public.financial_entries where id=p_entry_id for update; if not found then raise exception 'Despesa nao encontrada.'; end if;
  if v_actor is null or not public.current_user_has_permission('finance.confirm_payment') or not public.user_can_access_organization(v_actor,v_expense.organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  select settlement_entry_id into v_settlement from public.financial_entry_settlements where organization_id=v_expense.organization_id and idempotency_key=trim(p_idempotency_key); if v_settlement is not null then return v_settlement; end if;
  if v_expense.entry_kind<>'expense' or v_expense.lifecycle_status not in('open','partially_settled') or p_amount<=0 or p_paid_on is null or nullif(trim(p_reason),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Baixa invalida para a despesa.'; end if;
  select coalesce(sum(amount),0) into v_paid from public.financial_entry_settlements where expense_entry_id=p_entry_id;
  if v_paid+p_amount>v_expense.amount then raise exception 'Pagamento excede o saldo da despesa.'; end if;
  select id into v_cash from public.financial_accounts where organization_id=v_expense.organization_id and code='SYS_CAIXA' and account_type='asset' and is_active;
  select id into v_payable from public.financial_accounts where organization_id=v_expense.organization_id and code='SYS_A_PAGAR' and account_type='liability' and is_active;
  if v_cash is null or v_payable is null then raise exception 'Contas internas indisponiveis.'; end if;
  insert into public.financial_entries(organization_id,entry_kind,lifecycle_status,description,original_entry_id,amount,occurred_on,posted_at,settled_at,idempotency_key,created_by)
  values(v_expense.organization_id,'transfer','settled','Pagamento: '||v_expense.description,p_entry_id,p_amount,p_paid_on,now(),now(),'settlement:'||trim(p_idempotency_key),v_actor) returning id into v_settlement;
  insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo) values
    (v_settlement,v_expense.organization_id,v_payable,'debit',p_amount,'Baixa da obrigacao'),
    (v_settlement,v_expense.organization_id,v_cash,'credit',p_amount,'Pagamento da despesa');
  insert into public.financial_entry_settlements(organization_id,expense_entry_id,settlement_entry_id,amount,paid_on,reason,idempotency_key,settled_by)
  values(v_expense.organization_id,p_entry_id,v_settlement,p_amount,p_paid_on,trim(p_reason),trim(p_idempotency_key),v_actor);
  update public.financial_entries set lifecycle_status=case when v_paid+p_amount=amount then 'settled' else 'partially_settled' end,settled_at=case when v_paid+p_amount=amount then now() else null end,updated_at=now() where id=p_entry_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_expense_settled','financial_entries',p_entry_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_expense.organization_id,'settlement_entry_id',v_settlement,'amount',p_amount,'paid_on',p_paid_on,'reason',trim(p_reason),'idempotency_key',trim(p_idempotency_key)));
  return v_settlement;
end $$;


ALTER FUNCTION "public"."settle_simple_financial_expense"("p_entry_id" "uuid", "p_amount" numeric, "p_paid_on" "date", "p_reason" "text", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."simulate_order_payment_paid"("p_order_id" "uuid", "p_payment_method" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_method text := lower(trim(coalesce(p_payment_method, 'pix')));
begin
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;

  if v_method not in ('pix', 'credit_card', 'cash', 'courtesy') then
    raise exception 'Metodo de pagamento invalido.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;

  if auth.uid() is not null and auth.uid() <> v_order.user_id then
    raise exception 'Sem permissao para confirmar este pedido.';
  end if;

  select * into v_payment
  from public.payments
  where public.payments.order_id = p_order_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;

  if v_payment.payment_status = 'paid' then
    perform public.confirm_order_payment_and_issue_tickets(p_order_id);
    return true;
  end if;

  if v_payment.payment_status in ('expired', 'cancelled', 'refunded') then
    raise exception 'Pagamento nao pode ser confirmado neste status.';
  end if;

  update public.payments
  set payment_method = v_method,
      payment_status = 'paid',
      paid_at = now(),
      expires_at = null,
      updated_at = now()
  where id = v_payment.id;

  perform public.confirm_order_payment_and_issue_tickets(p_order_id);

  return true;
end;
$$;


ALTER FUNCTION "public"."simulate_order_payment_paid"("p_order_id" "uuid", "p_payment_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."simulate_payment_paid"("p_participant_id" "uuid", "p_payment_method" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_method text := lower(trim(coalesce(p_payment_method, 'pix')));
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;

  if v_method not in ('pix', 'credit_card', 'cash', 'courtesy') then
    raise exception 'Metodo de pagamento invalido.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select * into v_payment
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;

  if v_payment.payment_status = 'paid' then
    raise exception 'Pagamento ja confirmado.';
  end if;

  if v_payment.payment_status in ('expired', 'cancelled', 'refunded') then
    raise exception 'Pagamento nao pode ser confirmado neste status.';
  end if;

  update public.payments
  set payment_method = v_method,
      payment_status = 'paid',
      paid_at = now(),
      expires_at = null
  where id = v_payment.id;

  perform public.confirm_registration_payment(p_participant_id);

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'payment_simulated_paid',
    'payments',
    v_payment.id,
    jsonb_build_object(
      'participant_id', p_participant_id,
      'payment_method', v_method
    ),
    v_participant.event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."simulate_payment_paid"("p_participant_id" "uuid", "p_payment_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."simulate_store_order_payment"("p_store_order_id" "uuid", "p_payment_method" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid := auth.uid(); v_order public.store_orders%rowtype;
begin
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if v_order.user_id <> v_actor then raise exception 'Sem permissao para confirmar este pedido.'; end if;
  if v_order.status = 'cancelled' then raise exception 'Pedido cancelado nao pode ser confirmado.'; end if;
  if v_order.status = 'confirmed' then return; end if;

  update public.store_orders set status = 'confirmed', payment_status = 'paid', payment_method = coalesce(p_payment_method, payment_method),
    paid_at = now(), confirmed_at = now(), updated_at = now()
  where id = p_store_order_id;
  update public.store_order_items set status = 'confirmed' where store_order_id = p_store_order_id and status = 'reserved';
end; $$;


ALTER FUNCTION "public"."simulate_store_order_payment"("p_store_order_id" "uuid", "p_payment_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."slugify_text"("p_input" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select regexp_replace(
    regexp_replace(lower(coalesce(trim(p_input), '')), '[^a-z0-9]+', '-', 'g'),
    '(^-|-$)',
    '',
    'g'
  );
$_$;


ALTER FUNCTION "public"."slugify_text"("p_input" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_order_payment_pix"("p_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) RETURNS TABLE("payment_id" "uuid", "order_id" "uuid", "event_id" "uuid", "amount" numeric, "discount_amount" numeric, "final_amount" numeric, "payment_method" "text", "payment_status" "text", "pix_code" "text", "pix_qrcode" "text", "gateway_payment_id" "text", "expires_at" timestamp with time zone, "paid_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;

  if auth.uid() is not null and auth.uid() <> v_order.user_id then
    raise exception 'Sem permissao para alterar pagamento deste pedido.';
  end if;

  select * into v_payment
  from public.payments
  where public.payments.order_id = p_order_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;

  if v_payment.payment_status = 'paid' then
    return query
    select
      v_payment.id,
      p_order_id,
      v_payment.event_id,
      v_payment.amount,
      coalesce(v_payment.discount_amount, 0),
      coalesce(v_payment.final_amount, v_payment.amount),
      v_payment.payment_method,
      v_payment.payment_status,
      v_payment.pix_code,
      v_payment.pix_qrcode,
      v_payment.gateway_payment_id,
      v_payment.expires_at,
      v_payment.paid_at;
    return;
  end if;

  update public.payments
  set payment_method = 'pix',
      payment_status = 'pending',
      pix_code = p_pix_code,
      pix_qrcode = p_pix_qrcode,
      gateway_payment_id = p_gateway_payment_id,
      expires_at = p_expires_at,
      paid_at = null,
      updated_at = now()
  where id = v_payment.id
  returning * into v_payment;

  update public.order_items oi
  set status = 'reserved',
      reservation_expires_at = p_expires_at,
      updated_at = now()
  where oi.order_id = p_order_id
    and status not in ('cancelled', 'expired', 'refunded', 'transferred');

  update public.orders
  set status = 'pending',
      cancelled_at = null
  where id = p_order_id;

  return query
  select
    v_payment.id,
    p_order_id,
    v_payment.event_id,
    v_payment.amount,
    coalesce(v_payment.discount_amount, 0),
    coalesce(v_payment.final_amount, v_payment.amount),
    v_payment.payment_method,
    v_payment.payment_status,
    v_payment.pix_code,
    v_payment.pix_qrcode,
    v_payment.gateway_payment_id,
    v_payment.expires_at,
    v_payment.paid_at;
end;
$$;


ALTER FUNCTION "public"."start_order_payment_pix"("p_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_payment_pix"("p_participant_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) RETURNS TABLE("payment_id" "uuid", "participant_id" "uuid", "event_id" "uuid", "amount" numeric, "discount_amount" numeric, "final_amount" numeric, "payment_method" "text", "payment_status" "text", "pix_code" "text", "pix_qrcode" "text", "gateway_payment_id" "text", "expires_at" timestamp with time zone, "paid_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select * into v_payment
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;

  if v_payment.payment_status = 'paid' then
    return query
    select
      v_payment.id,
      v_payment.participant_id,
      v_payment.event_id,
      v_payment.amount,
      coalesce(v_payment.discount_amount, 0),
      coalesce(v_payment.final_amount, v_payment.amount),
      v_payment.payment_method,
      v_payment.payment_status,
      v_payment.pix_code,
      v_payment.pix_qrcode,
      v_payment.gateway_payment_id,
      v_payment.expires_at,
      v_payment.paid_at;
    return;
  end if;

  update public.payments
  set payment_method = 'pix',
      payment_status = 'pending',
      pix_code = p_pix_code,
      pix_qrcode = p_pix_qrcode,
      gateway_payment_id = p_gateway_payment_id,
      expires_at = p_expires_at,
      paid_at = null
  where id = v_payment.id
  returning * into v_payment;

  update public.participants
  set registration_status = 'pending',
      reservation_status = 'pending',
      reservation_expires_at = p_expires_at,
      updated_at = now()
  where id = p_participant_id
    and reservation_status <> 'confirmed';

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'payment_pix_started',
    'payments',
    v_payment.id,
    jsonb_build_object(
      'participant_id', p_participant_id,
      'expires_at', p_expires_at,
      'gateway_payment_id', p_gateway_payment_id
    ),
    v_participant.event_id
  );

  return query
  select
    v_payment.id,
    v_payment.participant_id,
    v_payment.event_id,
    v_payment.amount,
    coalesce(v_payment.discount_amount, 0),
    coalesce(v_payment.final_amount, v_payment.amount),
    v_payment.payment_method,
    v_payment.payment_status,
    v_payment.pix_code,
    v_payment.pix_qrcode,
    v_payment.gateway_payment_id,
    v_payment.expires_at,
    v_payment.paid_at;
end;
$$;


ALTER FUNCTION "public"."start_payment_pix"("p_participant_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "participant_id" "uuid",
    "order_number" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payment_method" "text",
    "payment_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "base_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "final_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "confirmed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pix_code" "text",
    "pix_qrcode" "text",
    "gateway_payment_id" "text",
    "expires_at" timestamp with time zone,
    "paid_at" timestamp with time zone,
    CONSTRAINT "store_orders_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'refunded'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "store_orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'cancelled'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."store_orders" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_store_order_payment_pix"("p_store_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) RETURNS "public"."store_orders"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid := auth.uid(); v_order public.store_orders%rowtype;
begin
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if v_order.user_id <> v_actor then raise exception 'Sem permissao para alterar pagamento deste pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta pendente de pagamento.'; end if;

  update public.store_orders set
    payment_method = 'pix', pix_code = p_pix_code, pix_qrcode = p_pix_qrcode,
    gateway_payment_id = p_gateway_payment_id, expires_at = p_expires_at, updated_at = now()
  where id = p_store_order_id
  returning * into v_order;

  return v_order;
end; $$;


ALTER FUNCTION "public"."start_store_order_payment_pix"("p_store_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_order_item_participant_to_ticket"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  update public.tickets set participant_id=new.participant_id
  where order_item_id=new.id and participant_id is distinct from new.participant_id;
  update public.participant_kit_items set participant_id=new.participant_id
  where order_item_id=new.id and participant_id is distinct from new.participant_id;
  return new;
end;
$$;


ALTER FUNCTION "public"."sync_order_item_participant_to_ticket"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_participant_registration_contact"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_cpf text := regexp_replace(coalesce(new.cpf,''),'\D','','g');
  v_contact_id uuid;
begin
  if new.registration_contact_id is not null then
    return new;
  end if;

  if length(v_cpf) <> 11
     or nullif(trim(coalesce(new.full_name,'')),'') is null
     or new.birth_date is null
     or nullif(trim(coalesce(new.phone,'')),'') is null
     or nullif(trim(coalesce(new.email,'')),'') is null
  then
    return new;
  end if;

  insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city)
  values(new.organization_id, trim(new.full_name), v_cpf, new.birth_date,
    nullif(trim(coalesce(new.gender,'')),''), regexp_replace(coalesce(new.phone,''),'\D','','g'),
    lower(trim(new.email)), nullif(trim(coalesce(new.city,'')),''))
  on conflict(organization_id,cpf) do update set updated_at=excluded.updated_at
  returning id into v_contact_id;

  new.registration_contact_id := v_contact_id;
  return new;
end;
$$;


ALTER FUNCTION "public"."sync_participant_registration_contact"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_ticket_kit_auxiliary_participant"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  update public.participant_kit_items
  set participant_id = new.participant_id
  where ticket_id = new.id and participant_id is distinct from new.participant_id;
  return new;
end;
$$;


ALTER FUNCTION "public"."sync_ticket_kit_auxiliary_participant"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."toggle_coupon_active"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_coupon_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  update public.coupons
  set is_active = coalesce(p_is_active, false),
      updated_at = now()
  where id = p_coupon_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Cupom nao encontrado para o evento.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'coupon_toggled',
    'coupons',
    p_coupon_id,
    jsonb_build_object('is_active', coalesce(p_is_active, false)),
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."toggle_coupon_active"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_admin_overrides_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_admin_overrides_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_admin_roles_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_admin_roles_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_admin_users_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_admin_users_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_customer_profiles_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_customer_profiles_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_event_kit_items_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.name := trim(new.name);
  new.slug := public.slugify_text(coalesce(nullif(new.slug, ''), new.name));
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_event_kit_items_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_import_batch_rows_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_import_batch_rows_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_order_items_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_order_items_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_participation_history_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_participation_history_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_payments_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_payments_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_registration_batch_prices_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_registration_batch_prices_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_ticket_category_benefits_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_ticket_category_benefits_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text") RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select public.change_ticket_holder_by_pin_for_owner(p_ticket_id,p_pin,'holder_changed');
$$;


ALTER FUNCTION "public"."transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_classify_administrative_order"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."trg_classify_administrative_order"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_enforce_ticket_holder_contact_uniqueness"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."trg_enforce_ticket_holder_contact_uniqueness"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_event_kit_items_set_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_org uuid;
begin
  select organization_id into v_org from public.events where id = NEW.event_id;
  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;
  if v_org is null then
    raise exception 'Evento % não possui organization_id.', NEW.event_id;
  end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then
    raise exception 'organization_id divergente em event_kit_items (esperado %).', v_org;
  end if;
  NEW.organization_id := v_org;
  return NEW;
end;
$$;


ALTER FUNCTION "public"."trg_event_kit_items_set_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_initialize_ticket_owner"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."trg_initialize_ticket_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_inventory_movements_set_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_org     uuid;
  v_inventory_org uuid;
begin
  select organization_id into v_event_org
  from public.events where id = NEW.event_id;
  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;
  if v_event_org is null then
    raise exception 'Evento % sem organization_id.', NEW.event_id;
  end if;

  select organization_id into v_inventory_org
  from public.shirt_inventory where id = NEW.inventory_id;
  if found and v_inventory_org is not null and v_inventory_org <> v_event_org then
    raise exception
      'Divergência: inventory (org %) e evento (org %) em inventory_movements.',
      v_inventory_org, v_event_org;
  end if;

  if NEW.organization_id is not null and NEW.organization_id <> v_event_org then
    raise exception 'organization_id divergente em inventory_movements (esperado %).', v_event_org;
  end if;

  NEW.organization_id := v_event_org;
  return NEW;
end;
$$;


ALTER FUNCTION "public"."trg_inventory_movements_set_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_orders_set_organization_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_org_id uuid;
begin
  if NEW.event_id is null then
    raise exception 'orders.event_id é obrigatório.';
  end if;

  select organization_id into v_event_org_id
  from public.events
  where id = NEW.event_id;

  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;

  if v_event_org_id is null then
    raise exception 'Evento % não possui organization_id.', NEW.event_id;
  end if;

  if NEW.organization_id is not null and NEW.organization_id <> v_event_org_id then
    raise exception
      'organization_id % diverge da organização do evento % (esperado: %).',
      NEW.organization_id, NEW.event_id, v_event_org_id;
  end if;

  NEW.organization_id := v_event_org_id;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."trg_orders_set_organization_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_participant_kit_items_set_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_org uuid;
  v_part_org  uuid;
  v_kit_org   uuid;
begin
  select organization_id into v_event_org
  from public.events where id = NEW.event_id;
  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;
  if v_event_org is null then
    raise exception 'Evento % sem organization_id.', NEW.event_id;
  end if;

  select organization_id into v_part_org
  from public.participants where id = NEW.participant_id;
  if found and v_part_org is not null and v_part_org <> v_event_org then
    raise exception
      'Divergência: participante (org %) e evento (org %) em participant_kit_items.',
      v_part_org, v_event_org;
  end if;

  select organization_id into v_kit_org
  from public.event_kit_items where id = NEW.kit_item_id;
  if found and v_kit_org is not null and v_kit_org <> v_event_org then
    raise exception
      'Divergência: kit_item (org %) e evento (org %) em participant_kit_items.',
      v_kit_org, v_event_org;
  end if;

  if NEW.organization_id is not null and NEW.organization_id <> v_event_org then
    raise exception 'organization_id divergente em participant_kit_items (esperado %).', v_event_org;
  end if;

  NEW.organization_id := v_event_org;
  return NEW;
end;
$$;


ALTER FUNCTION "public"."trg_participant_kit_items_set_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_participants_set_organization_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_org_id uuid;
begin
  if NEW.event_id is null then
    raise exception 'participants.event_id é obrigatório.';
  end if;

  select organization_id into v_event_org_id
  from public.events
  where id = NEW.event_id;

  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;

  if v_event_org_id is null then
    raise exception 'Evento % não possui organization_id.', NEW.event_id;
  end if;

  -- Rejeita organization_id divergente vindo do cliente
  if NEW.organization_id is not null and NEW.organization_id <> v_event_org_id then
    raise exception
      'organization_id % diverge da organização do evento % (esperado: %).',
      NEW.organization_id, NEW.event_id, v_event_org_id;
  end if;

  -- Garante que organization_id sempre reflete o evento
  NEW.organization_id := v_event_org_id;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."trg_participants_set_organization_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_payments_set_organization_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_order_org_id       uuid;
  v_event_org_id       uuid;
  v_participant_org_id uuid;
  v_resolved_org_id    uuid;
begin
  -- Resolve por order_id
  if NEW.order_id is not null then
    select organization_id into v_order_org_id
    from public.orders where id = NEW.order_id;

    if not found then
      raise exception 'Pedido % não encontrado em orders.', NEW.order_id;
    end if;
  end if;

  -- Resolve por event_id
  if NEW.event_id is not null then
    select organization_id into v_event_org_id
    from public.events where id = NEW.event_id;

    if not found then
      raise exception 'Evento % não encontrado em events.', NEW.event_id;
    end if;
  end if;

  -- Resolve por participant_id
  if NEW.participant_id is not null then
    select organization_id into v_participant_org_id
    from public.participants where id = NEW.participant_id;

    if not found then
      raise exception 'Participante % não encontrado em participants.', NEW.participant_id;
    end if;
  end if;

  -- Verifica divergência entre order e event
  if v_order_org_id is not null and v_event_org_id is not null
     and v_order_org_id <> v_event_org_id then
    raise exception
      'Divergência: pedido (org %) e evento (org %) apontam para organizações diferentes no pagamento.',
      v_order_org_id, v_event_org_id;
  end if;

  -- Verifica divergência entre order/event e participant
  if v_participant_org_id is not null then
    if v_order_org_id is not null and v_order_org_id <> v_participant_org_id then
      raise exception
        'Divergência: pedido (org %) e participante (org %) apontam para organizações diferentes.',
        v_order_org_id, v_participant_org_id;
    end if;
    if v_event_org_id is not null and v_event_org_id <> v_participant_org_id then
      raise exception
        'Divergência: evento (org %) e participante (org %) apontam para organizações diferentes.',
        v_event_org_id, v_participant_org_id;
    end if;
  end if;

  -- Usa prioridade: order_id > event_id > participant_id
  v_resolved_org_id := coalesce(v_order_org_id, v_event_org_id, v_participant_org_id);

  if v_resolved_org_id is null then
    raise exception
      'Não foi possível determinar a organização para o pagamento (order_id=%, event_id=%, participant_id=%).',
      NEW.order_id, NEW.event_id, NEW.participant_id;
  end if;

  -- Rejeita organization_id divergente enviado pelo cliente
  if NEW.organization_id is not null and NEW.organization_id <> v_resolved_org_id then
    raise exception
      'organization_id % diverge da organização resolvida % para o pagamento.',
      NEW.organization_id, v_resolved_org_id;
  end if;

  NEW.organization_id := v_resolved_org_id;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."trg_payments_set_organization_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_shirt_inventory_set_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_org uuid;
begin
  select organization_id into v_org from public.events where id = NEW.event_id;
  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;
  if v_org is null then
    raise exception 'Evento % não possui organization_id.', NEW.event_id;
  end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then
    raise exception 'organization_id divergente no shirt_inventory (esperado %).',  v_org;
  end if;
  NEW.organization_id := v_org;
  return NEW;
end;
$$;


ALTER FUNCTION "public"."trg_shirt_inventory_set_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_store_item_inventory_set_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_org uuid;
begin
  select organization_id into v_org from public.store_items where id = NEW.store_item_id;
  if not found or v_org is null then raise exception 'Item da loja % nao encontrado ou sem organization_id.', NEW.store_item_id; end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_item_inventory (esperado %).', v_org; end if;
  NEW.organization_id := v_org;
  return NEW;
end; $$;


ALTER FUNCTION "public"."trg_store_item_inventory_set_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_store_items_set_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_org uuid;
begin
  if NEW.event_id is not null then
    select organization_id into v_org from public.events where id = NEW.event_id;
    if not found or v_org is null then raise exception 'Evento % nao encontrado ou sem organization_id.', NEW.event_id; end if;
    if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_items (esperado %).', v_org; end if;
    NEW.organization_id := v_org;
  elsif NEW.organization_id is null then
    raise exception 'organization_id obrigatorio para item disponivel em todos os eventos.';
  end if;
  return NEW;
end; $$;


ALTER FUNCTION "public"."trg_store_items_set_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_store_orders_set_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_org uuid;
begin
  select organization_id into v_org from public.events where id = NEW.event_id;
  if not found or v_org is null then raise exception 'Evento % nao encontrado ou sem organization_id.', NEW.event_id; end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_orders (esperado %).', v_org; end if;
  NEW.organization_id := v_org;
  return NEW;
end; $$;


ALTER FUNCTION "public"."trg_store_orders_set_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_ticket_holder_history_contacts"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if new.previous_registration_contact_id is null and new.previous_participant_id is not null then
    select registration_contact_id into new.previous_registration_contact_id from public.participants where id=new.previous_participant_id;
  end if;
  if new.new_registration_contact_id is null and new.new_participant_id is not null then
    select registration_contact_id into new.new_registration_contact_id from public.participants where id=new.new_participant_id;
  end if;
  return new;
end; $$;


ALTER FUNCTION "public"."trg_ticket_holder_history_contacts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_ticket_holder_history_reason_compatibility"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if new.reason_code is null then
    new.reason_code:='legacy_unclassified';
    new.reason_text:=coalesce(nullif(trim(new.reason_text),''),nullif(trim(new.reason),''));
  end if;
  if new.operation='ticket_transferred' then new.operation:='holder_changed'; end if;
  return new;
end; $$;


ALTER FUNCTION "public"."trg_ticket_holder_history_reason_compatibility"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_ticket_kit_item_consistency"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ticket public.tickets%rowtype;
  v_order_item public.order_items%rowtype;
  v_item public.event_kit_items%rowtype;
  v_event_org uuid;
begin
  if new.ticket_id is null and new.order_item_id is null then
    if tg_op = 'INSERT' then
      -- Funcoes historicas ainda tentam inserir por participante antes de criar o
      -- order_item. A reserva de estoque feita por elas e preservada, mas o
      -- vinculo sem chave operacional nao e materializado. O trigger de
      -- order_items abaixo cria o mesmo item com chave deterministica.
      return null;
    end if;
    if coalesce(old.legacy_unresolved,false) and new.legacy_unresolved then return new; end if;
    raise exception 'Item de kit sem ticket_id/order_item_id nao e um legado autorizado.';
  end if;

  if new.ticket_id is not null then
    select * into v_ticket from public.tickets where id = new.ticket_id;
    if not found then raise exception 'Ingresso do item nao encontrado.'; end if;
    if v_ticket.order_item_id is null then raise exception 'Ingresso sem order_item deterministico.'; end if;
    if new.order_item_id is not null and new.order_item_id is distinct from v_ticket.order_item_id then
      raise exception 'order_item divergente do ingresso.';
    end if;
    new.order_item_id := v_ticket.order_item_id;
  end if;

  select * into v_order_item from public.order_items where id = new.order_item_id;
  if not found then raise exception 'Order item do kit nao encontrado.'; end if;
  if new.ticket_id is null then
    v_ticket.event_id := v_order_item.event_id;
    v_ticket.participant_id := v_order_item.participant_id;
  end if;
  select * into v_item from public.event_kit_items where id = new.kit_item_id;
  if not found or v_item.event_id is distinct from v_ticket.event_id then
    raise exception 'Item de kit nao pertence ao evento do ingresso.';
  end if;
  select organization_id into v_event_org from public.events where id = v_ticket.event_id;
  if v_event_org is null then raise exception 'Evento do ingresso nao encontrado.'; end if;
  if new.event_id is not null and new.event_id is distinct from v_ticket.event_id then
    raise exception 'Evento divergente no item operacional.';
  end if;
  if new.organization_id is not null and new.organization_id is distinct from v_event_org then
    raise exception 'Organizacao divergente no item operacional.';
  end if;

  new.event_id := v_ticket.event_id;
  new.organization_id := v_event_org;
  new.participant_id := coalesce(v_order_item.participant_id, v_ticket.participant_id);
  return new;
end;
$$;


ALTER FUNCTION "public"."trg_ticket_kit_item_consistency"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_tickets_set_organization_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_order_org_id       uuid;
  v_participant_org_id uuid;
  v_resolved_org_id    uuid;
begin
  -- order_id é NOT NULL na tabela; resolve a org do pedido
  select organization_id into v_order_org_id
  from public.orders
  where id = NEW.order_id;

  if not found then
    raise exception 'Pedido % não encontrado em orders.', NEW.order_id;
  end if;

  if v_order_org_id is null then
    raise exception 'Pedido % não possui organization_id.', NEW.order_id;
  end if;

  -- Valida participante quando informado
  if NEW.participant_id is not null then
    select organization_id into v_participant_org_id
    from public.participants
    where id = NEW.participant_id;

    if not found then
      raise exception 'Participante % não encontrado em participants.', NEW.participant_id;
    end if;

    if v_participant_org_id is not null and v_participant_org_id <> v_order_org_id then
      raise exception
        'Divergência de organização: participante % (org %) e pedido % (org %) são de organizações diferentes.',
        NEW.participant_id, v_participant_org_id, NEW.order_id, v_order_org_id;
    end if;
  end if;

  v_resolved_org_id := v_order_org_id;

  -- Rejeita organization_id divergente vindo do cliente
  if NEW.organization_id is not null and NEW.organization_id <> v_resolved_org_id then
    raise exception
      'organization_id % diverge da organização resolvida % para o ticket.',
      NEW.organization_id, v_resolved_org_id;
  end if;

  NEW.organization_id := v_resolved_org_id;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."trg_tickets_set_organization_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_wristbands_set_organization_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ticket_org uuid;
  v_event_org  uuid;
  v_part_org   uuid;
begin
  select organization_id into v_ticket_org
  from public.tickets where id = NEW.ticket_id;
  if not found then
    raise exception 'Ingresso % não encontrado em tickets.', NEW.ticket_id;
  end if;
  if v_ticket_org is null then
    raise exception 'Ingresso % não possui organization_id.', NEW.ticket_id;
  end if;

  select organization_id into v_event_org
  from public.events where id = NEW.event_id;
  if found and v_event_org is not null and v_event_org <> v_ticket_org then
    raise exception
      'Divergência: ingresso (org %) e evento (org %) em participant_wristbands.',
      v_ticket_org, v_event_org;
  end if;

  if NEW.participant_id is not null then
    select organization_id into v_part_org
    from public.participants where id = NEW.participant_id;
    if found and v_part_org is not null and v_part_org <> v_ticket_org then
      raise exception
        'Divergência: ingresso (org %) e participante (org %) em participant_wristbands.',
        v_ticket_org, v_part_org;
    end if;
  end if;

  if NEW.organization_id is not null and NEW.organization_id <> v_ticket_org then
    raise exception
      'organization_id % diverge da organização do ingresso % (esperado: %).',
      NEW.organization_id, NEW.ticket_id, v_ticket_org;
  end if;

  NEW.organization_id := v_ticket_org;
  return NEW;
end;
$$;


ALTER FUNCTION "public"."trg_wristbands_set_organization_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."undo_participant_checkin"("p_participant_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_participant public.participants%rowtype;
  v_ticket public.tickets%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('checkin.undo') then
    raise exception 'Sem permissao para desfazer check-in.';
  end if;

  select p.*
  into v_participant
  from public.participants p
  where p.id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select t.*
  into v_ticket
  from public.tickets t
  where t.participant_id = p_participant_id
  order by t.issued_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  if v_ticket.status <> 'used' and v_ticket.used_at is null then
    raise exception 'Este ingresso ainda nao realizou check-in.';
  end if;

  update public.tickets t
  set status = 'active',
      used_at = null
  where t.id = v_ticket.id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'participant_checkin_undone',
    'participants',
    p_participant_id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'ticket_id', v_ticket.id,
      'previous_used_at', v_ticket.used_at,
      'undone_at', now()
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."undo_participant_checkin"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."undo_participant_full_kit"("p_participant_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin return public.undo_ticket_full_kit(public.resolve_unique_ticket_for_participant(p_participant_id)); end;
$$;


ALTER FUNCTION "public"."undo_participant_full_kit"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."undo_participant_kit_item"("p_participant_id" "uuid", "p_kit_item_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin return public.undo_ticket_kit_item(public.resolve_unique_ticket_for_participant(p_participant_id),p_kit_item_id); end;
$$;


ALTER FUNCTION "public"."undo_participant_kit_item"("p_participant_id" "uuid", "p_kit_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."undo_store_order_item_delivery"("p_store_order_item_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype; v_item public.store_items%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para desfazer entrega da loja.'; end if;
  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_line.status <> 'delivered' then raise exception 'Item nao esta entregue.'; end if;
  select * into v_item from public.store_items where id = v_line.store_item_id;

  if v_item.supply_mode = 'stock' then
    update public.store_item_inventory set delivered_quantity = greatest(delivered_quantity - v_line.quantity, 0),
      reserved_quantity = reserved_quantity + v_line.quantity, updated_at = now()
    where store_item_id = v_line.store_item_id and variant_id is not distinct from v_line.variant_id;
  end if;
  update public.store_order_items set status = 'confirmed', delivered_at = null where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivery_undone', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;


ALTER FUNCTION "public"."undo_store_order_item_delivery"("p_store_order_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."undo_ticket_checkin"("p_ticket_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ticket      public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('checkin.undo') then
    raise exception 'Sem permissao para desfazer check-in.';
  end if;

  if p_ticket_id is null then
    raise exception 'Ingresso obrigatorio.';
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  -- Verifica acesso à organização do ingresso
  if not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Sem permissao para desfazer check-in neste ingresso.';
  end if;

  if v_ticket.status <> 'used' and v_ticket.used_at is null then
    raise exception 'Ingresso nao possui check-in para desfazer.';
  end if;

  if v_ticket.participant_id is not null then
    select * into v_participant
    from public.participants
    where id = v_ticket.participant_id;
  end if;

  update public.tickets
  set status  = 'active',
      used_at = null
  where id = v_ticket.id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'ticket_checkin_undo',
    'tickets',
    v_ticket.id,
    coalesce(v_participant.event_id, v_ticket.event_id),
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'ticket_id', v_ticket.id,
      'participant_id', v_ticket.participant_id,
      'organization_id', v_ticket.organization_id
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."undo_ticket_checkin"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."undo_ticket_full_kit"("p_ticket_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_row record; v_found boolean:=false; v_ticket public.tickets%rowtype;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  for v_row in select kit_item_id from public.participant_kit_items where ticket_id=p_ticket_id and status='delivered' loop v_found:=true; perform public.undo_ticket_kit_item(p_ticket_id,v_row.kit_item_id); end loop;
  if not v_found then raise exception 'Nenhum item entregue para desfazer.'; end if;
  return true;
end;
$$;


ALTER FUNCTION "public"."undo_ticket_full_kit"("p_ticket_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."undo_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_link public.participant_kit_items%rowtype; v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_kit public.event_kit_items%rowtype; v_inv public.shirt_inventory%rowtype; v_type text; v_size text;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update;
  if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(auth.uid(),v_link.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_link.status<>'delivered' then return true; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update;
  select * into v_kit from public.event_kit_items where id=p_kit_item_id;
  if v_kit.item_type='shirt' then
    v_type:=coalesce(v_link.variant_data->>'shirt_type',v_oi.shirt_type); v_size:=coalesce(v_link.variant_data->>'shirt_size',v_oi.shirt_size);
    select * into v_inv from public.shirt_inventory where event_id=v_ticket.event_id and shirt_type=v_type and shirt_size=v_size for update;
    if found then
      if coalesce(v_inv.delivered_quantity,0)<v_link.quantity then raise exception 'Quantidade entregue inconsistente no estoque.'; end if;
      update public.shirt_inventory set delivered_quantity=delivered_quantity-v_link.quantity,reserved_quantity=reserved_quantity+v_link.quantity,updated_at=now() where id=v_inv.id;
      insert into public.inventory_movements(event_id,inventory_id,movement_type,quantity,notes) values(v_ticket.event_id,v_inv.id,'kit_delivery_undo',v_link.quantity,format('Entrega desfeita para o ingresso %s.',p_ticket_id));
    end if;
  end if;
  update public.participant_kit_items set status='confirmed',delivered_at=null where id=v_link.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_kit_item_delivery_undone','participant_kit_items',v_link.id,v_link.event_id,jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'participant_id',v_link.participant_id,'kit_item_id',p_kit_item_id,'quantity',v_link.quantity));
  return true;
end;
$$;


ALTER FUNCTION "public"."undo_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unlink_wristband_from_ticket"("p_ticket_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_wristband   public.participant_wristbands%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.unlink')
  ) then
    raise exception 'Sem permissao para desvincular pulseira.';
  end if;

  select pw.* into v_wristband
  from public.participant_wristbands pw
  where pw.ticket_id = p_ticket_id and pw.status = 'active'
  limit 1 for update;

  if not found then
    raise exception 'Nenhuma pulseira ativa encontrada para este ingresso.';
  end if;

  -- Verifica org access
  if not public.user_can_access_organization(auth.uid(), v_wristband.organization_id) then
    raise exception 'Sem permissao para desvincular pulseira nesta organização.';
  end if;

  update public.participant_wristbands pw
  set status      = 'unlinked',
      unlinked_at = now(),
      unlinked_by = auth.uid(),
      notes       = nullif(trim(coalesce(p_reason, '')), ''),
      updated_at  = now()
  where pw.id = v_wristband.id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'wristband_unlinked', 'participant_wristbands', v_wristband.id, v_wristband.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_wristband.organization_id,
      'ticket_id', p_ticket_id,
      'participant_id', v_wristband.participant_id,
      'code', v_wristband.code,
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."unlink_wristband_from_ticket"("p_ticket_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_coupon"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_coupon_type text := lower(trim(coalesce(p_coupon_type, '')));
  v_discount numeric := coalesce(p_discount_percent, 0);
begin
  if p_coupon_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  if v_code = '' then
    raise exception 'Codigo do cupom obrigatorio.';
  end if;

  if v_coupon_type = 'courtesy' then
    v_discount := 100;
  elsif v_coupon_type = 'percentage' then
    if v_discount <= 0 or v_discount > 100 then
      raise exception 'Cupom percentual deve ter desconto maior que 0 e menor ou igual a 100.';
    end if;
  else
    raise exception 'Tipo de cupom invalido.';
  end if;

  if p_max_uses is not null and p_max_uses <= 0 then
    raise exception 'Limite de usos deve ser maior que zero.';
  end if;

  update public.coupons
  set
    code = v_code,
    coupon_type = v_coupon_type,
    discount_percent = v_discount,
    max_uses = p_max_uses,
    valid_from = p_valid_from,
    valid_until = p_valid_until,
    notes = nullif(trim(p_notes), ''),
    is_active = coalesce(p_is_active, true),
    updated_at = now()
  where id = p_coupon_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Cupom nao encontrado para o evento.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'coupon_updated',
    'coupons',
    p_coupon_id,
    jsonb_build_object(
      'code', v_code,
      'coupon_type', v_coupon_type,
      'discount_percent', v_discount,
      'max_uses', p_max_uses,
      'is_active', coalesce(p_is_active, true)
    ),
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."update_coupon"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_event"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_year" integer DEFAULT NULL::integer, "p_description" "text" DEFAULT NULL::"text", "p_starts_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_ends_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_registration_open_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_registration_close_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_location" "text" DEFAULT NULL::"text", "p_is_active" boolean DEFAULT false, "p_registration_enabled" boolean DEFAULT false, "p_kit_enabled" boolean DEFAULT false, "p_banner_hero_url" "text" DEFAULT NULL::"text", "p_banner_card_url" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_base_slug text; v_slug text; v_suffix integer:=1;
begin
  if v_actor is null then raise exception 'Autenticacao obrigatoria.'; end if;
  if not public.current_user_has_permission('events.edit') then raise exception 'Permissao insuficiente para editar evento.'; end if;
  select * into v_event from public.events where id=p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Acesso negado a organizacao.'; end if;
  if v_event.archived_at is not null then raise exception 'Evento arquivado deve ser restaurado antes da edicao.'; end if;
  if coalesce(p_is_active,false) is distinct from v_event.is_active
    or coalesce(p_registration_enabled,false) is distinct from v_event.registration_enabled then
    raise exception 'Use as operacoes especificas para ativacao e vendas.';
  end if;
  if nullif(trim(p_name),'') is null then raise exception 'Nome do evento obrigatorio.'; end if;
  v_base_slug:=public.slugify_text(coalesce(nullif(trim(p_slug),''),p_name||'-'||coalesce(p_year::text,extract(year from now())::text)));
  if v_base_slug='' then raise exception 'Slug do evento invalido.'; end if;
  v_slug:=v_base_slug;
  while exists(select 1 from public.events where slug=v_slug and id<>p_event_id) loop
    v_suffix:=v_suffix+1;
    v_slug:=v_base_slug||'-'||v_suffix::text;
  end loop;
  update public.events set name=trim(p_name),slug=v_slug,year=p_year,
    description=nullif(trim(coalesce(p_description,'')),''),starts_at=p_starts_at,ends_at=p_ends_at,
    registration_open_at=p_registration_open_at,registration_close_at=p_registration_close_at,
    location=nullif(trim(coalesce(p_location,'')),''),is_active=coalesce(p_is_active,false),
    registration_enabled=coalesce(p_registration_enabled,false),kit_enabled=coalesce(p_kit_enabled,false),
    banner_hero_url=nullif(trim(coalesce(p_banner_hero_url,'')),''),banner_card_url=nullif(trim(coalesce(p_banner_card_url,'')),''),
    updated_at=now()
  where id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values
    ('event_updated','events',p_event_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,
      'organization_id',v_event.organization_id,'previous_state',jsonb_build_object('name',v_event.name,'slug',v_event.slug,
      'is_active',v_event.is_active,'registration_enabled',v_event.registration_enabled,'kit_enabled',v_event.kit_enabled),
      'new_state',jsonb_build_object('name',trim(p_name),'slug',v_slug,'is_active',coalesce(p_is_active,false),
      'registration_enabled',coalesce(p_registration_enabled,false),'kit_enabled',coalesce(p_kit_enabled,false))));
  return true;
end; $$;


ALTER FUNCTION "public"."update_event"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_year" integer, "p_description" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_registration_open_at" timestamp with time zone, "p_registration_close_at" timestamp with time zone, "p_location" "text", "p_is_active" boolean, "p_registration_enabled" boolean, "p_kit_enabled" boolean, "p_banner_hero_url" "text", "p_banner_card_url" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_inventory_item"("p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_event_id uuid;
  v_actor text := coalesce(auth.role(), 'anon');
  v_item public.shirt_inventory%rowtype;
begin
  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_shirt_type not in ('Camiseta', 'Babylook') then
    raise exception 'Modelo invalido. Use Camiseta ou Babylook.';
  end if;

  if p_shirt_type = 'Camiseta' and p_shirt_size not in ('PP', 'P', 'M', 'G', 'GG', 'EG', 'EXG', 'EXGG') then
    raise exception 'Tamanho invalido para Camiseta.';
  end if;

  if p_shirt_type = 'Babylook' and p_shirt_size not in ('PP', 'P', 'M', 'G', 'GG', 'EG') then
    raise exception 'Tamanho invalido para Babylook.';
  end if;

  if p_total_quantity is null or p_total_quantity < 0 then
    raise exception 'Quantidade total deve ser maior ou igual a zero.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada.';
  end if;

  if v_item.event_id is distinct from v_event_id then
    raise exception 'Apenas o estoque do evento ativo pode ser alterado.';
  end if;

  if (v_item.reserved_quantity + v_item.delivered_quantity) > p_total_quantity then
    raise exception 'Total deve ser maior ou igual a reservadas + entregues.';
  end if;

  if exists (
    select 1
    from public.shirt_inventory
    where event_id = v_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
      and id <> p_inventory_id
  ) then
    raise exception 'Ja existe outra linha para este modelo e tamanho no evento ativo.';
  end if;

  update public.shirt_inventory
  set
    shirt_type = p_shirt_type,
    shirt_size = p_shirt_size,
    total_quantity = p_total_quantity,
    updated_at = now()
  where id = p_inventory_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_updated',
    'shirt_inventory',
    p_inventory_id,
    v_event_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'shirt_type', v_item.shirt_type,
        'shirt_size', v_item.shirt_size,
        'total_quantity', v_item.total_quantity,
        'reserved_quantity', v_item.reserved_quantity,
        'delivered_quantity', v_item.delivered_quantity
      ),
      'after', jsonb_build_object(
        'shirt_type', p_shirt_type,
        'shirt_size', p_shirt_size,
        'total_quantity', p_total_quantity,
        'reserved_quantity', v_item.reserved_quantity,
        'delivered_quantity', v_item.delivered_quantity
      )
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."update_inventory_item"("p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor text := coalesce(auth.role(), 'anon');
  v_item public.shirt_inventory%rowtype;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if coalesce(trim(p_shirt_type), '') = '' then
    raise exception 'Modelo obrigatorio.';
  end if;

  if coalesce(trim(p_shirt_size), '') = '' then
    raise exception 'Tamanho obrigatorio.';
  end if;

  if p_total_quantity is null or p_total_quantity < 0 then
    raise exception 'Quantidade total deve ser maior ou igual a zero.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada para o evento informado.';
  end if;

  if (v_item.reserved_quantity + v_item.delivered_quantity) > p_total_quantity then
    raise exception 'Total deve ser maior ou igual a reservadas + entregues.';
  end if;

  if exists (
    select 1
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
      and id <> p_inventory_id
  ) then
    raise exception 'Ja existe outra linha para este modelo e tamanho neste evento.';
  end if;

  update public.shirt_inventory
  set
    shirt_type = p_shirt_type,
    shirt_size = p_shirt_size,
    total_quantity = p_total_quantity,
    updated_at = now()
  where id = p_inventory_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_updated',
    'shirt_inventory',
    p_inventory_id,
    p_event_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'shirt_type', v_item.shirt_type,
        'shirt_size', v_item.shirt_size,
        'total_quantity', v_item.total_quantity,
        'reserved_quantity', v_item.reserved_quantity,
        'delivered_quantity', v_item.delivered_quantity
      ),
      'after', jsonb_build_object(
        'shirt_type', p_shirt_type,
        'shirt_size', p_shirt_size,
        'total_quantity', p_total_quantity,
        'reserved_quantity', v_item.reserved_quantity,
        'delivered_quantity', v_item.delivered_quantity
      )
    )
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."update_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_batch public.registration_batches%rowtype;
  v_confirmed_count integer;
  v_has_registrations boolean;
begin
  if p_batch_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select * into v_batch
  from public.registration_batches
  where id = p_batch_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Lote nao encontrado para o evento.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do lote obrigatorio.';
  end if;

  if p_sequence_number is null then
    raise exception 'Numero de sequencia obrigatorio.';
  end if;

  if p_male_price is null or p_male_price < 0 or p_female_price is null or p_female_price < 0 then
    raise exception 'Precos do lote devem ser maiores ou iguais a zero.';
  end if;

  if p_max_confirmed_registrations is null or p_max_confirmed_registrations <= 0 then
    raise exception 'Limite do lote deve ser maior que zero.';
  end if;

  if p_starts_at is not null and p_ends_at is not null and p_starts_at > p_ends_at then
    raise exception 'Janela de datas invalida para o lote.';
  end if;

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = p_batch_id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if p_max_confirmed_registrations < v_confirmed_count then
    raise exception 'Nao e permitido reduzir limite abaixo das inscricoes confirmadas (%).', v_confirmed_count;
  end if;

  select exists (
    select 1
    from public.participants p
    where p.batch_id = p_batch_id
  ) into v_has_registrations;

  if v_has_registrations then
    if round(p_male_price, 2) <> round(v_batch.male_price, 2)
       or round(p_female_price, 2) <> round(v_batch.female_price, 2) then
      raise exception 'Nao e permitido alterar preco de lote ja utilizado.';
    end if;
  end if;

  if coalesce(p_is_active, false) then
    update public.registration_batches
    set is_active = false,
        updated_at = now()
    where event_id = p_event_id
      and id <> p_batch_id;
  end if;

  update public.registration_batches
  set
    name = trim(p_name),
    sequence_number = p_sequence_number,
    male_price = round(p_male_price, 2),
    female_price = round(p_female_price, 2),
    max_confirmed_registrations = p_max_confirmed_registrations,
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    is_active = coalesce(p_is_active, false),
    updated_at = now()
  where id = p_batch_id
    and event_id = p_event_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_updated',
    'registration_batches',
    p_batch_id,
    jsonb_build_object(
      'name', trim(p_name),
      'sequence_number', p_sequence_number,
      'male_price', round(p_male_price, 2),
      'female_price', round(p_female_price, 2),
      'max_confirmed_registrations', p_max_confirmed_registrations,
      'is_active', coalesce(p_is_active, false)
    ),
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."update_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_registration_batch_with_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text" DEFAULT NULL::"text", "p_starts_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_ends_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_is_active" boolean DEFAULT false, "p_prices" "jsonb" DEFAULT '[]'::"jsonb") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_batch public.registration_batches%rowtype;
  v_name text;
  v_item jsonb;
  v_ticket_category_id uuid;
  v_enabled boolean;
  v_male_price numeric;
  v_female_price numeric;
  v_max_confirmed integer;
  v_enabled_count integer := 0;
  v_sum_max_confirmed integer := 0;
  v_legacy_male_price numeric := null;
  v_legacy_female_price numeric := null;
begin
  if p_batch_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select * into v_batch
  from public.registration_batches
  where id = p_batch_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Lote nao encontrado para o evento.';
  end if;

  if p_starts_at is not null and p_ends_at is not null and p_ends_at < p_starts_at then
    raise exception 'Data final nao pode ser anterior a data inicial.';
  end if;

  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then
    raise exception 'Lista de precos por categoria invalida.';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_prices)
  loop
    begin
      v_ticket_category_id := (v_item->>'ticket_category_id')::uuid;
    exception
      when others then
        raise exception 'Categoria invalida na lista de precos.';
    end;

    v_enabled := coalesce((v_item->>'enabled')::boolean, false);
    v_male_price := nullif(v_item->>'male_price', '')::numeric;
    v_female_price := nullif(v_item->>'female_price', '')::numeric;
    v_max_confirmed := nullif(v_item->>'max_confirmed_registrations', '')::integer;

    if not exists (
      select 1
      from public.ticket_categories tc
      where tc.id = v_ticket_category_id
        and tc.event_id = p_event_id
        and tc.is_active = true
    ) then
      raise exception 'Categoria % nao pertence ao evento ativo.', v_ticket_category_id;
    end if;

    if not v_enabled then
      continue;
    end if;

    if v_male_price is null or v_female_price is null then
      raise exception 'Toda categoria ativa deve possuir preco masculino e feminino.';
    end if;

    if v_male_price < 0 or v_female_price < 0 then
      raise exception 'Precos devem ser maiores ou iguais a zero.';
    end if;

    if v_max_confirmed is not null and v_max_confirmed <= 0 then
      raise exception 'Limite de confirmados deve ser maior que zero quando informado.';
    end if;

    if v_max_confirmed is null and p_ends_at is null then
      raise exception 'Toda categoria ativa deve possuir um limite de confirmados, uma data de encerramento do lote, ou os dois.';
    end if;

    v_enabled_count := v_enabled_count + 1;
    v_sum_max_confirmed := v_sum_max_confirmed + coalesce(v_max_confirmed, 0);

    if v_enabled_count = 1 then
      v_legacy_male_price := round(v_male_price, 2);
      v_legacy_female_price := round(v_female_price, 2);
    end if;
  end loop;

  if v_enabled_count = 0 then
    raise exception 'Ative pelo menos uma categoria no lote.';
  end if;

  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), format('%sº Lote', v_batch.sequence_number));

  if coalesce(p_is_active, false) then
    update public.registration_batches
    set is_active = false,
        updated_at = now()
    where event_id = p_event_id
      and id <> p_batch_id;
  end if;

  update public.registration_batches
  set
    name = v_name,
    male_price = v_legacy_male_price,
    female_price = v_legacy_female_price,
    max_confirmed_registrations = v_sum_max_confirmed,
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    is_active = coalesce(p_is_active, false),
    updated_at = now()
  where id = p_batch_id
    and event_id = p_event_id;

  -- Valida reducao abaixo do confirmado (por categoria) dentro do proprio
  -- upsert_registration_batch_prices, que ja compara cada item com o
  -- confirmado daquela (lote, categoria) antes de gravar.
  perform public.upsert_registration_batch_prices(
    p_batch_id,
    p_event_id,
    p_prices
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_updated',
    'registration_batches',
    p_batch_id,
    jsonb_build_object(
      'name', v_name,
      'sequence_number', v_batch.sequence_number,
      'male_price', v_legacy_male_price,
      'female_price', v_legacy_female_price,
      'max_confirmed_registrations_sum', v_sum_max_confirmed,
      'is_active', coalesce(p_is_active, false),
      'enabled_categories', v_enabled_count,
      'sequence_locked', true,
      'per_category_limits', true,
      'optional_limit_with_dates', true
    ),
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."update_registration_batch_with_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text" DEFAULT NULL::"text", "p_capacity" integer DEFAULT NULL::integer, "p_is_active" boolean DEFAULT true, "p_sort_order" integer DEFAULT 0) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_category public.ticket_categories%rowtype;
  v_name text := trim(coalesce(p_name, ''));
  v_slug text := trim(coalesce(p_slug, ''));
begin
  if p_category_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select * into v_category
  from public.ticket_categories
  where id = p_category_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Categoria nao encontrada para o evento.';
  end if;

  if v_name = '' then
    raise exception 'Nome da categoria obrigatorio.';
  end if;

  if v_slug = '' then
    v_slug := lower(regexp_replace(v_name, '[^a-z0-9]+', '-', 'g'));
  end if;

  if p_capacity is not null and p_capacity <= 0 then
    raise exception 'Capacidade deve ser maior que zero.';
  end if;

  update public.ticket_categories
  set
    name = v_name,
    slug = v_slug,
    description = nullif(trim(coalesce(p_description, '')), ''),
    capacity = p_capacity,
    is_active = coalesce(p_is_active, true),
    sort_order = coalesce(p_sort_order, 0),
    updated_at = now()
  where id = p_category_id
    and event_id = p_event_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'ticket_category_updated',
    'ticket_categories',
    p_category_id,
    jsonb_build_object(
      'name', v_name,
      'slug', v_slug,
      'capacity', p_capacity,
      'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0)
    ),
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."update_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_admin_user_access"("p_target_user_id" "uuid", "p_role_id" "uuid", "p_is_active" boolean DEFAULT true, "p_internal_note" "text" DEFAULT NULL::"text", "p_overrides" "jsonb" DEFAULT '[]'::"jsonb", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = v_actor_user_id),
    'system'
  );
  v_actor_is_owner boolean := false;
  v_actor_can_edit_permissions boolean := false;
  v_actor_can_disable_user boolean := false;
  v_target_exists boolean := false;
  v_target_before_is_owner boolean := false;
  v_target_after_is_owner boolean := false;
  v_target_before_role_id uuid;
  v_target_before_active boolean := false;
  v_target_before_note text;
  v_role_code text;
  v_before_effective text[] := array[]::text[];
  v_after_effective text[] := array[]::text[];
  v_added text[] := array[]::text[];
  v_removed text[] := array[]::text[];
  v_invalid_override_count integer := 0;
  v_forbidden_grant text;
begin
  if v_actor_user_id is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  if p_target_user_id is null then
    raise exception 'Usuario alvo obrigatorio.';
  end if;

  v_actor_is_owner := public.is_active_owner(v_actor_user_id);
  v_actor_can_edit_permissions :=
    v_actor_is_owner
    or public.resolve_user_permission(v_actor_user_id, 'team.edit_permissions');
  v_actor_can_disable_user :=
    v_actor_is_owner
    or public.resolve_user_permission(v_actor_user_id, 'team.disable_user');

  if not v_actor_can_edit_permissions then
    raise exception 'Sem permissao para editar acessos da equipe.';
  end if;

  select exists (
    select 1
    from auth.users u
    where u.id = p_target_user_id
  )
  into v_target_exists;

  if not v_target_exists then
    raise exception 'Usuario alvo nao encontrado no Auth.';
  end if;

  select
    au.role_id,
    au.is_active,
    au.internal_note
  into
    v_target_before_role_id,
    v_target_before_active,
    v_target_before_note
  from public.admin_users au
  where au.user_id = p_target_user_id;

  v_target_before_is_owner := public.is_active_owner(p_target_user_id);

  if p_role_id is not null then
    select ar.code
    into v_role_code
    from public.admin_roles ar
    where ar.id = p_role_id
      and ar.is_active = true
    limit 1;

    if v_role_code is null then
      raise exception 'Funcao selecionada nao existe ou esta inativa.';
    end if;
  else
    v_role_code := null;
  end if;

  if v_target_before_is_owner and not v_actor_is_owner then
    raise exception 'Somente Owner pode editar outro Owner.';
  end if;

  if v_role_code = 'owner' and not v_actor_is_owner then
    raise exception 'Somente Owner pode promover usuario para Owner.';
  end if;

  if coalesce(p_is_active, true) = false and not v_actor_can_disable_user then
    raise exception 'Sem permissao para desativar usuario da equipe.';
  end if;

  select count(*)
  into v_invalid_override_count
  from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
  left join public.admin_permissions ap
    on ap.code = trim(coalesce(item ->> 'permission_code', ''))
   and ap.is_active = true
  where trim(coalesce(item ->> 'permission_code', '')) = ''
     or trim(coalesce(item ->> 'effect', '')) not in ('allow', 'deny')
     or ap.id is null;

  if v_invalid_override_count > 0 then
    raise exception 'Overrides invalidos: use permission_code valido e effect em allow/deny.';
  end if;

  if not v_actor_is_owner then
    with role_codes as (
      select p.code
      from public.admin_role_permissions arp
      join public.admin_permissions p
        on p.id = arp.permission_id
      where arp.role_id = p_role_id
        and p.is_active = true
    ),
    override_codes as (
      select
        trim(coalesce(item ->> 'permission_code', '')) as code,
        trim(coalesce(item ->> 'effect', '')) as effect
      from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
    ),
    denied as (
      select code
      from override_codes
      where effect = 'deny'
    ),
    allowed as (
      select code
      from override_codes
      where effect = 'allow'
    ),
    desired as (
      select code from role_codes
      union
      select code from allowed
      except
      select code from denied
    )
    select d.code
    into v_forbidden_grant
    from desired d
    where not public.resolve_user_permission(v_actor_user_id, d.code)
    limit 1;

    if v_forbidden_grant is not null then
      raise exception 'Voce nao pode conceder permissao que nao possui: %', v_forbidden_grant;
    end if;
  end if;

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
  into v_before_effective
  from public.admin_permissions ap
  where ap.is_active = true
    and public.resolve_user_permission(p_target_user_id, ap.code);

  insert into public.admin_users (
    user_id,
    role_id,
    is_active,
    internal_note
  )
  values (
    p_target_user_id,
    p_role_id,
    coalesce(p_is_active, true),
    nullif(trim(coalesce(p_internal_note, '')), '')
  )
  on conflict (user_id)
  do update set
    role_id = excluded.role_id,
    is_active = excluded.is_active,
    internal_note = excluded.internal_note,
    updated_at = now();

  delete from public.admin_user_permission_overrides
  where user_id = p_target_user_id;

  insert into public.admin_user_permission_overrides (
    user_id,
    permission_id,
    effect
  )
  select
    p_target_user_id,
    ap.id,
    trim(item ->> 'effect')
  from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) as item
  join public.admin_permissions ap
    on ap.code = trim(item ->> 'permission_code')
   and ap.is_active = true
  on conflict (user_id, permission_id)
  do update set
    effect = excluded.effect,
    updated_at = now();

  v_target_after_is_owner := public.is_active_owner(p_target_user_id);

  select coalesce(array_agg(ap.code order by ap.code), array[]::text[])
  into v_after_effective
  from public.admin_permissions ap
  where ap.is_active = true
    and public.resolve_user_permission(p_target_user_id, ap.code);

  select coalesce(array_agg(code order by code), array[]::text[])
  into v_added
  from (
    select unnest(v_after_effective)
    except
    select unnest(v_before_effective)
  ) t(code);

  select coalesce(array_agg(code order by code), array[]::text[])
  into v_removed
  from (
    select unnest(v_before_effective)
    except
    select unnest(v_after_effective)
  ) t(code);

  if to_regclass('public.audit_logs') is not null then
    insert into public.audit_logs (
      action,
      entity_type,
      entity_id,
      event_id,
      details
    )
    values (
      'admin_access_updated',
      'admin_users',
      p_target_user_id,
      null,
      jsonb_build_object(
        'actor_user_id', v_actor_user_id,
        'actor_email', v_actor_email,
        'target_user_id', p_target_user_id,
        'target_before_role_id', v_target_before_role_id,
        'target_after_role_id', p_role_id,
        'target_before_is_owner', v_target_before_is_owner,
        'target_after_is_owner', v_target_after_is_owner,
        'status_before', coalesce(v_target_before_active, false),
        'status_after', coalesce(p_is_active, true),
        'internal_note_before', v_target_before_note,
        'internal_note_after', nullif(trim(coalesce(p_internal_note, '')), ''),
        'added_permissions', coalesce(v_added, array[]::text[]),
        'removed_permissions', coalesce(v_removed, array[]::text[]),
        'reason', nullif(trim(coalesce(p_reason, '')), '')
      )
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'target_user_id', p_target_user_id,
    'added_permissions', coalesce(v_added, array[]::text[]),
    'removed_permissions', coalesce(v_removed, array[]::text[])
  );
end;
$$;


ALTER FUNCTION "public"."upsert_admin_user_access"("p_target_user_id" "uuid", "p_role_id" "uuid", "p_is_active" boolean, "p_internal_note" "text", "p_overrides" "jsonb", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_current_event_import_participant"("p_import_batch_id" "uuid", "p_import_batch_row_id" "uuid", "p_expected_participant_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_batch_id" "uuid", "p_ticket_category_id" "uuid", "p_payment_method" "text" DEFAULT 'pix'::"text", "p_import_issues" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_batch public.import_batches%rowtype; v_row public.import_batch_rows%rowtype;
  v_event public.events%rowtype; v_p public.participants%rowtype; v_count integer; v_created boolean:=false;
  v_cpf text:=nullif(regexp_replace(coalesce(p_cpf,''),'\D','','g'),''); v_issue jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_batch from public.import_batches where id=p_import_batch_id for update;
  if not found or v_batch.import_type<>'current_event_registrations' or v_batch.imported_by<>v_actor then raise exception 'Lote de importacao invalido.'; end if;
  select * into v_event from public.events where id=v_batch.event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  select * into v_row from public.import_batch_rows where id=p_import_batch_row_id and import_batch_id=v_batch.id for update;
  if not found then raise exception 'Linha de importacao invalida.'; end if;
  if nullif(trim(p_full_name),'') is null then raise exception 'Nome obrigatorio ausente.'; end if;
  if p_registration_batch_id is not null and not exists(select 1 from public.registration_batches where id=p_registration_batch_id and event_id=v_event.id) then raise exception 'Lote nao pertence ao evento.'; end if;
  if p_ticket_category_id is not null and not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=v_event.id) then raise exception 'Categoria nao pertence ao evento.'; end if;

  if v_row.resolution='link_existing' and v_row.matched_participant_id is not null then
    select * into v_p from public.participants where id=v_row.matched_participant_id and event_id=v_event.id for update;
  elsif p_expected_participant_id is not null then
    select * into v_p from public.participants where id=p_expected_participant_id and event_id=v_event.id for update;
  elsif public.is_valid_cpf(v_cpf) then
    select count(*) into v_count from public.participants where event_id=v_event.id and regexp_replace(coalesce(cpf,''),'\D','','g')=v_cpf;
    if v_count>1 then raise exception 'CPF possui mais de um participant no evento; revisao administrativa obrigatoria.'; end if;
    if v_count=1 then select * into v_p from public.participants where event_id=v_event.id and regexp_replace(coalesce(cpf,''),'\D','','g')=v_cpf for update; end if;
  end if;

  if v_p.id is null then
    insert into public.participants(event_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,shirt_type,shirt_size,
      registration_status,reservation_status,batch_id,ticket_category_id,notes)
    values(v_event.id,null,trim(p_full_name),v_cpf,p_birth_date,nullif(trim(p_gender),''),nullif(trim(p_phone),''),
      lower(nullif(trim(p_email),'')),nullif(trim(p_city),''),nullif(trim(p_shirt_type),''),nullif(trim(p_shirt_size),''),
      'pending','pending',p_registration_batch_id,p_ticket_category_id,'Importacao administrativa') returning * into v_p;
    v_created:=true;
  else
    if public.is_valid_cpf(v_p.cpf) and public.is_valid_cpf(v_cpf)
      and regexp_replace(v_p.cpf,'\D','','g')<>v_cpf then raise exception 'CPF legitimo existente diverge da linha importada.'; end if;
    update public.participants set full_name=trim(p_full_name),
      cpf=case when public.is_valid_cpf(cpf) then cpf else coalesce(v_cpf,cpf) end,
      birth_date=coalesce(p_birth_date,birth_date),gender=coalesce(nullif(trim(p_gender),''),gender),
      phone=coalesce(nullif(trim(p_phone),''),phone),email=coalesce(lower(nullif(trim(p_email),'')),email),
      city=coalesce(nullif(trim(p_city),''),city),shirt_type=coalesce(nullif(trim(p_shirt_type),''),shirt_type),
      shirt_size=coalesce(nullif(trim(p_shirt_size),''),shirt_size),batch_id=coalesce(p_registration_batch_id,batch_id),
      ticket_category_id=coalesce(p_ticket_category_id,ticket_category_id),updated_at=now()
    where id=v_p.id returning * into v_p;
  end if;

  update public.import_batch_rows set matched_participant_id=v_p.id,matched_user_id=null where id=v_row.id;
  perform public.reevaluate_participant_data_issues(v_p.id,v_batch.id);
  for v_issue in select value from jsonb_array_elements(coalesce(p_import_issues,'[]'::jsonb)) loop
    insert into public.participant_data_issues(organization_id,event_id,participant_id,import_batch_id,
      field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery)
    values(v_event.organization_id,v_event.id,v_p.id,v_batch.id,v_issue->>'field_code',v_issue->>'issue_type',
      v_issue->>'message',coalesce((v_issue->>'blocks_payment')::boolean,false),
      coalesce((v_issue->>'blocks_ticket_issuance')::boolean,false),coalesce((v_issue->>'blocks_checkin')::boolean,false),
      coalesce((v_issue->>'blocks_kit_delivery')::boolean,false)) on conflict do nothing;
  end loop;
  update public.payments set payment_method=coalesce(nullif(trim(p_payment_method),''),payment_method)
  where participant_id=v_p.id and payment_status<>'paid';
  return jsonb_build_object('participant_id',v_p.id,'created',v_created,'user_id',v_p.user_id,
    'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_p.id));
end; $$;


ALTER FUNCTION "public"."upsert_current_event_import_participant"("p_import_batch_id" "uuid", "p_import_batch_row_id" "uuid", "p_expected_participant_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_batch_id" "uuid", "p_ticket_category_id" "uuid", "p_payment_method" "text", "p_import_issues" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_customer_profile"("p_user_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_city" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_user_id is null then
    raise exception 'Usuario obrigatorio.';
  end if;

  insert into public.customer_profiles (
    user_id,
    full_name,
    cpf,
    birth_date,
    gender,
    phone,
    city
  ) values (
    p_user_id,
    nullif(trim(coalesce(p_full_name, '')), ''),
    nullif(trim(coalesce(p_cpf, '')), ''),
    p_birth_date,
    nullif(trim(coalesce(p_gender, '')), ''),
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_city, '')), '')
  )
  on conflict (user_id)
  do update set
    full_name = excluded.full_name,
    cpf = excluded.cpf,
    birth_date = excluded.birth_date,
    gender = excluded.gender,
    phone = excluded.phone,
    city = excluded.city,
    updated_at = now();

  return true;
end;
$$;


ALTER FUNCTION "public"."upsert_customer_profile"("p_user_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_city" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_addon_option"("p_event_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer, "p_is_active" boolean, "p_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do adicional obrigatorio.';
  end if;

  if p_id is null then
    insert into public.event_addon_options (
      event_id,
      name,
      description,
      sort_order,
      is_active
    ) values (
      p_event_id,
      trim(p_name),
      nullif(trim(coalesce(p_description, '')), ''),
      coalesce(p_sort_order, 0),
      coalesce(p_is_active, true)
    )
    returning id into v_id;
  else
    update public.event_addon_options
       set name = trim(p_name),
           description = nullif(trim(coalesce(p_description, '')), ''),
           sort_order = coalesce(p_sort_order, 0),
           is_active = coalesce(p_is_active, true),
           updated_at = now()
     where id = p_id
       and event_id = p_event_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Adicional nao encontrado para este evento.';
    end if;
  end if;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."upsert_event_addon_option"("p_event_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer, "p_is_active" boolean, "p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_addons_config"("p_event_id" "uuid", "p_apply_to_all_batches" boolean, "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  insert into public.event_addons_config (
    event_id,
    apply_to_all_batches,
    kit_enabled,
    custom_cup_enabled,
    gifts_enabled
  ) values (
    p_event_id,
    coalesce(p_apply_to_all_batches, true),
    coalesce(p_kit_enabled, false),
    coalesce(p_custom_cup_enabled, false),
    coalesce(p_gifts_enabled, false)
  )
  on conflict (event_id)
  do update set
    apply_to_all_batches = excluded.apply_to_all_batches,
    kit_enabled = excluded.kit_enabled,
    custom_cup_enabled = excluded.custom_cup_enabled,
    gifts_enabled = excluded.gifts_enabled,
    updated_at = now();

  if coalesce(p_apply_to_all_batches, true) = true then
    delete from public.registration_batch_addons
    where event_id = p_event_id;
  end if;
end;
$$;


ALTER FUNCTION "public"."upsert_event_addons_config"("p_event_id" "uuid", "p_apply_to_all_batches" boolean, "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_addons_model"("p_event_id" "uuid", "p_apply_to_all_batches" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  insert into public.event_addons_model (event_id, apply_to_all_batches)
  values (p_event_id, coalesce(p_apply_to_all_batches, true))
  on conflict (event_id)
  do update set
    apply_to_all_batches = excluded.apply_to_all_batches,
    updated_at = now();
end;
$$;


ALTER FUNCTION "public"."upsert_event_addons_model"("p_event_id" "uuid", "p_apply_to_all_batches" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_attraction"("p_id" "uuid" DEFAULT NULL::"uuid", "p_event_id" "uuid" DEFAULT NULL::"uuid", "p_name" "text" DEFAULT NULL::"text", "p_description" "text" DEFAULT NULL::"text", "p_banner_url" "text" DEFAULT NULL::"text", "p_is_active" boolean DEFAULT true, "p_sort_order" integer DEFAULT 0) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
  v_id uuid := p_id;
begin
  if v_actor is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  if not public.current_user_has_permission('events.edit') then
    raise exception 'Permissao insuficiente para gerenciar atracoes.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Acesso negado a organizacao.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome da atracao obrigatorio.';
  end if;

  if v_id is null then
    insert into public.event_attractions (
      event_id, name, description, banner_url, is_active, sort_order
    ) values (
      p_event_id,
      trim(p_name),
      nullif(trim(coalesce(p_description, '')), ''),
      nullif(trim(coalesce(p_banner_url, '')), ''),
      coalesce(p_is_active, true),
      coalesce(p_sort_order, 0)
    )
    returning id into v_id;
  else
    update public.event_attractions
    set name = trim(p_name),
        description = nullif(trim(coalesce(p_description, '')), ''),
        banner_url = nullif(trim(coalesce(p_banner_url, '')), ''),
        is_active = coalesce(p_is_active, true),
        sort_order = coalesce(p_sort_order, 0),
        updated_at = now()
    where id = v_id
      and event_id = p_event_id;

    if not found then
      raise exception 'Atracao nao encontrada para o evento.';
    end if;
  end if;

  insert into public.audit_logs (
    action, entity_type, entity_id, event_id, details
  ) values (
    case when p_id is null then 'event_attraction_created' else 'event_attraction_updated' end,
    'event_attractions',
    v_id,
    p_event_id,
    jsonb_build_object(
      'name', trim(p_name),
      'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0)
    )
  );

  return v_id;
end;
$$;


ALTER FUNCTION "public"."upsert_event_attraction"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_description" "text", "p_banner_url" "text", "p_is_active" boolean, "p_sort_order" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_batch_addon_option"("p_event_id" "uuid", "p_batch_id" "uuid", "p_option_id" "uuid", "p_enabled" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_event_id is null or p_batch_id is null or p_option_id is null then
    raise exception 'Evento, lote e adicional obrigatorios.';
  end if;

  if not exists (
    select 1
    from public.registration_batches b
    where b.id = p_batch_id
      and b.event_id = p_event_id
  ) then
    raise exception 'Lote nao pertence ao evento informado.';
  end if;

  if not exists (
    select 1
    from public.event_addon_options o
    where o.id = p_option_id
      and o.event_id = p_event_id
  ) then
    raise exception 'Adicional nao pertence ao evento informado.';
  end if;

  insert into public.event_batch_addon_options (
    event_id,
    batch_id,
    option_id,
    enabled
  ) values (
    p_event_id,
    p_batch_id,
    p_option_id,
    coalesce(p_enabled, true)
  )
  on conflict (batch_id, option_id)
  do update set
    enabled = excluded.enabled,
    updated_at = now();
end;
$$;


ALTER FUNCTION "public"."upsert_event_batch_addon_option"("p_event_id" "uuid", "p_batch_id" "uuid", "p_option_id" "uuid", "p_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_highlight"("p_event_id" "uuid", "p_sort_order" integer, "p_is_active" boolean DEFAULT true) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  insert into public.event_highlights (event_id, sort_order, is_active)
  values (p_event_id, coalesce(p_sort_order, 0), coalesce(p_is_active, true))
  on conflict (event_id)
  do update
    set sort_order = excluded.sort_order,
        is_active = excluded.is_active,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."upsert_event_highlight"("p_event_id" "uuid", "p_sort_order" integer, "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_kit_item"("p_id" "uuid" DEFAULT NULL::"uuid", "p_event_id" "uuid" DEFAULT NULL::"uuid", "p_name" "text" DEFAULT NULL::"text", "p_slug" "text" DEFAULT NULL::"text", "p_description" "text" DEFAULT NULL::"text", "p_item_type" "text" DEFAULT 'other'::"text", "p_quantity_per_participant" integer DEFAULT 1, "p_requires_variant" boolean DEFAULT false, "p_is_required" boolean DEFAULT true, "p_is_active" boolean DEFAULT true, "p_sort_order" integer DEFAULT 0) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid := p_id;
  v_slug text;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do item obrigatorio.';
  end if;

  if p_item_type not in ('shirt', 'cup', 'strap', 'cup_holder', 'wristband', 'badge', 'voucher', 'other') then
    raise exception 'Tipo de item invalido.';
  end if;

  if coalesce(p_quantity_per_participant, 0) <= 0 then
    raise exception 'Quantidade por participante deve ser maior que zero.';
  end if;

  v_slug := public.slugify_text(coalesce(nullif(trim(p_slug), ''), p_name));

  if v_id is null then
    insert into public.event_kit_items (
      event_id,
      name,
      slug,
      description,
      item_type,
      quantity_per_participant,
      requires_variant,
      is_required,
      is_active,
      sort_order
    ) values (
      p_event_id,
      trim(p_name),
      v_slug,
      nullif(trim(coalesce(p_description, '')), ''),
      p_item_type,
      p_quantity_per_participant,
      coalesce(p_requires_variant, false),
      coalesce(p_is_required, true),
      coalesce(p_is_active, true),
      coalesce(p_sort_order, 0)
    ) returning id into v_id;
  else
    update public.event_kit_items
    set
      name = trim(p_name),
      slug = v_slug,
      description = nullif(trim(coalesce(p_description, '')), ''),
      item_type = p_item_type,
      quantity_per_participant = p_quantity_per_participant,
      requires_variant = coalesce(p_requires_variant, false),
      is_required = coalesce(p_is_required, true),
      is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0),
      updated_at = now()
    where id = v_id
      and event_id = p_event_id;

    if not found then
      raise exception 'Item de kit nao encontrado para o evento.';
    end if;
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    case when p_id is null then 'event_kit_item_created' else 'event_kit_item_updated' end,
    'event_kit_items',
    v_id,
    p_event_id,
    jsonb_build_object(
      'name', trim(p_name),
      'slug', v_slug,
      'item_type', p_item_type,
      'quantity_per_participant', p_quantity_per_participant,
      'requires_variant', coalesce(p_requires_variant, false),
      'is_required', coalesce(p_is_required, true),
      'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0)
    )
  );

  return v_id;
end;
$$;


ALTER FUNCTION "public"."upsert_event_kit_item"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_item_type" "text", "p_quantity_per_participant" integer, "p_requires_variant" boolean, "p_is_required" boolean, "p_is_active" boolean, "p_sort_order" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_kit_item_variant"("p_id" "uuid" DEFAULT NULL::"uuid", "p_kit_item_id" "uuid" DEFAULT NULL::"uuid", "p_name" "text" DEFAULT NULL::"text", "p_value" "text" DEFAULT NULL::"text", "p_sort_order" integer DEFAULT 0, "p_is_active" boolean DEFAULT true) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid := p_id;
begin
  if p_kit_item_id is null then
    raise exception 'Item de kit obrigatorio.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome da variacao obrigatorio.';
  end if;

  if coalesce(trim(p_value), '') = '' then
    raise exception 'Valor da variacao obrigatorio.';
  end if;

  if v_id is null then
    insert into public.event_kit_item_variants (
      kit_item_id,
      name,
      value,
      sort_order,
      is_active
    ) values (
      p_kit_item_id,
      trim(p_name),
      trim(p_value),
      coalesce(p_sort_order, 0),
      coalesce(p_is_active, true)
    ) returning id into v_id;
  else
    update public.event_kit_item_variants
    set
      name = trim(p_name),
      value = trim(p_value),
      sort_order = coalesce(p_sort_order, 0),
      is_active = coalesce(p_is_active, true)
    where id = v_id
      and kit_item_id = p_kit_item_id;

    if not found then
      raise exception 'Variacao nao encontrada.';
    end if;
  end if;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."upsert_event_kit_item_variant"("p_id" "uuid", "p_kit_item_id" "uuid", "p_name" "text", "p_value" "text", "p_sort_order" integer, "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_payment_methods"("p_event_id" "uuid", "p_pix_enabled" boolean DEFAULT true, "p_credit_card_single_enabled" boolean DEFAULT true, "p_credit_card_installments_enabled" boolean DEFAULT true) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if p_event_id is null then
    raise exception 'Evento invalido.';
  end if;

  if not coalesce(p_pix_enabled, false)
     and not coalesce(p_credit_card_single_enabled, false)
     and not coalesce(p_credit_card_installments_enabled, false) then
    raise exception 'Selecione pelo menos uma forma de pagamento.';
  end if;

  insert into public.event_payment_methods (
    event_id,
    pix_enabled,
    credit_card_single_enabled,
    credit_card_installments_enabled,
    created_at,
    updated_at
  )
  values (
    p_event_id,
    coalesce(p_pix_enabled, true),
    coalesce(p_credit_card_single_enabled, true),
    coalesce(p_credit_card_installments_enabled, true),
    now(),
    now()
  )
  on conflict (event_id) do update
  set
    pix_enabled = excluded.pix_enabled,
    credit_card_single_enabled = excluded.credit_card_single_enabled,
    credit_card_installments_enabled = excluded.credit_card_installments_enabled,
    updated_at = now();
end;
$$;


ALTER FUNCTION "public"."upsert_event_payment_methods"("p_event_id" "uuid", "p_pix_enabled" boolean, "p_credit_card_single_enabled" boolean, "p_credit_card_installments_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_event_schedule_item"("p_event_id" "uuid", "p_delivery_at" timestamp with time zone, "p_title" "text", "p_location" "text" DEFAULT NULL::"text", "p_description" "text" DEFAULT NULL::"text", "p_schedule_type" "text" DEFAULT 'other'::"text", "p_id" "uuid" DEFAULT NULL::"uuid", "p_sort_order" integer DEFAULT 0, "p_is_active" boolean DEFAULT true, "p_is_visible_to_users" boolean DEFAULT true) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_id uuid; v_org uuid;
begin
  if auth.uid() is null or not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao.'; end if;
  select organization_id into v_org from public.events where id=p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if p_delivery_at is null or nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Data, horario e titulo sao obrigatorios.'; end if;
  if p_schedule_type not in('kit_pickup','gates_open','event_start','attraction','accreditation','meeting','closing','other') then raise exception 'Tipo de compromisso invalido.'; end if;
  if p_id is null then
    insert into public.kit_delivery_schedule(event_id,delivery_at,title,location,description,schedule_type,sort_order,is_active,is_visible_to_users)
    values(p_event_id,p_delivery_at,trim(p_title),nullif(trim(coalesce(p_location,'')),''),nullif(trim(coalesce(p_description,'')),''),p_schedule_type,coalesce(p_sort_order,0),coalesce(p_is_active,true),coalesce(p_is_visible_to_users,true)) returning id into v_id;
  else
    update public.kit_delivery_schedule set delivery_at=p_delivery_at,title=trim(p_title),location=nullif(trim(coalesce(p_location,'')),''),description=nullif(trim(coalesce(p_description,'')),''),schedule_type=p_schedule_type,sort_order=coalesce(p_sort_order,0),is_active=coalesce(p_is_active,true),is_visible_to_users=coalesce(p_is_visible_to_users,true),updated_at=now()
    where id=p_id and event_id=p_event_id returning id into v_id;
    if v_id is null then raise exception 'Compromisso nao encontrado neste evento.'; end if;
  end if;
  return v_id;
end; $$;


ALTER FUNCTION "public"."upsert_event_schedule_item"("p_event_id" "uuid", "p_delivery_at" timestamp with time zone, "p_title" "text", "p_location" "text", "p_description" "text", "p_schedule_type" "text", "p_id" "uuid", "p_sort_order" integer, "p_is_active" boolean, "p_is_visible_to_users" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_financial_account"("p_organization_id" "uuid", "p_account_id" "uuid", "p_code" "text", "p_name" "text", "p_account_type" "text", "p_is_active" boolean, "p_idempotency_key" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_id uuid;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_accounts') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_account_type not in('asset','liability','equity','revenue','expense') or nullif(trim(p_code),'') is null or nullif(trim(p_name),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Conta financeira invalida.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':account:'||trim(p_idempotency_key),0));
  select entity_id into v_id from public.audit_logs where action='financial_account_upserted' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key) order by created_at limit 1; if v_id is not null then return v_id; end if;
  if p_account_id is null then insert into public.financial_accounts(organization_id,code,name,account_type,is_active) values(p_organization_id,trim(p_code),trim(p_name),p_account_type,coalesce(p_is_active,true)) on conflict(organization_id,code) do update set name=excluded.name,account_type=excluded.account_type,is_active=excluded.is_active,updated_at=now() returning id into v_id;
  else update public.financial_accounts set code=trim(p_code),name=trim(p_name),account_type=p_account_type,is_active=coalesce(p_is_active,true),updated_at=now() where id=p_account_id and organization_id=p_organization_id returning id into v_id; if v_id is null then raise exception 'Conta financeira nao encontrada.'; end if; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_account_upserted','financial_accounts',v_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;


ALTER FUNCTION "public"."upsert_financial_account"("p_organization_id" "uuid", "p_account_id" "uuid", "p_code" "text", "p_name" "text", "p_account_type" "text", "p_is_active" boolean, "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_name" "text", "p_entry_kind" "text", "p_is_active" boolean, "p_idempotency_key" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_id uuid;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_categories') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_entry_kind not in('revenue','expense','both') or nullif(trim(p_name),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Categoria financeira invalida.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':category:'||trim(p_idempotency_key),0));
  select entity_id into v_id from public.audit_logs where action='financial_category_upserted' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key) order by created_at limit 1; if v_id is not null then return v_id; end if;
  if p_category_id is null then insert into public.financial_categories(organization_id,name,entry_kind,is_active) values(p_organization_id,trim(p_name),p_entry_kind,coalesce(p_is_active,true)) on conflict(organization_id,name) do update set entry_kind=excluded.entry_kind,is_active=excluded.is_active,updated_at=now() returning id into v_id;
  else update public.financial_categories set name=trim(p_name),entry_kind=p_entry_kind,is_active=coalesce(p_is_active,true),updated_at=now() where id=p_category_id and organization_id=p_organization_id returning id into v_id; if v_id is null then raise exception 'Categoria financeira nao encontrada.'; end if; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_category_upserted','financial_categories',v_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;


ALTER FUNCTION "public"."upsert_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_name" "text", "p_entry_kind" "text", "p_is_active" boolean, "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_legal_name" "text", "p_display_name" "text", "p_tax_identifier" "text", "p_is_active" boolean, "p_idempotency_key" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_tax text:=nullif(regexp_replace(coalesce(p_tax_identifier,''),'[^0-9]','','g'),'');
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_suppliers') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if nullif(trim(p_legal_name),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Fornecedor invalido.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':supplier:'||trim(p_idempotency_key),0));
  select entity_id into v_id from public.audit_logs where action='financial_supplier_upserted' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key) order by created_at limit 1;
  if v_id is not null then return v_id; end if;
  if p_supplier_id is null then
    if v_tax is not null then select id into v_id from public.financial_suppliers where organization_id=p_organization_id and tax_identifier=v_tax for update; end if;
    if v_id is null then insert into public.financial_suppliers(organization_id,legal_name,display_name,tax_identifier,is_active) values(p_organization_id,trim(p_legal_name),nullif(trim(p_display_name),''),v_tax,coalesce(p_is_active,true)) returning id into v_id;
    else update public.financial_suppliers set legal_name=trim(p_legal_name),display_name=nullif(trim(p_display_name),''),is_active=coalesce(p_is_active,true),updated_at=now() where id=v_id; end if;
  else
    update public.financial_suppliers set legal_name=trim(p_legal_name),display_name=nullif(trim(p_display_name),''),tax_identifier=v_tax,is_active=coalesce(p_is_active,true),updated_at=now() where id=p_supplier_id and organization_id=p_organization_id returning id into v_id;
    if v_id is null then raise exception 'Fornecedor financeiro nao encontrado.'; end if;
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_supplier_upserted','financial_suppliers',v_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;


ALTER FUNCTION "public"."upsert_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_legal_name" "text", "p_display_name" "text", "p_tax_identifier" "text", "p_is_active" boolean, "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_kit_delivery_schedule"("p_delivery_at" timestamp with time zone, "p_city" "text", "p_location" "text", "p_id" "uuid" DEFAULT NULL::"uuid", "p_sort_order" integer DEFAULT 0, "p_is_active" boolean DEFAULT true) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id uuid;
begin
  if p_delivery_at is null then
    raise exception 'Data e hora obrigatorias.';
  end if;

  if coalesce(trim(p_city), '') = '' then
    raise exception 'Cidade obrigatoria.';
  end if;

  if coalesce(trim(p_location), '') = '' then
    raise exception 'Local obrigatorio.';
  end if;

  if p_id is null then
    insert into public.kit_delivery_schedule (
      delivery_at,
      city,
      location,
      sort_order,
      is_active
    ) values (
      p_delivery_at,
      trim(p_city),
      trim(p_location),
      coalesce(p_sort_order, 0),
      coalesce(p_is_active, true)
    )
    returning id into v_id;
  else
    update public.kit_delivery_schedule
       set delivery_at = p_delivery_at,
           city = trim(p_city),
           location = trim(p_location),
           sort_order = coalesce(p_sort_order, 0),
           is_active = coalesce(p_is_active, true),
           updated_at = now()
     where id = p_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Agenda de entrega nao encontrada.';
    end if;
  end if;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."upsert_kit_delivery_schedule"("p_delivery_at" timestamp with time zone, "p_city" "text", "p_location" "text", "p_id" "uuid", "p_sort_order" integer, "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_registration_batch_addons"("p_event_id" "uuid", "p_batch_id" "uuid", "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if p_event_id is null or p_batch_id is null then
    raise exception 'Evento e lote obrigatorios.';
  end if;

  if not exists (
    select 1
    from public.registration_batches b
    where b.id = p_batch_id
      and b.event_id = p_event_id
  ) then
    raise exception 'Lote nao pertence ao evento informado.';
  end if;

  insert into public.registration_batch_addons (
    event_id,
    batch_id,
    kit_enabled,
    custom_cup_enabled,
    gifts_enabled
  ) values (
    p_event_id,
    p_batch_id,
    coalesce(p_kit_enabled, false),
    coalesce(p_custom_cup_enabled, false),
    coalesce(p_gifts_enabled, false)
  )
  on conflict (batch_id)
  do update set
    event_id = excluded.event_id,
    kit_enabled = excluded.kit_enabled,
    custom_cup_enabled = excluded.custom_cup_enabled,
    gifts_enabled = excluded.gifts_enabled,
    updated_at = now();
end;
$$;


ALTER FUNCTION "public"."upsert_registration_batch_addons"("p_event_id" "uuid", "p_batch_id" "uuid", "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_registration_batch_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_prices" "jsonb") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_item jsonb;
  v_ticket_category_id uuid;
  v_enabled boolean;
  v_male_price numeric;
  v_female_price numeric;
  v_max_confirmed integer;
  v_existing_confirmed integer;
  v_count integer := 0;
  v_deleted integer := 0;
  v_batch_ends_at timestamptz;
begin
  if p_batch_id is null or p_event_id is null then
    raise exception 'Batch e evento sao obrigatorios.';
  end if;

  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then
    raise exception 'Lista de precos por categoria invalida.';
  end if;

  select ends_at into v_batch_ends_at
  from public.registration_batches
  where id = p_batch_id
    and event_id = p_event_id;

  for v_item in
    select value
    from jsonb_array_elements(p_prices)
  loop
    begin
      v_ticket_category_id := (v_item->>'ticket_category_id')::uuid;
    exception
      when others then
        raise exception 'Categoria invalida na lista de precos.';
    end;

    v_enabled := coalesce((v_item->>'enabled')::boolean, false);
    v_male_price := coalesce((v_item->>'male_price')::numeric, 0);
    v_female_price := coalesce((v_item->>'female_price')::numeric, 0);
    v_max_confirmed := nullif(v_item->>'max_confirmed_registrations', '')::integer;

    if not exists (
      select 1
      from public.ticket_categories tc
      where tc.id = v_ticket_category_id
        and tc.event_id = p_event_id
    ) then
      raise exception 'Categoria % nao pertence ao evento.', v_ticket_category_id;
    end if;

    if not v_enabled then
      delete from public.registration_batch_prices
      where batch_id = p_batch_id
        and ticket_category_id = v_ticket_category_id;

      v_deleted := v_deleted + 1;
      continue;
    end if;

    if v_male_price < 0 or v_female_price < 0 then
      raise exception 'Preco por categoria nao pode ser negativo.';
    end if;

    if v_max_confirmed is not null and v_max_confirmed <= 0 then
      raise exception 'Limite de confirmados por categoria deve ser maior que zero quando informado.';
    end if;

    if v_max_confirmed is null and v_batch_ends_at is null then
      raise exception 'Categoria ativa no lote precisa de um limite de confirmados, de uma data de encerramento do lote, ou dos dois.';
    end if;

    if v_max_confirmed is not null then
      select coalesce(count(*)::integer, 0) into v_existing_confirmed
      from public.participants part
      join public.payments pay on pay.participant_id = part.id
      where part.batch_id = p_batch_id
        and part.ticket_category_id = v_ticket_category_id
        and coalesce(part.registration_status, 'pending') <> 'cancelled'
        and pay.payment_status = 'paid'
        and (part.reservation_status is null or part.reservation_status = 'confirmed');

      if v_max_confirmed < v_existing_confirmed then
        raise exception 'Nao e permitido reduzir o limite da categoria abaixo das inscricoes ja confirmadas (%).', v_existing_confirmed;
      end if;
    end if;

    insert into public.registration_batch_prices (
      batch_id,
      ticket_category_id,
      male_price,
      female_price,
      max_confirmed_registrations
    )
    values (
      p_batch_id,
      v_ticket_category_id,
      round(v_male_price, 2),
      round(v_female_price, 2),
      v_max_confirmed
    )
    on conflict (batch_id, ticket_category_id)
    do update set
      male_price = excluded.male_price,
      female_price = excluded.female_price,
      max_confirmed_registrations = excluded.max_confirmed_registrations,
      updated_at = now();

    v_count := v_count + 1;
  end loop;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_prices_upserted',
    'registration_batches',
    p_batch_id,
    jsonb_build_object(
      'updated_prices', v_count,
      'disabled_prices', v_deleted
    ),
    p_event_id
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."upsert_registration_batch_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_prices" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_store_item"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_image_url" "text", "p_price" numeric, "p_requires_variant" boolean, "p_is_active" boolean, "p_sort_order" integer, "p_supply_mode" "text" DEFAULT 'stock'::"text", "p_available_all_events" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_event public.events%rowtype; v_existing public.store_items%rowtype; v_id uuid; v_org uuid; v_stored_event_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome obrigatorio.'; end if;
  if nullif(trim(coalesce(p_slug, '')), '') is null then raise exception 'Slug obrigatorio.'; end if;
  if p_price < 0 then raise exception 'Preco invalido.'; end if;
  if coalesce(p_supply_mode, 'stock') not in ('stock', 'made_to_order') then raise exception 'Modo de fornecimento invalido: %.', p_supply_mode; end if;

  if p_id is not null then
    select * into v_existing from public.store_items where id = p_id;
    if not found or not public.user_can_access_organization(auth.uid(), v_existing.organization_id) then raise exception 'Item da loja nao encontrado ou sem acesso.'; end if;
    v_org := v_existing.organization_id;
  else
    select * into v_event from public.events where id = p_event_id;
    if not found or not public.user_can_access_organization(auth.uid(), v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
    v_org := v_event.organization_id;
  end if;

  v_stored_event_id := case when coalesce(p_available_all_events, false) then null else p_event_id end;
  if v_stored_event_id is not null then
    select * into v_event from public.events where id = v_stored_event_id;
    if not found or v_event.organization_id <> v_org then raise exception 'Evento invalido para este item.'; end if;
  end if;

  if p_id is null then
    insert into public.store_items (organization_id, event_id, name, slug, description, image_url, price, requires_variant, is_active, sort_order, supply_mode)
    values (v_org, v_stored_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_image_url, '')), ''),
      p_price, coalesce(p_requires_variant, false), coalesce(p_is_active, true), coalesce(p_sort_order, 0), coalesce(p_supply_mode, 'stock'))
    returning id into v_id;
  else
    update public.store_items set
      organization_id = v_org, event_id = v_stored_event_id,
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      image_url = nullif(trim(coalesce(p_image_url, '')), ''),
      price = p_price, requires_variant = coalesce(p_requires_variant, false), is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), supply_mode = coalesce(p_supply_mode, 'stock'), updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da loja nao encontrado.'; end if;
  end if;
  return v_id;
end; $$;


ALTER FUNCTION "public"."upsert_store_item"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_image_url" "text", "p_price" numeric, "p_requires_variant" boolean, "p_is_active" boolean, "p_sort_order" integer, "p_supply_mode" "text", "p_available_all_events" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_store_item_variant"("p_id" "uuid", "p_store_item_id" "uuid", "p_name" "text", "p_value" "text", "p_price_adjustment" numeric, "p_is_active" boolean, "p_sort_order" integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_item public.store_items%rowtype; v_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_item.organization_id) then raise exception 'Item invalido ou sem acesso.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome da variante obrigatorio.'; end if;
  if nullif(trim(coalesce(p_value, '')), '') is null then raise exception 'Valor da variante obrigatorio.'; end if;

  if p_id is null then
    insert into public.store_item_variants (store_item_id, name, value, price_adjustment, is_active, sort_order)
    values (p_store_item_id, trim(p_name), trim(p_value), coalesce(p_price_adjustment, 0), coalesce(p_is_active, true), coalesce(p_sort_order, 0))
    returning id into v_id;
  else
    update public.store_item_variants set
      name = trim(p_name), value = trim(p_value), price_adjustment = coalesce(p_price_adjustment, 0),
      is_active = coalesce(p_is_active, true), sort_order = coalesce(p_sort_order, 0)
    where id = p_id and store_item_id = p_store_item_id
    returning id into v_id;
    if v_id is null then raise exception 'Variante nao encontrada.'; end if;
  end if;
  return v_id;
end; $$;


ALTER FUNCTION "public"."upsert_store_item_variant"("p_id" "uuid", "p_store_item_id" "uuid", "p_name" "text", "p_value" "text", "p_price_adjustment" numeric, "p_is_active" boolean, "p_sort_order" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_can_access_organization"("p_user_id" "uuid", "p_organization_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select
    -- Platform owner e admin têm acesso a todas as organizações
    exists (
      select 1
      from public.platform_users pu
      where pu.user_id  = p_user_id
        and pu.is_active = true
        and pu.role in ('owner', 'admin')
    )
    or
    -- Membro ativo da organização específica
    exists (
      select 1
      from public.organization_members om
      where om.user_id         = p_user_id
        and om.organization_id = p_organization_id
        and om.is_active = true
    );
$$;


ALTER FUNCTION "public"."user_can_access_organization"("p_user_id" "uuid", "p_organization_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_has_permission"("p_user_id" "uuid", "p_permission_code" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_is_owner boolean := false;
  v_actor_can_edit_permissions boolean := false;
begin
  if v_actor_user_id is null then
    return false;
  end if;

  if p_user_id is null then
    return false;
  end if;

  if v_actor_user_id <> p_user_id then
    v_actor_is_owner := public.is_active_owner(v_actor_user_id);
    v_actor_can_edit_permissions := public.resolve_user_permission(v_actor_user_id, 'team.edit_permissions');
    if not v_actor_is_owner and not v_actor_can_edit_permissions then
      return false;
    end if;
  end if;

  return public.resolve_user_permission(p_user_id, p_permission_code);
end;
$$;


ALTER FUNCTION "public"."user_has_permission"("p_user_id" "uuid", "p_permission_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_is_order_item_holder"("p_user_id" "uuid", "p_order_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
    from public.order_items oi
    join public.participants p on p.id = oi.participant_id
    where oi.order_id = p_order_id
      and p.user_id = p_user_id
  );
$$;


ALTER FUNCTION "public"."user_is_order_item_holder"("p_user_id" "uuid", "p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_organization_ids"("p_user_id" "uuid") RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  -- Platform owner enxerga todas as organizações ativas
  select id
  from public.organizations
  where public.is_platform_owner(p_user_id)
  union
  -- Membros ativos enxergam suas próprias organizações
  select om.organization_id
  from public.organization_members om
  where om.user_id  = p_user_id
    and om.is_active = true;
$$;


ALTER FUNCTION "public"."user_organization_ids"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_coupon"("p_code" "text", "p_event_id" "uuid", "p_original_amount" numeric) RETURNS TABLE("coupon_id" "uuid", "coupon_type" "text", "discount_percent" numeric, "discount_amount" numeric, "final_amount" numeric, "message" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_code text;
  v_coupon public.coupons%rowtype;
  v_now timestamptz := now();
  v_discount numeric;
  v_final numeric;
begin
  v_code := upper(trim(coalesce(p_code, '')));

  if v_code = '' then
    raise exception 'Informe um codigo de cupom.';
  end if;

  if p_event_id is null then
    raise exception 'Evento invalido para validacao de cupom.';
  end if;

  if p_original_amount is null or p_original_amount < 0 then
    raise exception 'Valor original invalido.';
  end if;

  select * into v_coupon
  from public.coupons
  where event_id = p_event_id
    and code = v_code
  for update;

  if not found then
    raise exception 'Codigo invalido para este evento.';
  end if;

  if not v_coupon.is_active then
    raise exception 'Cupom inativo.';
  end if;

  if v_coupon.valid_from is not null and v_now < v_coupon.valid_from then
    raise exception 'Cupom ainda nao esta vigente.';
  end if;

  if v_coupon.valid_until is not null and v_now > v_coupon.valid_until then
    raise exception 'Cupom expirado.';
  end if;

  if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
    raise exception 'Limite de usos do cupom atingido.';
  end if;

  if v_coupon.coupon_type = 'courtesy' then
    v_discount := round(p_original_amount, 2);
    v_final := 0;
  else
    v_discount := round((p_original_amount * v_coupon.discount_percent) / 100.0, 2);
    v_final := round(greatest(0, p_original_amount - v_discount), 2);
  end if;

  return query
  select
    v_coupon.id,
    v_coupon.coupon_type,
    v_coupon.discount_percent,
    v_discount,
    v_final,
    case
      when v_coupon.coupon_type = 'courtesy' then 'Cortesia aplicada com sucesso.'
      else 'Cupom valido e pronto para aplicacao.'
    end;
end;
$$;


ALTER FUNCTION "public"."validate_coupon"("p_code" "text", "p_event_id" "uuid", "p_original_amount" numeric) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "module" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_role_permissions" (
    "role_id" "uuid" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_role_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_system" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_user_permission_overrides" (
    "user_id" "uuid" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "effect" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_user_permission_overrides_effect_check" CHECK (("effect" = ANY (ARRAY['allow'::"text", 'deny'::"text"])))
);


ALTER TABLE "public"."admin_user_permission_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_users" (
    "user_id" "uuid" NOT NULL,
    "role_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "internal_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "action" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "event_id" "uuid"
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "participant_id" "uuid",
    "ticket_category_id" "uuid",
    "batch_id" "uuid",
    "shirt_type" "text",
    "shirt_size" "text",
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_price" numeric(10,2) NOT NULL,
    "discount_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "final_amount" numeric(10,2) NOT NULL,
    "status" "text" DEFAULT 'reserved'::"text" NOT NULL,
    "reservation_expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ownership_status" "text" DEFAULT 'unassigned'::"text" NOT NULL,
    "item_position" integer,
    "holder_full_name" "text",
    "holder_email" "text",
    "holder_phone" "text",
    "registration_contact_id" "uuid",
    CONSTRAINT "chk_order_items_ownership_status" CHECK (("ownership_status" = ANY (ARRAY['unassigned'::"text", 'assigned'::"text", 'transferred'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "order_items_prices_non_negative_check" CHECK ((("unit_price" >= (0)::numeric) AND ("discount_amount" >= (0)::numeric) AND ("final_amount" >= (0)::numeric))),
    CONSTRAINT "order_items_quantity_is_one_check" CHECK (("quantity" = 1)),
    CONSTRAINT "order_items_status_check" CHECK (("status" = ANY (ARRAY['reserved'::"text", 'confirmed'::"text", 'cancelled'::"text", 'expired'::"text", 'refunded'::"text", 'transferred'::"text"])))
);


ALTER TABLE "public"."order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "participant_id" "uuid",
    "event_id" "uuid" NOT NULL,
    "payment_id" "uuid",
    "order_number" "text" NOT NULL,
    "status" "text" NOT NULL,
    "base_amount" numeric(10,2) NOT NULL,
    "discount_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "final_amount" numeric(10,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "confirmed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "client_request_id" "text",
    "organization_id" "uuid" NOT NULL,
    "buyer_type" "text" DEFAULT 'account'::"text" NOT NULL,
    "import_batch_id" "uuid",
    CONSTRAINT "orders_buyer_ownership_check" CHECK (((("buyer_type" = 'account'::"text") AND ("user_id" IS NOT NULL) AND ("import_batch_id" IS NULL)) OR (("buyer_type" = 'imported_holder'::"text") AND ("user_id" IS NULL) AND ("import_batch_id" IS NOT NULL)) OR (("buyer_type" = 'administrative'::"text") AND ("user_id" IS NULL) AND ("import_batch_id" IS NULL)))),
    CONSTRAINT "orders_buyer_type_check" CHECK (("buyer_type" = ANY (ARRAY['account'::"text", 'imported_holder'::"text", 'administrative'::"text"]))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'expired'::"text", 'cancelled'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


COMMENT ON COLUMN "public"."orders"."participant_id" IS 'LEGACY compatibility field. New purchases should use public.order_items.participant_id.';



COMMENT ON COLUMN "public"."orders"."base_amount" IS 'LEGACY compatibility total. New purchases should aggregate public.order_items.unit_price.';



COMMENT ON COLUMN "public"."orders"."discount_amount" IS 'LEGACY compatibility total. New purchases should aggregate public.order_items.discount_amount.';



COMMENT ON COLUMN "public"."orders"."final_amount" IS 'LEGACY compatibility total. New purchases should aggregate public.order_items.final_amount.';



CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "participant_id" "uuid",
    "amount" numeric NOT NULL,
    "payment_method" "text",
    "payment_status" "text" NOT NULL,
    "paid_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "event_id" "uuid",
    "discount_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "final_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "pix_code" "text",
    "pix_qrcode" "text",
    "gateway_payment_id" "text",
    "expires_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "order_id" "uuid",
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "payments_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "payments_method_check" CHECK ((COALESCE("payment_method", 'pix'::"text") = ANY (ARRAY['pix'::"text", 'credit_card'::"text", 'cash'::"text", 'courtesy'::"text"]))),
    CONSTRAINT "payments_status_check" CHECK (("payment_status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'expired'::"text", 'cancelled'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."confirmed_payments_cash_backfill_111_candidates" AS
 WITH "confirmed" AS (
         SELECT "pay"."id",
            "pay"."participant_id",
            "pay"."amount",
            "pay"."payment_method",
            "pay"."payment_status",
            "pay"."paid_at",
            "pay"."created_at",
            "pay"."event_id",
            "pay"."discount_amount",
            "pay"."final_amount",
            "pay"."pix_code",
            "pay"."pix_qrcode",
            "pay"."gateway_payment_id",
            "pay"."expires_at",
            "pay"."updated_at",
            "pay"."order_id",
            "pay"."organization_id"
           FROM "public"."payments" "pay"
          WHERE ("pay"."payment_status" = 'paid'::"text")
        ), "links" AS (
         SELECT DISTINCT "pay"."id" AS "payment_id",
            "o"."id" AS "order_id",
            "o"."created_at" AS "order_created_at"
           FROM ("confirmed" "pay"
             JOIN "public"."orders" "o" ON ((("o"."id" = "pay"."order_id") OR ("o"."payment_id" = "pay"."id"))))
        ), "per_payment" AS (
         SELECT "pay"."id" AS "payment_id",
            ("count"(DISTINCT "l"."order_id"))::integer AS "related_order_count",
            ("array_agg"(DISTINCT "l"."order_id" ORDER BY "l"."order_id") FILTER (WHERE ("l"."order_id" IS NOT NULL)))[1] AS "order_id",
            "min"("l"."order_created_at") AS "order_created_at",
            ("count"(DISTINCT "oi"."id"))::integer AS "order_item_count"
           FROM (("confirmed" "pay"
             LEFT JOIN "links" "l" ON (("l"."payment_id" = "pay"."id")))
             LEFT JOIN "public"."order_items" "oi" ON (("oi"."order_id" = "l"."order_id")))
          GROUP BY "pay"."id"
        ), "per_order" AS (
         SELECT "l"."order_id",
            ("count"(DISTINCT "l"."payment_id"))::integer AS "paid_payment_count"
           FROM "links" "l"
          GROUP BY "l"."order_id"
        ), "gateway" AS (
         SELECT "pay"."id" AS "payment_id",
                CASE
                    WHEN (NULLIF("pay"."gateway_payment_id", ''::"text") IS NULL) THEN 0
                    ELSE ("count"(*) OVER (PARTITION BY "pay"."gateway_payment_id"))::integer
                END AS "gateway_count"
           FROM "confirmed" "pay"
        ), "classified" AS (
         SELECT "pay"."id" AS "payment_id",
            "pp"."order_id",
            "pay"."participant_id",
            "pay"."event_id",
            "pay"."organization_id",
            "pay"."final_amount" AS "amount",
            (COALESCE("pp"."order_created_at", "pay"."created_at"))::"date" AS "competency_on",
            "pay"."paid_at" AS "effective_at",
                CASE
                    WHEN (("pp"."related_order_count" = 1) AND ("pp"."order_item_count" > 0) AND (COALESCE("po"."paid_payment_count", 0) = 1) AND ("g"."gateway_count" <= 1)) THEN 'proven_distinct_sale'::"text"
                    WHEN (("pp"."related_order_count" = 0) AND ("g"."gateway_count" <= 1)) THEN 'confirmed_legacy_revenue_without_order'::"text"
                    ELSE 'excluded'::"text"
                END AS "classification"
           FROM ((("confirmed" "pay"
             JOIN "per_payment" "pp" ON (("pp"."payment_id" = "pay"."id")))
             LEFT JOIN "per_order" "po" ON (("po"."order_id" = "pp"."order_id")))
             JOIN "gateway" "g" ON (("g"."payment_id" = "pay"."id")))
        )
 SELECT "payment_id",
    "order_id",
    "participant_id",
    "event_id",
    "organization_id",
    "amount",
    "competency_on",
    "effective_at",
    "classification",
    ('cash-backfill-111:payment:'::"text" || ("payment_id")::"text") AS "idempotency_key"
   FROM "classified" "c"
  WHERE ("classification" = ANY (ARRAY['proven_distinct_sale'::"text", 'confirmed_legacy_revenue_without_order'::"text"]));


ALTER VIEW "public"."confirmed_payments_cash_backfill_111_candidates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coupon_redemptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "coupon_id" "uuid" NOT NULL,
    "participant_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "original_amount" numeric NOT NULL,
    "discount_amount" numeric NOT NULL,
    "final_amount" numeric NOT NULL,
    "redeemed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "coupon_redemptions_amounts_check" CHECK ((("original_amount" >= (0)::numeric) AND ("discount_amount" >= (0)::numeric) AND ("final_amount" >= (0)::numeric)))
);


ALTER TABLE "public"."coupon_redemptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coupons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "coupon_type" "text" NOT NULL,
    "discount_percent" numeric DEFAULT 0 NOT NULL,
    "max_uses" integer,
    "used_count" integer DEFAULT 0 NOT NULL,
    "valid_from" timestamp with time zone,
    "valid_until" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "coupons_max_uses_check" CHECK ((("max_uses" IS NULL) OR ("max_uses" > 0))),
    CONSTRAINT "coupons_percent_check" CHECK (((("coupon_type" = 'courtesy'::"text") AND ("discount_percent" = (100)::numeric)) OR (("coupon_type" = 'percentage'::"text") AND ("discount_percent" > (0)::numeric) AND ("discount_percent" <= (100)::numeric)))),
    CONSTRAINT "coupons_type_check" CHECK (("coupon_type" = ANY (ARRAY['courtesy'::"text", 'percentage'::"text"]))),
    CONSTRAINT "coupons_used_count_limit" CHECK ((("max_uses" IS NULL) OR ("used_count" <= "max_uses"))),
    CONSTRAINT "coupons_used_count_non_negative" CHECK (("used_count" >= 0))
);


ALTER TABLE "public"."coupons" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_profiles" (
    "user_id" "uuid" NOT NULL,
    "full_name" "text",
    "cpf" "text",
    "birth_date" "date",
    "gender" "text",
    "phone" "text",
    "city" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "account_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "must_complete_profile" boolean DEFAULT false NOT NULL,
    "must_change_password" boolean DEFAULT false NOT NULL,
    "imported_at" timestamp with time zone,
    "activation_completed_at" timestamp with time zone,
    "public_pin" "text" DEFAULT "public"."generate_customer_public_pin"() NOT NULL,
    CONSTRAINT "customer_profiles_account_status_check" CHECK (("account_status" = ANY (ARRAY['pending_activation'::"text", 'active'::"text", 'blocked'::"text", 'legacy_without_account'::"text"]))),
    CONSTRAINT "customer_profiles_public_pin_format" CHECK ((("public_pin" IS NULL) OR ("public_pin" ~ '^[A-Z0-9]{10}$'::"text")))
);


ALTER TABLE "public"."customer_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_addon_options" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_addon_options" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_addons_config" (
    "event_id" "uuid" NOT NULL,
    "apply_to_all_batches" boolean DEFAULT true NOT NULL,
    "kit_enabled" boolean DEFAULT false NOT NULL,
    "custom_cup_enabled" boolean DEFAULT false NOT NULL,
    "gifts_enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_addons_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_addons_model" (
    "event_id" "uuid" NOT NULL,
    "apply_to_all_batches" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_addons_model" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_attractions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "banner_url" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_attractions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_batch_addon_options" (
    "event_id" "uuid" NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "option_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_batch_addon_options" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_highlights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_highlights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_kit_item_variant_inventory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "kit_item_id" "uuid" NOT NULL,
    "variant_id" "uuid" NOT NULL,
    "total_quantity" integer DEFAULT 0 NOT NULL,
    "reserved_quantity" integer DEFAULT 0 NOT NULL,
    "delivered_quantity" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "event_kit_item_variant_inventory_check" CHECK ((("reserved_quantity" + "delivered_quantity") <= "total_quantity")),
    CONSTRAINT "event_kit_item_variant_inventory_delivered_quantity_check" CHECK (("delivered_quantity" >= 0)),
    CONSTRAINT "event_kit_item_variant_inventory_physical_stock_bounds" CHECK (("delivered_quantity" <= "total_quantity")),
    CONSTRAINT "event_kit_item_variant_inventory_reserved_quantity_check" CHECK (("reserved_quantity" >= 0)),
    CONSTRAINT "event_kit_item_variant_inventory_total_quantity_check" CHECK (("total_quantity" >= 0))
);


ALTER TABLE "public"."event_kit_item_variant_inventory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_kit_item_variants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kit_item_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "value" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."event_kit_item_variants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_kit_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "item_type" "text" NOT NULL,
    "quantity_per_participant" integer DEFAULT 1 NOT NULL,
    "requires_variant" boolean DEFAULT false NOT NULL,
    "is_required" boolean DEFAULT true NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid" NOT NULL,
    "allow_participant_change" boolean DEFAULT false NOT NULL,
    "track_variant_inventory" boolean DEFAULT false NOT NULL,
    "shirt_supply_mode" "text",
    CONSTRAINT "event_kit_items_item_type_check" CHECK (("item_type" = ANY (ARRAY['shirt'::"text", 'cup'::"text", 'strap'::"text", 'cup_holder'::"text", 'wristband'::"text", 'badge'::"text", 'voucher'::"text", 'other'::"text"]))),
    CONSTRAINT "event_kit_items_quantity_positive" CHECK (("quantity_per_participant" > 0)),
    CONSTRAINT "event_kit_items_shirt_supply_mode_check" CHECK ((("shirt_supply_mode" IS NULL) OR ("shirt_supply_mode" = ANY (ARRAY['stock'::"text", 'made_to_order'::"text", 'disabled'::"text"]))))
);


ALTER TABLE "public"."event_kit_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_payment_methods" (
    "event_id" "uuid" NOT NULL,
    "pix_enabled" boolean DEFAULT true NOT NULL,
    "credit_card_single_enabled" boolean DEFAULT true NOT NULL,
    "credit_card_installments_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "event_payment_methods_at_least_one" CHECK (("pix_enabled" OR "credit_card_single_enabled" OR "credit_card_installments_enabled"))
);


ALTER TABLE "public"."event_payment_methods" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "year" integer NOT NULL,
    "registration_open" timestamp with time zone DEFAULT "now"() NOT NULL,
    "registration_close" timestamp with time zone,
    "is_active" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "slug" "text",
    "description" "text",
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "registration_open_at" timestamp with time zone,
    "registration_close_at" timestamp with time zone,
    "location" "text",
    "registration_enabled" boolean DEFAULT false NOT NULL,
    "kit_enabled" boolean DEFAULT false NOT NULL,
    "allow_checkin_during_kit_delivery" boolean DEFAULT false NOT NULL,
    "shirt_order_deadline" timestamp with time zone,
    "limit_shirt_selection_to_stock" boolean DEFAULT false NOT NULL,
    "wristband_enabled" boolean DEFAULT false NOT NULL,
    "wristband_required_for_kit" boolean DEFAULT false NOT NULL,
    "wristband_required_for_checkin" boolean DEFAULT false NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "allow_participant_item_changes" boolean DEFAULT false NOT NULL,
    "allow_holder_change" boolean DEFAULT false NOT NULL,
    "allow_ticket_transfer" boolean DEFAULT false NOT NULL,
    "archived_at" timestamp with time zone,
    "archived_by" "uuid",
    "min_age" integer DEFAULT 18 NOT NULL,
    "banner_hero_url" "text",
    "banner_card_url" "text",
    CONSTRAINT "events_min_age_check" CHECK (("min_age" >= 0)),
    CONSTRAINT "events_wristband_requirements_check" CHECK (("wristband_enabled" OR (("wristband_required_for_kit" = false) AND ("wristband_required_for_checkin" = false))))
);


ALTER TABLE "public"."events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "account_type" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "financial_accounts_account_type_check" CHECK (("account_type" = ANY (ARRAY['asset'::"text", 'liability'::"text", 'equity'::"text", 'revenue'::"text", 'expense'::"text"])))
);


ALTER TABLE "public"."financial_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "entry_kind" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "financial_categories_entry_kind_check" CHECK (("entry_kind" = ANY (ARRAY['revenue'::"text", 'expense'::"text", 'both'::"text"])))
);


ALTER TABLE "public"."financial_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "entry_kind" "text" NOT NULL,
    "lifecycle_status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "description" "text" NOT NULL,
    "category_id" "uuid",
    "supplier_id" "uuid",
    "source_payment_id" "uuid",
    "original_entry_id" "uuid",
    "amount" numeric(14,2) NOT NULL,
    "due_date" "date",
    "occurred_on" "date" DEFAULT CURRENT_DATE NOT NULL,
    "posted_at" timestamp with time zone,
    "settled_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "currency" "text" DEFAULT 'BRL'::"text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_order_id" "uuid",
    "source_participant_id" "uuid",
    CONSTRAINT "financial_entries_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "financial_entries_currency_check" CHECK (("currency" = 'BRL'::"text")),
    CONSTRAINT "financial_entries_entry_kind_check" CHECK (("entry_kind" = ANY (ARRAY['revenue'::"text", 'expense'::"text", 'transfer'::"text", 'adjustment'::"text", 'reversal'::"text"]))),
    CONSTRAINT "financial_entries_lifecycle_status_check" CHECK (("lifecycle_status" = ANY (ARRAY['draft'::"text", 'open'::"text", 'partially_settled'::"text", 'settled'::"text", 'cancelled'::"text", 'partially_reversed'::"text", 'reversed'::"text"])))
);


ALTER TABLE "public"."financial_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_entry_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entry_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "line_side" "text" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "memo" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "financial_entry_lines_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "financial_entry_lines_line_side_check" CHECK (("line_side" = ANY (ARRAY['debit'::"text", 'credit'::"text"])))
);


ALTER TABLE "public"."financial_entry_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_entry_settlements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "expense_entry_id" "uuid" NOT NULL,
    "settlement_entry_id" "uuid" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "paid_on" "date" NOT NULL,
    "reason" "text",
    "idempotency_key" "text" NOT NULL,
    "settled_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "financial_entry_settlements_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."financial_entry_settlements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_event_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entry_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "financial_event_allocations_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."financial_event_allocations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_reconciliations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entry_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "reconciled_on" "date" NOT NULL,
    "external_reference" "text",
    "idempotency_key" "text" NOT NULL,
    "reconciled_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "financial_reconciliations_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."financial_reconciliations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_reversals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "original_entry_id" "uuid" NOT NULL,
    "reversal_entry_id" "uuid" NOT NULL,
    "amount" numeric(14,2) NOT NULL,
    "reason" "text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "reversed_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "financial_reversals_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."financial_reversals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "legal_name" "text" NOT NULL,
    "display_name" "text",
    "tax_identifier" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."financial_suppliers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."import_batch_rows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_batch_id" "uuid" NOT NULL,
    "row_number" integer NOT NULL,
    "raw_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "normalized_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'ready'::"text" NOT NULL,
    "resolution" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_message" "text",
    "matched_participant_id" "uuid",
    "matched_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "data_issues" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "import_batch_rows_resolution_check" CHECK (("resolution" = ANY (ARRAY['pending'::"text", 'link_existing'::"text", 'create_new'::"text", 'ignore'::"text", 'mark_duplicate'::"text"]))),
    CONSTRAINT "import_batch_rows_status_check" CHECK (("status" = ANY (ARRAY['ready'::"text", 'data_pending'::"text", 'review_required'::"text", 'duplicate'::"text", 'error'::"text", 'skipped'::"text", 'imported'::"text"])))
);


ALTER TABLE "public"."import_batch_rows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."import_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "file_name" "text",
    "import_type" "text" NOT NULL,
    "event_id" "uuid",
    "total_rows" integer DEFAULT 0 NOT NULL,
    "imported_rows" integer DEFAULT 0 NOT NULL,
    "skipped_rows" integer DEFAULT 0 NOT NULL,
    "error_rows" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'processing'::"text" NOT NULL,
    "imported_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "historical_event_label" "text",
    "historical_event_key" "text",
    "historical_event_year" integer,
    "payment_mode_original" "text",
    "payment_reason_original" "text",
    CONSTRAINT "import_batches_payment_mode_original_check" CHECK ((("payment_mode_original" IS NULL) OR ("payment_mode_original" = ANY (ARRAY['pending'::"text", 'confirm_all'::"text"])))),
    CONSTRAINT "import_batches_status_check" CHECK (("status" = ANY (ARRAY['processing'::"text", 'ready_for_review'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "import_batches_type_check" CHECK (("import_type" = ANY (ARRAY['historical_participations'::"text", 'current_event_registrations'::"text", 'inventory'::"text", 'payments'::"text"])))
);


ALTER TABLE "public"."import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "inventory_id" "uuid" NOT NULL,
    "movement_type" "text" NOT NULL,
    "quantity" integer NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "inventory_movements_movement_type_check" CHECK (("movement_type" = ANY (ARRAY['purchase'::"text", 'adjustment'::"text", 'return'::"text", 'loss'::"text", 'kit_delivery_undo'::"text", 'reservation'::"text", 'release'::"text", 'cancel'::"text"]))),
    CONSTRAINT "inventory_movements_quantity_check" CHECK (("quantity" <> 0))
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kit_deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "participant_id" "uuid" NOT NULL,
    "delivered_at" timestamp with time zone DEFAULT "now"(),
    "delivered_by" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "event_id" "uuid"
);


ALTER TABLE "public"."kit_deliveries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kit_delivery_schedule" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "delivery_at" timestamp with time zone NOT NULL,
    "city" "text",
    "location" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "schedule_type" "text" DEFAULT 'other'::"text" NOT NULL,
    "is_visible_to_users" boolean DEFAULT true NOT NULL,
    CONSTRAINT "kit_delivery_schedule_type_check" CHECK (("schedule_type" = ANY (ARRAY['kit_pickup'::"text", 'gates_open'::"text", 'event_start'::"text", 'attraction'::"text", 'accreditation'::"text", 'meeting'::"text", 'closing'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."kit_delivery_schedule" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."order_number_seq"
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."order_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role_id" "uuid",
    "is_owner" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."organization_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "legal_name" "text",
    "document" "text",
    "email" "text",
    "phone" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "plan_code" "text",
    "trial_ends_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organizations_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'trial'::"text", 'suspended'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."participant_account_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "participant_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "invited_by" "uuid" NOT NULL,
    "claimed_user_id" "uuid",
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "claimed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "auth_user_id" "uuid",
    "requires_password_setup" boolean DEFAULT false NOT NULL,
    "password_setup_completed_at" timestamp with time zone,
    CONSTRAINT "participant_account_invites_password_setup_state_check" CHECK ((("password_setup_completed_at" IS NULL) OR "requires_password_setup")),
    CONSTRAINT "participant_account_invites_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'claimed'::"text", 'revoked'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."participant_account_invites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."participant_data_issues" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "participant_id" "uuid" NOT NULL,
    "import_batch_id" "uuid",
    "field_code" "text" NOT NULL,
    "issue_type" "text" NOT NULL,
    "message" "text" NOT NULL,
    "blocks_payment" boolean DEFAULT false NOT NULL,
    "blocks_ticket_issuance" boolean DEFAULT false NOT NULL,
    "blocks_checkin" boolean DEFAULT false NOT NULL,
    "blocks_kit_delivery" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolution_scope" "text" DEFAULT 'admin_only'::"text" NOT NULL,
    CONSTRAINT "participant_data_issues_resolution_scope_check" CHECK (("resolution_scope" = ANY (ARRAY['user_resolvable'::"text", 'admin_only'::"text"]))),
    CONSTRAINT "participant_data_issues_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'resolved'::"text", 'ignored'::"text"])))
);


ALTER TABLE "public"."participant_data_issues" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."participant_kit_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "participant_id" "uuid",
    "event_id" "uuid" NOT NULL,
    "kit_item_id" "uuid" NOT NULL,
    "variant_data" "jsonb",
    "quantity" integer DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'reserved'::"text" NOT NULL,
    "delivered_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid" NOT NULL,
    "ticket_id" "uuid",
    "order_item_id" "uuid",
    "legacy_unresolved" boolean DEFAULT false NOT NULL,
    CONSTRAINT "participant_kit_items_operational_owner_check" CHECK ((("ticket_id" IS NOT NULL) OR ("order_item_id" IS NOT NULL) OR "legacy_unresolved")),
    CONSTRAINT "participant_kit_items_quantity_positive" CHECK (("quantity" > 0)),
    CONSTRAINT "participant_kit_items_status_check" CHECK (("status" = ANY (ARRAY['reserved'::"text", 'confirmed'::"text", 'delivered'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."participant_kit_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."participant_wristbands" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "ticket_id" "uuid" NOT NULL,
    "participant_id" "uuid",
    "code" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "linked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "linked_by" "uuid",
    "unlinked_at" timestamp with time zone,
    "unlinked_by" "uuid",
    "replaced_by_wristband_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    CONSTRAINT "participant_wristbands_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'blocked'::"text", 'lost'::"text", 'replaced'::"text", 'unlinked'::"text"])))
);


ALTER TABLE "public"."participant_wristbands" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."participants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "full_name" "text" NOT NULL,
    "cpf" "text",
    "birth_date" "date",
    "gender" "text",
    "phone" "text",
    "email" "text",
    "city" "text",
    "shirt_type" "text",
    "shirt_size" "text",
    "registration_status" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "event_id" "uuid",
    "reservation_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reservation_expires_at" timestamp with time zone,
    "reservation_released_at" timestamp with time zone,
    "batch_id" "uuid",
    "base_amount" numeric(10,2),
    "discount_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "final_amount" numeric(10,2),
    "ticket_category_id" "uuid",
    "user_id" "uuid",
    "organization_id" "uuid" NOT NULL,
    "registration_contact_id" "uuid",
    CONSTRAINT "participants_reservation_status_check" CHECK (("reservation_status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'expired'::"text", 'released'::"text"])))
);


ALTER TABLE "public"."participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."participation_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid",
    "user_id" "uuid",
    "participant_id" "uuid",
    "legacy_event_name" "text",
    "event_year" integer NOT NULL,
    "full_name" "text" NOT NULL,
    "normalized_name" "text",
    "cpf" "text",
    "email" "text",
    "status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "source" "text" DEFAULT 'import'::"text" NOT NULL,
    "import_batch_id" "uuid",
    "manually_verified" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "historical_event_label" "text",
    "historical_event_key" "text",
    "historical_event_year" integer,
    CONSTRAINT "participation_history_source_check" CHECK (("source" = ANY (ARRAY['import'::"text", 'system'::"text", 'manual'::"text"]))),
    CONSTRAINT "participation_history_status_check" CHECK (("status" = ANY (ARRAY['confirmed'::"text", 'pending'::"text", 'cancelled'::"text", 'duplicate'::"text", 'review_required'::"text"])))
);


ALTER TABLE "public"."participation_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_settings" (
    "id" boolean DEFAULT true NOT NULL,
    "brand_theme" "text" DEFAULT 'pink'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid",
    CONSTRAINT "platform_settings_brand_theme_check" CHECK (("brand_theme" = ANY (ARRAY['pink'::"text", 'red'::"text", 'rose'::"text", 'fuchsia'::"text", 'purple'::"text", 'violet'::"text", 'indigo'::"text", 'blue'::"text", 'sky'::"text", 'cyan'::"text", 'teal'::"text", 'emerald'::"text", 'green'::"text", 'lime'::"text", 'yellow'::"text", 'amber'::"text", 'orange'::"text"]))),
    CONSTRAINT "platform_settings_singleton" CHECK ("id")
);


ALTER TABLE "public"."platform_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_users" (
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "platform_users_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'support'::"text", 'finance'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."platform_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."registration_batch_addons" (
    "batch_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "kit_enabled" boolean DEFAULT false NOT NULL,
    "custom_cup_enabled" boolean DEFAULT false NOT NULL,
    "gifts_enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."registration_batch_addons" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."registration_batch_prices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "ticket_category_id" "uuid" NOT NULL,
    "male_price" numeric(10,2) NOT NULL,
    "female_price" numeric(10,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "max_confirmed_registrations" integer,
    CONSTRAINT "registration_batch_prices_female_nonnegative" CHECK (("female_price" >= (0)::numeric)),
    CONSTRAINT "registration_batch_prices_limit_positive" CHECK ((("max_confirmed_registrations" IS NULL) OR ("max_confirmed_registrations" > 0))),
    CONSTRAINT "registration_batch_prices_male_nonnegative" CHECK (("male_price" >= (0)::numeric))
);


ALTER TABLE "public"."registration_batch_prices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."registration_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "sequence_number" integer NOT NULL,
    "male_price" numeric(10,2) NOT NULL,
    "female_price" numeric(10,2) NOT NULL,
    "max_confirmed_registrations" integer NOT NULL,
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "is_active" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "registration_batches_female_price_non_negative" CHECK (("female_price" >= (0)::numeric)),
    CONSTRAINT "registration_batches_limit_positive" CHECK (("max_confirmed_registrations" > 0)),
    CONSTRAINT "registration_batches_male_price_non_negative" CHECK (("male_price" >= (0)::numeric)),
    CONSTRAINT "registration_batches_time_window" CHECK ((("starts_at" IS NULL) OR ("ends_at" IS NULL) OR ("starts_at" <= "ends_at")))
);


ALTER TABLE "public"."registration_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."registration_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "cpf" "text" NOT NULL,
    "birth_date" "date" NOT NULL,
    "gender" "text",
    "phone" "text" NOT NULL,
    "email" "text" NOT NULL,
    "city" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "public_pin" "text" DEFAULT "public"."generate_registration_contact_public_pin"() NOT NULL,
    CONSTRAINT "registration_contacts_public_pin_format" CHECK ((("public_pin" IS NULL) OR ("public_pin" ~ '^[A-Z0-9]{10}$'::"text")))
);


ALTER TABLE "public"."registration_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_item_inventory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_id" "uuid",
    "store_item_id" "uuid" NOT NULL,
    "variant_id" "uuid",
    "total_quantity" integer DEFAULT 0 NOT NULL,
    "reserved_quantity" integer DEFAULT 0 NOT NULL,
    "delivered_quantity" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "store_item_inventory_delivered_quantity_check" CHECK (("delivered_quantity" >= 0)),
    CONSTRAINT "store_item_inventory_reserved_quantity_check" CHECK (("reserved_quantity" >= 0)),
    CONSTRAINT "store_item_inventory_stock_bounds" CHECK ((("reserved_quantity" + "delivered_quantity") <= "total_quantity")),
    CONSTRAINT "store_item_inventory_total_quantity_check" CHECK (("total_quantity" >= 0))
);


ALTER TABLE "public"."store_item_inventory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_item_variants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "store_item_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "value" "text" NOT NULL,
    "price_adjustment" numeric(10,2) DEFAULT 0 NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."store_item_variants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_id" "uuid",
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "price" numeric(10,2) DEFAULT 0 NOT NULL,
    "requires_variant" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "image_url" "text",
    "supply_mode" "text" DEFAULT 'stock'::"text" NOT NULL,
    CONSTRAINT "store_items_price_check" CHECK (("price" >= (0)::numeric)),
    CONSTRAINT "store_items_supply_mode_check" CHECK (("supply_mode" = ANY (ARRAY['stock'::"text", 'made_to_order'::"text"])))
);


ALTER TABLE "public"."store_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."store_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "store_order_id" "uuid" NOT NULL,
    "store_item_id" "uuid" NOT NULL,
    "variant_id" "uuid",
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_price" numeric(10,2) NOT NULL,
    "final_amount" numeric(10,2) NOT NULL,
    "status" "text" DEFAULT 'reserved'::"text" NOT NULL,
    "delivered_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "store_order_items_quantity_check" CHECK (("quantity" > 0)),
    CONSTRAINT "store_order_items_status_check" CHECK (("status" = ANY (ARRAY['reserved'::"text", 'confirmed'::"text", 'delivered'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."store_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ticket_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "capacity" integer,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ticket_categories_capacity_positive" CHECK ((("capacity" IS NULL) OR ("capacity" > 0))),
    CONSTRAINT "ticket_categories_slug_format" CHECK (("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::"text"))
);


ALTER TABLE "public"."ticket_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ticket_category_benefits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticket_category_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ticket_category_benefits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ticket_holder_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticket_id" "uuid" NOT NULL,
    "order_item_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "operation" "text" NOT NULL,
    "previous_participant_id" "uuid",
    "new_participant_id" "uuid",
    "previous_user_id" "uuid",
    "new_user_id" "uuid",
    "actor_user_id" "uuid" NOT NULL,
    "actor_origin" "text" NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "previous_registration_contact_id" "uuid",
    "new_registration_contact_id" "uuid",
    "reason_code" "text",
    "reason_text" "text",
    CONSTRAINT "ticket_holder_history_actor_origin_check" CHECK (("actor_origin" = ANY (ARRAY['portal'::"text", 'admin'::"text"]))),
    CONSTRAINT "ticket_holder_history_operation_check" CHECK (("operation" = ANY (ARRAY['holder_assigned'::"text", 'holder_changed'::"text", 'holder_removed'::"text", 'ticket_transferred'::"text"])))
);


ALTER TABLE "public"."ticket_holder_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ticket_item_change_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticket_id" "uuid" NOT NULL,
    "kit_item_id" "uuid" NOT NULL,
    "participant_kit_item_id" "uuid",
    "organization_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "current_variant_id" "uuid",
    "requested_variant_id" "uuid" NOT NULL,
    "current_variant" "jsonb",
    "requested_variant" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "requested_by" "uuid" NOT NULL,
    "reviewed_by" "uuid",
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    "reason" "text",
    "review_notes" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ticket_item_change_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."ticket_item_change_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ticket_owner_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticket_id" "uuid" NOT NULL,
    "order_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "operation" "text" NOT NULL,
    "previous_owner_user_id" "uuid",
    "new_owner_user_id" "uuid" NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "reason_code" "text" NOT NULL,
    "reason_text" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ticket_owner_history_operation_check" CHECK (("operation" = ANY (ARRAY['owner_assigned'::"text", 'owner_transferred'::"text"]))),
    CONSTRAINT "ticket_owner_history_other_reason_check" CHECK ((("reason_code" <> 'other'::"text") OR (NULLIF(TRIM(BOTH FROM "reason_text"), ''::"text") IS NOT NULL))),
    CONSTRAINT "ticket_owner_history_reason_code_check" CHECK (("reason_code" = ANY (ARRAY['registration_correction'::"text", 'buyer_request'::"text", 'holder_request'::"text", 'third_party_ticket'::"text", 'administrative_adjustment'::"text", 'issuance_error'::"text", 'system_error'::"text", 'data_regularization'::"text", 'other'::"text", 'legacy_unclassified'::"text"])))
);


ALTER TABLE "public"."ticket_owner_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tickets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "participant_id" "uuid",
    "event_id" "uuid" NOT NULL,
    "token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "issued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "used_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "order_item_id" "uuid",
    "organization_id" "uuid" NOT NULL,
    "owner_user_id" "uuid",
    CONSTRAINT "tickets_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'used'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."tickets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_pin_lookup_attempts" (
    "id" bigint NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "found" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."user_pin_lookup_attempts" OWNER TO "postgres";


ALTER TABLE "public"."user_pin_lookup_attempts" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."user_pin_lookup_attempts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "public"."admin_permissions"
    ADD CONSTRAINT "admin_permissions_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."admin_permissions"
    ADD CONSTRAINT "admin_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_role_permissions"
    ADD CONSTRAINT "admin_role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id");



ALTER TABLE ONLY "public"."admin_roles"
    ADD CONSTRAINT "admin_roles_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."admin_roles"
    ADD CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_user_permission_overrides"
    ADD CONSTRAINT "admin_user_permission_overrides_pkey" PRIMARY KEY ("user_id", "permission_id");



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_profiles"
    ADD CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."event_addon_options"
    ADD CONSTRAINT "event_addon_options_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_addons_config"
    ADD CONSTRAINT "event_addons_config_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."event_addons_model"
    ADD CONSTRAINT "event_addons_model_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."event_attractions"
    ADD CONSTRAINT "event_attractions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_batch_addon_options"
    ADD CONSTRAINT "event_batch_addon_options_pkey" PRIMARY KEY ("batch_id", "option_id");



ALTER TABLE ONLY "public"."event_highlights"
    ADD CONSTRAINT "event_highlights_event_id_key" UNIQUE ("event_id");



ALTER TABLE ONLY "public"."event_highlights"
    ADD CONSTRAINT "event_highlights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_kit_item_variant_inventory"
    ADD CONSTRAINT "event_kit_item_variant_inventory_kit_item_id_variant_id_key" UNIQUE ("kit_item_id", "variant_id");



ALTER TABLE ONLY "public"."event_kit_item_variant_inventory"
    ADD CONSTRAINT "event_kit_item_variant_inventory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_kit_item_variants"
    ADD CONSTRAINT "event_kit_item_variants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_kit_items"
    ADD CONSTRAINT "event_kit_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_payment_methods"
    ADD CONSTRAINT "event_payment_methods_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_id_organization_id_key" UNIQUE ("id", "organization_id");



ALTER TABLE ONLY "public"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_organization_id_code_key" UNIQUE ("organization_id", "code");



ALTER TABLE ONLY "public"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_categories"
    ADD CONSTRAINT "financial_categories_id_organization_id_key" UNIQUE ("id", "organization_id");



ALTER TABLE ONLY "public"."financial_categories"
    ADD CONSTRAINT "financial_categories_organization_id_name_key" UNIQUE ("organization_id", "name");



ALTER TABLE ONLY "public"."financial_categories"
    ADD CONSTRAINT "financial_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_id_organization_id_key" UNIQUE ("id", "organization_id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_organization_id_idempotency_key_key" UNIQUE ("organization_id", "idempotency_key");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_entry_lines"
    ADD CONSTRAINT "financial_entry_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_entry_settlements"
    ADD CONSTRAINT "financial_entry_settlements_organization_id_idempotency_key_key" UNIQUE ("organization_id", "idempotency_key");



ALTER TABLE ONLY "public"."financial_entry_settlements"
    ADD CONSTRAINT "financial_entry_settlements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_entry_settlements"
    ADD CONSTRAINT "financial_entry_settlements_settlement_entry_id_key" UNIQUE ("settlement_entry_id");



ALTER TABLE ONLY "public"."financial_event_allocations"
    ADD CONSTRAINT "financial_event_allocations_entry_id_event_id_key" UNIQUE ("entry_id", "event_id");



ALTER TABLE ONLY "public"."financial_event_allocations"
    ADD CONSTRAINT "financial_event_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_reconciliations"
    ADD CONSTRAINT "financial_reconciliations_organization_id_idempotency_key_key" UNIQUE ("organization_id", "idempotency_key");



ALTER TABLE ONLY "public"."financial_reconciliations"
    ADD CONSTRAINT "financial_reconciliations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_reversals"
    ADD CONSTRAINT "financial_reversals_organization_id_idempotency_key_key" UNIQUE ("organization_id", "idempotency_key");



ALTER TABLE ONLY "public"."financial_reversals"
    ADD CONSTRAINT "financial_reversals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_reversals"
    ADD CONSTRAINT "financial_reversals_reversal_entry_id_key" UNIQUE ("reversal_entry_id");



ALTER TABLE ONLY "public"."financial_suppliers"
    ADD CONSTRAINT "financial_suppliers_id_organization_id_key" UNIQUE ("id", "organization_id");



ALTER TABLE ONLY "public"."financial_suppliers"
    ADD CONSTRAINT "financial_suppliers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_batch_rows"
    ADD CONSTRAINT "import_batch_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_batch_rows"
    ADD CONSTRAINT "import_batch_rows_unique_row" UNIQUE ("import_batch_id", "row_number");



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kit_deliveries"
    ADD CONSTRAINT "kit_deliveries_participant_id_key" UNIQUE ("participant_id");



ALTER TABLE ONLY "public"."kit_deliveries"
    ADD CONSTRAINT "kit_deliveries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kit_delivery_schedule"
    ADD CONSTRAINT "kit_delivery_schedule_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_order_number_key" UNIQUE ("order_number");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_organization_id_user_id_key" UNIQUE ("organization_id", "user_id");



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."participant_account_invites"
    ADD CONSTRAINT "participant_account_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."participant_data_issues"
    ADD CONSTRAINT "participant_data_issues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."participant_kit_items"
    ADD CONSTRAINT "participant_kit_items_participant_kit_unique" UNIQUE ("order_item_id", "kit_item_id");



ALTER TABLE ONLY "public"."participant_kit_items"
    ADD CONSTRAINT "participant_kit_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."participant_wristbands"
    ADD CONSTRAINT "participant_wristbands_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."participation_history"
    ADD CONSTRAINT "participation_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_users"
    ADD CONSTRAINT "platform_users_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."registration_batch_addons"
    ADD CONSTRAINT "registration_batch_addons_event_batch_key" UNIQUE ("event_id", "batch_id");



ALTER TABLE ONLY "public"."registration_batch_addons"
    ADD CONSTRAINT "registration_batch_addons_pkey" PRIMARY KEY ("batch_id");



ALTER TABLE ONLY "public"."registration_batch_prices"
    ADD CONSTRAINT "registration_batch_prices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."registration_batches"
    ADD CONSTRAINT "registration_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."registration_batches"
    ADD CONSTRAINT "registration_batches_sequence_unique" UNIQUE ("event_id", "sequence_number");



ALTER TABLE ONLY "public"."registration_contacts"
    ADD CONSTRAINT "registration_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shirt_inventory"
    ADD CONSTRAINT "shirt_inventory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_item_inventory"
    ADD CONSTRAINT "store_item_inventory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_item_variants"
    ADD CONSTRAINT "store_item_variants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_items"
    ADD CONSTRAINT "store_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_order_items"
    ADD CONSTRAINT "store_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."store_orders"
    ADD CONSTRAINT "store_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ticket_categories"
    ADD CONSTRAINT "ticket_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ticket_category_benefits"
    ADD CONSTRAINT "ticket_category_benefits_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_new_reason_required_check" CHECK (("reason_code" IS NOT NULL)) NOT VALID;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_reason_code_check" CHECK (("reason_code" = ANY (ARRAY['registration_correction'::"text", 'buyer_request'::"text", 'holder_request'::"text", 'third_party_ticket'::"text", 'administrative_adjustment'::"text", 'issuance_error'::"text", 'system_error'::"text", 'data_regularization'::"text", 'other'::"text", 'legacy_unclassified'::"text"]))) NOT VALID;



ALTER TABLE "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_reason_other_text_check" CHECK ((("reason_code" <> 'other'::"text") OR (NULLIF(TRIM(BOTH FROM "reason_text"), ''::"text") IS NOT NULL))) NOT VALID;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ticket_owner_history"
    ADD CONSTRAINT "ticket_owner_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."user_pin_lookup_attempts"
    ADD CONSTRAINT "user_pin_lookup_attempts_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_admin_overrides_user_effect" ON "public"."admin_user_permission_overrides" USING "btree" ("user_id", "effect");



CREATE INDEX "idx_admin_permissions_module_sort" ON "public"."admin_permissions" USING "btree" ("module", "sort_order", "code");



CREATE INDEX "idx_admin_users_role_active" ON "public"."admin_users" USING "btree" ("role_id", "is_active");



CREATE INDEX "idx_audit_logs_event_id" ON "public"."audit_logs" USING "btree" ("event_id");



CREATE INDEX "idx_coupon_redemptions_coupon_id" ON "public"."coupon_redemptions" USING "btree" ("coupon_id");



CREATE INDEX "idx_coupon_redemptions_event_id" ON "public"."coupon_redemptions" USING "btree" ("event_id");



CREATE INDEX "idx_coupons_code" ON "public"."coupons" USING "btree" ("code");



CREATE INDEX "idx_coupons_event_id" ON "public"."coupons" USING "btree" ("event_id");



CREATE INDEX "idx_coupons_is_active" ON "public"."coupons" USING "btree" ("is_active");



CREATE INDEX "idx_coupons_valid_until" ON "public"."coupons" USING "btree" ("valid_until");



CREATE INDEX "idx_event_addon_options_event" ON "public"."event_addon_options" USING "btree" ("event_id", "is_active", "sort_order", "created_at");



CREATE INDEX "idx_event_attractions_event_active" ON "public"."event_attractions" USING "btree" ("event_id", "is_active", "sort_order");



CREATE INDEX "idx_event_batch_addon_options_event" ON "public"."event_batch_addon_options" USING "btree" ("event_id", "batch_id", "option_id");



CREATE INDEX "idx_event_highlights_is_active" ON "public"."event_highlights" USING "btree" ("is_active");



CREATE INDEX "idx_event_highlights_sort_order" ON "public"."event_highlights" USING "btree" ("sort_order");



CREATE INDEX "idx_event_kit_item_variants_item" ON "public"."event_kit_item_variants" USING "btree" ("kit_item_id", "is_active", "sort_order");



CREATE INDEX "idx_event_kit_items_event_active" ON "public"."event_kit_items" USING "btree" ("event_id", "is_active", "sort_order");



CREATE INDEX "idx_event_kit_items_org" ON "public"."event_kit_items" USING "btree" ("organization_id");



CREATE INDEX "idx_event_kit_items_org_event" ON "public"."event_kit_items" USING "btree" ("organization_id", "event_id");



CREATE INDEX "idx_events_organization_id" ON "public"."events" USING "btree" ("organization_id");



CREATE INDEX "idx_financial_allocations_event" ON "public"."financial_event_allocations" USING "btree" ("organization_id", "event_id");



CREATE INDEX "idx_financial_entries_org_due" ON "public"."financial_entries" USING "btree" ("organization_id", "due_date") WHERE ("lifecycle_status" = ANY (ARRAY['open'::"text", 'partially_settled'::"text"]));



CREATE INDEX "idx_financial_entries_org_kind" ON "public"."financial_entries" USING "btree" ("organization_id", "entry_kind", "lifecycle_status");



CREATE INDEX "idx_financial_reconciliations_entry" ON "public"."financial_reconciliations" USING "btree" ("entry_id");



CREATE INDEX "idx_financial_reversals_original" ON "public"."financial_reversals" USING "btree" ("original_entry_id");



CREATE INDEX "idx_import_batch_rows_batch_status" ON "public"."import_batch_rows" USING "btree" ("import_batch_id", "status", "row_number");



CREATE INDEX "idx_import_batches_historical_event_key" ON "public"."import_batches" USING "btree" ("historical_event_key");



CREATE INDEX "idx_import_batches_type_status" ON "public"."import_batches" USING "btree" ("import_type", "status", "created_at" DESC);



CREATE INDEX "idx_inventory_movements_event_id" ON "public"."inventory_movements" USING "btree" ("event_id");



CREATE INDEX "idx_inventory_movements_event_inventory_created_at" ON "public"."inventory_movements" USING "btree" ("event_id", "inventory_id", "created_at" DESC);



CREATE INDEX "idx_inventory_movements_inventory_id_created_at" ON "public"."inventory_movements" USING "btree" ("inventory_id", "created_at" DESC);



CREATE INDEX "idx_inventory_movements_org" ON "public"."inventory_movements" USING "btree" ("organization_id");



CREATE INDEX "idx_inventory_movements_org_event" ON "public"."inventory_movements" USING "btree" ("organization_id", "event_id");



CREATE INDEX "idx_inventory_type_size" ON "public"."shirt_inventory" USING "btree" ("shirt_type", "shirt_size");



CREATE INDEX "idx_kit_deliveries_event_id" ON "public"."kit_deliveries" USING "btree" ("event_id");



CREATE INDEX "idx_kit_delivery_schedule_active" ON "public"."kit_delivery_schedule" USING "btree" ("is_active");



CREATE INDEX "idx_kit_delivery_schedule_event_time" ON "public"."kit_delivery_schedule" USING "btree" ("event_id", "delivery_at") WHERE ("is_active" AND "is_visible_to_users");



CREATE INDEX "idx_kit_delivery_schedule_order" ON "public"."kit_delivery_schedule" USING "btree" ("sort_order", "delivery_at");



CREATE INDEX "idx_order_items_event_status" ON "public"."order_items" USING "btree" ("event_id", "status");



CREATE INDEX "idx_order_items_order_id" ON "public"."order_items" USING "btree" ("order_id");



CREATE INDEX "idx_order_items_order_status" ON "public"."order_items" USING "btree" ("order_id", "status");



CREATE INDEX "idx_order_items_participant_id" ON "public"."order_items" USING "btree" ("participant_id");



CREATE INDEX "idx_orders_event" ON "public"."orders" USING "btree" ("event_id");



CREATE INDEX "idx_orders_import_batch_id" ON "public"."orders" USING "btree" ("import_batch_id") WHERE ("import_batch_id" IS NOT NULL);



CREATE INDEX "idx_orders_org_created_at" ON "public"."orders" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_orders_org_event" ON "public"."orders" USING "btree" ("organization_id", "event_id");



CREATE INDEX "idx_orders_organization_id" ON "public"."orders" USING "btree" ("organization_id");



CREATE INDEX "idx_orders_participant_id" ON "public"."orders" USING "btree" ("participant_id");



CREATE INDEX "idx_orders_user_created" ON "public"."orders" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_org_members_org" ON "public"."organization_members" USING "btree" ("organization_id");



CREATE INDEX "idx_org_members_user" ON "public"."organization_members" USING "btree" ("user_id");



CREATE INDEX "idx_participant_account_invites_auth_user" ON "public"."participant_account_invites" USING "btree" ("auth_user_id") WHERE ("auth_user_id" IS NOT NULL);



CREATE INDEX "idx_participant_account_invites_email" ON "public"."participant_account_invites" USING "btree" ("lower"("email"), "status", "expires_at");



CREATE INDEX "idx_participant_data_issues_open" ON "public"."participant_data_issues" USING "btree" ("event_id", "participant_id", "field_code") WHERE ("status" = 'open'::"text");



CREATE INDEX "idx_participant_kit_items_event" ON "public"."participant_kit_items" USING "btree" ("event_id", "status");



CREATE INDEX "idx_participant_kit_items_org" ON "public"."participant_kit_items" USING "btree" ("organization_id");



CREATE INDEX "idx_participant_kit_items_org_event" ON "public"."participant_kit_items" USING "btree" ("organization_id", "event_id");



CREATE INDEX "idx_participant_kit_items_participant" ON "public"."participant_kit_items" USING "btree" ("participant_id", "status");



CREATE INDEX "idx_participant_kit_items_ticket_status" ON "public"."participant_kit_items" USING "btree" ("ticket_id", "status") WHERE ("ticket_id" IS NOT NULL);



CREATE INDEX "idx_participants_cpf" ON "public"."participants" USING "btree" ("cpf");



CREATE INDEX "idx_participants_email" ON "public"."participants" USING "btree" ("lower"("email"));



CREATE INDEX "idx_participants_event_category_status" ON "public"."participants" USING "btree" ("event_id", "ticket_category_id", "reservation_status", "registration_status");



CREATE INDEX "idx_participants_event_cpf" ON "public"."participants" USING "btree" ("event_id", "cpf");



CREATE INDEX "idx_participants_event_cpf_normalized" ON "public"."participants" USING "btree" ("event_id", "regexp_replace"(COALESCE("cpf", ''::"text"), '\\D'::"text", ''::"text", 'g'::"text"));



CREATE INDEX "idx_participants_event_email" ON "public"."participants" USING "btree" ("event_id", "lower"("email"));



CREATE INDEX "idx_participants_event_id" ON "public"."participants" USING "btree" ("event_id");



CREATE INDEX "idx_participants_event_id_reservation" ON "public"."participants" USING "btree" ("event_id");



CREATE INDEX "idx_participants_org_event" ON "public"."participants" USING "btree" ("organization_id", "event_id");



CREATE INDEX "idx_participants_organization_id" ON "public"."participants" USING "btree" ("organization_id");



CREATE INDEX "idx_participants_reservation_expires_at" ON "public"."participants" USING "btree" ("reservation_expires_at");



CREATE INDEX "idx_participants_reservation_status" ON "public"."participants" USING "btree" ("reservation_status");



CREATE INDEX "idx_participants_ticket_category_id" ON "public"."participants" USING "btree" ("ticket_category_id");



CREATE INDEX "idx_participants_user_id" ON "public"."participants" USING "btree" ("user_id");



CREATE INDEX "idx_participation_history_cpf" ON "public"."participation_history" USING "btree" ("cpf");



CREATE INDEX "idx_participation_history_email" ON "public"."participation_history" USING "btree" ("lower"("email"));



CREATE INDEX "idx_participation_history_event_year" ON "public"."participation_history" USING "btree" ("event_id", "event_year" DESC);



CREATE INDEX "idx_participation_history_historical_event_key" ON "public"."participation_history" USING "btree" ("historical_event_key");



CREATE INDEX "idx_participation_history_user_status" ON "public"."participation_history" USING "btree" ("user_id", "status", "event_year" DESC);



CREATE INDEX "idx_payments_event_id" ON "public"."payments" USING "btree" ("event_id");



CREATE INDEX "idx_payments_event_status" ON "public"."payments" USING "btree" ("event_id", "payment_status");



CREATE INDEX "idx_payments_expires_at" ON "public"."payments" USING "btree" ("expires_at");



CREATE INDEX "idx_payments_method_status" ON "public"."payments" USING "btree" ("payment_method", "payment_status");



CREATE INDEX "idx_payments_order_id" ON "public"."payments" USING "btree" ("order_id");



CREATE INDEX "idx_payments_org_created_at" ON "public"."payments" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_payments_org_event" ON "public"."payments" USING "btree" ("organization_id", "event_id");



CREATE INDEX "idx_payments_org_status" ON "public"."payments" USING "btree" ("organization_id", "payment_status");



CREATE INDEX "idx_payments_organization_id" ON "public"."payments" USING "btree" ("organization_id");



CREATE INDEX "idx_payments_participant_id" ON "public"."payments" USING "btree" ("participant_id");



CREATE INDEX "idx_payments_status" ON "public"."payments" USING "btree" ("payment_status");



CREATE INDEX "idx_platform_users_active" ON "public"."platform_users" USING "btree" ("is_active");



CREATE INDEX "idx_registration_batch_addons_event_id" ON "public"."registration_batch_addons" USING "btree" ("event_id");



CREATE INDEX "idx_registration_batch_prices_batch" ON "public"."registration_batch_prices" USING "btree" ("batch_id");



CREATE INDEX "idx_registration_batch_prices_category" ON "public"."registration_batch_prices" USING "btree" ("ticket_category_id");



CREATE INDEX "idx_registration_batches_event_sequence" ON "public"."registration_batches" USING "btree" ("event_id", "sequence_number");



CREATE INDEX "idx_registration_contacts_org_name" ON "public"."registration_contacts" USING "btree" ("organization_id", "full_name");



CREATE INDEX "idx_shirt_inventory_event_id" ON "public"."shirt_inventory" USING "btree" ("event_id");



CREATE INDEX "idx_shirt_inventory_org" ON "public"."shirt_inventory" USING "btree" ("organization_id");



CREATE INDEX "idx_shirt_inventory_org_event" ON "public"."shirt_inventory" USING "btree" ("organization_id", "event_id");



CREATE INDEX "idx_shirt_inventory_org_event_type_size" ON "public"."shirt_inventory" USING "btree" ("organization_id", "event_id", "shirt_type", "shirt_size");



CREATE INDEX "idx_store_item_variants_item" ON "public"."store_item_variants" USING "btree" ("store_item_id", "is_active", "sort_order");



CREATE INDEX "idx_store_items_event_active" ON "public"."store_items" USING "btree" ("event_id", "is_active", "sort_order");



CREATE INDEX "idx_store_order_items_order" ON "public"."store_order_items" USING "btree" ("store_order_id");



CREATE INDEX "idx_store_orders_event" ON "public"."store_orders" USING "btree" ("event_id", "status");



CREATE INDEX "idx_store_orders_user" ON "public"."store_orders" USING "btree" ("user_id");



CREATE INDEX "idx_ticket_categories_event_active" ON "public"."ticket_categories" USING "btree" ("event_id", "is_active", "sort_order");



CREATE INDEX "idx_ticket_category_benefits_category" ON "public"."ticket_category_benefits" USING "btree" ("ticket_category_id", "sort_order", "created_at");



CREATE INDEX "idx_ticket_item_change_requests_event_status" ON "public"."ticket_item_change_requests" USING "btree" ("event_id", "status", "requested_at" DESC);



CREATE INDEX "idx_ticket_owner_history_org_created" ON "public"."ticket_owner_history" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_ticket_owner_history_ticket_created" ON "public"."ticket_owner_history" USING "btree" ("ticket_id", "created_at" DESC);



CREATE INDEX "idx_tickets_event_id" ON "public"."tickets" USING "btree" ("event_id");



CREATE INDEX "idx_tickets_order_id" ON "public"."tickets" USING "btree" ("order_id");



CREATE INDEX "idx_tickets_order_item_id" ON "public"."tickets" USING "btree" ("order_item_id");



CREATE INDEX "idx_tickets_org_order" ON "public"."tickets" USING "btree" ("organization_id", "order_id");



CREATE INDEX "idx_tickets_org_owner_user_id" ON "public"."tickets" USING "btree" ("organization_id", "owner_user_id") WHERE ("owner_user_id" IS NOT NULL);



CREATE INDEX "idx_tickets_org_participant" ON "public"."tickets" USING "btree" ("organization_id", "participant_id");



CREATE INDEX "idx_tickets_org_status" ON "public"."tickets" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_tickets_organization_id" ON "public"."tickets" USING "btree" ("organization_id");



CREATE INDEX "idx_tickets_owner_user_id" ON "public"."tickets" USING "btree" ("owner_user_id") WHERE ("owner_user_id" IS NOT NULL);



CREATE INDEX "idx_tickets_participant_id" ON "public"."tickets" USING "btree" ("participant_id");



CREATE INDEX "idx_user_pin_lookup_attempts_actor_time" ON "public"."user_pin_lookup_attempts" USING "btree" ("actor_user_id", "attempted_at" DESC);



CREATE INDEX "idx_wristbands_org_code_active" ON "public"."participant_wristbands" USING "btree" ("organization_id", "event_id", "lower"("code")) WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_wristbands_org_event" ON "public"."participant_wristbands" USING "btree" ("organization_id", "event_id");



CREATE INDEX "idx_wristbands_org_ticket" ON "public"."participant_wristbands" USING "btree" ("organization_id", "ticket_id");



CREATE INDEX "idx_wristbands_organization_id" ON "public"."participant_wristbands" USING "btree" ("organization_id");



CREATE UNIQUE INDEX "participant_wristbands_event_code_active_uidx" ON "public"."participant_wristbands" USING "btree" ("event_id", "lower"("code")) WHERE ("status" = 'active'::"text");



CREATE INDEX "participant_wristbands_event_idx" ON "public"."participant_wristbands" USING "btree" ("event_id");



CREATE INDEX "participant_wristbands_participant_idx" ON "public"."participant_wristbands" USING "btree" ("participant_id");



CREATE UNIQUE INDEX "participant_wristbands_ticket_active_uidx" ON "public"."participant_wristbands" USING "btree" ("ticket_id") WHERE ("status" = 'active'::"text");



CREATE UNIQUE INDEX "uq_financial_entries_source_payment_revenue" ON "public"."financial_entries" USING "btree" ("source_payment_id") WHERE (("source_payment_id" IS NOT NULL) AND ("entry_kind" = 'revenue'::"text"));



CREATE UNIQUE INDEX "uq_financial_suppliers_org_tax_identifier" ON "public"."financial_suppliers" USING "btree" ("organization_id", "tax_identifier") WHERE ("tax_identifier" IS NOT NULL);



CREATE UNIQUE INDEX "ux_admin_roles_code" ON "public"."admin_roles" USING "btree" ("code");



CREATE UNIQUE INDEX "ux_admin_roles_name" ON "public"."admin_roles" USING "btree" ("name");



CREATE UNIQUE INDEX "ux_coupon_redemption_once_per_participant" ON "public"."coupon_redemptions" USING "btree" ("coupon_id", "participant_id");



CREATE UNIQUE INDEX "ux_coupons_event_code" ON "public"."coupons" USING "btree" ("event_id", "code");



CREATE UNIQUE INDEX "ux_customer_profiles_public_pin" ON "public"."customer_profiles" USING "btree" ("public_pin") WHERE ("public_pin" IS NOT NULL);



CREATE UNIQUE INDEX "ux_event_addon_options_event_name" ON "public"."event_addon_options" USING "btree" ("event_id", "lower"("name"));



CREATE UNIQUE INDEX "ux_event_kit_items_event_slug" ON "public"."event_kit_items" USING "btree" ("event_id", "slug");



CREATE UNIQUE INDEX "ux_events_slug" ON "public"."events" USING "btree" ("slug");



CREATE UNIQUE INDEX "ux_order_items_order_item_position" ON "public"."order_items" USING "btree" ("order_id", "item_position") WHERE ("item_position" IS NOT NULL);



CREATE UNIQUE INDEX "ux_order_items_order_participant" ON "public"."order_items" USING "btree" ("order_id", "participant_id");



CREATE UNIQUE INDEX "ux_orders_user_client_request" ON "public"."orders" USING "btree" ("user_id", "client_request_id") WHERE ("client_request_id" IS NOT NULL);



CREATE UNIQUE INDEX "ux_participant_account_invites_pending" ON "public"."participant_account_invites" USING "btree" ("participant_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "ux_participant_data_issues_open" ON "public"."participant_data_issues" USING "btree" ("participant_id", COALESCE("import_batch_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "field_code", "issue_type") WHERE ("status" = 'open'::"text");



CREATE UNIQUE INDEX "ux_participant_kit_items_order_item_item" ON "public"."participant_kit_items" USING "btree" ("order_item_id", "kit_item_id") WHERE ("order_item_id" IS NOT NULL);



CREATE UNIQUE INDEX "ux_participant_kit_items_ticket_item" ON "public"."participant_kit_items" USING "btree" ("ticket_id", "kit_item_id") WHERE ("ticket_id" IS NOT NULL);



CREATE UNIQUE INDEX "ux_participation_history_hist_key_cpf_confirmed" ON "public"."participation_history" USING "btree" ("historical_event_key", "public"."normalize_cpf"("cpf")) WHERE (("event_id" IS NULL) AND ("historical_event_key" IS NOT NULL) AND ("public"."normalize_cpf"("cpf") IS NOT NULL) AND ("status" = 'confirmed'::"text"));



CREATE UNIQUE INDEX "ux_participation_history_hist_key_email_confirmed" ON "public"."participation_history" USING "btree" ("historical_event_key", "public"."normalize_email"("email")) WHERE (("event_id" IS NULL) AND ("historical_event_key" IS NOT NULL) AND ("public"."normalize_cpf"("cpf") IS NULL) AND ("public"."normalize_email"("email") IS NOT NULL) AND ("status" = 'confirmed'::"text"));



CREATE UNIQUE INDEX "ux_participation_history_hist_key_name_confirmed" ON "public"."participation_history" USING "btree" ("historical_event_key", COALESCE(NULLIF(TRIM(BOTH FROM "normalized_name"), ''::"text"), "public"."normalize_text_for_match"("full_name"))) WHERE (("event_id" IS NULL) AND ("historical_event_key" IS NOT NULL) AND ("public"."normalize_cpf"("cpf") IS NULL) AND ("public"."normalize_email"("email") IS NULL) AND (COALESCE(NULLIF(TRIM(BOTH FROM "normalized_name"), ''::"text"), "public"."normalize_text_for_match"("full_name")) IS NOT NULL) AND ("status" = 'confirmed'::"text"));



CREATE UNIQUE INDEX "ux_participation_history_user_event_confirmed" ON "public"."participation_history" USING "btree" ("user_id", "event_id") WHERE (("user_id" IS NOT NULL) AND ("event_id" IS NOT NULL) AND ("status" = 'confirmed'::"text"));



CREATE UNIQUE INDEX "ux_registration_batch_prices_batch_category" ON "public"."registration_batch_prices" USING "btree" ("batch_id", "ticket_category_id");



CREATE UNIQUE INDEX "ux_registration_batches_single_active" ON "public"."registration_batches" USING "btree" ("event_id") WHERE "is_active";



CREATE UNIQUE INDEX "ux_registration_contacts_org_cpf" ON "public"."registration_contacts" USING "btree" ("organization_id", "cpf");



CREATE UNIQUE INDEX "ux_registration_contacts_public_pin" ON "public"."registration_contacts" USING "btree" ("public_pin") WHERE ("public_pin" IS NOT NULL);



CREATE UNIQUE INDEX "ux_shirt_inventory_event_type_size" ON "public"."shirt_inventory" USING "btree" ("event_id", "shirt_type", "shirt_size");



CREATE UNIQUE INDEX "ux_store_item_inventory_item_variant" ON "public"."store_item_inventory" USING "btree" ("store_item_id", COALESCE("variant_id", '00000000-0000-0000-0000-000000000000'::"uuid"));



CREATE UNIQUE INDEX "ux_store_items_event_slug" ON "public"."store_items" USING "btree" ("event_id", "slug");



CREATE UNIQUE INDEX "ux_store_orders_number" ON "public"."store_orders" USING "btree" ("order_number");



CREATE UNIQUE INDEX "ux_ticket_categories_event_name" ON "public"."ticket_categories" USING "btree" ("event_id", "lower"("name"));



CREATE UNIQUE INDEX "ux_ticket_categories_event_slug" ON "public"."ticket_categories" USING "btree" ("event_id", "slug");



CREATE UNIQUE INDEX "ux_ticket_item_change_requests_pending" ON "public"."ticket_item_change_requests" USING "btree" ("ticket_id", "kit_item_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "ux_tickets_order_item_id_all" ON "public"."tickets" USING "btree" ("order_item_id");



CREATE OR REPLACE TRIGGER "classify_administrative_order" BEFORE INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."trg_classify_administrative_order"();



CREATE OR REPLACE TRIGGER "enforce_order_item_holder_contact_uniqueness" BEFORE UPDATE OF "participant_id", "registration_contact_id", "event_id" ON "public"."order_items" FOR EACH ROW EXECUTE FUNCTION "public"."trg_enforce_ticket_holder_contact_uniqueness"();



CREATE OR REPLACE TRIGGER "enforce_ticket_holder_contact_uniqueness" BEFORE INSERT OR UPDATE OF "participant_id", "event_id", "status", "order_item_id" ON "public"."tickets" FOR EACH ROW EXECUTE FUNCTION "public"."trg_enforce_ticket_holder_contact_uniqueness"();



CREATE OR REPLACE TRIGGER "initialize_ticket_owner" BEFORE INSERT ON "public"."tickets" FOR EACH ROW EXECUTE FUNCTION "public"."trg_initialize_ticket_owner"();



CREATE OR REPLACE TRIGGER "ticket_holder_history_contacts" BEFORE INSERT OR UPDATE OF "previous_participant_id", "new_participant_id" ON "public"."ticket_holder_history" FOR EACH ROW EXECUTE FUNCTION "public"."trg_ticket_holder_history_contacts"();



CREATE OR REPLACE TRIGGER "ticket_holder_history_reason_compatibility" BEFORE INSERT ON "public"."ticket_holder_history" FOR EACH ROW EXECUTE FUNCTION "public"."trg_ticket_holder_history_reason_compatibility"();



CREATE OR REPLACE TRIGGER "trg_admin_overrides_touch_updated_at" BEFORE UPDATE ON "public"."admin_user_permission_overrides" FOR EACH ROW EXECUTE FUNCTION "public"."touch_admin_overrides_updated_at"();



CREATE OR REPLACE TRIGGER "trg_admin_roles_touch_updated_at" BEFORE UPDATE ON "public"."admin_roles" FOR EACH ROW EXECUTE FUNCTION "public"."touch_admin_roles_updated_at"();



CREATE OR REPLACE TRIGGER "trg_admin_users_touch_updated_at" BEFORE UPDATE ON "public"."admin_users" FOR EACH ROW EXECUTE FUNCTION "public"."touch_admin_users_updated_at"();



CREATE OR REPLACE TRIGGER "trg_attach_unresolved_kit_items_to_ticket" AFTER INSERT ON "public"."tickets" FOR EACH ROW EXECUTE FUNCTION "public"."attach_order_item_kit_items_to_new_ticket"();



CREATE OR REPLACE TRIGGER "trg_enforce_explicit_shirt_supply_mode" BEFORE INSERT OR UPDATE ON "public"."event_kit_items" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_explicit_shirt_supply_mode"();



CREATE OR REPLACE TRIGGER "trg_event_kit_items_org" BEFORE INSERT OR UPDATE ON "public"."event_kit_items" FOR EACH ROW EXECUTE FUNCTION "public"."trg_event_kit_items_set_org"();



CREATE OR REPLACE TRIGGER "trg_events_normalize_before_write" BEFORE INSERT OR UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_events_before_write"();



CREATE OR REPLACE TRIGGER "trg_inventory_movements_org" BEFORE INSERT OR UPDATE ON "public"."inventory_movements" FOR EACH ROW EXECUTE FUNCTION "public"."trg_inventory_movements_set_org"();



CREATE OR REPLACE TRIGGER "trg_materialize_order_item_kit_reservations" AFTER INSERT ON "public"."order_items" FOR EACH ROW EXECUTE FUNCTION "public"."materialize_order_item_kit_reservations"();



CREATE OR REPLACE TRIGGER "trg_normalize_coupon_code" BEFORE INSERT OR UPDATE OF "code" ON "public"."coupons" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_coupon_code"();



CREATE OR REPLACE TRIGGER "trg_orders_org_consistency" BEFORE INSERT OR UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."trg_orders_set_organization_id"();



CREATE OR REPLACE TRIGGER "trg_participant_kit_items_org" BEFORE INSERT OR UPDATE ON "public"."participant_kit_items" FOR EACH ROW EXECUTE FUNCTION "public"."trg_participant_kit_items_set_org"();



CREATE OR REPLACE TRIGGER "trg_participants_org_consistency" BEFORE INSERT OR UPDATE ON "public"."participants" FOR EACH ROW EXECUTE FUNCTION "public"."trg_participants_set_organization_id"();



CREATE OR REPLACE TRIGGER "trg_payments_org_consistency" BEFORE INSERT OR UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."trg_payments_set_organization_id"();



CREATE OR REPLACE TRIGGER "trg_prevent_last_owner_admin_user_mutation" BEFORE DELETE OR UPDATE ON "public"."admin_users" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_last_owner_admin_user_mutation"();



CREATE OR REPLACE TRIGGER "trg_prevent_owner_role_mutation" BEFORE DELETE OR UPDATE ON "public"."admin_roles" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_owner_role_mutation"();



CREATE OR REPLACE TRIGGER "trg_shirt_inventory_org" BEFORE INSERT OR UPDATE ON "public"."shirt_inventory" FOR EACH ROW EXECUTE FUNCTION "public"."trg_shirt_inventory_set_org"();



CREATE OR REPLACE TRIGGER "trg_store_item_inventory_org" BEFORE INSERT OR UPDATE ON "public"."store_item_inventory" FOR EACH ROW EXECUTE FUNCTION "public"."trg_store_item_inventory_set_org"();



CREATE OR REPLACE TRIGGER "trg_store_items_org" BEFORE INSERT OR UPDATE ON "public"."store_items" FOR EACH ROW EXECUTE FUNCTION "public"."trg_store_items_set_org"();



CREATE OR REPLACE TRIGGER "trg_store_orders_org" BEFORE INSERT OR UPDATE ON "public"."store_orders" FOR EACH ROW EXECUTE FUNCTION "public"."trg_store_orders_set_org"();



CREATE OR REPLACE TRIGGER "trg_sync_participant_registration_contact" BEFORE INSERT ON "public"."participants" FOR EACH ROW EXECUTE FUNCTION "public"."sync_participant_registration_contact"();



CREATE OR REPLACE TRIGGER "trg_ticket_categories_normalize" BEFORE INSERT OR UPDATE ON "public"."ticket_categories" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_ticket_category_slug"();



CREATE OR REPLACE TRIGGER "trg_ticket_kit_auxiliary_participant" AFTER UPDATE OF "participant_id" ON "public"."tickets" FOR EACH ROW EXECUTE FUNCTION "public"."sync_ticket_kit_auxiliary_participant"();



CREATE OR REPLACE TRIGGER "trg_ticket_kit_item_consistency" BEFORE INSERT OR UPDATE OF "ticket_id", "order_item_id", "kit_item_id", "event_id", "organization_id", "participant_id" ON "public"."participant_kit_items" FOR EACH ROW EXECUTE FUNCTION "public"."trg_ticket_kit_item_consistency"();



CREATE OR REPLACE TRIGGER "trg_tickets_org_consistency" BEFORE INSERT OR UPDATE ON "public"."tickets" FOR EACH ROW EXECUTE FUNCTION "public"."trg_tickets_set_organization_id"();



CREATE OR REPLACE TRIGGER "trg_touch_customer_profiles_updated_at" BEFORE UPDATE ON "public"."customer_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."touch_customer_profiles_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_event_kit_items" BEFORE INSERT OR UPDATE ON "public"."event_kit_items" FOR EACH ROW EXECUTE FUNCTION "public"."touch_event_kit_items_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_import_batch_rows_updated_at" BEFORE UPDATE ON "public"."import_batch_rows" FOR EACH ROW EXECUTE FUNCTION "public"."touch_import_batch_rows_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_order_items_updated_at" BEFORE UPDATE ON "public"."order_items" FOR EACH ROW EXECUTE FUNCTION "public"."touch_order_items_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_participation_history_updated_at" BEFORE UPDATE ON "public"."participation_history" FOR EACH ROW EXECUTE FUNCTION "public"."touch_participation_history_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_payments_updated_at" BEFORE UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."touch_payments_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_registration_batch_prices_updated_at" BEFORE UPDATE ON "public"."registration_batch_prices" FOR EACH ROW EXECUTE FUNCTION "public"."touch_registration_batch_prices_updated_at"();



CREATE OR REPLACE TRIGGER "trg_touch_ticket_category_benefits_updated_at" BEFORE UPDATE ON "public"."ticket_category_benefits" FOR EACH ROW EXECUTE FUNCTION "public"."touch_ticket_category_benefits_updated_at"();



CREATE OR REPLACE TRIGGER "trg_wristbands_org_consistency" BEFORE INSERT OR UPDATE ON "public"."participant_wristbands" FOR EACH ROW EXECUTE FUNCTION "public"."trg_wristbands_set_organization_id"();



ALTER TABLE ONLY "public"."admin_role_permissions"
    ADD CONSTRAINT "admin_role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."admin_permissions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."admin_role_permissions"
    ADD CONSTRAINT "admin_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."admin_roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."admin_user_permission_overrides"
    ADD CONSTRAINT "admin_user_permission_overrides_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."admin_permissions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."admin_user_permission_overrides"
    ADD CONSTRAINT "admin_user_permission_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."admin_roles"("id");



ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id");



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."coupon_redemptions"
    ADD CONSTRAINT "coupon_redemptions_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id");



ALTER TABLE ONLY "public"."coupons"
    ADD CONSTRAINT "coupons_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."customer_profiles"
    ADD CONSTRAINT "customer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_addon_options"
    ADD CONSTRAINT "event_addon_options_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_addons_config"
    ADD CONSTRAINT "event_addons_config_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_addons_model"
    ADD CONSTRAINT "event_addons_model_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_attractions"
    ADD CONSTRAINT "event_attractions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_batch_addon_options"
    ADD CONSTRAINT "event_batch_addon_options_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."registration_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_batch_addon_options"
    ADD CONSTRAINT "event_batch_addon_options_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_batch_addon_options"
    ADD CONSTRAINT "event_batch_addon_options_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "public"."event_addon_options"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_highlights"
    ADD CONSTRAINT "event_highlights_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_kit_item_variant_inventory"
    ADD CONSTRAINT "event_kit_item_variant_inventory_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_kit_item_variant_inventory"
    ADD CONSTRAINT "event_kit_item_variant_inventory_kit_item_id_fkey" FOREIGN KEY ("kit_item_id") REFERENCES "public"."event_kit_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_kit_item_variant_inventory"
    ADD CONSTRAINT "event_kit_item_variant_inventory_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_kit_item_variant_inventory"
    ADD CONSTRAINT "event_kit_item_variant_inventory_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."event_kit_item_variants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_kit_item_variants"
    ADD CONSTRAINT "event_kit_item_variants_kit_item_id_fkey" FOREIGN KEY ("kit_item_id") REFERENCES "public"."event_kit_items"("id");



ALTER TABLE ONLY "public"."event_kit_items"
    ADD CONSTRAINT "event_kit_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."event_kit_items"
    ADD CONSTRAINT "event_kit_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."event_payment_methods"
    ADD CONSTRAINT "event_payment_methods_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."financial_accounts"
    ADD CONSTRAINT "financial_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."financial_event_allocations"
    ADD CONSTRAINT "financial_alloc_entry_org_fk" FOREIGN KEY ("entry_id", "organization_id") REFERENCES "public"."financial_entries"("id", "organization_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_event_allocations"
    ADD CONSTRAINT "financial_alloc_event_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."financial_categories"
    ADD CONSTRAINT "financial_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_category_org_fk" FOREIGN KEY ("category_id", "organization_id") REFERENCES "public"."financial_categories"("id", "organization_id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_original_fk" FOREIGN KEY ("original_entry_id") REFERENCES "public"."financial_entries"("id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_source_order_id_fkey" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_source_participant_id_fkey" FOREIGN KEY ("source_participant_id") REFERENCES "public"."participants"("id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_source_payment_id_fkey" FOREIGN KEY ("source_payment_id") REFERENCES "public"."payments"("id");



ALTER TABLE ONLY "public"."financial_entries"
    ADD CONSTRAINT "financial_entries_supplier_org_fk" FOREIGN KEY ("supplier_id", "organization_id") REFERENCES "public"."financial_suppliers"("id", "organization_id");



ALTER TABLE ONLY "public"."financial_entry_settlements"
    ADD CONSTRAINT "financial_entry_settlements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."financial_entry_settlements"
    ADD CONSTRAINT "financial_entry_settlements_settled_by_fkey" FOREIGN KEY ("settled_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."financial_entry_lines"
    ADD CONSTRAINT "financial_lines_account_org_fk" FOREIGN KEY ("account_id", "organization_id") REFERENCES "public"."financial_accounts"("id", "organization_id");



ALTER TABLE ONLY "public"."financial_entry_lines"
    ADD CONSTRAINT "financial_lines_entry_org_fk" FOREIGN KEY ("entry_id", "organization_id") REFERENCES "public"."financial_entries"("id", "organization_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_reconciliations"
    ADD CONSTRAINT "financial_rec_account_org_fk" FOREIGN KEY ("account_id", "organization_id") REFERENCES "public"."financial_accounts"("id", "organization_id");



ALTER TABLE ONLY "public"."financial_reconciliations"
    ADD CONSTRAINT "financial_rec_entry_org_fk" FOREIGN KEY ("entry_id", "organization_id") REFERENCES "public"."financial_entries"("id", "organization_id");



ALTER TABLE ONLY "public"."financial_reconciliations"
    ADD CONSTRAINT "financial_reconciliations_reconciled_by_fkey" FOREIGN KEY ("reconciled_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."financial_reversals"
    ADD CONSTRAINT "financial_reversal_entry_org_fk" FOREIGN KEY ("reversal_entry_id", "organization_id") REFERENCES "public"."financial_entries"("id", "organization_id");



ALTER TABLE ONLY "public"."financial_reversals"
    ADD CONSTRAINT "financial_reversal_original_org_fk" FOREIGN KEY ("original_entry_id", "organization_id") REFERENCES "public"."financial_entries"("id", "organization_id");



ALTER TABLE ONLY "public"."financial_reversals"
    ADD CONSTRAINT "financial_reversals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."financial_reversals"
    ADD CONSTRAINT "financial_reversals_reversed_by_fkey" FOREIGN KEY ("reversed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."financial_entry_settlements"
    ADD CONSTRAINT "financial_settlement_entry_org_fk" FOREIGN KEY ("settlement_entry_id", "organization_id") REFERENCES "public"."financial_entries"("id", "organization_id");



ALTER TABLE ONLY "public"."financial_entry_settlements"
    ADD CONSTRAINT "financial_settlement_expense_org_fk" FOREIGN KEY ("expense_entry_id", "organization_id") REFERENCES "public"."financial_entries"("id", "organization_id");



ALTER TABLE ONLY "public"."financial_suppliers"
    ADD CONSTRAINT "financial_suppliers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."import_batch_rows"
    ADD CONSTRAINT "import_batch_rows_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_batch_rows"
    ADD CONSTRAINT "import_batch_rows_matched_participant_id_fkey" FOREIGN KEY ("matched_participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."import_batch_rows"
    ADD CONSTRAINT "import_batch_rows_matched_user_id_fkey" FOREIGN KEY ("matched_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_imported_by_fkey" FOREIGN KEY ("imported_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "public"."shirt_inventory"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."kit_deliveries"
    ADD CONSTRAINT "kit_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."kit_deliveries"
    ADD CONSTRAINT "kit_deliveries_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."kit_delivery_schedule"
    ADD CONSTRAINT "kit_delivery_schedule_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."registration_batches"("id");



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_registration_contact_id_fkey" FOREIGN KEY ("registration_contact_id") REFERENCES "public"."registration_contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_ticket_category_id_fkey" FOREIGN KEY ("ticket_category_id") REFERENCES "public"."ticket_categories"("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."admin_roles"("id");



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_account_invites"
    ADD CONSTRAINT "participant_account_invites_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participant_account_invites"
    ADD CONSTRAINT "participant_account_invites_claimed_user_id_fkey" FOREIGN KEY ("claimed_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participant_account_invites"
    ADD CONSTRAINT "participant_account_invites_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_account_invites"
    ADD CONSTRAINT "participant_account_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."participant_account_invites"
    ADD CONSTRAINT "participant_account_invites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_account_invites"
    ADD CONSTRAINT "participant_account_invites_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_data_issues"
    ADD CONSTRAINT "participant_data_issues_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_data_issues"
    ADD CONSTRAINT "participant_data_issues_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participant_data_issues"
    ADD CONSTRAINT "participant_data_issues_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_data_issues"
    ADD CONSTRAINT "participant_data_issues_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_data_issues"
    ADD CONSTRAINT "participant_data_issues_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participant_kit_items"
    ADD CONSTRAINT "participant_kit_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."participant_kit_items"
    ADD CONSTRAINT "participant_kit_items_kit_item_id_fkey" FOREIGN KEY ("kit_item_id") REFERENCES "public"."event_kit_items"("id");



ALTER TABLE ONLY "public"."participant_kit_items"
    ADD CONSTRAINT "participant_kit_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participant_kit_items"
    ADD CONSTRAINT "participant_kit_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."participant_kit_items"
    ADD CONSTRAINT "participant_kit_items_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participant_kit_items"
    ADD CONSTRAINT "participant_kit_items_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_wristbands"
    ADD CONSTRAINT "participant_wristbands_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_wristbands"
    ADD CONSTRAINT "participant_wristbands_linked_by_fkey" FOREIGN KEY ("linked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participant_wristbands"
    ADD CONSTRAINT "participant_wristbands_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."participant_wristbands"
    ADD CONSTRAINT "participant_wristbands_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participant_wristbands"
    ADD CONSTRAINT "participant_wristbands_replaced_by_wristband_id_fkey" FOREIGN KEY ("replaced_by_wristband_id") REFERENCES "public"."participant_wristbands"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participant_wristbands"
    ADD CONSTRAINT "participant_wristbands_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participant_wristbands"
    ADD CONSTRAINT "participant_wristbands_unlinked_by_fkey" FOREIGN KEY ("unlinked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."registration_batches"("id");



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_registration_contact_id_fkey" FOREIGN KEY ("registration_contact_id") REFERENCES "public"."registration_contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_ticket_category_id_fkey" FOREIGN KEY ("ticket_category_id") REFERENCES "public"."ticket_categories"("id");



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participation_history"
    ADD CONSTRAINT "participation_history_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participation_history"
    ADD CONSTRAINT "participation_history_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participation_history"
    ADD CONSTRAINT "participation_history_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participation_history"
    ADD CONSTRAINT "participation_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_settings"
    ADD CONSTRAINT "platform_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."platform_users"
    ADD CONSTRAINT "platform_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."registration_batch_addons"
    ADD CONSTRAINT "registration_batch_addons_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."registration_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."registration_batch_addons"
    ADD CONSTRAINT "registration_batch_addons_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."registration_batch_prices"
    ADD CONSTRAINT "registration_batch_prices_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."registration_batches"("id");



ALTER TABLE ONLY "public"."registration_batch_prices"
    ADD CONSTRAINT "registration_batch_prices_ticket_category_id_fkey" FOREIGN KEY ("ticket_category_id") REFERENCES "public"."ticket_categories"("id");



ALTER TABLE ONLY "public"."registration_batches"
    ADD CONSTRAINT "registration_batches_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."registration_contacts"
    ADD CONSTRAINT "registration_contacts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."registration_contacts"
    ADD CONSTRAINT "registration_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shirt_inventory"
    ADD CONSTRAINT "shirt_inventory_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."shirt_inventory"
    ADD CONSTRAINT "shirt_inventory_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."store_item_inventory"
    ADD CONSTRAINT "store_item_inventory_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_item_inventory"
    ADD CONSTRAINT "store_item_inventory_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_item_inventory"
    ADD CONSTRAINT "store_item_inventory_store_item_id_fkey" FOREIGN KEY ("store_item_id") REFERENCES "public"."store_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_item_inventory"
    ADD CONSTRAINT "store_item_inventory_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."store_item_variants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_item_variants"
    ADD CONSTRAINT "store_item_variants_store_item_id_fkey" FOREIGN KEY ("store_item_id") REFERENCES "public"."store_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_items"
    ADD CONSTRAINT "store_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_items"
    ADD CONSTRAINT "store_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_order_items"
    ADD CONSTRAINT "store_order_items_store_item_id_fkey" FOREIGN KEY ("store_item_id") REFERENCES "public"."store_items"("id");



ALTER TABLE ONLY "public"."store_order_items"
    ADD CONSTRAINT "store_order_items_store_order_id_fkey" FOREIGN KEY ("store_order_id") REFERENCES "public"."store_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_order_items"
    ADD CONSTRAINT "store_order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."store_item_variants"("id");



ALTER TABLE ONLY "public"."store_orders"
    ADD CONSTRAINT "store_orders_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_orders"
    ADD CONSTRAINT "store_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."store_orders"
    ADD CONSTRAINT "store_orders_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."store_orders"
    ADD CONSTRAINT "store_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ticket_categories"
    ADD CONSTRAINT "ticket_categories_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."ticket_category_benefits"
    ADD CONSTRAINT "ticket_category_benefits_ticket_category_id_fkey" FOREIGN KEY ("ticket_category_id") REFERENCES "public"."ticket_categories"("id");



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_new_participant_id_fkey" FOREIGN KEY ("new_participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_new_registration_contact_id_fkey" FOREIGN KEY ("new_registration_contact_id") REFERENCES "public"."registration_contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_new_user_id_fkey" FOREIGN KEY ("new_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_previous_participant_id_fkey" FOREIGN KEY ("previous_participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_previous_registration_contact_id_fkey" FOREIGN KEY ("previous_registration_contact_id") REFERENCES "public"."registration_contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_previous_user_id_fkey" FOREIGN KEY ("previous_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ticket_holder_history"
    ADD CONSTRAINT "ticket_holder_history_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_current_variant_id_fkey" FOREIGN KEY ("current_variant_id") REFERENCES "public"."event_kit_item_variants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_kit_item_id_fkey" FOREIGN KEY ("kit_item_id") REFERENCES "public"."event_kit_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_participant_kit_item_id_fkey" FOREIGN KEY ("participant_kit_item_id") REFERENCES "public"."participant_kit_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_requested_variant_id_fkey" FOREIGN KEY ("requested_variant_id") REFERENCES "public"."event_kit_item_variants"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ticket_item_change_requests"
    ADD CONSTRAINT "ticket_item_change_requests_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ticket_owner_history"
    ADD CONSTRAINT "ticket_owner_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_owner_history"
    ADD CONSTRAINT "ticket_owner_history_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_owner_history"
    ADD CONSTRAINT "ticket_owner_history_new_owner_user_id_fkey" FOREIGN KEY ("new_owner_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_owner_history"
    ADD CONSTRAINT "ticket_owner_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_owner_history"
    ADD CONSTRAINT "ticket_owner_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_owner_history"
    ADD CONSTRAINT "ticket_owner_history_previous_owner_user_id_fkey" FOREIGN KEY ("previous_owner_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."ticket_owner_history"
    ADD CONSTRAINT "ticket_owner_history_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id");



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_pin_lookup_attempts"
    ADD CONSTRAINT "user_pin_lookup_attempts_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."admin_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_role_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_user_permission_overrides" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coupon_redemptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "coupon_redemptions_read_only" ON "public"."coupon_redemptions" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."coupons" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "coupons_read_only" ON "public"."coupons" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."customer_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_profiles_owner_insert" ON "public"."customer_profiles" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "customer_profiles_owner_select" ON "public"."customer_profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "customer_profiles_owner_update" ON "public"."customer_profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."event_attractions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_attractions_read_only" ON "public"."event_attractions" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."event_kit_item_variant_inventory" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_kit_item_variant_inventory_select" ON "public"."event_kit_item_variant_inventory" FOR SELECT TO "authenticated" USING ("public"."user_can_access_organization"("auth"."uid"(), "organization_id"));



ALTER TABLE "public"."event_kit_item_variants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_kit_item_variants_read_only" ON "public"."event_kit_item_variants" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."event_kit_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_kit_items_read_only" ON "public"."event_kit_items" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "events_select_authenticated" ON "public"."events" FOR SELECT TO "authenticated" USING (("public"."is_platform_user"("auth"."uid"()) OR "public"."is_organization_member"("auth"."uid"(), "organization_id")));



CREATE POLICY "events_select_public" ON "public"."events" FOR SELECT TO "anon" USING ((("is_active" = true) AND ("registration_enabled" = true) AND ((COALESCE("registration_open_at", "registration_open") IS NULL) OR (COALESCE("registration_open_at", "registration_open") <= "now"())) AND ((COALESCE("registration_close_at", "registration_close") IS NULL) OR (COALESCE("registration_close_at", "registration_close") >= "now"()))));



CREATE POLICY "events_select_public_authenticated" ON "public"."events" FOR SELECT TO "authenticated" USING ((("is_active" = true) AND ("registration_enabled" = true) AND ((COALESCE("registration_open_at", "registration_open") IS NULL) OR (COALESCE("registration_open_at", "registration_open") <= "now"())) AND ((COALESCE("registration_close_at", "registration_close") IS NULL) OR (COALESCE("registration_close_at", "registration_close") >= "now"()))));



ALTER TABLE "public"."financial_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_entry_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_entry_settlements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_event_allocations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "financial_ledger_read" ON "public"."financial_accounts" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('finance.view'::"text")));



CREATE POLICY "financial_ledger_read" ON "public"."financial_categories" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('finance.view'::"text")));



CREATE POLICY "financial_ledger_read" ON "public"."financial_entries" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('finance.view'::"text") AND "public"."current_user_has_permission"('finance.view_amounts'::"text")));



CREATE POLICY "financial_ledger_read" ON "public"."financial_entry_lines" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('finance.view'::"text") AND "public"."current_user_has_permission"('finance.view_amounts'::"text")));



CREATE POLICY "financial_ledger_read" ON "public"."financial_entry_settlements" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('finance.view'::"text") AND "public"."current_user_has_permission"('finance.view_amounts'::"text")));



CREATE POLICY "financial_ledger_read" ON "public"."financial_event_allocations" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('finance.view'::"text") AND "public"."current_user_has_permission"('finance.view_amounts'::"text")));



CREATE POLICY "financial_ledger_read" ON "public"."financial_reconciliations" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('finance.view'::"text") AND "public"."current_user_has_permission"('finance.view_amounts'::"text")));



CREATE POLICY "financial_ledger_read" ON "public"."financial_reversals" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('finance.view'::"text") AND "public"."current_user_has_permission"('finance.view_amounts'::"text")));



CREATE POLICY "financial_ledger_read" ON "public"."financial_suppliers" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('finance.view'::"text")));



ALTER TABLE "public"."financial_reconciliations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_reversals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_suppliers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_movements_rbac_select" ON "public"."inventory_movements" FOR SELECT TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'inventory.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'inventory.view_history'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'inventory.adjust'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'inventory.clear_history'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));



ALTER TABLE "public"."kit_deliveries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."kit_delivery_schedule" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "kit_delivery_schedule_select" ON "public"."kit_delivery_schedule" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM ("public"."tickets" "t"
     JOIN "public"."participants" "p" ON (("p"."id" = "t"."participant_id")))
  WHERE (("t"."event_id" = "kit_delivery_schedule"."event_id") AND ("p"."user_id" = "auth"."uid"()) AND ("t"."status" <> 'cancelled'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "kit_delivery_schedule"."event_id") AND "public"."user_can_access_organization"("auth"."uid"(), "e"."organization_id") AND "public"."current_user_has_permission"('events.view'::"text"))))));



ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_items_holder_select" ON "public"."order_items" FOR SELECT TO "authenticated" USING ((("participant_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."participants" "p"
  WHERE (("p"."id" = "order_items"."participant_id") AND ("p"."user_id" = "auth"."uid"()))))));



CREATE POLICY "order_items_owner_select" ON "public"."order_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_items"."order_id") AND ("o"."user_id" = "auth"."uid"())))));



CREATE POLICY "order_items_ticket_owner_select" ON "public"."order_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."tickets" "t"
  WHERE (("t"."order_item_id" = "order_items"."id") AND ("t"."owner_user_id" = "auth"."uid"())))));



ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders_holder_select" ON "public"."orders" FOR SELECT TO "authenticated" USING ("public"."user_is_order_item_holder"("auth"."uid"(), "id"));



CREATE POLICY "orders_owner_select" ON "public"."orders" FOR SELECT TO "authenticated" USING ((("buyer_type" = 'account'::"text") AND ("auth"."uid"() = "user_id")));



CREATE POLICY "orders_rbac_select" ON "public"."orders" FOR SELECT TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'orders.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'finance.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'finance.view_amounts'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'finance.confirm_payment'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'finance.refund'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.view'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));



CREATE POLICY "org_insert_platform_owner_admin" ON "public"."organizations" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."platform_users" "pu"
  WHERE (("pu"."user_id" = "auth"."uid"()) AND ("pu"."is_active" = true) AND ("pu"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))));



CREATE POLICY "org_members_delete" ON "public"."organization_members" FOR DELETE TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."platform_users" "pu"
  WHERE (("pu"."user_id" = "auth"."uid"()) AND ("pu"."is_active" = true) AND ("pu"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))) OR "public"."is_organization_owner"("auth"."uid"(), "organization_id")));



CREATE POLICY "org_members_insert" ON "public"."organization_members" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."platform_users" "pu"
  WHERE (("pu"."user_id" = "auth"."uid"()) AND ("pu"."is_active" = true) AND ("pu"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))) OR "public"."is_organization_owner"("auth"."uid"(), "organization_id")));



CREATE POLICY "org_members_select" ON "public"."organization_members" FOR SELECT TO "authenticated" USING (("public"."is_platform_user"("auth"."uid"()) OR "public"."is_organization_member"("auth"."uid"(), "organization_id")));



CREATE POLICY "org_members_update" ON "public"."organization_members" FOR UPDATE TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."platform_users" "pu"
  WHERE (("pu"."user_id" = "auth"."uid"()) AND ("pu"."is_active" = true) AND ("pu"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))) OR "public"."is_organization_owner"("auth"."uid"(), "organization_id")));



CREATE POLICY "org_select_platform_users" ON "public"."organizations" FOR SELECT TO "authenticated" USING (("public"."is_platform_user"("auth"."uid"()) OR "public"."is_organization_member"("auth"."uid"(), "id")));



CREATE POLICY "org_update_platform_owner_admin" ON "public"."organizations" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."platform_users" "pu"
  WHERE (("pu"."user_id" = "auth"."uid"()) AND ("pu"."is_active" = true) AND ("pu"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))));



ALTER TABLE "public"."organization_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."participant_account_invites" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "participant_account_invites_admin_select" ON "public"."participant_account_invites" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND "public"."current_user_has_permission"('participants.view'::"text")));



ALTER TABLE "public"."participant_data_issues" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "participant_data_issues_admin_select" ON "public"."participant_data_issues" FOR SELECT TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR ("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND ("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.view'::"text")))));



CREATE POLICY "participant_data_issues_holder_select" ON "public"."participant_data_issues" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."participants" "p"
  WHERE (("p"."id" = "participant_data_issues"."participant_id") AND ("p"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."participant_kit_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "participant_kit_items_owner_delete" ON "public"."participant_kit_items" FOR DELETE TO "authenticated" USING ("public"."is_active_owner"("auth"."uid"()));



CREATE POLICY "participant_kit_items_owner_select" ON "public"."participant_kit_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."participants" "p"
  WHERE (("p"."id" = "participant_kit_items"."participant_id") AND ("p"."user_id" = "auth"."uid"())))));



CREATE POLICY "participant_kit_items_rbac_insert" ON "public"."participant_kit_items" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.create'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'imports.create'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.replace_item'::"text")) AND (("event_id" IS NULL) OR "public"."user_can_access_organization"("auth"."uid"(), ( SELECT "e"."organization_id"
   FROM "public"."events" "e"
  WHERE ("e"."id" = "participant_kit_items"."event_id")))))));



CREATE POLICY "participant_kit_items_rbac_select" ON "public"."participant_kit_items" FOR SELECT TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.deliver'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.replace_item'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.undo_delivery'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.view_history'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.view'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));



CREATE POLICY "participant_kit_items_rbac_update" ON "public"."participant_kit_items" FOR UPDATE TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.deliver'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.replace_item'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.undo_delivery'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id")))) WITH CHECK (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.deliver'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.replace_item'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.undo_delivery'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));



CREATE POLICY "participant_kit_items_ticket_owner_select" ON "public"."participant_kit_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."tickets" "t"
  WHERE (("t"."id" = "participant_kit_items"."ticket_id") AND ("t"."owner_user_id" = "auth"."uid"())))));



ALTER TABLE "public"."participant_wristbands" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "participant_wristbands_rbac_insert" ON "public"."participant_wristbands" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.link'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.replace'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), ( SELECT "t"."organization_id"
   FROM "public"."tickets" "t"
  WHERE ("t"."id" = "participant_wristbands"."ticket_id"))))));



CREATE POLICY "participant_wristbands_rbac_select" ON "public"."participant_wristbands" FOR SELECT TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.link'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.unlink'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.replace'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.block'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.view'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));



CREATE POLICY "participant_wristbands_rbac_update" ON "public"."participant_wristbands" FOR UPDATE TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.unlink'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.replace'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.block'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id")))) WITH CHECK (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.unlink'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.replace'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'wristbands.block'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));



ALTER TABLE "public"."participants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "participants_owner_delete" ON "public"."participants" FOR DELETE TO "authenticated" USING ("public"."is_active_owner"("auth"."uid"()));



CREATE POLICY "participants_owner_select" ON "public"."participants" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "participants_owner_update" ON "public"."participants" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "participants_rbac_insert" ON "public"."participants" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.create'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'imports.create'::"text")) AND (("event_id" IS NULL) OR "public"."user_can_access_organization"("auth"."uid"(), ( SELECT "e"."organization_id"
   FROM "public"."events" "e"
  WHERE ("e"."id" = "participants"."event_id")))))));



CREATE POLICY "participants_rbac_select" ON "public"."participants" FOR SELECT TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.scan'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));



CREATE POLICY "participants_rbac_update" ON "public"."participants" FOR UPDATE TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.edit_basic'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.edit_sensitive'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.cancel'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'inventory.change_participant_shirt'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.deliver'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.undo_delivery'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.scan'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.undo'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id")))) WITH CHECK (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.edit_basic'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.edit_sensitive'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.cancel'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'inventory.change_participant_shirt'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.deliver'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.undo_delivery'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.scan'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.undo'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payments_owner_select" ON "public"."payments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."participants" "p"
  WHERE (("p"."id" = "payments"."participant_id") AND ("p"."user_id" = "auth"."uid"())))));



CREATE POLICY "payments_rbac_select" ON "public"."payments" FOR SELECT TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'finance.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'finance.view_amounts'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'finance.confirm_payment'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'finance.refund'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'finance.export'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.view'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));



ALTER TABLE "public"."platform_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_settings_select_all" ON "public"."platform_settings" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."platform_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_users_insert" ON "public"."platform_users" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_platform_owner"("auth"."uid"()));



CREATE POLICY "platform_users_select" ON "public"."platform_users" FOR SELECT TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR ("user_id" = "auth"."uid"())));



CREATE POLICY "platform_users_update" ON "public"."platform_users" FOR UPDATE TO "authenticated" USING ("public"."is_platform_owner"("auth"."uid"()));



ALTER TABLE "public"."registration_batch_prices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "registration_batch_prices_read_only" ON "public"."registration_batch_prices" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."registration_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "registration_batches_read_only" ON "public"."registration_batches" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."registration_contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "registration_contacts_org_select" ON "public"."registration_contacts" FOR SELECT USING ("public"."user_can_access_organization"("auth"."uid"(), "organization_id"));



ALTER TABLE "public"."shirt_inventory" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "shirt_inventory_read_only" ON "public"."shirt_inventory" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."store_item_inventory" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "store_item_inventory_select" ON "public"."store_item_inventory" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."store_item_variants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "store_item_variants_select" ON "public"."store_item_variants" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."store_items" "si"
  WHERE ("si"."id" = "store_item_variants"."store_item_id"))));



ALTER TABLE "public"."store_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "store_items_select" ON "public"."store_items" FOR SELECT TO "authenticated" USING (("is_active" OR "public"."user_can_access_organization"("auth"."uid"(), "organization_id")));



ALTER TABLE "public"."store_order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "store_order_items_select" ON "public"."store_order_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."store_orders" "so"
  WHERE (("so"."id" = "store_order_items"."store_order_id") AND (("so"."user_id" = "auth"."uid"()) OR "public"."user_can_access_organization"("auth"."uid"(), "so"."organization_id"))))));



ALTER TABLE "public"."store_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "store_orders_select" ON "public"."store_orders" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."user_can_access_organization"("auth"."uid"(), "organization_id")));



ALTER TABLE "public"."ticket_categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ticket_categories_read_only" ON "public"."ticket_categories" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."ticket_category_benefits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ticket_category_benefits_read_only" ON "public"."ticket_category_benefits" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."ticket_holder_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ticket_holder_history_select" ON "public"."ticket_holder_history" FOR SELECT TO "authenticated" USING ((("previous_user_id" = "auth"."uid"()) OR ("new_user_id" = "auth"."uid"()) OR "public"."user_can_access_organization"("auth"."uid"(), "organization_id")));



ALTER TABLE "public"."ticket_item_change_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ticket_item_change_requests_select" ON "public"."ticket_item_change_requests" FOR SELECT TO "authenticated" USING ((("requested_by" = "auth"."uid"()) OR "public"."user_can_access_organization"("auth"."uid"(), "organization_id")));



ALTER TABLE "public"."ticket_owner_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ticket_owner_history_admin_select" ON "public"."ticket_owner_history" FOR SELECT TO "authenticated" USING (("public"."user_can_access_organization"("auth"."uid"(), "organization_id") AND ("public"."current_user_has_permission"('participants.view'::"text") OR "public"."current_user_has_permission"('orders.view'::"text"))));



ALTER TABLE "public"."tickets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tickets_current_owner_select" ON "public"."tickets" FOR SELECT TO "authenticated" USING (("owner_user_id" = "auth"."uid"()));



CREATE POLICY "tickets_rbac_select" ON "public"."tickets" FOR SELECT TO "authenticated" USING (("public"."is_platform_owner"("auth"."uid"()) OR (("public"."is_active_owner"("auth"."uid"()) OR "public"."resolve_user_permission"("auth"."uid"(), 'orders.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'participants.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.scan'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'checkin.undo'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.view'::"text") OR "public"."resolve_user_permission"("auth"."uid"(), 'kits.deliver'::"text")) AND "public"."user_can_access_organization"("auth"."uid"(), "organization_id"))));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";











































































































































































REVOKE ALL ON FUNCTION "public"."activate_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."activate_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."activate_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."activate_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."add_inventory_quantity"("p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."add_inventory_quantity"("p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."add_inventory_quantity"("p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."add_inventory_quantity"("p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."add_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."add_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."add_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity" integer, "p_notes" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."adjust_inventory_quantity"("p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."adjust_inventory_quantity"("p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."adjust_inventory_quantity"("p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."adjust_inventory_quantity"("p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."adjust_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."adjust_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."adjust_inventory_quantity"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_quantity_delta" integer, "p_notes" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_cancel_ticket"("p_ticket_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_cancel_ticket"("p_ticket_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_cancel_ticket"("p_ticket_id" "uuid", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_change_ticket_shirt"("p_ticket_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_change_ticket_shirt"("p_ticket_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_change_ticket_shirt"("p_ticket_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_confirm_participant_payment"("p_participant_id" "uuid", "p_payment_id" "uuid", "p_reason" "text", "p_actor_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_confirm_participant_payment"("p_participant_id" "uuid", "p_payment_id" "uuid", "p_reason" "text", "p_actor_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason_code" "text", "p_reason_text" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason_code" "text", "p_reason_text" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason_code" "text", "p_reason_text" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text", "p_reason" "text", "p_operation" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text", "p_reason" "text", "p_operation" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text", "p_reason" "text", "p_operation" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_transfer_ticket_holder"("p_ticket_id" "uuid", "p_target_participant_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_transfer_ticket_holder"("p_ticket_id" "uuid", "p_target_participant_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_transfer_ticket_holder"("p_ticket_id" "uuid", "p_target_participant_id" "uuid", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_transfer_ticket_ownership"("p_ticket_id" "uuid", "p_expected_owner_user_id" "uuid", "p_new_owner_user_id" "uuid", "p_holder_action" "text", "p_reason_code" "text", "p_reason_text" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_transfer_ticket_ownership"("p_ticket_id" "uuid", "p_expected_owner_user_id" "uuid", "p_new_owner_user_id" "uuid", "p_holder_action" "text", "p_reason_code" "text", "p_reason_text" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_transfer_ticket_ownership"("p_ticket_id" "uuid", "p_expected_owner_user_id" "uuid", "p_new_owner_user_id" "uuid", "p_holder_action" "text", "p_reason_code" "text", "p_reason_text" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_update_payment_status"("p_payment_id" "uuid", "p_participant_id" "uuid", "p_expected_current_status" "text", "p_new_status" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_payment_status"("p_payment_id" "uuid", "p_participant_id" "uuid", "p_expected_current_status" "text", "p_new_status" "text", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_payment_status"("p_payment_id" "uuid", "p_participant_id" "uuid", "p_expected_current_status" "text", "p_new_status" "text", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."advance_registration_batch_if_needed"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."advance_registration_batch_if_needed"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."advance_registration_batch_if_needed"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."advance_registration_batch_if_needed"("p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."archive_event"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."archive_event"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."archive_event"("p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."assert_ticket_holder_contact_available"("p_ticket_id" "uuid", "p_event_id" "uuid", "p_registration_contact_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assert_ticket_holder_contact_available"("p_ticket_id" "uuid", "p_event_id" "uuid", "p_registration_contact_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."assign_order_item_participant"("p_order_item_id" "uuid", "p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assign_order_item_participant"("p_order_item_id" "uuid", "p_participant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."attach_order_item_kit_items_to_new_ticket"() TO "anon";
GRANT ALL ON FUNCTION "public"."attach_order_item_kit_items_to_new_ticket"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."attach_order_item_kit_items_to_new_ticket"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."backfill_confirmed_payments_cash_111"("p_cash_account_id" "uuid", "p_revenue_account_id" "uuid", "p_revenue_category_id" "uuid", "p_created_by" "uuid", "p_apply" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."backfill_confirmed_payments_cash_111"("p_cash_account_id" "uuid", "p_revenue_account_id" "uuid", "p_revenue_category_id" "uuid", "p_created_by" "uuid", "p_apply" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."block_wristband"("p_wristband_id" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."block_wristband"("p_wristband_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."block_wristband"("p_wristband_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_registration_payment"("p_participant_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_registration_payment"("p_participant_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."cancel_registration_payment"("p_participant_id" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_registration_payment"("p_participant_id" "uuid", "p_reason" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."cancel_store_order"("p_store_order_id" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_store_order"("p_store_order_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_store_order"("p_store_order_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."change_participant_shirt"("p_participant_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."change_participant_shirt"("p_participant_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."change_ticket_holder_by_pin_for_owner"("p_ticket_id" "uuid", "p_pin" "text", "p_operation" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."change_ticket_holder_by_pin_for_owner"("p_ticket_id" "uuid", "p_pin" "text", "p_operation" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."change_ticket_holder_by_pin_internal"("p_ticket_id" "uuid", "p_pin" "text", "p_operation" "text", "p_admin_override" boolean, "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."change_ticket_holder_by_pin_internal"("p_ticket_id" "uuid", "p_pin" "text", "p_operation" "text", "p_admin_override" boolean, "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."change_ticket_shirt"("p_ticket_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."change_ticket_shirt"("p_ticket_id" "uuid", "p_new_shirt_type" "text", "p_new_shirt_size" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."check_participant_account_invite_eligibility"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_participant_account_invite_eligibility"("p_participant_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."check_participant_account_invite_eligibility"("p_participant_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."checkin_participant_entry"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."checkin_participant_entry"("p_participant_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."checkin_participant_entry"("p_participant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."checkin_participant_entry"("p_participant_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."checkin_ticket_entry"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."checkin_ticket_entry"("p_ticket_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."checkin_ticket_entry"("p_ticket_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."claim_participant_account_invite"("p_invite_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_participant_account_invite"("p_invite_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."claim_participant_account_invite"("p_invite_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."confirm_order_and_issue_ticket"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_order_and_issue_ticket"("p_participant_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."confirm_order_and_issue_ticket"("p_participant_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."confirm_order_item_and_issue_ticket"("p_order_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_order_item_and_issue_ticket"("p_order_item_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."confirm_order_item_and_issue_ticket"("p_order_item_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."confirm_order_payment_and_issue_tickets"("p_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."confirm_order_payment_and_issue_tickets"("p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."confirm_order_payment_and_issue_tickets"("p_order_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."confirm_registration_payment"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_registration_payment"("p_participant_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."confirm_registration_payment"("p_participant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."confirm_registration_payment"("p_participant_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."confirm_store_order_payment"("p_store_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."confirm_store_order_payment"("p_store_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."confirm_store_order_payment"("p_store_order_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_coupon"("p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_coupon"("p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."create_coupon"("p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."create_coupon"("p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_event"("p_name" "text", "p_slug" "text", "p_year" integer, "p_description" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_registration_open_at" timestamp with time zone, "p_registration_close_at" timestamp with time zone, "p_location" "text", "p_is_active" boolean, "p_registration_enabled" boolean, "p_kit_enabled" boolean, "p_organization_id" "uuid", "p_min_age" integer, "p_banner_hero_url" "text", "p_banner_card_url" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_event"("p_name" "text", "p_slug" "text", "p_year" integer, "p_description" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_registration_open_at" timestamp with time zone, "p_registration_close_at" timestamp with time zone, "p_location" "text", "p_is_active" boolean, "p_registration_enabled" boolean, "p_kit_enabled" boolean, "p_organization_id" "uuid", "p_min_age" integer, "p_banner_hero_url" "text", "p_banner_card_url" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_event"("p_name" "text", "p_slug" "text", "p_year" integer, "p_description" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_registration_open_at" timestamp with time zone, "p_registration_close_at" timestamp with time zone, "p_location" "text", "p_is_active" boolean, "p_registration_enabled" boolean, "p_kit_enabled" boolean, "p_organization_id" "uuid", "p_min_age" integer, "p_banner_hero_url" "text", "p_banner_card_url" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_financial_entry"("p_organization_id" "uuid", "p_entry_kind" "text", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_source_payment_id" "uuid", "p_lines" "jsonb", "p_allocations" "jsonb", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_financial_entry"("p_organization_id" "uuid", "p_entry_kind" "text", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_source_payment_id" "uuid", "p_lines" "jsonb", "p_allocations" "jsonb", "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_financial_entry"("p_organization_id" "uuid", "p_entry_kind" "text", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_source_payment_id" "uuid", "p_lines" "jsonb", "p_allocations" "jsonb", "p_idempotency_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_imported_order_and_issue_ticket"("p_participant_id" "uuid", "p_import_batch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_imported_order_and_issue_ticket"("p_participant_id" "uuid", "p_import_batch_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_imported_order_and_issue_ticket"("p_participant_id" "uuid", "p_import_batch_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_inventory_item"("p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_inventory_item"("p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."create_inventory_item"("p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) TO "anon";



REVOKE ALL ON FUNCTION "public"."create_inventory_item"("p_event_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_inventory_item"("p_event_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."create_inventory_item"("p_event_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_manual_registration_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_manual_registration_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_manual_registration_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_manual_unassigned_ticket_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_manual_unassigned_ticket_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_manual_unassigned_ticket_order"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_multi_ticket_order_checkout"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_buyer_full_name" "text", "p_buyer_cpf" "text", "p_buyer_birth_date" "date", "p_buyer_gender" "text", "p_buyer_phone" "text", "p_buyer_email" "text", "p_buyer_city" "text", "p_assign_first_to_buyer" boolean, "p_items" "jsonb", "p_limit_per_order" integer, "p_notes" "text", "p_client_request_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_multi_ticket_order_checkout"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_buyer_full_name" "text", "p_buyer_cpf" "text", "p_buyer_birth_date" "date", "p_buyer_gender" "text", "p_buyer_phone" "text", "p_buyer_email" "text", "p_buyer_city" "text", "p_assign_first_to_buyer" boolean, "p_items" "jsonb", "p_limit_per_order" integer, "p_notes" "text", "p_client_request_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_multi_ticket_order_checkout"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_buyer_full_name" "text", "p_buyer_cpf" "text", "p_buyer_birth_date" "date", "p_buyer_gender" "text", "p_buyer_phone" "text", "p_buyer_email" "text", "p_buyer_city" "text", "p_assign_first_to_buyer" boolean, "p_items" "jsonb", "p_limit_per_order" integer, "p_notes" "text", "p_client_request_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_multi_ticket_order_checkout_legacy"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_buyer_full_name" "text", "p_buyer_cpf" "text", "p_buyer_birth_date" "date", "p_buyer_gender" "text", "p_buyer_phone" "text", "p_buyer_email" "text", "p_buyer_city" "text", "p_assign_first_to_buyer" boolean, "p_items" "jsonb", "p_limit_per_order" integer, "p_notes" "text", "p_client_request_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_multi_ticket_order_checkout_legacy"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_buyer_full_name" "text", "p_buyer_cpf" "text", "p_buyer_birth_date" "date", "p_buyer_gender" "text", "p_buyer_phone" "text", "p_buyer_email" "text", "p_buyer_city" "text", "p_assign_first_to_buyer" boolean, "p_items" "jsonb", "p_limit_per_order" integer, "p_notes" "text", "p_client_request_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_multi_ticket_order_checkout_legacy"("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_gender" "text", "p_quantity" integer, "p_payment_method" "text", "p_coupon_code" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_buyer_full_name" "text", "p_buyer_cpf" "text", "p_buyer_birth_date" "date", "p_buyer_gender" "text", "p_buyer_phone" "text", "p_buyer_email" "text", "p_buyer_city" "text", "p_assign_first_to_buyer" boolean, "p_items" "jsonb", "p_limit_per_order" integer, "p_notes" "text", "p_client_request_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_pending_imported_participant"("p_import_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_pending_imported_participant"("p_import_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_pending_imported_participant"("p_import_batch_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."create_registration"("p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_status" "text", "p_notes" "text", "p_payment_method" "text", "p_payment_status" "text", "p_event_id" "uuid", "p_coupon_code" "text", "p_ticket_category_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."create_registration"("p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_status" "text", "p_notes" "text", "p_payment_method" "text", "p_payment_status" "text", "p_event_id" "uuid", "p_coupon_code" "text", "p_ticket_category_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_registration"("p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_status" "text", "p_notes" "text", "p_payment_method" "text", "p_payment_status" "text", "p_event_id" "uuid", "p_coupon_code" "text", "p_ticket_category_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_registration_batch"("p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_registration_batch"("p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."create_registration_batch"("p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."create_registration_batch"("p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_registration_batch_with_prices"("p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_registration_batch_with_prices"("p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_registration_batch_with_prices"("p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."create_registration_batch_with_prices"("p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_registration_contact"("p_organization_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_registration_contact"("p_organization_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_registration_contact"("p_organization_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_simple_financial_expense"("p_organization_id" "uuid", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_event_id" "uuid", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_simple_financial_expense"("p_organization_id" "uuid", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_event_id" "uuid", "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_simple_financial_expense"("p_organization_id" "uuid", "p_description" "text", "p_amount" numeric, "p_due_date" "date", "p_occurred_on" "date", "p_category_id" "uuid", "p_supplier_id" "uuid", "p_event_id" "uuid", "p_idempotency_key" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."create_store_order"("p_event_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_store_order"("p_event_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_store_order"("p_event_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_ticket_category"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_ticket_category"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."create_ticket_category"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."create_ticket_category"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_ticket_category_benefit"("p_ticket_category_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_ticket_category_benefit"("p_ticket_category_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."create_ticket_category_benefit"("p_ticket_category_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."create_ticket_category_benefit"("p_ticket_category_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer) TO "authenticated";



GRANT ALL ON FUNCTION "public"."current_organization_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_organization_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_organization_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_user_has_permission"("p_permission_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_has_permission"("p_permission_code" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."current_user_has_permission"("p_permission_code" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."define_ticket_holder_by_pin"("p_ticket_id" "uuid", "p_pin" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."define_ticket_holder_by_pin"("p_ticket_id" "uuid", "p_pin" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."define_ticket_holder_by_pin"("p_ticket_id" "uuid", "p_pin" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_event_addon_option"("p_event_id" "uuid", "p_option_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_event_addon_option"("p_event_id" "uuid", "p_option_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_event_addon_option"("p_event_id" "uuid", "p_option_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_event_attraction"("p_event_id" "uuid", "p_attraction_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_event_attraction"("p_event_id" "uuid", "p_attraction_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_event_attraction"("p_event_id" "uuid", "p_attraction_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_event_kit_item"("p_event_id" "uuid", "p_kit_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_event_kit_item"("p_event_id" "uuid", "p_kit_item_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_event_kit_item"("p_event_id" "uuid", "p_kit_item_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_event_kit_item_variant"("p_variant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_event_kit_item_variant"("p_variant_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_event_kit_item_variant"("p_variant_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_event_schedule_item"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_event_schedule_item"("p_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_event_schedule_item"("p_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_inventory_item"("p_inventory_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_inventory_item"("p_inventory_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_kit_delivery_schedule"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_kit_delivery_schedule"("p_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delete_ticket_category_benefit"("p_benefit_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_ticket_category_benefit"("p_benefit_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_ticket_category_benefit"("p_benefit_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_ticket_category_benefit"("p_benefit_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."deliver_items_and_checkin"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deliver_items_and_checkin"("p_ticket_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."deliver_items_and_checkin"("p_ticket_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."deliver_kit"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deliver_kit"("p_participant_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."deliver_kit_and_checkin"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deliver_kit_and_checkin"("p_ticket_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."deliver_participant_full_kit"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deliver_participant_full_kit"("p_participant_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."deliver_participant_kit_item"("p_participant_id" "uuid", "p_kit_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deliver_participant_kit_item"("p_participant_id" "uuid", "p_kit_item_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deliver_store_order_item"("p_store_order_item_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deliver_store_order_item"("p_store_order_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deliver_store_order_item"("p_store_order_item_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."deliver_ticket_full_kit"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deliver_ticket_full_kit"("p_ticket_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."deliver_ticket_full_kit"("p_ticket_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."deliver_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deliver_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."deliver_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."duplicate_event_configuration"("p_source_event_id" "uuid", "p_target_name" "text", "p_target_slug" "text", "p_target_year" integer, "p_copy_categories" boolean, "p_copy_kit_items" boolean, "p_copy_benefits" boolean, "p_copy_batches" boolean, "p_copy_batch_prices" boolean, "p_copy_inventory_structure" boolean, "p_copy_coupons" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."duplicate_event_configuration"("p_source_event_id" "uuid", "p_target_name" "text", "p_target_slug" "text", "p_target_year" integer, "p_copy_categories" boolean, "p_copy_kit_items" boolean, "p_copy_benefits" boolean, "p_copy_batches" boolean, "p_copy_batch_prices" boolean, "p_copy_inventory_structure" boolean, "p_copy_coupons" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."duplicate_event_configuration"("p_source_event_id" "uuid", "p_target_name" "text", "p_target_slug" "text", "p_target_year" integer, "p_copy_categories" boolean, "p_copy_kit_items" boolean, "p_copy_benefits" boolean, "p_copy_batches" boolean, "p_copy_batch_prices" boolean, "p_copy_inventory_structure" boolean, "p_copy_coupons" boolean) TO "authenticated";



GRANT ALL ON FUNCTION "public"."enforce_explicit_shirt_supply_mode"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_explicit_shirt_supply_mode"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_explicit_shirt_supply_mode"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."ensure_order_for_participant"("p_participant_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_order_for_participant"("p_participant_id" "uuid", "p_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."ensure_order_for_participant"("p_participant_id" "uuid", "p_user_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."ensure_simple_financial_accounts"("p_organization_id" "uuid", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_simple_financial_accounts"("p_organization_id" "uuid", "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."ensure_simple_financial_accounts"("p_organization_id" "uuid", "p_idempotency_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."ensure_ticket_kit_items"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_ticket_kit_items"("p_ticket_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."ensure_ticket_kit_items"("p_ticket_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."finalize_cadastro_payment_and_ticket"("p_participant_id" "uuid", "p_payment_id" "uuid", "p_event_id" "uuid", "p_organization_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_cadastro_payment_and_ticket"("p_participant_id" "uuid", "p_payment_id" "uuid", "p_event_id" "uuid", "p_organization_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."finalize_cadastro_payment_and_ticket"("p_participant_id" "uuid", "p_payment_id" "uuid", "p_event_id" "uuid", "p_organization_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."finalize_import_batch"("p_import_batch_id" "uuid", "p_payment_mode" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_import_batch"("p_import_batch_id" "uuid", "p_payment_mode" "text", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."finalize_import_batch"("p_import_batch_id" "uuid", "p_payment_mode" "text", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."finalize_imported_participant_after_issue_resolution"("p_participant_id" "uuid", "p_resolved_fields" "text"[], "p_force_confirm" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_imported_participant_after_issue_resolution"("p_participant_id" "uuid", "p_resolved_fields" "text"[], "p_force_confirm" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."finalize_imported_participant_after_issue_resolution"("p_participant_id" "uuid", "p_resolved_fields" "text"[], "p_force_confirm" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."find_user_by_public_pin"("p_ticket_id" "uuid", "p_pin" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."find_user_by_public_pin"("p_ticket_id" "uuid", "p_pin" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."find_user_by_public_pin"("p_ticket_id" "uuid", "p_pin" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."generate_customer_public_pin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_customer_public_pin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_order_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_order_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_order_number"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."generate_registration_contact_public_pin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_registration_contact_public_pin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_active_registration_batch"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_active_registration_batch"() TO "service_role";
GRANT ALL ON FUNCTION "public"."get_active_registration_batch"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_active_registration_batch"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_admin_ticket_audit_timeline"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_admin_ticket_audit_timeline"("p_ticket_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_admin_ticket_audit_timeline"("p_ticket_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_admin_ticket_shirt_options"("p_ticket_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_admin_ticket_shirt_options"("p_ticket_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_ticket_shirt_options"("p_ticket_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_admin_user_profile"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_admin_user_profile"("p_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_admin_user_profile"("p_user_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_cadastro_payment_ticket_context"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_cadastro_payment_ticket_context"("p_participant_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_cadastro_payment_ticket_context"("p_participant_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_customer_profile"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_customer_profile"("p_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_customer_profile"("p_user_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_event_addons_dynamic_setup"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_event_addons_dynamic_setup"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_event_addons_dynamic_setup"("p_event_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_event_addons_setup"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_event_addons_setup"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_event_addons_setup"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_event_kit_items"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_event_kit_items"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_event_kit_items"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_event_kit_items"("p_event_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_event_payment_methods_setup"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_event_payment_methods_setup"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_event_payment_methods_setup"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_event_ticket_categories"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_event_ticket_categories"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_event_ticket_categories"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_event_ticket_categories"("p_event_id" "uuid") TO "anon";



REVOKE ALL ON FUNCTION "public"."get_events_overview"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_events_overview"() TO "service_role";
GRANT ALL ON FUNCTION "public"."get_events_overview"() TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_featured_events_for_dashboard"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_featured_events_for_dashboard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_featured_events_for_dashboard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_my_public_pin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_my_public_pin"() TO "service_role";
GRANT ALL ON FUNCTION "public"."get_my_public_pin"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_operation_buyers"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_operation_buyers"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_operation_buyers"("p_event_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."get_order_checkout_snapshot"("p_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_order_checkout_snapshot"("p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_order_checkout_snapshot"("p_order_id" "uuid") TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."shirt_inventory" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."shirt_inventory" TO "authenticated";
GRANT ALL ON TABLE "public"."shirt_inventory" TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_ordered_shirt_inventory"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_ordered_shirt_inventory"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_ordered_shirt_inventory"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_ordered_shirt_inventory"("p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_participant_kit_items"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_participant_kit_items"("p_participant_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_participant_payment_details"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_participant_payment_details"("p_participant_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_participant_payment_details"("p_participant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_participant_payment_details"("p_participant_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_public_account_email_status"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_account_email_status"("p_email" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_public_account_email_status"("p_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_account_email_status"("p_email" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_registration_batches"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_registration_batches"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_registration_batches"("p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_registration_pricing_preview"("p_gender" "text", "p_coupon_code" "text", "p_event_id" "uuid", "p_ticket_category_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_registration_pricing_preview"("p_gender" "text", "p_coupon_code" "text", "p_event_id" "uuid", "p_ticket_category_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_registration_pricing_preview"("p_gender" "text", "p_coupon_code" "text", "p_event_id" "uuid", "p_ticket_category_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_registration_pricing_preview"("p_gender" "text", "p_coupon_code" "text", "p_event_id" "uuid", "p_ticket_category_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_ticket_kit_items"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_ticket_kit_items"("p_ticket_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_ticket_kit_items"("p_ticket_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_ticket_shirt_stock"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_ticket_shirt_stock"("p_ticket_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_ticket_shirt_stock"("p_ticket_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_upcoming_kit_deliveries"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_upcoming_kit_deliveries"("p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."import_participant_has_issuance_blockers"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."import_participant_has_issuance_blockers"("p_participant_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."import_participant_has_issuance_blockers"("p_participant_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."initialize_event_inventory"("p_event_id" "uuid", "p_source_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."initialize_event_inventory"("p_event_id" "uuid", "p_source_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."initialize_event_inventory"("p_event_id" "uuid", "p_source_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."is_active_owner"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_active_owner"("p_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."is_active_owner"("p_user_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."is_event_payment_method_allowed"("p_event_id" "uuid", "p_payment_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."is_event_payment_method_allowed"("p_event_id" "uuid", "p_payment_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_event_payment_method_allowed"("p_event_id" "uuid", "p_payment_method" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_organization_member"("p_user_id" "uuid", "p_organization_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_organization_member"("p_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_organization_member"("p_user_id" "uuid", "p_organization_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_organization_owner"("p_user_id" "uuid", "p_organization_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_organization_owner"("p_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_organization_owner"("p_user_id" "uuid", "p_organization_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_platform_owner"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_platform_owner"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_platform_owner"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_platform_user"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_platform_user"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_platform_user"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_valid_cpf"("p_value" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_valid_cpf"("p_value" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."is_valid_cpf"("p_value" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."issue_manual_ticket_batch"("p_registration_contact_id" "uuid", "p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_quantity" integer, "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."issue_manual_ticket_batch"("p_registration_contact_id" "uuid", "p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_quantity" integer, "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."issue_manual_ticket_batch"("p_registration_contact_id" "uuid", "p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_quantity" integer, "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text", "p_assign_holder" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."issue_manual_ticket_batch"("p_registration_contact_id" "uuid", "p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_quantity" integer, "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text", "p_assign_holder" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."issue_manual_ticket_batch"("p_registration_contact_id" "uuid", "p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_quantity" integer, "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text", "p_assign_holder" boolean) TO "authenticated";



GRANT ALL ON FUNCTION "public"."link_wristband_to_ticket"("p_ticket_id" "uuid", "p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."link_wristband_to_ticket"("p_ticket_id" "uuid", "p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."link_wristband_to_ticket"("p_ticket_id" "uuid", "p_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_admin_roles"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_admin_roles"() TO "service_role";
GRANT ALL ON FUNCTION "public"."list_admin_roles"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."list_admin_team"("p_search" "text", "p_role_name" "text", "p_status" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_admin_team"("p_search" "text", "p_role_name" "text", "p_status" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."list_admin_team"("p_search" "text", "p_role_name" "text", "p_status" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."list_override_state_for_user"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_override_state_for_user"("p_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."list_override_state_for_user"("p_user_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."list_store_items_for_event"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."list_store_items_for_event"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_store_items_for_event"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_user_effective_permissions"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_user_effective_permissions"("p_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."list_user_effective_permissions"("p_user_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."materialize_event_participant_kit_items"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."materialize_event_participant_kit_items"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."materialize_event_ticket_kit_items"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."materialize_event_ticket_kit_items"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."materialize_event_ticket_kit_items"("p_event_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."materialize_order_item_kit_reservations"() TO "anon";
GRANT ALL ON FUNCTION "public"."materialize_order_item_kit_reservations"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."materialize_order_item_kit_reservations"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."materialize_participant_kit_items"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."materialize_participant_kit_items"("p_ticket_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."materialize_participant_kit_items_internal"("p_ticket_id" "uuid", "p_source" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."materialize_participant_kit_items_internal"("p_ticket_id" "uuid", "p_source" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."materialize_ticket_kit_items"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."materialize_ticket_kit_items"("p_ticket_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."materialize_ticket_kit_items"("p_ticket_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."materialize_ticket_kit_items_internal"("p_ticket_id" "uuid", "p_source" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."materialize_ticket_kit_items_internal"("p_ticket_id" "uuid", "p_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_coupon_code"() TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_coupon_code"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_coupon_code"() TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_cpf"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_cpf"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_cpf"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_email"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_email"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_email"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_events_before_write"() TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_events_before_write"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_events_before_write"() TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_text_for_match"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_text_for_match"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_text_for_match"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_ticket_category_slug"() TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_ticket_category_slug"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_ticket_category_slug"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."post_financial_entry"("p_entry_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."post_financial_entry"("p_entry_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."post_financial_entry"("p_entry_id" "uuid", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."prepare_participant_account_invite"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prepare_participant_account_invite"("p_participant_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."prepare_participant_account_invite"("p_participant_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."prevent_last_owner_admin_user_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_last_owner_admin_user_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_last_owner_admin_user_mutation"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_owner_role_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_owner_role_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_owner_role_mutation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."raise_shirt_out_of_stock"("p_shirt_type" "text", "p_shirt_size" "text", "p_physical_available" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."raise_shirt_out_of_stock"("p_shirt_type" "text", "p_shirt_size" "text", "p_physical_available" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_financial_entry"("p_entry_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_reconciled_on" "date", "p_external_reference" "text", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_financial_entry"("p_entry_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_reconciled_on" "date", "p_external_reference" "text", "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."reconcile_financial_entry"("p_entry_id" "uuid", "p_account_id" "uuid", "p_amount" numeric, "p_reconciled_on" "date", "p_external_reference" "text", "p_idempotency_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."record_import_field_inference_audit"("p_import_batch_id" "uuid", "p_participant_id" "uuid", "p_inferred_field" "text", "p_inferred_value" "text", "p_inference_source" "text", "p_original_value" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_import_field_inference_audit"("p_import_batch_id" "uuid", "p_participant_id" "uuid", "p_inferred_field" "text", "p_inferred_value" "text", "p_inference_source" "text", "p_original_value" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."record_import_field_inference_audit"("p_import_batch_id" "uuid", "p_participant_id" "uuid", "p_inferred_field" "text", "p_inferred_value" "text", "p_inference_source" "text", "p_original_value" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."record_ticket_history_export"("p_ticket_id" "uuid", "p_format" "text", "p_scope" "text", "p_from" "date", "p_to" "date", "p_type" "text", "p_filter_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_ticket_history_export"("p_ticket_id" "uuid", "p_format" "text", "p_scope" "text", "p_from" "date", "p_to" "date", "p_type" "text", "p_filter_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."record_ticket_history_export"("p_ticket_id" "uuid", "p_format" "text", "p_scope" "text", "p_from" "date", "p_to" "date", "p_type" "text", "p_filter_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."redeem_coupon"("p_coupon_id" "uuid", "p_participant_id" "uuid", "p_event_id" "uuid", "p_original_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."redeem_coupon"("p_coupon_id" "uuid", "p_participant_id" "uuid", "p_event_id" "uuid", "p_original_amount" numeric) TO "service_role";
GRANT ALL ON FUNCTION "public"."redeem_coupon"("p_coupon_id" "uuid", "p_participant_id" "uuid", "p_event_id" "uuid", "p_original_amount" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."redeem_coupon"("p_coupon_id" "uuid", "p_participant_id" "uuid", "p_event_id" "uuid", "p_original_amount" numeric) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reevaluate_participant_data_issues"("p_participant_id" "uuid", "p_import_batch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reevaluate_participant_data_issues"("p_participant_id" "uuid", "p_import_batch_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."reevaluate_participant_data_issues"("p_participant_id" "uuid", "p_import_batch_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."registration_contact_has_active_ticket"("p_event_id" "uuid", "p_registration_contact_id" "uuid", "p_exclude_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."registration_contact_has_active_ticket"("p_event_id" "uuid", "p_registration_contact_id" "uuid", "p_exclude_ticket_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_expired_reservations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_expired_reservations"() TO "service_role";
GRANT ALL ON FUNCTION "public"."release_expired_reservations"() TO "anon";
GRANT ALL ON FUNCTION "public"."release_expired_reservations"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."remove_event_highlight"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_event_highlight"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."remove_event_highlight"("p_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."remove_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."remove_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."remove_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."remove_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_reason" "text", "p_idempotency_key" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."replace_wristband_for_ticket"("p_ticket_id" "uuid", "p_new_code" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_wristband_for_ticket"("p_ticket_id" "uuid", "p_new_code" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_wristband_for_ticket"("p_ticket_id" "uuid", "p_new_code" "text", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."request_ticket_item_change"("p_ticket_id" "uuid", "p_kit_item_id" "uuid", "p_requested_variant_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."request_ticket_item_change"("p_ticket_id" "uuid", "p_kit_item_id" "uuid", "p_requested_variant_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."request_ticket_item_change"("p_ticket_id" "uuid", "p_kit_item_id" "uuid", "p_requested_variant_id" "uuid", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reset_event_shirt_inventory"("p_event_id" "uuid", "p_clear_history" boolean, "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reset_event_shirt_inventory"("p_event_id" "uuid", "p_clear_history" boolean, "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."reset_event_shirt_inventory"("p_event_id" "uuid", "p_clear_history" boolean, "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."resolve_administrative_ticket_owner"("p_organization_id" "uuid", "p_registration_contact_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_administrative_ticket_owner"("p_organization_id" "uuid", "p_registration_contact_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."resolve_participant_data_issues"("p_participant_id" "uuid", "p_expected_issue_ids" "uuid"[], "p_values" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_participant_data_issues"("p_participant_id" "uuid", "p_expected_issue_ids" "uuid"[], "p_values" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."resolve_participant_data_issues"("p_participant_id" "uuid", "p_expected_issue_ids" "uuid"[], "p_values" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."resolve_unique_ticket_for_participant"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_unique_ticket_for_participant"("p_participant_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."resolve_user_permission"("p_user_id" "uuid", "p_permission_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_user_permission"("p_user_id" "uuid", "p_permission_code" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."resolve_user_permission"("p_user_id" "uuid", "p_permission_code" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."restore_event"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."restore_event"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."restore_event"("p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reverse_financial_entry"("p_entry_id" "uuid", "p_amount" numeric, "p_reason" "text", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reverse_financial_entry"("p_entry_id" "uuid", "p_amount" numeric, "p_reason" "text", "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."reverse_financial_entry"("p_entry_id" "uuid", "p_amount" numeric, "p_reason" "text", "p_idempotency_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."review_ticket_item_change_request"("p_request_id" "uuid", "p_decision" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."review_ticket_item_change_request"("p_request_id" "uuid", "p_decision" "text", "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."review_ticket_item_change_request"("p_request_id" "uuid", "p_decision" "text", "p_notes" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."search_admin_ticket_holder_candidates"("p_ticket_id" "uuid", "p_term" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_admin_ticket_holder_candidates"("p_ticket_id" "uuid", "p_term" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."search_admin_ticket_holder_candidates"("p_ticket_id" "uuid", "p_term" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."search_admin_ticket_holder_contacts"("p_ticket_id" "uuid", "p_term" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_admin_ticket_holder_contacts"("p_ticket_id" "uuid", "p_term" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."search_admin_ticket_holder_contacts"("p_ticket_id" "uuid", "p_term" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."search_admin_ticket_owner_accounts"("p_ticket_id" "uuid", "p_term" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_admin_ticket_owner_accounts"("p_ticket_id" "uuid", "p_term" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."search_admin_ticket_owner_accounts"("p_ticket_id" "uuid", "p_term" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_event_active"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_event_active"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."set_event_active"("p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_event_inactive"("p_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_event_inactive"("p_event_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."set_event_inactive"("p_event_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_event_kit_item_change_rules"("p_kit_item_id" "uuid", "p_allow_change" boolean, "p_track_inventory" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_event_kit_item_change_rules"("p_kit_item_id" "uuid", "p_allow_change" boolean, "p_track_inventory" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."set_event_kit_item_change_rules"("p_kit_item_id" "uuid", "p_allow_change" boolean, "p_track_inventory" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_event_kit_item_variant_stock"("p_variant_id" "uuid", "p_total_quantity" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_event_kit_item_variant_stock"("p_variant_id" "uuid", "p_total_quantity" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."set_event_kit_item_variant_stock"("p_variant_id" "uuid", "p_total_quantity" integer) TO "authenticated";



GRANT ALL ON FUNCTION "public"."set_event_min_age"("p_event_id" "uuid", "p_min_age" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."set_event_min_age"("p_event_id" "uuid", "p_min_age" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_event_min_age"("p_event_id" "uuid", "p_min_age" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_event_participant_item_changes"("p_event_id" "uuid", "p_enabled" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_event_participant_item_changes"("p_event_id" "uuid", "p_enabled" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."set_event_participant_item_changes"("p_event_id" "uuid", "p_enabled" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_event_registration_enabled"("p_event_id" "uuid", "p_enabled" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_event_registration_enabled"("p_event_id" "uuid", "p_enabled" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."set_event_registration_enabled"("p_event_id" "uuid", "p_enabled" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_event_shirt_stock_limit"("p_event_id" "uuid", "p_enabled" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_event_shirt_stock_limit"("p_event_id" "uuid", "p_enabled" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."set_event_shirt_stock_limit"("p_event_id" "uuid", "p_enabled" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_event_ticket_holder_rules"("p_event_id" "uuid", "p_allow_holder_change" boolean, "p_allow_ticket_transfer" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_event_ticket_holder_rules"("p_event_id" "uuid", "p_allow_holder_change" boolean, "p_allow_ticket_transfer" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."set_event_ticket_holder_rules"("p_event_id" "uuid", "p_allow_holder_change" boolean, "p_allow_ticket_transfer" boolean) TO "authenticated";



GRANT ALL ON FUNCTION "public"."set_platform_brand_theme"("p_theme" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_platform_brand_theme"("p_theme" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_platform_brand_theme"("p_theme" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_store_item_stock"("p_store_item_id" "uuid", "p_variant_id" "uuid", "p_total_quantity" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."set_store_item_stock"("p_store_item_id" "uuid", "p_variant_id" "uuid", "p_total_quantity" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_store_item_stock"("p_store_item_id" "uuid", "p_variant_id" "uuid", "p_total_quantity" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_ticket_category_active"("p_category_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_ticket_category_active"("p_category_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."set_ticket_category_active"("p_category_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."set_ticket_category_active"("p_category_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."settle_simple_financial_expense"("p_entry_id" "uuid", "p_amount" numeric, "p_paid_on" "date", "p_reason" "text", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_simple_financial_expense"("p_entry_id" "uuid", "p_amount" numeric, "p_paid_on" "date", "p_reason" "text", "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."settle_simple_financial_expense"("p_entry_id" "uuid", "p_amount" numeric, "p_paid_on" "date", "p_reason" "text", "p_idempotency_key" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."simulate_order_payment_paid"("p_order_id" "uuid", "p_payment_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."simulate_order_payment_paid"("p_order_id" "uuid", "p_payment_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."simulate_order_payment_paid"("p_order_id" "uuid", "p_payment_method" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."simulate_payment_paid"("p_participant_id" "uuid", "p_payment_method" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."simulate_payment_paid"("p_participant_id" "uuid", "p_payment_method" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."simulate_payment_paid"("p_participant_id" "uuid", "p_payment_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."simulate_payment_paid"("p_participant_id" "uuid", "p_payment_method" "text") TO "authenticated";



GRANT ALL ON FUNCTION "public"."simulate_store_order_payment"("p_store_order_id" "uuid", "p_payment_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."simulate_store_order_payment"("p_store_order_id" "uuid", "p_payment_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."simulate_store_order_payment"("p_store_order_id" "uuid", "p_payment_method" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."slugify_text"("p_input" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."slugify_text"("p_input" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."slugify_text"("p_input" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."start_order_payment_pix"("p_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."start_order_payment_pix"("p_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."start_order_payment_pix"("p_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."start_payment_pix"("p_participant_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."start_payment_pix"("p_participant_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) TO "service_role";
GRANT ALL ON FUNCTION "public"."start_payment_pix"("p_participant_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."start_payment_pix"("p_participant_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) TO "authenticated";



GRANT ALL ON TABLE "public"."store_orders" TO "anon";
GRANT ALL ON TABLE "public"."store_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."store_orders" TO "service_role";



GRANT ALL ON FUNCTION "public"."start_store_order_payment_pix"("p_store_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."start_store_order_payment_pix"("p_store_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."start_store_order_payment_pix"("p_store_order_id" "uuid", "p_pix_code" "text", "p_pix_qrcode" "text", "p_gateway_payment_id" "text", "p_expires_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_order_item_participant_to_ticket"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_order_item_participant_to_ticket"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_order_item_participant_to_ticket"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_participant_registration_contact"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_participant_registration_contact"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_participant_registration_contact"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_ticket_kit_auxiliary_participant"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_ticket_kit_auxiliary_participant"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_ticket_kit_auxiliary_participant"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."toggle_coupon_active"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."toggle_coupon_active"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."toggle_coupon_active"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."toggle_coupon_active"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_is_active" boolean) TO "authenticated";



GRANT ALL ON FUNCTION "public"."touch_admin_overrides_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_admin_overrides_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_admin_overrides_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_admin_roles_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_admin_roles_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_admin_roles_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_admin_users_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_admin_users_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_admin_users_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_customer_profiles_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_customer_profiles_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_customer_profiles_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_event_kit_items_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_event_kit_items_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_event_kit_items_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_import_batch_rows_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_import_batch_rows_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_import_batch_rows_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_order_items_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_order_items_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_order_items_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_participation_history_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_participation_history_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_participation_history_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_payments_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_payments_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_payments_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_registration_batch_prices_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_registration_batch_prices_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_registration_batch_prices_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_ticket_category_benefits_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_ticket_category_benefits_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_ticket_category_benefits_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."transfer_ticket_by_pin"("p_ticket_id" "uuid", "p_pin" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."trg_classify_administrative_order"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trg_classify_administrative_order"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_enforce_ticket_holder_contact_uniqueness"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_enforce_ticket_holder_contact_uniqueness"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_enforce_ticket_holder_contact_uniqueness"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_event_kit_items_set_org"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_event_kit_items_set_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_event_kit_items_set_org"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trg_initialize_ticket_owner"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trg_initialize_ticket_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_inventory_movements_set_org"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_inventory_movements_set_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_inventory_movements_set_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_orders_set_organization_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_orders_set_organization_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_orders_set_organization_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_participant_kit_items_set_org"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_participant_kit_items_set_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_participant_kit_items_set_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_participants_set_organization_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_participants_set_organization_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_participants_set_organization_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_payments_set_organization_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_payments_set_organization_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_payments_set_organization_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_shirt_inventory_set_org"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_shirt_inventory_set_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_shirt_inventory_set_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_store_item_inventory_set_org"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_store_item_inventory_set_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_store_item_inventory_set_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_store_items_set_org"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_store_items_set_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_store_items_set_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_store_orders_set_org"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_store_orders_set_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_store_orders_set_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_ticket_holder_history_contacts"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_ticket_holder_history_contacts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_ticket_holder_history_contacts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_ticket_holder_history_reason_compatibility"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_ticket_holder_history_reason_compatibility"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_ticket_holder_history_reason_compatibility"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_ticket_kit_item_consistency"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_ticket_kit_item_consistency"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_ticket_kit_item_consistency"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_tickets_set_organization_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_tickets_set_organization_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_tickets_set_organization_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trg_wristbands_set_organization_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_wristbands_set_organization_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_wristbands_set_organization_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."undo_participant_checkin"("p_participant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."undo_participant_checkin"("p_participant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."undo_participant_checkin"("p_participant_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."undo_participant_full_kit"("p_participant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."undo_participant_full_kit"("p_participant_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."undo_participant_kit_item"("p_participant_id" "uuid", "p_kit_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."undo_participant_kit_item"("p_participant_id" "uuid", "p_kit_item_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."undo_store_order_item_delivery"("p_store_order_item_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."undo_store_order_item_delivery"("p_store_order_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."undo_store_order_item_delivery"("p_store_order_item_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."undo_ticket_checkin"("p_ticket_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."undo_ticket_checkin"("p_ticket_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."undo_ticket_checkin"("p_ticket_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."undo_ticket_full_kit"("p_ticket_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."undo_ticket_full_kit"("p_ticket_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."undo_ticket_full_kit"("p_ticket_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."undo_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."undo_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."undo_ticket_kit_item"("p_ticket_id" "uuid", "p_kit_item_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."unlink_wristband_from_ticket"("p_ticket_id" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."unlink_wristband_from_ticket"("p_ticket_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unlink_wristband_from_ticket"("p_ticket_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_coupon"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_coupon"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."update_coupon"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."update_coupon"("p_coupon_id" "uuid", "p_event_id" "uuid", "p_code" "text", "p_coupon_type" "text", "p_discount_percent" numeric, "p_max_uses" integer, "p_valid_from" timestamp with time zone, "p_valid_until" timestamp with time zone, "p_notes" "text", "p_is_active" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."update_event"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_year" integer, "p_description" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_registration_open_at" timestamp with time zone, "p_registration_close_at" timestamp with time zone, "p_location" "text", "p_is_active" boolean, "p_registration_enabled" boolean, "p_kit_enabled" boolean, "p_banner_hero_url" "text", "p_banner_card_url" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_event"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_year" integer, "p_description" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_registration_open_at" timestamp with time zone, "p_registration_close_at" timestamp with time zone, "p_location" "text", "p_is_active" boolean, "p_registration_enabled" boolean, "p_kit_enabled" boolean, "p_banner_hero_url" "text", "p_banner_card_url" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."update_event"("p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_year" integer, "p_description" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_registration_open_at" timestamp with time zone, "p_registration_close_at" timestamp with time zone, "p_location" "text", "p_is_active" boolean, "p_registration_enabled" boolean, "p_kit_enabled" boolean, "p_banner_hero_url" "text", "p_banner_card_url" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."update_inventory_item"("p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_inventory_item"("p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."update_inventory_item"("p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) TO "anon";



REVOKE ALL ON FUNCTION "public"."update_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."update_inventory_item"("p_event_id" "uuid", "p_inventory_id" "uuid", "p_shirt_type" "text", "p_shirt_size" "text", "p_total_quantity" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."update_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."update_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."update_registration_batch"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_sequence_number" integer, "p_male_price" numeric, "p_female_price" numeric, "p_max_confirmed_registrations" integer, "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."update_registration_batch_with_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_registration_batch_with_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."update_registration_batch_with_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."update_registration_batch_with_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_is_active" boolean, "p_prices" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."update_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."update_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."update_ticket_category"("p_category_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_capacity" integer, "p_is_active" boolean, "p_sort_order" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_admin_user_access"("p_target_user_id" "uuid", "p_role_id" "uuid", "p_is_active" boolean, "p_internal_note" "text", "p_overrides" "jsonb", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_admin_user_access"("p_target_user_id" "uuid", "p_role_id" "uuid", "p_is_active" boolean, "p_internal_note" "text", "p_overrides" "jsonb", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_admin_user_access"("p_target_user_id" "uuid", "p_role_id" "uuid", "p_is_active" boolean, "p_internal_note" "text", "p_overrides" "jsonb", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_current_event_import_participant"("p_import_batch_id" "uuid", "p_import_batch_row_id" "uuid", "p_expected_participant_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_batch_id" "uuid", "p_ticket_category_id" "uuid", "p_payment_method" "text", "p_import_issues" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_current_event_import_participant"("p_import_batch_id" "uuid", "p_import_batch_row_id" "uuid", "p_expected_participant_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_batch_id" "uuid", "p_ticket_category_id" "uuid", "p_payment_method" "text", "p_import_issues" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_current_event_import_participant"("p_import_batch_id" "uuid", "p_import_batch_row_id" "uuid", "p_expected_participant_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_email" "text", "p_city" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_registration_batch_id" "uuid", "p_ticket_category_id" "uuid", "p_payment_method" "text", "p_import_issues" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_customer_profile"("p_user_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_city" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_customer_profile"("p_user_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_city" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_customer_profile"("p_user_id" "uuid", "p_full_name" "text", "p_cpf" "text", "p_birth_date" "date", "p_gender" "text", "p_phone" "text", "p_city" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_event_addon_option"("p_event_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer, "p_is_active" boolean, "p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_addon_option"("p_event_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer, "p_is_active" boolean, "p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_event_addon_option"("p_event_id" "uuid", "p_name" "text", "p_description" "text", "p_sort_order" integer, "p_is_active" boolean, "p_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_event_addons_config"("p_event_id" "uuid", "p_apply_to_all_batches" boolean, "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_addons_config"("p_event_id" "uuid", "p_apply_to_all_batches" boolean, "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_event_addons_config"("p_event_id" "uuid", "p_apply_to_all_batches" boolean, "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_event_addons_model"("p_event_id" "uuid", "p_apply_to_all_batches" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_addons_model"("p_event_id" "uuid", "p_apply_to_all_batches" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_event_addons_model"("p_event_id" "uuid", "p_apply_to_all_batches" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_event_attraction"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_description" "text", "p_banner_url" "text", "p_is_active" boolean, "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_attraction"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_description" "text", "p_banner_url" "text", "p_is_active" boolean, "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_event_attraction"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_description" "text", "p_banner_url" "text", "p_is_active" boolean, "p_sort_order" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_event_batch_addon_option"("p_event_id" "uuid", "p_batch_id" "uuid", "p_option_id" "uuid", "p_enabled" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_batch_addon_option"("p_event_id" "uuid", "p_batch_id" "uuid", "p_option_id" "uuid", "p_enabled" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_event_batch_addon_option"("p_event_id" "uuid", "p_batch_id" "uuid", "p_option_id" "uuid", "p_enabled" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_event_highlight"("p_event_id" "uuid", "p_sort_order" integer, "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_highlight"("p_event_id" "uuid", "p_sort_order" integer, "p_is_active" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_event_highlight"("p_event_id" "uuid", "p_sort_order" integer, "p_is_active" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_event_kit_item"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_item_type" "text", "p_quantity_per_participant" integer, "p_requires_variant" boolean, "p_is_required" boolean, "p_is_active" boolean, "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_kit_item"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_item_type" "text", "p_quantity_per_participant" integer, "p_requires_variant" boolean, "p_is_required" boolean, "p_is_active" boolean, "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_event_kit_item"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_item_type" "text", "p_quantity_per_participant" integer, "p_requires_variant" boolean, "p_is_required" boolean, "p_is_active" boolean, "p_sort_order" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_event_kit_item_variant"("p_id" "uuid", "p_kit_item_id" "uuid", "p_name" "text", "p_value" "text", "p_sort_order" integer, "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_kit_item_variant"("p_id" "uuid", "p_kit_item_id" "uuid", "p_name" "text", "p_value" "text", "p_sort_order" integer, "p_is_active" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_event_kit_item_variant"("p_id" "uuid", "p_kit_item_id" "uuid", "p_name" "text", "p_value" "text", "p_sort_order" integer, "p_is_active" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_event_payment_methods"("p_event_id" "uuid", "p_pix_enabled" boolean, "p_credit_card_single_enabled" boolean, "p_credit_card_installments_enabled" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_payment_methods"("p_event_id" "uuid", "p_pix_enabled" boolean, "p_credit_card_single_enabled" boolean, "p_credit_card_installments_enabled" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_event_payment_methods"("p_event_id" "uuid", "p_pix_enabled" boolean, "p_credit_card_single_enabled" boolean, "p_credit_card_installments_enabled" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_event_schedule_item"("p_event_id" "uuid", "p_delivery_at" timestamp with time zone, "p_title" "text", "p_location" "text", "p_description" "text", "p_schedule_type" "text", "p_id" "uuid", "p_sort_order" integer, "p_is_active" boolean, "p_is_visible_to_users" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_event_schedule_item"("p_event_id" "uuid", "p_delivery_at" timestamp with time zone, "p_title" "text", "p_location" "text", "p_description" "text", "p_schedule_type" "text", "p_id" "uuid", "p_sort_order" integer, "p_is_active" boolean, "p_is_visible_to_users" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_event_schedule_item"("p_event_id" "uuid", "p_delivery_at" timestamp with time zone, "p_title" "text", "p_location" "text", "p_description" "text", "p_schedule_type" "text", "p_id" "uuid", "p_sort_order" integer, "p_is_active" boolean, "p_is_visible_to_users" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_financial_account"("p_organization_id" "uuid", "p_account_id" "uuid", "p_code" "text", "p_name" "text", "p_account_type" "text", "p_is_active" boolean, "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_financial_account"("p_organization_id" "uuid", "p_account_id" "uuid", "p_code" "text", "p_name" "text", "p_account_type" "text", "p_is_active" boolean, "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_financial_account"("p_organization_id" "uuid", "p_account_id" "uuid", "p_code" "text", "p_name" "text", "p_account_type" "text", "p_is_active" boolean, "p_idempotency_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_name" "text", "p_entry_kind" "text", "p_is_active" boolean, "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_name" "text", "p_entry_kind" "text", "p_is_active" boolean, "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_financial_category"("p_organization_id" "uuid", "p_category_id" "uuid", "p_name" "text", "p_entry_kind" "text", "p_is_active" boolean, "p_idempotency_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_legal_name" "text", "p_display_name" "text", "p_tax_identifier" "text", "p_is_active" boolean, "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_legal_name" "text", "p_display_name" "text", "p_tax_identifier" "text", "p_is_active" boolean, "p_idempotency_key" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_financial_supplier"("p_organization_id" "uuid", "p_supplier_id" "uuid", "p_legal_name" "text", "p_display_name" "text", "p_tax_identifier" "text", "p_is_active" boolean, "p_idempotency_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."upsert_kit_delivery_schedule"("p_delivery_at" timestamp with time zone, "p_city" "text", "p_location" "text", "p_id" "uuid", "p_sort_order" integer, "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_kit_delivery_schedule"("p_delivery_at" timestamp with time zone, "p_city" "text", "p_location" "text", "p_id" "uuid", "p_sort_order" integer, "p_is_active" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_registration_batch_addons"("p_event_id" "uuid", "p_batch_id" "uuid", "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_registration_batch_addons"("p_event_id" "uuid", "p_batch_id" "uuid", "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_registration_batch_addons"("p_event_id" "uuid", "p_batch_id" "uuid", "p_kit_enabled" boolean, "p_custom_cup_enabled" boolean, "p_gifts_enabled" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_registration_batch_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_prices" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_registration_batch_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_prices" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."upsert_registration_batch_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_prices" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_registration_batch_prices"("p_batch_id" "uuid", "p_event_id" "uuid", "p_prices" "jsonb") TO "authenticated";



GRANT ALL ON FUNCTION "public"."upsert_store_item"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_image_url" "text", "p_price" numeric, "p_requires_variant" boolean, "p_is_active" boolean, "p_sort_order" integer, "p_supply_mode" "text", "p_available_all_events" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_store_item"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_image_url" "text", "p_price" numeric, "p_requires_variant" boolean, "p_is_active" boolean, "p_sort_order" integer, "p_supply_mode" "text", "p_available_all_events" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_store_item"("p_id" "uuid", "p_event_id" "uuid", "p_name" "text", "p_slug" "text", "p_description" "text", "p_image_url" "text", "p_price" numeric, "p_requires_variant" boolean, "p_is_active" boolean, "p_sort_order" integer, "p_supply_mode" "text", "p_available_all_events" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_store_item_variant"("p_id" "uuid", "p_store_item_id" "uuid", "p_name" "text", "p_value" "text", "p_price_adjustment" numeric, "p_is_active" boolean, "p_sort_order" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_store_item_variant"("p_id" "uuid", "p_store_item_id" "uuid", "p_name" "text", "p_value" "text", "p_price_adjustment" numeric, "p_is_active" boolean, "p_sort_order" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_store_item_variant"("p_id" "uuid", "p_store_item_id" "uuid", "p_name" "text", "p_value" "text", "p_price_adjustment" numeric, "p_is_active" boolean, "p_sort_order" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."user_can_access_organization"("p_user_id" "uuid", "p_organization_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."user_can_access_organization"("p_user_id" "uuid", "p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_can_access_organization"("p_user_id" "uuid", "p_organization_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."user_has_permission"("p_user_id" "uuid", "p_permission_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."user_has_permission"("p_user_id" "uuid", "p_permission_code" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."user_has_permission"("p_user_id" "uuid", "p_permission_code" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."user_is_order_item_holder"("p_user_id" "uuid", "p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."user_is_order_item_holder"("p_user_id" "uuid", "p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."user_is_order_item_holder"("p_user_id" "uuid", "p_order_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."user_organization_ids"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."user_organization_ids"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_organization_ids"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_coupon"("p_code" "text", "p_event_id" "uuid", "p_original_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_coupon"("p_code" "text", "p_event_id" "uuid", "p_original_amount" numeric) TO "service_role";
GRANT ALL ON FUNCTION "public"."validate_coupon"("p_code" "text", "p_event_id" "uuid", "p_original_amount" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."validate_coupon"("p_code" "text", "p_event_id" "uuid", "p_original_amount" numeric) TO "authenticated";
























GRANT ALL ON TABLE "public"."admin_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."admin_role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."admin_roles" TO "service_role";



GRANT ALL ON TABLE "public"."admin_user_permission_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."admin_users" TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."order_items" TO "anon";
GRANT ALL ON TABLE "public"."order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."order_items" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."confirmed_payments_cash_backfill_111_candidates" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."coupon_redemptions" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."coupon_redemptions" TO "authenticated";
GRANT ALL ON TABLE "public"."coupon_redemptions" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."coupons" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."coupons" TO "authenticated";
GRANT ALL ON TABLE "public"."coupons" TO "service_role";



GRANT ALL ON TABLE "public"."customer_profiles" TO "anon";
GRANT ALL ON TABLE "public"."customer_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."event_addon_options" TO "anon";
GRANT ALL ON TABLE "public"."event_addon_options" TO "authenticated";
GRANT ALL ON TABLE "public"."event_addon_options" TO "service_role";



GRANT ALL ON TABLE "public"."event_addons_config" TO "anon";
GRANT ALL ON TABLE "public"."event_addons_config" TO "authenticated";
GRANT ALL ON TABLE "public"."event_addons_config" TO "service_role";



GRANT ALL ON TABLE "public"."event_addons_model" TO "anon";
GRANT ALL ON TABLE "public"."event_addons_model" TO "authenticated";
GRANT ALL ON TABLE "public"."event_addons_model" TO "service_role";



GRANT ALL ON TABLE "public"."event_attractions" TO "anon";
GRANT ALL ON TABLE "public"."event_attractions" TO "authenticated";
GRANT ALL ON TABLE "public"."event_attractions" TO "service_role";



GRANT ALL ON TABLE "public"."event_batch_addon_options" TO "anon";
GRANT ALL ON TABLE "public"."event_batch_addon_options" TO "authenticated";
GRANT ALL ON TABLE "public"."event_batch_addon_options" TO "service_role";



GRANT ALL ON TABLE "public"."event_highlights" TO "anon";
GRANT ALL ON TABLE "public"."event_highlights" TO "authenticated";
GRANT ALL ON TABLE "public"."event_highlights" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_kit_item_variant_inventory" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_kit_item_variant_inventory" TO "authenticated";
GRANT ALL ON TABLE "public"."event_kit_item_variant_inventory" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_kit_item_variants" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_kit_item_variants" TO "authenticated";
GRANT ALL ON TABLE "public"."event_kit_item_variants" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_kit_items" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."event_kit_items" TO "authenticated";
GRANT ALL ON TABLE "public"."event_kit_items" TO "service_role";



GRANT ALL ON TABLE "public"."event_payment_methods" TO "anon";
GRANT ALL ON TABLE "public"."event_payment_methods" TO "authenticated";
GRANT ALL ON TABLE "public"."event_payment_methods" TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "anon";
GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT ALL ON TABLE "public"."financial_accounts" TO "anon";
GRANT ALL ON TABLE "public"."financial_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."financial_categories" TO "anon";
GRANT ALL ON TABLE "public"."financial_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_categories" TO "service_role";



GRANT ALL ON TABLE "public"."financial_entries" TO "anon";
GRANT ALL ON TABLE "public"."financial_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_entries" TO "service_role";



GRANT ALL ON TABLE "public"."financial_entry_lines" TO "anon";
GRANT ALL ON TABLE "public"."financial_entry_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_entry_lines" TO "service_role";



GRANT ALL ON TABLE "public"."financial_entry_settlements" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_entry_settlements" TO "service_role";



GRANT ALL ON TABLE "public"."financial_event_allocations" TO "anon";
GRANT ALL ON TABLE "public"."financial_event_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_event_allocations" TO "service_role";



GRANT ALL ON TABLE "public"."financial_reconciliations" TO "anon";
GRANT ALL ON TABLE "public"."financial_reconciliations" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_reconciliations" TO "service_role";



GRANT ALL ON TABLE "public"."financial_reversals" TO "anon";
GRANT ALL ON TABLE "public"."financial_reversals" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_reversals" TO "service_role";



GRANT ALL ON TABLE "public"."financial_suppliers" TO "anon";
GRANT ALL ON TABLE "public"."financial_suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_suppliers" TO "service_role";



GRANT ALL ON TABLE "public"."import_batch_rows" TO "anon";
GRANT ALL ON TABLE "public"."import_batch_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."import_batch_rows" TO "service_role";



GRANT ALL ON TABLE "public"."import_batches" TO "anon";
GRANT ALL ON TABLE "public"."import_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."import_batches" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory_movements" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";



GRANT ALL ON TABLE "public"."kit_deliveries" TO "anon";
GRANT ALL ON TABLE "public"."kit_deliveries" TO "authenticated";
GRANT ALL ON TABLE "public"."kit_deliveries" TO "service_role";



GRANT ALL ON TABLE "public"."kit_delivery_schedule" TO "anon";
GRANT ALL ON TABLE "public"."kit_delivery_schedule" TO "authenticated";
GRANT ALL ON TABLE "public"."kit_delivery_schedule" TO "service_role";



GRANT ALL ON SEQUENCE "public"."order_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."order_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."order_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."organization_members" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."organization_members" TO "authenticated";



GRANT ALL ON TABLE "public"."organizations" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."organizations" TO "authenticated";



GRANT ALL ON TABLE "public"."participant_account_invites" TO "service_role";
GRANT SELECT ON TABLE "public"."participant_account_invites" TO "authenticated";



GRANT ALL ON TABLE "public"."participant_data_issues" TO "anon";
GRANT ALL ON TABLE "public"."participant_data_issues" TO "authenticated";
GRANT ALL ON TABLE "public"."participant_data_issues" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."participant_kit_items" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."participant_kit_items" TO "authenticated";
GRANT ALL ON TABLE "public"."participant_kit_items" TO "service_role";



GRANT ALL ON TABLE "public"."participant_wristbands" TO "anon";
GRANT ALL ON TABLE "public"."participant_wristbands" TO "authenticated";
GRANT ALL ON TABLE "public"."participant_wristbands" TO "service_role";



GRANT ALL ON TABLE "public"."participants" TO "anon";
GRANT ALL ON TABLE "public"."participants" TO "authenticated";
GRANT ALL ON TABLE "public"."participants" TO "service_role";



GRANT ALL ON TABLE "public"."participation_history" TO "anon";
GRANT ALL ON TABLE "public"."participation_history" TO "authenticated";
GRANT ALL ON TABLE "public"."participation_history" TO "service_role";



GRANT ALL ON TABLE "public"."platform_settings" TO "anon";
GRANT ALL ON TABLE "public"."platform_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_settings" TO "service_role";



GRANT ALL ON TABLE "public"."platform_users" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."platform_users" TO "authenticated";



GRANT ALL ON TABLE "public"."registration_batch_addons" TO "anon";
GRANT ALL ON TABLE "public"."registration_batch_addons" TO "authenticated";
GRANT ALL ON TABLE "public"."registration_batch_addons" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."registration_batch_prices" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."registration_batch_prices" TO "authenticated";
GRANT ALL ON TABLE "public"."registration_batch_prices" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."registration_batches" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."registration_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."registration_batches" TO "service_role";



GRANT ALL ON TABLE "public"."registration_contacts" TO "anon";
GRANT ALL ON TABLE "public"."registration_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."registration_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."store_item_inventory" TO "anon";
GRANT ALL ON TABLE "public"."store_item_inventory" TO "authenticated";
GRANT ALL ON TABLE "public"."store_item_inventory" TO "service_role";



GRANT ALL ON TABLE "public"."store_item_variants" TO "anon";
GRANT ALL ON TABLE "public"."store_item_variants" TO "authenticated";
GRANT ALL ON TABLE "public"."store_item_variants" TO "service_role";



GRANT ALL ON TABLE "public"."store_items" TO "anon";
GRANT ALL ON TABLE "public"."store_items" TO "authenticated";
GRANT ALL ON TABLE "public"."store_items" TO "service_role";



GRANT ALL ON TABLE "public"."store_order_items" TO "anon";
GRANT ALL ON TABLE "public"."store_order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."store_order_items" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_categories" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."ticket_categories" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_category_benefits" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_category_benefits" TO "authenticated";
GRANT ALL ON TABLE "public"."ticket_category_benefits" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_holder_history" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_holder_history" TO "authenticated";
GRANT ALL ON TABLE "public"."ticket_holder_history" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_item_change_requests" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_item_change_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."ticket_item_change_requests" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_owner_history" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ticket_owner_history" TO "authenticated";
GRANT ALL ON TABLE "public"."ticket_owner_history" TO "service_role";



GRANT ALL ON TABLE "public"."tickets" TO "anon";
GRANT ALL ON TABLE "public"."tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."tickets" TO "service_role";



GRANT ALL ON TABLE "public"."user_pin_lookup_attempts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_pin_lookup_attempts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_pin_lookup_attempts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_pin_lookup_attempts_id_seq" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































