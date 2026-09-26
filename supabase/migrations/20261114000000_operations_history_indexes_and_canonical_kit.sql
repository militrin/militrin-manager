-- Central de Histórico de Operações (Fase 1): índices de leitura por evento+tempo
-- e evento canônico de entrega/desfazimento de kit.
--
-- NÃO alterar logs existentes. Sem backfill.
--
-- Justificativa dos índices (consultas em src/lib/operations/history/query.ts):
--   1) audit_logs filtrado por event_id + faixa de created_at, ordenado
--      created_at DESC, id DESC. idx_audit_logs_event_id (só event_id) não
--      cobre o range/sort temporal.
--   2) o mesmo recorte ainda restringe action IN (...allowlist operacional).
--      Índice (event_id, action, created_at DESC) atende bitmap/index skip
--      por ação sem varrer todos os logs do evento.
--   3) ticket_holder_history: event_id + created_at DESC, sem índice composto
--      equivalente no schema atual.
-- Não recria idx_audit_logs_event_id.

begin;

create index if not exists idx_audit_logs_event_created_at_desc
  on public.audit_logs (event_id, created_at desc);

create index if not exists idx_audit_logs_event_action_created_at_desc
  on public.audit_logs (event_id, action, created_at desc);

create index if not exists idx_ticket_holder_history_event_created_at_desc
  on public.ticket_holder_history (event_id, created_at desc);

comment on index public.idx_audit_logs_event_created_at_desc is
  'Leitura do histórico operacional: event_id + created_at DESC (feed/cards por período).';
comment on index public.idx_audit_logs_event_action_created_at_desc is
  'Leitura do histórico operacional: event_id + action + created_at DESC (allowlist de ações).';
comment on index public.idx_ticket_holder_history_event_created_at_desc is
  'Titularidade no histórico operacional: event_id + created_at DESC.';

-- kit_delivered: 1 leitura/ação de kit completo = 1 evento de auditoria.
-- Mantém ticket_kit_item_delivered por item (outras telas ainda dependem).
create or replace function public.deliver_ticket_full_kit(p_ticket_id uuid, p_wristband_code text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_row record; v_ticket public.tickets%rowtype; v_available integer;
  v_event public.events%rowtype; v_has_wristband boolean;
  v_delivered integer := 0;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
  v_oi public.order_items%rowtype;
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
  -- Estoque fisico zerado sempre bloqueia a entrega de camiseta, nos dois
  -- modos (stock e made_to_order) -- so 'disabled' fica fora da entrega.
  for v_row in
    select pki.kit_item_id,pki.quantity,v.id as variant_id,v.name as shirt_type,v.value as shirt_size
    from public.participant_kit_items pki
    join public.event_kit_items eki on eki.id=pki.kit_item_id
    left join public.event_kit_item_variants v on v.id=nullif(pki.variant_data->>'variant_id','')::uuid
    where pki.ticket_id=p_ticket_id and pki.status not in('delivered','cancelled')
      and eki.item_type='shirt' and eki.shirt_supply_mode in('stock','made_to_order')
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

  select * into v_event from public.events where id = v_ticket.event_id;
  if coalesce(v_event.wristband_enabled, false) and coalesce(v_event.wristband_required_for_kit, false) then
    select exists(select 1 from public.participant_wristbands pw where pw.ticket_id = v_ticket.id and pw.status = 'active') into v_has_wristband;
    if not v_has_wristband then
      if nullif(trim(coalesce(p_wristband_code, '')), '') is null then
        raise exception using errcode = 'P0001', message = 'WRISTBAND_REQUIRED',
          detail = jsonb_build_object('code', 'WRISTBAND_REQUIRED', 'message', 'Este evento exige pulseira vinculada para a entrega do kit.')::text;
      end if;
      perform public.link_wristband_to_ticket(v_ticket.id, p_wristband_code);
    end if;
  end if;

  for v_row in select kit_item_id from public.participant_kit_items
    where ticket_id=p_ticket_id and status not in('delivered','cancelled') order by kit_item_id
  loop
    perform public.deliver_ticket_kit_item(p_ticket_id,v_row.kit_item_id,p_wristband_code);
    v_delivered := v_delivered + 1;
  end loop;

  if v_delivered > 0 then
    select * into v_oi from public.order_items where id = v_ticket.order_item_id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values(
      'kit_delivered',
      'tickets',
      p_ticket_id,
      v_ticket.event_id,
      jsonb_build_object(
        'actor_user_id', auth.uid(),
        'actor_email', v_actor_email,
        'ticket_id', p_ticket_id,
        'participant_id', v_ticket.participant_id,
        'items_delivered', v_delivered,
        'shirt_type', v_oi.shirt_type,
        'shirt_size', v_oi.shirt_size,
        'operation', 'full_kit_delivery'
      )
    );
  end if;
  return true;
end; $$;

comment on function public.deliver_ticket_full_kit(uuid, text) is
  'Entrega o kit completo do ingresso. Alem dos logs por item, grava kit_delivered (1 acao = 1 entrega) quando ao menos um item e entregue nesta chamada.';

-- kit_delivery_undone: desfazimento canônico da entrega completa.
create or replace function public.undo_ticket_full_kit(
  p_ticket_id uuid, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_row record; v_found boolean:=false; v_ticket public.tickets%rowtype;
  v_undone integer := 0;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  for v_row in select kit_item_id from public.participant_kit_items where ticket_id=p_ticket_id and status='delivered' loop
    v_found:=true;
    perform public.undo_ticket_kit_item(p_ticket_id,v_row.kit_item_id,p_reason_code,p_reason_text);
    v_undone := v_undone + 1;
  end loop;
  if not v_found then raise exception 'Nenhum item entregue para desfazer.'; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values(
    'kit_delivery_undone',
    'tickets',
    p_ticket_id,
    v_ticket.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'ticket_id', p_ticket_id,
      'participant_id', v_ticket.participant_id,
      'items_undone', v_undone,
      'reason_code', p_reason_code,
      'reason_text', nullif(trim(coalesce(p_reason_text,'')),''),
      'operation', 'full_kit_undo'
    )
  );
  return true;
end;
$$;

comment on function public.undo_ticket_full_kit(uuid, text, text) is
  'Desfaz a entrega completa do kit. Alem dos logs por item, grava kit_delivery_undone (evento canonico de auditoria).';

commit;
