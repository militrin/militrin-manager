-- 078_imported_orders_without_buyer.sql
-- Separa compras de conta de inscricoes importadas sem comprador na plataforma.

begin;

alter table public.orders
  alter column user_id drop not null,
  add column if not exists buyer_type text not null default 'account',
  add column if not exists import_batch_id uuid references public.import_batches(id) on delete restrict;

alter table public.orders
  drop constraint if exists orders_buyer_type_check,
  drop constraint if exists orders_buyer_ownership_check;

alter table public.orders
  add constraint orders_buyer_type_check check (buyer_type in ('account', 'imported_holder')),
  add constraint orders_buyer_ownership_check check (
    (buyer_type = 'account' and user_id is not null and import_batch_id is null)
    or (buyer_type = 'imported_holder' and user_id is null and import_batch_id is not null)
  );

create index if not exists idx_orders_import_batch_id
  on public.orders(import_batch_id) where import_batch_id is not null;

create temporary table imported_order_diagnostic on commit drop as
select distinct on (o.id)
  o.id as order_id,
  o.order_number,
  o.event_id,
  o.participant_id,
  p.full_name as participant_name,
  ph.import_batch_id,
  o.user_id as current_user_id,
  coalesce(cp.full_name, au.raw_user_meta_data ->> 'full_name') as current_user_name,
  lower(au.email) as current_user_email,
  concat(
    'participation_history.source=import; participation_history.import_batch_id=', ph.import_batch_id,
    '; import_batches.import_type=current_event_registrations',
    '; participant_id vinculado ao historico importado',
    '; orders.event_id=import_batches.event_id',
    '; orders.user_id=import_batches.imported_by',
    '; orders.created_at dentro da janela do lote'
  )::text as classification_reason
from public.orders o
join public.participants p
  on p.id = o.participant_id
join public.participation_history ph
  on ph.participant_id = o.participant_id
 and ph.source = 'import'
 and ph.import_batch_id is not null
join public.import_batches ib
  on ib.id = ph.import_batch_id
 and ib.import_type = 'current_event_registrations'
 and ib.event_id = o.event_id
 and ib.imported_by = o.user_id
left join public.customer_profiles cp on cp.user_id = o.user_id
left join auth.users au on au.id = o.user_id
where o.buyer_type = 'account'
  and o.created_at >= ib.created_at
  and o.created_at <= coalesce(ib.completed_at, now());

-- Diagnostico obrigatoriamente emitido antes da correcao.
select
  order_id,
  order_number,
  event_id,
  participant_id,
  participant_name,
  import_batch_id,
  current_user_id,
  current_user_name,
  current_user_email,
  classification_reason
from imported_order_diagnostic
order by order_id;

do $$
declare v_count integer;
begin
  select count(*) into v_count from imported_order_diagnostic;
  raise notice 'Pedidos comprovadamente importados a corrigir: %', v_count;
end $$;

update public.orders o
set user_id = null,
    buyer_type = 'imported_holder',
    import_batch_id = d.import_batch_id
from imported_order_diagnostic d
where o.id = d.order_id;

-- Desvincula o operador apenas quando a identidade do participante diverge da conta.
update public.participants p
set user_id = null, updated_at = now()
from imported_order_diagnostic d
join public.import_batches ib on ib.id = d.import_batch_id
left join public.customer_profiles cp on cp.user_id = ib.imported_by
left join auth.users au on au.id = ib.imported_by
where p.id = d.participant_id
  and p.user_id = ib.imported_by
  and (
    nullif(regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g'), '')
      is distinct from nullif(regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g'), '')
    or lower(nullif(trim(p.email), '')) is distinct from lower(nullif(trim(au.email), ''))
  );

insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
select 'imported_order_buyer_corrected', 'orders', d.order_id, o.event_id,
  jsonb_build_object(
    'imported_by_user_id', ib.imported_by,
    'imported_by_email', lower(au.email),
    'import_batch_id', d.import_batch_id,
    'participant_id', d.participant_id,
    'ticket_id', t.id,
    'source', 'import',
    'order_id', d.order_id,
    'previous_user_id', d.current_user_id,
    'correction_reason', d.classification_reason
  )
from imported_order_diagnostic d
join public.orders o on o.id = d.order_id
join public.import_batches ib on ib.id = d.import_batch_id
left join auth.users au on au.id = ib.imported_by
left join lateral (
  select ticket.id
  from public.tickets ticket
  where ticket.order_id = d.order_id
  order by ticket.issued_at desc
  limit 1
) t on true;

-- Comprador e operador de importacao sao papeis distintos também no RLS.
drop policy if exists "orders_owner_select" on public.orders;
create policy "orders_owner_select"
on public.orders
for select
to authenticated
using (buyer_type = 'account' and auth.uid() = user_id);

create or replace function public.get_operation_buyers(
  p_event_id uuid
)
returns table (
  user_id uuid,
  full_name text,
  cpf text,
  phone text,
  email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_organization_id uuid;
begin
  if v_actor_user_id is null then raise exception 'Usuario nao autenticado.'; end if;

  select e.organization_id into v_organization_id
  from public.events e where e.id = p_event_id;
  if v_organization_id is null then raise exception 'Evento nao encontrado.'; end if;

  if not public.user_can_access_organization(v_actor_user_id, v_organization_id)
    or not (
      public.is_active_owner(v_actor_user_id)
      or public.resolve_user_permission(v_actor_user_id, 'participants.view')
    ) then
    raise exception 'Usuario sem permissao para consultar compradores deste evento.';
  end if;

  return query
  select distinct cp.user_id, cp.full_name, cp.cpf, cp.phone, lower(au.email)
  from public.orders o
  join public.customer_profiles cp on cp.user_id = o.user_id
  join auth.users au on au.id = o.user_id
  where o.event_id = p_event_id
    and o.buyer_type = 'account';
end;
$$;

revoke all on function public.get_operation_buyers(uuid) from public, anon, authenticated;
grant execute on function public.get_operation_buyers(uuid) to authenticated;

create or replace function public.create_imported_order_and_issue_ticket(
  p_participant_id uuid,
  p_import_batch_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_email text;
  v_batch public.import_batches%rowtype;
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_order_id uuid;
  v_order_item_id uuid;
  v_ticket_id uuid;
  v_previous_user_id uuid;
begin
  if v_actor_user_id is null then raise exception 'Usuario nao autenticado.'; end if;

  select * into v_batch from public.import_batches where id = p_import_batch_id for update;
  if not found or v_batch.import_type <> 'current_event_registrations' then
    raise exception 'Lote de importacao de inscritos invalido.';
  end if;
  if v_batch.imported_by <> v_actor_user_id then
    raise exception 'Somente o operador do lote pode emitir seus ingressos importados.';
  end if;

  select * into v_participant from public.participants where id = p_participant_id for update;
  if not found or v_participant.event_id is distinct from v_batch.event_id then
    raise exception 'Participante nao pertence ao evento do lote.';
  end if;

  select * into v_payment from public.payments
  where participant_id = p_participant_id order by created_at desc limit 1 for update;
  if not found then raise exception 'Pagamento do participante nao encontrado.'; end if;

  select o.id, o.user_id into v_order_id, v_previous_user_id
  from public.orders o
  where o.participant_id = v_participant.id
    and o.event_id = v_batch.event_id
    and o.user_id = v_actor_user_id
    and o.buyer_type = 'account'
    and o.created_at >= v_batch.created_at
    and o.created_at <= coalesce(v_batch.completed_at, now())
  order by o.created_at desc
  limit 1
  for update;

  if v_order_id is null then
    insert into public.orders (
      user_id, participant_id, event_id, payment_id, order_number, status,
      base_amount, discount_amount, final_amount, buyer_type, import_batch_id, confirmed_at
    ) values (
      null, v_participant.id, v_participant.event_id, v_payment.id, public.generate_order_number(),
      case when v_payment.payment_status = 'paid' then 'confirmed' else 'pending' end,
      coalesce(v_payment.amount, 0), coalesce(v_payment.discount_amount, 0),
      coalesce(v_payment.final_amount, v_payment.amount, 0), 'imported_holder', v_batch.id,
      case when v_payment.payment_status = 'paid' then now() else null end
    ) returning id into v_order_id;
  else
    update public.orders
    set user_id = null,
        buyer_type = 'imported_holder',
        import_batch_id = v_batch.id
    where id = v_order_id;
  end if;

  update public.payments set order_id = v_order_id where id = v_payment.id;

  -- create_registration pode ter vinculado o operador ao participante.
  -- Mantem o vinculo somente quando CPF e e-mail realmente identificam a mesma conta.
  update public.participants p
  set user_id = null, updated_at = now()
  where p.id = v_participant.id
    and p.user_id = v_actor_user_id
    and (
      nullif(regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g'), '')
        is distinct from (
          select nullif(regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g'), '')
          from public.customer_profiles cp where cp.user_id = v_actor_user_id
        )
      or lower(nullif(trim(p.email), '')) is distinct from (
          select lower(nullif(trim(au.email), ''))
          from auth.users au where au.id = v_actor_user_id
        )
    );

  select oi.id into v_order_item_id
  from public.order_items oi
  where oi.order_id = v_order_id
  order by oi.created_at asc
  limit 1
  for update;

  if v_order_item_id is null then
    insert into public.order_items (
    order_id, event_id, participant_id, ownership_status, holder_full_name,
    ticket_category_id, batch_id, shirt_type, shirt_size, quantity,
    unit_price, discount_amount, final_amount, status, reservation_expires_at
  ) values (
    v_order_id, v_participant.event_id, v_participant.id, 'assigned', v_participant.full_name,
    v_participant.ticket_category_id, v_participant.batch_id, v_participant.shirt_type,
    v_participant.shirt_size, 1, coalesce(v_payment.amount, 0),
    coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount, 0),
    case when v_payment.payment_status = 'paid' then 'confirmed' else 'reserved' end,
    v_participant.reservation_expires_at
    ) returning id into v_order_item_id;
  end if;

  if v_payment.payment_status = 'paid' then
    select t.id into v_ticket_id
    from public.tickets t
    where t.order_item_id = v_order_item_id
    limit 1;

    if v_ticket_id is null then
      select public.confirm_order_item_and_issue_ticket(v_order_item_id) into v_ticket_id;
    end if;
  end if;

  select lower(email) into v_actor_email from auth.users where id = v_actor_user_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('imported_registration_order_created', 'orders', v_order_id, v_participant.event_id,
    jsonb_build_object(
      'imported_by_user_id', v_actor_user_id,
      'imported_by_email', v_actor_email,
      'import_batch_id', v_batch.id,
      'participant_id', v_participant.id,
      'ticket_id', v_ticket_id,
      'order_id', v_order_id,
      'previous_user_id', v_previous_user_id,
      'source', 'import',
      'correction_reason', case
        when v_previous_user_id is null then 'pedido criado sem comprador para inscricao importada'
        else 'operador do lote removido da propriedade do pedido importado'
      end
    ));

  return v_ticket_id;
end;
$$;

revoke all on function public.create_imported_order_and_issue_ticket(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_imported_order_and_issue_ticket(uuid, uuid) to authenticated;

commit;
