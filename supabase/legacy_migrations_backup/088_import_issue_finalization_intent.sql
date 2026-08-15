-- 088_import_issue_finalization_intent.sql
-- Preserva a intencao financeira do lote e finaliza importados pendentes sem comprador.

begin;

alter table public.import_batches
  add column if not exists payment_mode_original text,
  add column if not exists payment_reason_original text;

alter table public.import_batches
  drop constraint if exists import_batches_payment_mode_original_check;
alter table public.import_batches
  add constraint import_batches_payment_mode_original_check
  check (payment_mode_original is null or payment_mode_original in ('pending','confirm_all'));

create or replace function public.finalize_imported_participant_after_issue_resolution(
  p_participant_id uuid,
  p_resolved_fields text[] default array[]::text[],
  p_force_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_participant public.participants%rowtype;
  v_batch public.import_batches%rowtype;
  v_payment public.payments%rowtype;
  v_order public.orders%rowtype;
  v_order_item public.order_items%rowtype;
  v_ticket_id uuid;
  v_open integer;
  v_batch_count integer;
  v_finalization text;
  v_batch_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;

  select * into v_participant from public.participants
  where id=p_participant_id for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_participant.organization_id) then
    raise exception 'Usuario sem acesso ao participante.';
  end if;

  select count(distinct ib.id), (array_agg(distinct ib.id order by ib.id))[1]
  into v_batch_count, v_batch_id
  from public.participation_history ph
  join public.import_batches ib on ib.id=ph.import_batch_id
    and ib.event_id=v_participant.event_id
    and ib.import_type='current_event_registrations'
  where ph.participant_id=p_participant_id and ph.source='import';

  if v_batch_count=0 then
    return jsonb_build_object('success',true,'applicable',false,'finalization','not_imported');
  end if;
  if v_batch_count<>1 then raise exception 'Mais de um lote de importacao comprovado para o participante.'; end if;
  select * into v_batch from public.import_batches where id=v_batch_id for update;

  select count(*) into v_open from public.participant_data_issues
  where participant_id=p_participant_id and status='open';
  if v_open>0 then
    v_finalization := 'issues_remaining';
  else
    select * into v_payment from public.payments
    where participant_id=p_participant_id and event_id=v_participant.event_id
    order by created_at desc limit 1 for update;
    if not found or v_payment.amount is null or v_payment.final_amount is null then
      raise exception 'Pagamento real nao foi criado apos o recalculo.';
    end if;

    if coalesce(v_batch.payment_mode_original,'pending')='pending' and not p_force_confirm then
      v_finalization := 'payment_pending';
    else
      if not (public.is_active_owner(v_actor)
        or public.resolve_user_permission(v_actor,'finance.confirm_payment')) then
        raise exception 'Sem permissao para confirmar o pagamento originalmente solicitado.';
      end if;

      update public.payments set payment_status='paid', paid_at=coalesce(paid_at,now()), updated_at=now()
      where id=v_payment.id;

      select * into v_order from public.orders
      where participant_id=p_participant_id and event_id=v_participant.event_id
        and buyer_type='imported_holder' and user_id is null and import_batch_id=v_batch.id
      for update;
      if not found then
        if exists(select 1 from public.orders where participant_id=p_participant_id and event_id=v_participant.event_id) then
          raise exception 'Existe pedido de outra origem; regularizacao automatica bloqueada.';
        end if;
        insert into public.orders(user_id,participant_id,event_id,payment_id,order_number,status,
          base_amount,discount_amount,final_amount,buyer_type,import_batch_id,confirmed_at)
        values(null,p_participant_id,v_participant.event_id,v_payment.id,public.generate_order_number(),'confirmed',
          v_payment.amount,coalesce(v_payment.discount_amount,0),v_payment.final_amount,'imported_holder',v_batch.id,now())
        returning * into v_order;
      else
        update public.orders set payment_id=v_payment.id,status='confirmed',confirmed_at=coalesce(confirmed_at,now()),
          base_amount=v_payment.amount,discount_amount=coalesce(v_payment.discount_amount,0),final_amount=v_payment.final_amount
        where id=v_order.id returning * into v_order;
      end if;
      update public.payments set order_id=v_order.id where id=v_payment.id;

      select * into v_order_item from public.order_items
      where order_id=v_order.id and participant_id=p_participant_id for update;
      if not found then
        insert into public.order_items(order_id,event_id,participant_id,ownership_status,holder_full_name,
          ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status)
        values(v_order.id,v_participant.event_id,p_participant_id,'assigned',v_participant.full_name,
          v_participant.ticket_category_id,v_participant.batch_id,v_participant.shirt_type,v_participant.shirt_size,
          1,v_payment.amount,coalesce(v_payment.discount_amount,0),v_payment.final_amount,'confirmed')
        returning * into v_order_item;
      else
        update public.order_items set status='confirmed',unit_price=v_payment.amount,
          discount_amount=coalesce(v_payment.discount_amount,0),final_amount=v_payment.final_amount
        where id=v_order_item.id;
      end if;

      select id into v_ticket_id from public.tickets where order_item_id=v_order_item.id;
      if v_ticket_id is null then
        select public.confirm_order_item_and_issue_ticket(v_order_item.id) into v_ticket_id;
      end if;
      update public.participants set registration_status='confirmed',updated_at=now()
      where id=p_participant_id;
      v_finalization := 'paid_and_ticket_issued';
    end if;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('imported_participant_issue_finalized','participants',p_participant_id,v_participant.event_id,
    jsonb_build_object('participant_id',p_participant_id,'import_batch_id',v_batch.id,
      'payment_mode_original',coalesce(v_batch.payment_mode_original,'pending'),
      'payment_reason_original',v_batch.payment_reason_original,
      'fields_resolved',coalesce(p_resolved_fields,array[]::text[]),'payment_id',v_payment.id,
      'order_id',v_order.id,'order_item_id',v_order_item.id,'ticket_id',v_ticket_id,
      'actor_user_id',v_actor,'source','participant_issue_resolution','finalization',v_finalization));

  return jsonb_build_object('success',true,'applicable',true,'finalization',v_finalization,
    'payment_id',v_payment.id,'order_id',v_order.id,'order_item_id',v_order_item.id,'ticket_id',v_ticket_id,
    'payment_mode_original',coalesce(v_batch.payment_mode_original,'pending'));
end;
$$;

revoke all on function public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)
  from public,anon,authenticated;
grant execute on function public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)
  to authenticated;

commit;
