-- P0: ingressos importados do Militrin 2026 sao historicamente pagos.
-- price_origin=legacy_unknown + amount 0 + method NULL nao significa
-- "pagamento em aberto". A Central/RPCs liam payment_status='pending' e
-- bloqueavam kit/check-in com "Pagamento pendente".
--
-- Este arquivo:
-- 1) define ticket_has_operational_payment (pago, cortesia, legado historico)
-- 2) aplica o gate nas RPCs de check-in/entrega
-- 3) grava quitacao historica no batch oficial, sem inventar valor/metodo/Asaas
-- 4) futuros imports legacy_unknown tambem passam a quitar o placeholder
--
-- Nao chama Asaas. Nao cria charge, recebivel, webhook nem receita.

begin;

create or replace function public.ticket_has_operational_payment(p_order_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.orders%rowtype;
  v_paid boolean;
  v_legacy_placeholder boolean;
begin
  if p_order_id is null then
    return false;
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return false;
  end if;

  select exists(
    select 1
    from public.payments p
    where (p.order_id = v_order.id or p.id = v_order.payment_id)
      and p.payment_status = 'paid'
  ) into v_paid;
  if v_paid then
    return true;
  end if;

  -- Placeholder de importacao historica: preco/metodo desconhecidos nao sao
  -- pagamento em aberto. Cobranca Asaas real (provider/gateway id) nunca entra.
  select exists(
    select 1
    from public.payments p
    where (p.order_id = v_order.id or p.id = v_order.payment_id)
      and p.payment_status = 'pending'
      and p.gateway_payment_id is null
      and coalesce(p.provider, '') = ''
      and public.is_legacy_import_historical_price(coalesce(p.price_origin, v_order.price_origin))
      and v_order.buyer_type = 'imported_holder'
      and v_order.import_batch_id is not null
      and v_order.status in ('confirmed', 'paid')
  ) into v_legacy_placeholder;

  return v_legacy_placeholder;
end;
$$;

comment on function public.ticket_has_operational_payment(uuid) is
  'Elegibilidade operacional (kit/check-in): paid, cortesia ja paid, ou placeholder legado sem gateway. Pending real Asaas/catalogo permanece bloqueado.';

revoke all on function public.ticket_has_operational_payment(uuid) from public, anon;
grant execute on function public.ticket_has_operational_payment(uuid) to authenticated, service_role;

create or replace function public.checkin_ticket_entry(p_ticket_id uuid, p_wristband_code text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_participant public.participants%rowtype; v_contact public.registration_contacts%rowtype; v_actor_email text;
  v_event public.events%rowtype; v_has_wristband boolean;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para realizar check-in.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado. Check-in bloqueado.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Este ingresso ja foi utilizado.'; end if;
  select * into v_item from public.order_items where id=v_ticket.order_item_id for update;
  if not found or v_item.status in('cancelled','expired','refunded') then raise exception 'Item de pedido invalido para check-in.'; end if;
  select * into strict v_order from public.orders where id=v_ticket.order_id;
  if not public.ticket_has_operational_payment(v_order.id) then
    raise exception 'Pagamento ainda não confirmado. A entrega/check-in não pode ser realizada.';
  end if;

  select * into v_event from public.events where id = v_ticket.event_id;
  if coalesce(v_event.wristband_enabled, false) and coalesce(v_event.wristband_required_for_checkin, false) then
    select exists(select 1 from public.participant_wristbands pw where pw.ticket_id = v_ticket.id and pw.status = 'active') into v_has_wristband;
    if not v_has_wristband then
      if nullif(trim(coalesce(p_wristband_code, '')), '') is null then
        raise exception using errcode = 'P0001', message = 'WRISTBAND_REQUIRED',
          detail = jsonb_build_object('code', 'WRISTBAND_REQUIRED', 'message', 'Este evento exige pulseira vinculada para o check-in.')::text;
      end if;
      perform public.link_wristband_to_ticket(v_ticket.id, p_wristband_code);
    end if;
  end if;

  update public.tickets set status='used',used_at=now() where id=v_ticket.id;
  if v_item.participant_id is not null then
    select * into v_participant from public.participants where id=v_item.participant_id;
    if found and v_participant.registration_contact_id is not null then select * into v_contact from public.registration_contacts where id=v_participant.registration_contact_id; end if;
    if found and v_participant.user_id is not null then
      insert into public.participation_history(event_id,user_id,participant_id,registration_contact_id,legacy_event_name,event_year,full_name,normalized_name,cpf,email,status,source,manually_verified,created_at,updated_at)
      values(v_ticket.event_id,v_participant.user_id,v_participant.id,v_participant.registration_contact_id,null,extract(year from coalesce(v_ticket.issued_at,now()))::integer,
        coalesce(v_contact.full_name,v_participant.full_name,'Participante'),public.normalize_text_for_match(coalesce(v_contact.full_name,v_participant.full_name)),
        coalesce(v_contact.cpf,v_participant.cpf),coalesce(v_contact.email,v_participant.email),'confirmed','system',false,now(),now()) on conflict do nothing;
    end if;
  end if;
  select lower(email) into v_actor_email from auth.users where id=auth.uid();
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_checkin_entry','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'actor_email',v_actor_email,'organization_id',v_ticket.organization_id,'ticket_id',v_ticket.id,
      'order_item_id',v_ticket.order_item_id,'participant_id',v_item.participant_id,'registration_contact_id',v_item.registration_contact_id,'used_at',now()));
  return true;
end; $$;

create or replace function public.deliver_ticket_kit_item(p_ticket_id uuid, p_kit_item_id uuid, p_wristband_code text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_link public.participant_kit_items%rowtype;
  v_ticket public.tickets%rowtype;
  v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype;
  v_inv public.event_kit_item_variant_inventory%rowtype;
  v_variant_id uuid;
  v_available integer;
  v_event public.events%rowtype;
  v_has_wristband boolean;
begin
  if auth.uid() is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado nao permite entrega de kit.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update;
  if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
  if v_link.status='delivered' then return true; end if;
  if v_link.status='cancelled' then raise exception 'Item cancelado nao pode ser entregue.'; end if;
  if not public.ticket_has_operational_payment(v_ticket.order_id) then
    raise exception 'Pagamento ainda não confirmado. A entrega/check-in não pode ser realizada.';
  end if;

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

  select * into strict v_item from public.event_kit_items where id=p_kit_item_id and event_id=v_ticket.event_id and is_active;

  if v_item.item_type='shirt' then
    if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Camiseta indisponivel para entrega.'; end if;
    v_variant_id:=nullif(v_link.variant_data->>'variant_id','')::uuid;
    if v_variant_id is null then raise exception 'Camiseta nao vinculada.'; end if;
    select * into strict v_variant from public.event_kit_item_variants where id=v_variant_id and kit_item_id=v_item.id;
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

  update public.participant_kit_items set status='delivered',delivered_at=now() where id=v_link.id and status<>'delivered';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('ticket_kit_item_delivered','participant_kit_items',v_link.id,v_link.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'kit_item_id',p_kit_item_id,
      'supply_mode',v_item.shirt_supply_mode,'variant_id',v_variant_id));
  return true;
end; $$;

create or replace function public.deliver_kit_and_checkin(p_ticket_id uuid)
returns table(success boolean,kit_delivered boolean,checkin_done boolean,message text,participant_id uuid,event_id uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_event public.events%rowtype; v_pending integer; v_paid boolean;
begin
  if not public.current_user_has_permission('kits.deliver') or not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para operacao combinada.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  select * into strict v_event from public.events where id=v_ticket.event_id;
  if not coalesce(v_event.allow_checkin_during_kit_delivery,false) then
    return query select false,false,false,'Operacao combinada desativada para este evento.'::text,v_item.participant_id,v_ticket.event_id; return;
  end if;
  v_paid := public.ticket_has_operational_payment(v_ticket.order_id);
  if not v_paid then return query select false,false,false,'Pagamento ainda não confirmado. A entrega/check-in não pode ser realizada.'::text,v_item.participant_id,v_ticket.event_id; return; end if;
  perform public.ensure_ticket_kit_items(v_ticket.id);
  select count(*) into v_pending from public.participant_kit_items pki where pki.ticket_id=v_ticket.id and pki.status<>'delivered';
  if v_pending>0 then perform public.deliver_ticket_full_kit(v_ticket.id); end if;
  if v_ticket.status<>'used' and v_ticket.used_at is null then perform public.checkin_ticket_entry(v_ticket.id); end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('combined_kit_delivery_and_checkin','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',v_ticket.id,'order_item_id',v_item.id,'participant_id',v_item.participant_id));
  return query select true,true,true,'Kit entregue e entrada registrada.'::text,v_item.participant_id,v_ticket.event_id;
end; $$;

create or replace function public.finalize_imported_ticket_after_issue_resolution(
  p_order_item_id uuid,p_resolved_fields text[] default array[]::text[],p_force_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_payment public.payments%rowtype; v_batch public.import_batches%rowtype; v_ticket_id uuid; v_blocked boolean; v_finalization text;
  v_can_confirm boolean; v_legacy_unknown boolean;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  if v_item.item_kind <> 'ticket' then
    return jsonb_build_object('success',true,'applicable',false,'finalization','not_ticket');
  end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if v_order.buyer_type<>'imported_holder' or v_order.import_batch_id is null then
    return jsonb_build_object('success',true,'applicable',false,'finalization','not_imported');
  end if;
  if not public.user_can_access_organization(v_actor,v_order.organization_id) and not exists(
    select 1 from public.participants p where p.id=v_item.participant_id and p.user_id=v_actor
  ) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  select * into v_batch from public.import_batches where id=v_order.import_batch_id for update;
  select * into v_payment from public.payments where id=v_order.payment_id for update;
  if not found then raise exception 'Pagamento importado nao encontrado.'; end if;
  v_legacy_unknown := public.is_legacy_import_unknown_price(v_order.price_origin, v_order.buyer_type, v_order.import_batch_id);
  select exists(select 1 from public.participant_data_issues i where i.order_item_id=v_item.id and i.status='open' and i.blocks_ticket_issuance) into v_blocked;
  if v_blocked then
    v_finalization:='issues_remaining';
  elsif v_legacy_unknown then
    -- Quitacao historica: status paid, sem inventar amount/method/gateway.
    if v_payment.gateway_payment_id is null and coalesce(v_payment.provider,'') = '' then
      update public.payments
        set payment_status='paid',
            paid_at=coalesce(paid_at, v_order.confirmed_at, now()),
            updated_at=now()
      where id=v_payment.id
        and payment_status='pending'
        and gateway_payment_id is null
        and coalesce(provider,'') = '';
    end if;
    update public.orders set status='confirmed',confirmed_at=coalesce(confirmed_at,now()) where id=v_order.id;
    update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now() where id=v_item.id;
    select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
    if v_ticket_id is null then select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id; end if;
    update public.import_batch_rows set ticket_id=v_ticket_id where order_item_id=v_item.id;
    update public.participant_data_issues set ticket_id=v_ticket_id where order_item_id=v_item.id;
    v_finalization:='legacy_unknown_ticket_issued';
  elsif v_payment.payment_status <> 'paid'
    and coalesce(v_batch.payment_mode_original,'pending')='pending'
    and not p_force_confirm then
    v_finalization:='payment_pending';
  else
    v_can_confirm := v_payment.payment_status='paid'
      or coalesce(v_batch.payment_mode_original,'pending')='confirm_all'
      or public.is_active_owner(v_actor)
      or public.resolve_user_permission(v_actor,'finance.confirm_payment');
    if not v_can_confirm then raise exception 'Sem permissao para confirmar o pagamento.'; end if;
    update public.payments set payment_status='paid',paid_at=coalesce(paid_at,now()),updated_at=now() where id=v_payment.id;
    update public.orders set status='confirmed',confirmed_at=coalesce(confirmed_at,now()) where id=v_order.id;
    update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now() where id=v_item.id;
    select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
    if v_ticket_id is null then select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id; end if;
    update public.import_batch_rows set ticket_id=v_ticket_id where order_item_id=v_item.id;
    update public.participant_data_issues set ticket_id=v_ticket_id where order_item_id=v_item.id;
    v_finalization:='paid_and_ticket_issued';
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('imported_ticket_issue_finalized','order_items',v_item.id,v_item.event_id,jsonb_build_object(
    'order_item_id',v_item.id,'ticket_id',v_ticket_id,'registration_contact_id',v_item.registration_contact_id,
    'import_batch_id',v_batch.id,'fields_resolved',coalesce(p_resolved_fields,array[]::text[]),'actor_user_id',v_actor,
    'finalization',v_finalization,'price_origin',v_order.price_origin));
  return jsonb_build_object('success',true,'applicable',true,'finalization',v_finalization,'payment_id',v_order.payment_id,
    'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id);
end; $$;

with backfill as (
  update public.payments p
  set
    payment_status = 'paid',
    paid_at = coalesce(p.paid_at, o.confirmed_at, b.created_at, now()),
    updated_at = now()
  from public.orders o
  join public.import_batches b on b.id = o.import_batch_id
  where p.order_id = o.id
    and o.import_batch_id = 'aee74ffb-1eb3-4742-818f-77b701fd7da0'
    and p.payment_status = 'pending'
    and coalesce(p.price_origin, o.price_origin, '') = 'legacy_unknown'
    and p.gateway_payment_id is null
    and coalesce(p.provider, '') = ''
    and p.payment_method is null
    and coalesce(p.amount, 0) = 0
    and coalesce(p.final_amount, 0) = 0
  returning p.id, p.order_id, o.event_id
)
insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
select
  'legacy_historical_payment_settled',
  'payments',
  backfill.id,
  backfill.event_id,
  jsonb_build_object(
    'order_id', backfill.order_id,
    'import_batch_id', 'aee74ffb-1eb3-4742-818f-77b701fd7da0',
    'reason', 'historical_settlement_official_militrin_2026',
    'amount_unchanged', true,
    'method_unchanged', true,
    'gateway_untouched', true
  )
from backfill;

commit;
