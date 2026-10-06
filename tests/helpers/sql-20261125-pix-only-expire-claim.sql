-- Copia operacional das funcoes PIX-only da 20261124/20261125.
-- Uso: provar worker NOVO + banco antigo (Fase A). Nao e migration.

begin;

create or replace function public.expire_stale_order_payments(p_organization_id uuid default null)
returns integer
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_payment public.payments%rowtype;
  v_count integer := 0;
  v_needs_gateway boolean := false;
begin
  if v_actor is not null then
    if p_organization_id is null then
      raise exception 'organization_id obrigatorio para execucao manual.';
    end if;
    if not (public.current_user_has_permission('orders.cancel') and public.user_can_access_organization(v_actor, p_organization_id)) then
      raise exception 'Sem permissao para expirar pedidos desta organizacao.';
    end if;
  end if;

  for v_payment in
    select p.* from public.payments p
    where p.payment_status = 'pending'
      and p.order_id is not null
      and lower(coalesce(p.payment_method, 'pix')) = 'pix'
      and public.is_short_checkout_hold(p.created_at, p.expires_at)
      and public.checkout_hold_expires_at(p.created_at, p.expires_at) <= now()
      and (p_organization_id is null or p.organization_id = p_organization_id)
    order by p.created_at
    for update skip locked
  loop
    v_needs_gateway := coalesce(v_payment.provider, '') = 'asaas'
      and nullif(trim(coalesce(v_payment.gateway_payment_id, '')), '') is not null;

    if v_needs_gateway then
      if v_payment.pending_cancel_provider_payment_id is null then
        update public.payments
        set pending_cancel_provider = v_payment.provider,
            pending_cancel_provider_payment_id = v_payment.gateway_payment_id,
            updated_at = now()
        where id = v_payment.id;
        insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
        values (
          'payment_expiration_pending_cancel',
          'payments',
          v_payment.id,
          v_payment.event_id,
          jsonb_build_object(
            'order_id', v_payment.order_id,
            'gateway_payment_id', v_payment.gateway_payment_id,
            'provider', v_payment.provider
          )
        );
        v_count := v_count + 1;
      end if;
      continue;
    end if;

    perform public._apply_terminal_order_payment_status(v_payment.id, 'expired');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_order_payments(uuid) from public;
grant execute on function public.expire_stale_order_payments(uuid) to authenticated, service_role;

create or replace function public.claim_expired_pix_cancellations(
  p_limit integer default 20,
  p_organization_id uuid default null
)
returns table(
  payment_id uuid,
  organization_id uuid,
  provider text,
  provider_payment_id text,
  gateway_account_key text,
  order_id uuid
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  return query
  with picked as (
    select p.id
    from public.payments p
    where p.payment_status = 'pending'
      and p.pending_cancel_provider_payment_id is not null
      and lower(coalesce(p.payment_method, 'pix')) = 'pix'
      and coalesce(p.provider, '') = 'asaas'
      and (p.expiration_lease_until is null or p.expiration_lease_until < now())
      and (p_organization_id is null or p.organization_id = p_organization_id)
    order by coalesce(p.expiration_last_attempt_at, p.created_at)
    for update skip locked
    limit greatest(coalesce(p_limit, 20), 1)
  )
  update public.payments pay
  set expiration_lease_until = now() + interval '60 seconds',
      expiration_last_attempt_at = now(),
      expiration_attempt_count = coalesce(pay.expiration_attempt_count, 0) + 1,
      updated_at = now()
  from picked
  where pay.id = picked.id
  returning
    pay.id,
    pay.organization_id,
    pay.pending_cancel_provider,
    pay.pending_cancel_provider_payment_id,
    pay.gateway_account_key,
    pay.order_id;
end;
$$;

revoke all on function public.claim_expired_pix_cancellations(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_expired_pix_cancellations(integer, uuid) to service_role;

commit;
