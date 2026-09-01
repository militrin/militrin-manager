begin;

-- Auditoria da Central de Integridade Operacional encontrou um segundo bug no
-- mesmo fluxo do problema anterior (participant_invite.ts): mesmo quando
-- resolve_ticket_data_issues chega a ser chamada corretamente, ela marcava a
-- pendencia de genero como resolvida mas NUNCA recalculava o preco quando a
-- categoria/lote tem preco diferenciado por genero (registration_batch_prices
-- .male_price/.female_price) -- o pedido ficava com o valor "generico" usado
-- na importacao (normalmente o male_price, ver import_current_event_contact_first)
-- para sempre, mesmo depois do genero real ser informado. Isso replica
-- exatamente a logica ja usada em resolve_import_ticket_options (para
-- categoria/lote) e em create_registration (para o checkout publico), so que
-- disparada quando o campo resolvido e "gender" em vez de "category"/"batch".
--
-- REVISAO DE SEGURANCA (pre-push): resolve_import_ticket_options (existente,
-- nao alterado aqui) atualiza order_items/orders incondicionalmente e so
-- protege `payments` com `payment_status<>'paid'`. Isso deixaria uma janela
-- rara mas real: se o pagamento ja tiver sido efetivamente processado (por
-- qualquer caminho -- webhook, cortesia, override) enquanto a pendencia de
-- genero ainda constava como aberta, recalcular so orders/order_items
-- criaria uma divergencia entre o valor registrado no pedido e o valor
-- realmente cobrado. Por isso aqui o recalculo de preco por genero e' feito
-- ANTES de qualquer decisao, com o pagamento ja carregado, e as tres tabelas
-- (order_items, orders, payments) SO sao tocadas quando o pagamento ainda
-- nao esta pago -- nunca sobrescrevemos valor de pedido/pagamento ja
-- concluido.
create or replace function public.resolve_ticket_data_issues(
  p_order_item_id uuid,p_expected_issue_ids uuid[],p_values jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_participant public.participants%rowtype; v_contact_id uuid; v_ticket_id uuid; v_key text;
  v_current uuid[]; v_remaining jsonb; v_payment public.payments%rowtype;
  v_personal jsonb:='{}'::jsonb; v_category uuid; v_batch uuid; v_shirt_type text; v_shirt_size text;
  v_price public.registration_batch_prices%rowtype; v_amount numeric;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  select * into v_payment from public.payments where id=v_order.payment_id for update;
  if v_item.participant_id is not null then select * into v_participant from public.participants where id=v_item.participant_id for update; end if;
  v_contact_id:=coalesce(v_item.registration_contact_id,v_participant.registration_contact_id);
  if v_contact_id is null then raise exception 'Ingresso sem cadastro global vinculado.'; end if;
  if v_participant.user_id is distinct from v_actor and not(
    public.user_can_access_organization(v_actor,v_order.organization_id)
    and (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'participants.edit_basic'))
  ) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  perform 1 from public.participant_data_issues where order_item_id=v_item.id and status='open' for update;
  select coalesce(array_agg(id order by id),array[]::uuid[]) into v_current from public.participant_data_issues
    where order_item_id=v_item.id and status='open';
  if v_current is distinct from (select coalesce(array_agg(x order by x),array[]::uuid[]) from unnest(coalesce(p_expected_issue_ids,array[]::uuid[])) x)
    then return jsonb_build_object('success',false,'conflict',true,'message','As pendencias foram atualizadas. Recarregue e tente novamente.'); end if;
  for v_key in select jsonb_object_keys(coalesce(p_values,'{}'::jsonb)) loop
    if v_key in('full_name','cpf','birth_date','gender','phone','email','city') then v_personal:=v_personal||jsonb_build_object(v_key,p_values->v_key);
    elsif v_key not in('category','batch','shirt_type','shirt_size') then raise exception 'Campo de correcao nao permitido.'; end if;
  end loop;
  if v_personal<>'{}'::jsonb then perform public.update_registration_contact_from_participant(v_participant.id,v_personal); end if;
  v_category:=nullif(p_values->>'category','')::uuid; v_batch:=nullif(p_values->>'batch','')::uuid;
  if v_category is not null or v_batch is not null then
    perform public.resolve_import_ticket_options(v_item.id,coalesce(v_category,v_item.ticket_category_id),coalesce(v_batch,v_item.batch_id));
  elsif v_personal?'gender' and v_item.ticket_category_id is not null and v_item.batch_id is not null
    and coalesce(v_payment.payment_status,'pending')<>'paid' then
    -- Mesma formula de genero->preco ja usada em create_registration/
    -- reevaluate_participant_data_issues: so "feminino/female/f" cai no
    -- preco feminino, qualquer outro valor (inclusive ausente) cai no
    -- masculino -- price nao fica indeterminado por genero desconhecido.
    -- O guard payment_status<>'paid' protege as TRES tabelas (nao so
    -- payments): um pedido cujo pagamento ja foi processado nunca tem seu
    -- valor registrado alterado por esta correcao.
    select * into v_price from public.registration_batch_prices
      where batch_id=v_item.batch_id and ticket_category_id=v_item.ticket_category_id;
    if found then
      v_amount:=case when lower(coalesce(p_values->>'gender','')) in('feminino','female','f') then v_price.female_price else v_price.male_price end;
      if v_amount is not null then
        update public.order_items set unit_price=v_amount,final_amount=v_amount,updated_at=now() where id=v_item.id;
        update public.orders set base_amount=v_amount,final_amount=v_amount where id=v_order.id;
        update public.payments set amount=v_amount,final_amount=v_amount,updated_at=now() where id=v_payment.id;
      end if;
    end if;
  end if;
  v_shirt_type:=nullif(trim(p_values->>'shirt_type'),''); v_shirt_size:=nullif(upper(trim(p_values->>'shirt_size')),'');
  if v_shirt_type is not null or v_shirt_size is not null then
    update public.order_items set shirt_type=coalesce(v_shirt_type,shirt_type),shirt_size=coalesce(v_shirt_size,shirt_size),updated_at=now() where id=v_item.id;
    select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
    if v_ticket_id is not null and v_shirt_type is not null and v_shirt_size is not null then perform public.admin_change_ticket_shirt(v_ticket_id,v_shirt_type,v_shirt_size); end if;
  end if;
  update public.participant_data_issues set status='resolved',resolved_at=now(),resolved_by=v_actor,updated_at=now()
  where order_item_id=v_item.id and status='open' and (
    field_code in(select jsonb_object_keys(coalesce(p_values,'{}'::jsonb)))
    or (field_code='shirt_selection' and (p_values?'shirt_type' or p_values?'shirt_size'))
  );
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'field_code',field_code,'issue_type',issue_type,'message',message,
    'blocks_payment',blocks_payment,'blocks_ticket_issuance',blocks_ticket_issuance,'blocks_checkin',blocks_checkin,'blocks_kit_delivery',blocks_kit_delivery)
    order by created_at),'[]'::jsonb) into v_remaining from public.participant_data_issues where order_item_id=v_item.id and status='open';
  select * into v_payment from public.payments where id=v_order.payment_id;
  return jsonb_build_object('success',true,'remaining_issues',v_remaining,'base_amount',v_payment.amount,
    'final_amount',v_payment.final_amount,'payment_status',coalesce(v_payment.payment_status,'pending'),'order_item_id',v_item.id);
end; $$;

revoke all on function public.resolve_ticket_data_issues(uuid,uuid[],jsonb) from public,anon;
grant execute on function public.resolve_ticket_data_issues(uuid,uuid[],jsonb) to authenticated,service_role;

commit;
