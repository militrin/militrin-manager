-- 114_optional_loyalty_in_ticket_checkin.sql
-- O banco nao possui public.recalculate_customer_loyalty (fidelidade fora de escopo,
-- ver 028). A 062 tornou a chamada opcional em checkin_participant_entry, mas
-- 065/072/087 recriaram checkin_ticket_entry sem o guard, quebrando check-in e
-- "Entregar kit + check-in" com: function public.recalculate_customer_loyalty(uuid) does not exist.
-- Recria checkin_ticket_entry identica a 087, com a chamada de fidelidade condicional.

begin;

create or replace function public.checkin_ticket_entry(p_ticket_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
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

commit;
