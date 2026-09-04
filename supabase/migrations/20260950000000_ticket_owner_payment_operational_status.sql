-- HOTFIX UX Minha Conta: o owner da conta precisa ver o status operacional
-- do pagamento dos tickets que possui (tickets.owner_user_id = auth.uid()),
-- mesmo quando o titular/registration_contact e outra Pessoa.
--
-- Causa: payments_owner_select so libera SELECT quando
-- payments.participant_id.user_id = auth.uid(). Na familia importada, Maria
-- e owner dos 3 tickets, mas so o payment do item dela tem participant
-- vinculado a ela -- João/Pedro ficam invisíveis. A lista então fazia
-- `payment?.payment_status ?? 'pending'` e pintava "Pagamento pendente".
--
-- Nao amplia RLS de payments. Nao devolve PIX, gateway id nem valores.
-- Reusa get_ticket_payment_operational_status (Gate #1) e adiciona um
-- lote somente dos tickets owned pelo ator.

create or replace function public.get_ticket_payment_operational_status(p_ticket_id uuid)
returns table(payment_status text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_order public.orders%rowtype;
  v_is_admin boolean := false;
  v_status text;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id;

  if not found then
    raise exception 'Ingresso invalido ou sem acesso.';
  end if;

  v_is_admin := public.current_user_has_permission('participants.view')
    and public.user_can_access_organization(v_actor, v_ticket.organization_id);

  if v_ticket.owner_user_id is distinct from v_actor and not v_is_admin then
    raise exception 'Ingresso invalido ou sem acesso.';
  end if;

  select * into v_order
  from public.orders
  where id = v_ticket.order_id;

  select p.payment_status into v_status
  from public.payments p
  where p.order_id = v_ticket.order_id
  order by p.created_at desc
  limit 1;

  if v_status is null then
    -- Leitura autorizada sem linha de payment: cortesia/import confirmado
    -- nao pode virar "pendente" por ausencia de SELECT. Espelha o pedido.
    v_status := case
      when v_order.status in ('confirmed', 'paid') then 'paid'
      when v_order.status in ('cancelled', 'canceled') then 'cancelled'
      when v_order.status = 'refunded' then 'refunded'
      when v_order.status in ('pending', 'processing', 'reserved', 'expired') then v_order.status
      when v_order.status is null then 'unknown'
      else v_order.status
    end;
  end if;

  return query select v_status;
end;
$$;

revoke all on function public.get_ticket_payment_operational_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_ticket_payment_operational_status(uuid)
to authenticated;

create or replace function public.get_my_tickets_payment_operational_status()
returns table(ticket_id uuid, payment_status text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;

  return query
  select
    t.id,
    coalesce(
      (
        select p.payment_status
        from public.payments p
        where p.order_id = t.order_id
        order by p.created_at desc
        limit 1
      ),
      case
        when o.status in ('confirmed', 'paid') then 'paid'
        when o.status in ('cancelled', 'canceled') then 'cancelled'
        when o.status = 'refunded' then 'refunded'
        when o.status in ('pending', 'processing', 'reserved', 'expired') then o.status
        when o.status is null then 'unknown'
        else o.status
      end
    )
  from public.tickets t
  left join public.orders o on o.id = t.order_id
  where t.owner_user_id = v_actor;
end;
$$;

revoke all on function public.get_my_tickets_payment_operational_status()
from public, anon, authenticated, service_role;
grant execute on function public.get_my_tickets_payment_operational_status()
to authenticated;
