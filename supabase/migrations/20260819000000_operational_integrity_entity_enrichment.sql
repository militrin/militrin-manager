-- NEXORA/Militrin: Central de Integridade Operacional -- enriquecimento de
-- entidade (V1.1).
--
-- Nao adiciona detectores novos, nao muda o contrato `integrity_issue_row`
-- nem a assinatura de get_operational_integrity_report/..._issue_entities.
-- Cada `detect_integrity_*` passa a preencher o `metadata` jsonb com dados
-- legiveis (nome do titular, nome do evento, codigo amigavel do ingresso,
-- categoria/lote, status) que hoje so existem como IDs tecnicos -- para o
-- drawer da Central deixar de repetir o mesmo titulo generico em cada card e
-- mostrar QUEM/QUAL registro esta com o problema.
--
-- `title`/`description` de cada detector permanecem genericos de proposito:
-- get_operational_integrity_report agrega com (array_agg(title))[1], entao
-- personalizar o titulo por entidade faria o card resumo (usado tambem pelo
-- Dashboard) mostrar o nome de uma pessoa aleatoria da primeira linha
-- agregada. Toda personalizacao por entidade vive so em `metadata`,
-- consumido pelo drawer via get_operational_integrity_issue_entities (que
-- reusa os MESMOS detectores, sem agrupar).
--
-- Codigo amigavel do ingresso replica exatamente a formula ja usada no
-- front (src/app/ingressos/[ticketId]/page.tsx): '#' || primeiros 8
-- caracteres de tickets.token em maiusculo.
begin;

-- ============================================================
-- Titularidade
-- ============================================================

create or replace function public.detect_integrity_named_without_holder(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_NAMED_WITHOUT_CANONICAL_HOLDER'::text,
    'attention'::text,
    'titularidade'::text,
    'Titular incompleto'::text,
    'O ingresso possui um nome informado, mas ainda não está corretamente vinculado a uma pessoa.'::text,
    pdi.event_id,
    'order_item'::text,
    pdi.order_item_id,
    'Definir titular'::text,
    case when t.id is not null then '/ingressos/' || t.id || '/editar' else '/ingressos' end,
    jsonb_build_object(
      'issue_id', pdi.id, 'order_item_id', pdi.order_item_id, 'field_code', pdi.field_code,
      'holder_name', oi.holder_full_name, 'event_name', e.name,
      'ticket_code', case when t.id is not null then '#' || upper(left(t.token::text, 8)) else null end
    )
  from public.participant_data_issues pdi
  join public.events e on e.id = pdi.event_id
  left join public.order_items oi on oi.id = pdi.order_item_id
  left join public.tickets t on t.order_item_id = pdi.order_item_id and t.status <> 'cancelled'
  where e.organization_id = p_organization_id
    and (p_event_id is null or pdi.event_id = p_event_id)
    and pdi.status = 'open'
    and pdi.issue_type = 'insufficient_named_holder_identity'
    and pdi.order_item_id is not null;
$$;
revoke all on function public.detect_integrity_named_without_holder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_named_without_holder(uuid, uuid) to service_role;

create or replace function public.detect_integrity_duplicate_active_holder(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  with active_holders as (
    select
      coalesce(oi.registration_contact_id, p.registration_contact_id) as contact_id,
      t.event_id, t.id as ticket_id
    from public.tickets t
    join public.order_items oi on oi.id = t.order_item_id
    left join public.participants p on p.id = coalesce(oi.participant_id, t.participant_id)
    where t.status not in ('cancelled', 'canceled', 'void', 'voided')
      and coalesce(oi.registration_contact_id, p.registration_contact_id) is not null
      and t.organization_id = p_organization_id
      and (p_event_id is null or t.event_id = p_event_id)
  ),
  conflicts as (
    select contact_id, event_id, count(*) as ticket_count
    from active_holders group by contact_id, event_id having count(*) > 1
  )
  select
    'DUPLICATE_ACTIVE_HOLDER'::text, 'critical'::text, 'titularidade'::text,
    'Titular duplicado no mesmo evento'::text,
    'Esta pessoa aparece como titular de mais de um ingresso ativo no mesmo evento.'::text,
    ah.event_id, 'ticket'::text, ah.ticket_id,
    'Abrir ingresso'::text, '/ingressos/' || ah.ticket_id,
    jsonb_build_object(
      'registration_contact_id', ah.contact_id, 'ticket_count', c.ticket_count,
      'holder_name', rc.full_name, 'event_name', ev.name,
      'ticket_code', '#' || upper(left(t2.token::text, 8)),
      'category_name', tc.name, 'batch_name', rb.name, 'ticket_status', t2.status
    )
  from active_holders ah
  join conflicts c on c.contact_id = ah.contact_id and c.event_id = ah.event_id
  join public.tickets t2 on t2.id = ah.ticket_id
  join public.events ev on ev.id = ah.event_id
  left join public.registration_contacts rc on rc.id = ah.contact_id
  left join public.order_items oi2 on oi2.id = t2.order_item_id
  left join public.ticket_categories tc on tc.id = oi2.ticket_category_id
  left join public.registration_batches rb on rb.id = oi2.batch_id;
$$;
revoke all on function public.detect_integrity_duplicate_active_holder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_duplicate_active_holder(uuid, uuid) to service_role;

create or replace function public.detect_integrity_legacy_holder_mismatch(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'LEGACY_HOLDER_REFERENCE_MISMATCH'::text, 'attention'::text, 'titularidade'::text,
    'Referência de titularidade desatualizada'::text,
    'O cadastro vinculado a este ingresso não corresponde mais ao titular atual — provavelmente após uma transferência.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Abrir ingresso'::text, case when t.id is not null then '/ingressos/' || t.id else '/ingressos' end,
    jsonb_build_object(
      'order_item_registration_contact_id', oi.registration_contact_id, 'participant_registration_contact_id', p.registration_contact_id,
      'current_holder_name', rc_current.full_name, 'legacy_holder_name', rc_legacy.full_name,
      'event_name', e.name,
      'ticket_code', case when t.id is not null then '#' || upper(left(t.token::text, 8)) else null end
    )
  from public.order_items oi
  join public.events e on e.id = oi.event_id
  join public.participants p on p.id = oi.participant_id
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  left join public.registration_contacts rc_current on rc_current.id = oi.registration_contact_id
  left join public.registration_contacts rc_legacy on rc_legacy.id = p.registration_contact_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and oi.registration_contact_id is not null
    and p.registration_contact_id is not null
    and oi.registration_contact_id is distinct from p.registration_contact_id
    and oi.status not in ('cancelled', 'expired', 'refunded');
$$;
revoke all on function public.detect_integrity_legacy_holder_mismatch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_legacy_holder_mismatch(uuid, uuid) to service_role;

-- ============================================================
-- Ingressos / Pedidos
-- ============================================================

create or replace function public.detect_integrity_paid_order_without_ticket(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'PAID_ORDER_WITHOUT_TICKET'::text, 'critical'::text, 'ingressos_pedidos'::text,
    'Pedido pago sem ingresso emitido'::text,
    'O pagamento deste pedido foi confirmado, mas o ingresso correspondente não foi emitido.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Abrir pedido'::text, '/pedidos?eventId=' || oi.event_id || '&q=' || o.order_number,
    jsonb_build_object(
      'order_id', o.id, 'order_number', o.order_number, 'order_item_status', oi.status,
      'event_name', e.name, 'holder_name', coalesce(rc.full_name, oi.holder_full_name),
      'final_amount', oi.final_amount
    )
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.events e on e.id = oi.event_id
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and oi.status in ('confirmed', 'transferred')
    and exists (select 1 from public.payments pay where (pay.order_id = o.id or pay.id = o.payment_id) and pay.payment_status = 'paid')
    and t.id is null;
$$;
revoke all on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) to service_role;

create or replace function public.detect_integrity_ticket_without_order_item(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_WITHOUT_ORDER_ITEM'::text, 'critical'::text, 'ingressos_pedidos'::text,
    'Ingresso sem vínculo comercial'::text,
    'Este ingresso perdeu a referência ao item de pedido que o originou — a relação comercial está quebrada.'::text,
    t.event_id, 'ticket'::text, t.id,
    'Abrir ingresso'::text, '/ingressos/' || t.id,
    jsonb_build_object(
      'ticket_status', t.status, 'order_id', t.order_id,
      'event_name', e.name, 'ticket_code', '#' || upper(left(t.token::text, 8))
    )
  from public.tickets t
  join public.events e on e.id = t.event_id
  where t.organization_id = p_organization_id
    and (p_event_id is null or t.event_id = p_event_id)
    and t.order_item_id is null
    and t.status <> 'cancelled';
$$;
revoke all on function public.detect_integrity_ticket_without_order_item(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_ticket_without_order_item(uuid, uuid) to service_role;

-- ============================================================
-- Categoria / Lote / Preco (sem mudanca -- ja tinham event_name)
-- ============================================================

create or replace function public.detect_integrity_single_ticket_price_unconfirmed(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event record;
begin
  for v_event in
    select e.id, e.name from public.events e
    where e.organization_id = p_organization_id and (p_event_id is null or e.id = p_event_id) and e.registration_enabled
  loop
    return query
    select
      'SINGLE_TICKET_PRICE_NOT_CONFIRMED'::text, 'critical'::text, 'categoria_preco'::text,
      'Preço do ingresso único não configurado'::text,
      'As vendas estão abertas, mas o preço do ingresso único ainda não foi confirmado.'::text,
      v_event.id, 'event'::text, v_event.id,
      'Configurar preço'::text, '/painel/eventos/' || v_event.id,
      jsonb_build_object('event_name', v_event.name)
    from public.get_event_single_ticket_price_status(v_event.id) s
    where s.active_category_count = 0 and s.registration_enabled and not s.price_confirmed;
  end loop;
end; $$;
revoke all on function public.detect_integrity_single_ticket_price_unconfirmed(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_single_ticket_price_unconfirmed(uuid, uuid) to service_role;

create or replace function public.detect_integrity_no_purchasable_category(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event record; v_active_categories integer; v_eligible_categories integer;
begin
  for v_event in
    select e.id, e.name from public.events e
    where e.organization_id = p_organization_id and (p_event_id is null or e.id = p_event_id) and e.registration_enabled
  loop
    select count(*) into v_active_categories from public.ticket_categories tc where tc.event_id = v_event.id and tc.is_active = true;
    if v_active_categories = 0 then continue; end if;

    select count(*) into v_eligible_categories from public.get_event_ticket_categories(v_event.id) tc
    where tc.is_active and (tc.available_slots is null or tc.available_slots > 0) and tc.current_batch_id is not null;

    if v_eligible_categories = 0 then
      return query select
        'NO_PURCHASABLE_CATEGORY_OPTION'::text, 'critical'::text, 'categoria_preco'::text,
        'Nenhuma opção de compra disponível'::text,
        'As vendas estão abertas e o evento tem categorias configuradas, mas nenhuma delas está disponível para compra no momento.'::text,
        v_event.id, 'event'::text, v_event.id,
        'Configurar preço'::text, '/painel/eventos/' || v_event.id,
        jsonb_build_object('event_name', v_event.name, 'active_categories', v_active_categories);
    end if;
  end loop;
end; $$;
revoke all on function public.detect_integrity_no_purchasable_category(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_no_purchasable_category(uuid, uuid) to service_role;

create or replace function public.detect_integrity_category_event_mismatch(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'ORDER_ITEM_CATEGORY_EVENT_MISMATCH'::text, 'critical'::text, 'categoria_preco'::text,
    'Categoria ou lote de outro evento'::text,
    'Este ingresso referencia uma categoria ou lote que pertence a um evento diferente do evento do ingresso.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Abrir pedido'::text, '/pedidos?eventId=' || oi.event_id || '&q=' || o.order_number,
    jsonb_build_object(
      'order_id', o.id, 'order_number', o.order_number, 'category_event_id', tc.event_id, 'batch_event_id', rb.event_id,
      'event_name', e.name, 'wrong_category_name', tc.name, 'wrong_batch_name', rb.name
    )
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.events e on e.id = oi.event_id
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.registration_batches rb on rb.id = oi.batch_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and (
      (tc.id is not null and tc.event_id <> oi.event_id)
      or (rb.id is not null and rb.event_id <> oi.event_id)
    );
$$;
revoke all on function public.detect_integrity_category_event_mismatch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_category_event_mismatch(uuid, uuid) to service_role;

-- ============================================================
-- Camisetas e Kits
-- ============================================================

create or replace function public.detect_integrity_missing_shirt_variant(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_MISSING_REQUIRED_SHIRT_VARIANT'::text, 'attention'::text, 'camisetas_kits'::text,
    'Camiseta não definida'::text,
    'Este ingresso tem direito a camiseta, mas ainda não possui tamanho/variante definido.'::text,
    t.event_id, 'ticket'::text, t.id,
    'Abrir ingresso'::text, '/ingressos/' || t.id || '/editar',
    jsonb_build_object(
      'kit_item_id', eki.id, 'kit_item_name', eki.name,
      'holder_name', coalesce(rc.full_name, oi.holder_full_name), 'event_name', ev.name,
      'category_name', tc.name, 'ticket_code', '#' || upper(left(t.token::text, 8))
    )
  from public.tickets t
  join public.event_kit_items eki on eki.event_id = t.event_id and eki.item_type = 'shirt' and eki.is_active = true and eki.requires_variant = true
  join public.events ev on ev.id = t.event_id
  left join public.order_items oi on oi.id = t.order_item_id
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.participant_kit_items pki on pki.kit_item_id = eki.id
    and pki.status <> 'cancelled'
    and (pki.ticket_id = t.id or (pki.ticket_id is null and pki.order_item_id = t.order_item_id))
  where t.organization_id = p_organization_id
    and (p_event_id is null or t.event_id = p_event_id)
    and t.status <> 'cancelled'
    and (
      pki.id is null
      or pki.variant_data is null
      or coalesce(pki.variant_data->>'variant_id', '') = ''
    );
$$;
revoke all on function public.detect_integrity_missing_shirt_variant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_missing_shirt_variant(uuid, uuid) to service_role;

create or replace function public.detect_integrity_cancelled_ticket_pending_kit(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_CANCELLED_WITH_PENDING_KIT_ITEM'::text, 'critical'::text, 'camisetas_kits'::text,
    'Item de kit preso a ingresso cancelado'::text,
    'Este ingresso foi cancelado, mas ainda existe um item de kit reservado/confirmado vinculado a ele.'::text,
    t.event_id, 'ticket'::text, t.id,
    'Abrir ingresso'::text, '/ingressos/' || t.id,
    jsonb_build_object(
      'kit_item_status', pki.status, 'kit_item_id', pki.kit_item_id, 'kit_item_name', eki.name,
      'holder_name', coalesce(rc.full_name, oi.holder_full_name), 'event_name', ev.name
    )
  from public.participant_kit_items pki
  join public.tickets t on t.id = pki.ticket_id or (pki.ticket_id is null and t.order_item_id = pki.order_item_id)
  join public.events ev on ev.id = t.event_id
  left join public.event_kit_items eki on eki.id = pki.kit_item_id
  left join public.order_items oi on oi.id = t.order_item_id
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  where t.organization_id = p_organization_id
    and (p_event_id is null or t.event_id = p_event_id)
    and pki.status in ('reserved', 'confirmed')
    and t.status = 'cancelled';
$$;
revoke all on function public.detect_integrity_cancelled_ticket_pending_kit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_cancelled_ticket_pending_kit(uuid, uuid) to service_role;

-- ============================================================
-- Estoque
-- ============================================================

create or replace function public.detect_integrity_shirt_inventory_overdelivered(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'SHIRT_INVENTORY_DELIVERED_EXCEEDS_TOTAL'::text, 'critical'::text, 'estoque'::text,
    'Estoque de camiseta inconsistente'::text,
    'A quantidade entregue deste item é maior do que a quantidade total registrada em estoque.'::text,
    si.event_id, 'shirt_inventory'::text, si.id,
    'Ver estoque'::text, '/camisetas',
    jsonb_build_object(
      'shirt_type', si.shirt_type, 'shirt_size', si.shirt_size, 'total_quantity', si.total_quantity, 'delivered_quantity', si.delivered_quantity,
      'event_name', e.name
    )
  from public.shirt_inventory si
  join public.events e on e.id = si.event_id
  where si.organization_id = p_organization_id
    and (p_event_id is null or si.event_id = p_event_id)
    and si.delivered_quantity > si.total_quantity;
$$;
revoke all on function public.detect_integrity_shirt_inventory_overdelivered(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_shirt_inventory_overdelivered(uuid, uuid) to service_role;

-- ============================================================
-- Check-in / Retirada
-- ============================================================

create or replace function public.detect_integrity_cancelled_ticket_checkin(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_CANCELLED_WITH_CHECKIN'::text, 'critical'::text, 'checkin_retirada'::text,
    'Check-in registrado em ingresso cancelado'::text,
    'Este ingresso está cancelado, mas possui um registro de check-in — os dois estados não podem coexistir.'::text,
    t.event_id, 'ticket'::text, t.id,
    'Abrir ingresso'::text, '/ingressos/' || t.id,
    jsonb_build_object(
      'used_at', t.used_at, 'cancelled_at', t.cancelled_at,
      'event_name', e.name, 'ticket_code', '#' || upper(left(t.token::text, 8)),
      'holder_name', coalesce(rc.full_name, oi.holder_full_name)
    )
  from public.tickets t
  join public.events e on e.id = t.event_id
  left join public.order_items oi on oi.id = t.order_item_id
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  where t.organization_id = p_organization_id
    and (p_event_id is null or t.event_id = p_event_id)
    and t.status = 'cancelled'
    and t.used_at is not null;
$$;
revoke all on function public.detect_integrity_cancelled_ticket_checkin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_cancelled_ticket_checkin(uuid, uuid) to service_role;

-- ============================================================
-- Cadastros
-- ============================================================

create or replace function public.detect_integrity_open_blocking_data_issue(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'OPEN_BLOCKING_DATA_ISSUE'::text,
    case when pdi.blocks_payment or pdi.blocks_ticket_issuance then 'critical' else 'attention' end,
    'cadastros'::text,
    'Pendência de cadastro'::text,
    coalesce(nullif(trim(pdi.message), ''), 'Existe uma pendência de dados que pode afetar a operação deste cadastro.'),
    pdi.event_id,
    case when pdi.ticket_id is not null then 'ticket' when pdi.order_item_id is not null then 'order_item' else 'registration_contact' end,
    coalesce(pdi.ticket_id, pdi.order_item_id, pdi.registration_contact_id),
    'Abrir cadastro'::text,
    case when pdi.ticket_id is not null then '/ingressos/' || pdi.ticket_id
         when pdi.registration_contact_id is not null then '/cadastros/' || pdi.registration_contact_id
         else '/cadastros' end,
    jsonb_build_object('issue_id', pdi.id, 'issue_type', pdi.issue_type, 'field_code', pdi.field_code,
      'blocks_payment', pdi.blocks_payment, 'blocks_ticket_issuance', pdi.blocks_ticket_issuance,
      'blocks_checkin', pdi.blocks_checkin, 'blocks_kit_delivery', pdi.blocks_kit_delivery,
      'contact_name', rc.full_name, 'event_name', e.name)
  from public.participant_data_issues pdi
  join public.events e on e.id = pdi.event_id
  left join public.registration_contacts rc on rc.id = pdi.registration_contact_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or pdi.event_id = p_event_id)
    and pdi.status = 'open'
    and pdi.issue_type <> 'insufficient_named_holder_identity'
    and (pdi.blocks_payment or pdi.blocks_ticket_issuance or pdi.blocks_checkin or pdi.blocks_kit_delivery);
$$;
revoke all on function public.detect_integrity_open_blocking_data_issue(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_open_blocking_data_issue(uuid, uuid) to service_role;

-- ============================================================
-- Configuracao do evento (sem mudanca -- ja tinha event_name)
-- ============================================================

create or replace function public.detect_integrity_shirt_kit_without_variants(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'EVENT_SHIRT_KIT_WITHOUT_VARIANTS'::text,
    case when e.registration_enabled then 'critical' else 'warning' end,
    'configuracao_evento'::text,
    'Camiseta obrigatória sem tamanhos configurados'::text,
    'Este evento exige camiseta, mas nenhum tamanho/variante foi cadastrado.'::text,
    e.id, 'event'::text, e.id,
    'Configurar camiseta'::text, '/painel/eventos/' || e.id,
    jsonb_build_object('event_name', e.name, 'kit_item_id', eki.id)
  from public.event_kit_items eki
  join public.events e on e.id = eki.event_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or e.id = p_event_id)
    and eki.item_type = 'shirt' and eki.is_active = true and eki.requires_variant = true
    and not exists (select 1 from public.event_kit_item_variants v where v.kit_item_id = eki.id and v.is_active = true);
$$;
revoke all on function public.detect_integrity_shirt_kit_without_variants(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_shirt_kit_without_variants(uuid, uuid) to service_role;

-- ============================================================
-- Lista de detectores para "verificacoes aprovadas" -- agora com
-- domain+label (rotulo afirmativo do que foi checado) alem do code, para o
-- drawer "Verificacoes aprovadas" poder listar o que passou sem inventar
-- texto no frontend. Mudanca de tipo de retorno (text[] -> table) exige
-- dropar a funcao antes de recriar; os dois consumidores atuais (actions.ts
-- e os testes de integracao) so usam o tamanho do resultado, entao a troca
-- e compativel.
-- ============================================================

drop function if exists public.get_operational_integrity_detector_codes();

create or replace function public.get_operational_integrity_detector_codes()
returns table(code text, domain text, label text) language sql immutable as $$
  select * from (values
    ('TICKET_NAMED_WITHOUT_CANONICAL_HOLDER', 'titularidade', 'Nenhum ingresso com nome informado sem titular vinculado'),
    ('DUPLICATE_ACTIVE_HOLDER', 'titularidade', 'Nenhum titular duplicado no mesmo evento'),
    ('LEGACY_HOLDER_REFERENCE_MISMATCH', 'titularidade', 'Nenhuma referência de titularidade desatualizada'),
    ('PAID_ORDER_WITHOUT_TICKET', 'ingressos_pedidos', 'Nenhum pedido pago sem ingresso emitido'),
    ('TICKET_WITHOUT_ORDER_ITEM', 'ingressos_pedidos', 'Nenhum ingresso sem vínculo comercial'),
    ('SINGLE_TICKET_PRICE_NOT_CONFIRMED', 'categoria_preco', 'Preço do ingresso único confirmado em todos os eventos com vendas abertas'),
    ('NO_PURCHASABLE_CATEGORY_OPTION', 'categoria_preco', 'Sempre há opção de compra disponível quando as vendas estão abertas'),
    ('ORDER_ITEM_CATEGORY_EVENT_MISMATCH', 'categoria_preco', 'Nenhuma categoria ou lote de outro evento vinculado a um pedido'),
    ('TICKET_MISSING_REQUIRED_SHIRT_VARIANT', 'camisetas_kits', 'Nenhum ingresso com camiseta obrigatória sem tamanho definido'),
    ('TICKET_CANCELLED_WITH_PENDING_KIT_ITEM', 'camisetas_kits', 'Nenhum item de kit preso a um ingresso cancelado'),
    ('SHIRT_INVENTORY_DELIVERED_EXCEEDS_TOTAL', 'estoque', 'Estoque de camiseta consistente em todos os eventos'),
    ('TICKET_CANCELLED_WITH_CHECKIN', 'checkin_retirada', 'Nenhum check-in registrado em ingresso cancelado'),
    ('OPEN_BLOCKING_DATA_ISSUE', 'cadastros', 'Nenhuma pendência de cadastro bloqueando pagamento, emissão, check-in ou kit'),
    ('EVENT_SHIRT_KIT_WITHOUT_VARIANTS', 'configuracao_evento', 'Toda camiseta obrigatória tem tamanhos configurados')
  ) as t(code, domain, label);
$$;
revoke all on function public.get_operational_integrity_detector_codes() from public, anon;
grant execute on function public.get_operational_integrity_detector_codes() to authenticated;

commit;
