begin;

-- Segunda parte da auditoria "fechar todos os writers de categoria antes de
-- aplicar a 906" (a primeira, admin_update_ticket_category, esta em
-- 20260906000000). resolve_import_ticket_options (fluxo de correcao de
-- importacao, supabase/migrations/20260815003331_contact_first_import_phase2.sql)
-- e o segundo escritor real de order_items.ticket_category_id encontrado, e
-- e MAIS sensivel que o primeiro: alem da categoria/lote, ela recalcula
-- incondicionalmente order_items.unit_price/final_amount e
-- orders.base_amount/final_amount (so o UPDATE em payments ja tinha uma
-- guarda parcial, `where payment_status<>'paid'`). Sem nenhuma checagem de
-- status, um admin corrigindo uma pendencia de importacao podia mudar a
-- categoria E o valor financeiro de um pedido ja pago, sem qualquer ajuste
-- contabil correspondente.
--
-- Ao contrario de admin_update_ticket_category (20260906000000), aqui NAO
-- existe override administrativo: a tarefa foi explicita que uma correcao de
-- importacao pos-pagamento precisa de um fluxo de regularizacao financeira
-- proprio (fora de escopo aqui, nao inventado nesta migration) -- nunca uma
-- alteracao silenciosa de categoria+preco. Antes do pagamento, o
-- comportamento fica exatamente como era (nenhuma mudanca de sinalizacao,
-- validacao ou calculo).
--
-- "Pago"/"check-in" usam a MESMA semantica canonica ja estabelecida em
-- 20260906000000 (== resolveCommercialStatus, src/lib/dashboard/
-- commercial-status.ts): orders.status = 'confirmed' OU order_items.status
-- = 'confirmed' OU payments.payment_status = 'paid' OU existe um ticket
-- emitido para este order_item com check-in (used_at/status='used').
-- resolve_ticket_data_issues (mesmo arquivo, linha ~303) delega category/
-- batch diretamente para esta funcao via `perform`, entao o bloqueio cobre
-- os dois pontos de entrada sem precisar duplicar a checagem.
create or replace function public.resolve_import_ticket_options(
  p_order_item_id uuid, p_ticket_category_id uuid, p_batch_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_gender text;
  v_amount numeric;
  v_payment_status text;
  v_is_paid boolean := false;
  v_is_checked_in boolean := false;
begin
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  select * into v_order from public.orders where id = v_item.order_id for update;
  if v_actor is null or not public.user_can_access_organization(v_actor, v_order.organization_id)
    or not (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor, 'participants.edit_basic')) then
    raise exception 'Sem permissao para corrigir o ingresso.';
  end if;

  if v_order.payment_id is not null then
    select payment_status into v_payment_status from public.payments where id = v_order.payment_id;
  end if;
  v_is_paid := coalesce(v_order.status, '') = 'confirmed'
    or v_item.status = 'confirmed'
    or coalesce(v_payment_status, '') = 'paid';
  select exists(
    select 1 from public.tickets t
    where t.order_item_id = v_item.id and (t.used_at is not null or t.status = 'used')
  ) into v_is_checked_in;

  if v_is_paid or v_is_checked_in then
    raise exception 'Este ingresso ja esta pago/confirmado (ou ja teve check-in) -- a correcao de categoria e lote pela importacao nao esta mais disponivel aqui. Use o fluxo administrativo de regularizacao financeira para este caso.';
  end if;

  if not exists(select 1 from public.ticket_categories where id = p_ticket_category_id and event_id = v_item.event_id and is_active) then
    raise exception 'Categoria invalida para o evento.';
  end if;
  if not exists(select 1 from public.registration_batches where id = p_batch_id and event_id = v_item.event_id and is_active) then
    raise exception 'Lote invalido para o evento.';
  end if;
  select coalesce(rc.gender, p.gender) into v_gender
    from public.participants p
    left join public.registration_contacts rc on rc.id = coalesce(v_item.registration_contact_id, p.registration_contact_id)
    where p.id = v_item.participant_id;
  select case when lower(coalesce(v_gender, '')) = 'female' then female_price else male_price end into v_amount
    from public.registration_batch_prices where batch_id = p_batch_id and ticket_category_id = p_ticket_category_id;
  if v_amount is null then raise exception 'Preco nao configurado para categoria e lote.'; end if;

  update public.order_items set ticket_category_id = p_ticket_category_id, batch_id = p_batch_id, unit_price = v_amount, final_amount = v_amount, updated_at = now() where id = v_item.id;
  update public.orders set base_amount = v_amount, final_amount = v_amount where id = v_order.id;
  update public.payments set amount = v_amount, final_amount = v_amount, updated_at = now() where id = v_order.payment_id and payment_status <> 'paid';
  update public.participant_data_issues set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
    where order_item_id = v_item.id and status = 'open' and field_code in ('category', 'batch', 'price');

  return jsonb_build_object('success', true, 'order_item_id', v_item.id, 'amount', v_amount);
end;
$$;

commit;
