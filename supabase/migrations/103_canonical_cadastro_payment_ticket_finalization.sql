-- 103_canonical_cadastro_payment_ticket_finalization.sql
-- Valida e devolve o checkout canonico sem depender de SELECTs sujeitos a RLS.

begin;

create or replace function public.finalize_cadastro_payment_and_ticket(
  p_participant_id uuid,p_payment_id uuid,p_event_id uuid,p_organization_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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

create or replace function public.get_cadastro_payment_ticket_context(p_participant_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
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

revoke all on function public.finalize_cadastro_payment_and_ticket(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.finalize_cadastro_payment_and_ticket(uuid,uuid,uuid,uuid) to authenticated;
revoke all on function public.get_cadastro_payment_ticket_context(uuid) from public,anon,authenticated;
grant execute on function public.get_cadastro_payment_ticket_context(uuid) to authenticated;

commit;
