-- Limite maximo de parcelas no cartao, por evento.
--
-- Diagnostico: nao existia campo equivalente. O teto era hardcoded 12
-- (preview_event_payment_fees 2..12, wizard Math.min(12), grade admin
-- MAX_INSTALLMENTS=12). Asaas hosted checkout usa POST /payments com
-- installmentCount EXATO (nao Payment Link / maxInstallmentCount): o
-- Militrin so envia o numero escolhido, entao o gateway nao oferece
-- mais parcelas do que o backend gravou na cobranca.
--
-- Default 12 materializa o comportamento atual em eventos existentes
-- (Militrin 2026, Esquenta Militrin e demais) sem mudar o limite deles.
begin;

alter table public.events
  add column if not exists max_card_installments integer not null default 12;

alter table public.events drop constraint if exists events_max_card_installments_check;
alter table public.events add constraint events_max_card_installments_check
  check (max_card_installments >= 1 and max_card_installments <= 12);

comment on column public.events.max_card_installments is
  'Maximo de parcelas no cartao para ingresso/pacote deste evento (1=somente a vista, ate 12=teto do gateway Asaas). Default 12 preserva o checkout atual. Vale na criacao de uma NOVA cobranca; pagamentos ja existentes nao sao alterados.';

-- ============================================================
-- Fonte de verdade no banco: rejeita (nao reduz) qualquer tentativa
-- acima do limite do evento.
-- ============================================================
create or replace function public.assert_card_installments_allowed(
  p_event_id uuid,
  p_installments integer
) returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested integer := greatest(coalesce(p_installments, 1), 1);
  v_allowed integer;
begin
  if p_event_id is null then
    raise exception 'Evento invalido.';
  end if;

  select least(greatest(coalesce(max_card_installments, 12), 1), 12)
    into v_allowed
  from public.events
  where id = p_event_id;

  if v_allowed is null then
    raise exception 'Evento nao encontrado.';
  end if;

  if v_requested > v_allowed then
    raise exception 'Este evento permite pagamento em até %x.', v_allowed;
  end if;

  return v_requested;
end;
$$;

revoke all on function public.assert_card_installments_allowed(uuid, integer) from public, anon;
grant execute on function public.assert_card_installments_allowed(uuid, integer) to authenticated, service_role;

-- ============================================================
-- Preview: so devolve opcoes 2..max do evento. 1x continua em
-- credit_card_single. Evento com max=1 nao oferece parcelado.
-- ============================================================
create or replace function public.preview_event_payment_fees(
  p_event_id uuid,
  p_base_amount numeric
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base numeric := greatest(coalesce(p_base_amount, 0), 0);
  v_pix_config record;
  v_pix_fee record;
  v_single_config record;
  v_single_fee record;
  v_n integer;
  v_cfg record;
  v_fee record;
  v_installments_options jsonb := '[]'::jsonb;
  v_max integer := 12;
begin
  if not exists (select 1 from public.events where id = p_event_id) then
    raise exception 'Evento nao encontrado.';
  end if;

  select least(greatest(coalesce(max_card_installments, 12), 1), 12)
    into v_max
  from public.events
  where id = p_event_id;

  select * into v_pix_config from public.resolve_event_payment_fee_config(p_event_id, 'pix', 1);
  select * into v_pix_fee from public.compute_payment_fee(v_base, v_pix_config.fee_mode, v_pix_config.customer_fee_share_percent, v_pix_config.fixed_fee, v_pix_config.percentage_fee);

  select * into v_single_config from public.resolve_event_payment_fee_config(p_event_id, 'credit_card', 1);
  select * into v_single_fee from public.compute_payment_fee(v_base, v_single_config.fee_mode, v_single_config.customer_fee_share_percent, v_single_config.fixed_fee, v_single_config.percentage_fee);

  -- 1x usa credit_card_single, nunca entra aqui. Loop ate o teto do evento
  -- (nunca acima de 12, teto do gateway atual).
  if v_max >= 2 then
    for v_n in 2..v_max loop
      select * into v_cfg from public.resolve_event_payment_fee_config(p_event_id, 'credit_card', v_n);
      select * into v_fee from public.compute_payment_fee(v_base, v_cfg.fee_mode, v_cfg.customer_fee_share_percent, v_cfg.fixed_fee, v_cfg.percentage_fee);
      v_installments_options := v_installments_options || jsonb_build_object(
        'installments', v_n,
        'fee_mode', v_cfg.fee_mode,
        'calculated_fee', v_fee.calculated_fee,
        'customer_fee', v_fee.customer_fee,
        'organizer_fee', v_fee.organizer_fee
      );
    end loop;
  end if;

  return jsonb_build_object(
    'base_amount', v_base,
    'pix', jsonb_build_object(
      'fee_mode', v_pix_config.fee_mode,
      'calculated_fee', v_pix_fee.calculated_fee,
      'customer_fee', v_pix_fee.customer_fee,
      'organizer_fee', v_pix_fee.organizer_fee
    ),
    'credit_card_single', jsonb_build_object(
      'fee_mode', v_single_config.fee_mode,
      'calculated_fee', v_single_fee.calculated_fee,
      'customer_fee', v_single_fee.customer_fee,
      'organizer_fee', v_single_fee.organizer_fee
    ),
    'credit_card_installments', jsonb_build_object('options', v_installments_options)
  );
end;
$$;

revoke all on function public.preview_event_payment_fees(uuid, numeric) from public;
grant execute on function public.preview_event_payment_fees(uuid, numeric) to anon, authenticated, service_role;

-- ============================================================
-- finalize_cart_order_payment: mesma assinatura vigente
-- (20260913000000). Unica mudanca: assert_card_installments_allowed
-- antes de gravar installments no cartao.
-- ============================================================
create or replace function public.finalize_cart_order_payment(p_order_id uuid, p_payment_method text, p_installments integer default 1)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_payment public.payments%rowtype;
  v_status text; v_item record; v_method text := trim(coalesce(p_payment_method, ''));
  v_installments integer := greatest(coalesce(p_installments, 1), 1);
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido ja foi finalizado.'; end if;
  if not exists(select 1 from public.order_items where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')) then
    raise exception 'Carrinho vazio.';
  end if;
  if lower(v_method) not in ('pix','credit_card','cash','courtesy') then
    raise exception 'Forma de pagamento invalida.';
  end if;

  if lower(v_method) = 'credit_card' then
    v_installments := public.assert_card_installments_allowed(v_order.event_id, v_installments);
  end if;

  select * into v_payment from public.payments where order_id = p_order_id order by created_at desc limit 1 for update;
  if not found then raise exception 'Pagamento nao encontrado para o pedido.'; end if;

  update public.payments set
    payment_method = lower(v_method),
    installments = case when lower(v_method) = 'credit_card' then v_installments else null end,
    updated_at = now()
  where id = v_payment.id;

  perform public._recompute_order_payment_fee(p_order_id);

  select * into v_payment from public.payments where id = v_payment.id;

  v_status := case when lower(v_method) = 'courtesy' or v_payment.final_amount <= 0 then 'paid' else 'pending' end;

  update public.payments set payment_status = v_status,
    paid_at = case when v_status = 'paid' then coalesce(paid_at, now()) end, updated_at = now()
  where id = v_payment.id;

  update public.orders set status = case when v_status = 'paid' then 'confirmed' else 'pending' end,
    confirmed_at = case when v_status = 'paid' then coalesce(confirmed_at, now()) else confirmed_at end
  where id = p_order_id;

  if v_status = 'paid' then
    for v_item in select id from public.order_items where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred') loop
      perform public.confirm_order_item_and_issue_ticket(v_item.id);
    end loop;
  end if;

  return jsonb_build_object('order_id', p_order_id, 'payment_status', v_status, 'final_amount', v_payment.final_amount);
end; $$;

revoke all on function public.finalize_cart_order_payment(uuid,text,integer) from public,anon;
grant execute on function public.finalize_cart_order_payment(uuid,text,integer) to authenticated,service_role;

-- ============================================================
-- get_event_payment_methods_setup: return type muda (coluna nova),
-- DROP explicito para nao deixar overload velho ao lado.
-- ============================================================
drop function if exists public.get_event_payment_methods_setup(uuid);

create or replace function public.get_event_payment_methods_setup(p_event_id uuid)
returns table(
  event_id uuid, pix_enabled boolean, credit_card_single_enabled boolean, credit_card_installments_enabled boolean,
  pix_fee_mode text, pix_fee_fixed_amount numeric, pix_fee_percentage numeric, pix_customer_fee_share_percent numeric,
  credit_card_single_fee_mode text, credit_card_single_fee_fixed_amount numeric, credit_card_single_fee_percentage numeric, credit_card_single_customer_fee_share_percent numeric,
  credit_card_installments_fee_mode text, credit_card_installments_customer_fee_share_percent numeric,
  installment_fees jsonb,
  max_card_installments integer
)
    language sql stable security definer
    set search_path to 'public', 'pg_temp'
    as $$
  select
    e.id as event_id,
    coalesce(epm.pix_enabled, true), coalesce(epm.credit_card_single_enabled, true), coalesce(epm.credit_card_installments_enabled, true),
    coalesce(epm.pix_fee_mode, 'absorb'), coalesce(epm.pix_fee_fixed_amount, 0), coalesce(epm.pix_fee_percentage, 0), coalesce(epm.pix_customer_fee_share_percent, 0),
    coalesce(epm.credit_card_single_fee_mode, 'absorb'), coalesce(epm.credit_card_single_fee_fixed_amount, 0), coalesce(epm.credit_card_single_fee_percentage, 0), coalesce(epm.credit_card_single_customer_fee_share_percent, 0),
    coalesce(epm.credit_card_installments_fee_mode, 'absorb'), coalesce(epm.credit_card_installments_customer_fee_share_percent, 0),
    coalesce((
      select jsonb_agg(jsonb_build_object('installments', f.installments, 'fixed_fee', f.fixed_fee, 'percentage_fee', f.percentage_fee) order by f.installments)
      from public.event_payment_method_installment_fees f
      where f.event_id = e.id
    ), '[]'::jsonb),
    least(greatest(coalesce(e.max_card_installments, 12), 1), 12)
  from public.events e
  left join public.event_payment_methods epm on epm.event_id = e.id
  where e.id = p_event_id;
$$;

revoke all on function public.get_event_payment_methods_setup(uuid) from public;
grant execute on function public.get_event_payment_methods_setup(uuid) to anon, authenticated, service_role;

-- ============================================================
-- upsert_event_payment_methods: ganha p_max_card_installments
-- (arity muda -- DROP da assinatura vigente 20260913000000).
-- ============================================================
drop function if exists public.upsert_event_payment_methods(uuid, boolean, boolean, boolean, text, numeric, numeric, numeric, text, numeric, numeric, numeric, text, numeric, jsonb);

create or replace function public.upsert_event_payment_methods(
  p_event_id uuid,
  p_pix_enabled boolean default true,
  p_credit_card_single_enabled boolean default true,
  p_credit_card_installments_enabled boolean default true,
  p_pix_fee_mode text default 'absorb',
  p_pix_fee_fixed_amount numeric default 0,
  p_pix_fee_percentage numeric default 0,
  p_pix_customer_fee_share_percent numeric default 0,
  p_credit_card_single_fee_mode text default 'absorb',
  p_credit_card_single_fee_fixed_amount numeric default 0,
  p_credit_card_single_fee_percentage numeric default 0,
  p_credit_card_single_customer_fee_share_percent numeric default 0,
  p_credit_card_installments_fee_mode text default 'absorb',
  p_credit_card_installments_customer_fee_share_percent numeric default 0,
  p_installment_fees jsonb default '[]'::jsonb,
  p_max_card_installments integer default 12
) returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_org uuid;
  v_row jsonb;
  v_installments integer;
  v_max integer := coalesce(p_max_card_installments, 12);
begin
  if p_event_id is null then
    raise exception 'Evento invalido.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  if not coalesce(p_pix_enabled, false)
     and not coalesce(p_credit_card_single_enabled, false)
     and not coalesce(p_credit_card_installments_enabled, false) then
    raise exception 'Selecione pelo menos uma forma de pagamento.';
  end if;

  if v_max < 1 or v_max > 12 then
    raise exception 'O maximo de parcelas no cartao deve ser entre 1x e 12x.';
  end if;

  if coalesce(p_pix_fee_mode, 'absorb') not in ('absorb','pass_through','split')
     or coalesce(p_credit_card_single_fee_mode, 'absorb') not in ('absorb','pass_through','split')
     or coalesce(p_credit_card_installments_fee_mode, 'absorb') not in ('absorb','pass_through','split') then
    raise exception 'Modo de taxa invalido.';
  end if;

  update public.events
    set max_card_installments = v_max, updated_at = now()
    where id = p_event_id;

  insert into public.event_payment_methods (
    event_id, pix_enabled, credit_card_single_enabled, credit_card_installments_enabled,
    pix_fee_mode, pix_fee_fixed_amount, pix_fee_percentage, pix_customer_fee_share_percent,
    credit_card_single_fee_mode, credit_card_single_fee_fixed_amount, credit_card_single_fee_percentage, credit_card_single_customer_fee_share_percent,
    credit_card_installments_fee_mode, credit_card_installments_customer_fee_share_percent,
    created_at, updated_at
  )
  values (
    p_event_id, coalesce(p_pix_enabled, true), coalesce(p_credit_card_single_enabled, true),
    coalesce(p_credit_card_installments_enabled, true),
    coalesce(p_pix_fee_mode, 'absorb'), coalesce(p_pix_fee_fixed_amount, 0), coalesce(p_pix_fee_percentage, 0), coalesce(p_pix_customer_fee_share_percent, 0),
    coalesce(p_credit_card_single_fee_mode, 'absorb'), coalesce(p_credit_card_single_fee_fixed_amount, 0), coalesce(p_credit_card_single_fee_percentage, 0), coalesce(p_credit_card_single_customer_fee_share_percent, 0),
    coalesce(p_credit_card_installments_fee_mode, 'absorb'), coalesce(p_credit_card_installments_customer_fee_share_percent, 0),
    now(), now()
  )
  on conflict (event_id) do update set
    pix_enabled = excluded.pix_enabled,
    credit_card_single_enabled = excluded.credit_card_single_enabled,
    credit_card_installments_enabled = excluded.credit_card_installments_enabled,
    pix_fee_mode = excluded.pix_fee_mode,
    pix_fee_fixed_amount = excluded.pix_fee_fixed_amount,
    pix_fee_percentage = excluded.pix_fee_percentage,
    pix_customer_fee_share_percent = excluded.pix_customer_fee_share_percent,
    credit_card_single_fee_mode = excluded.credit_card_single_fee_mode,
    credit_card_single_fee_fixed_amount = excluded.credit_card_single_fee_fixed_amount,
    credit_card_single_fee_percentage = excluded.credit_card_single_fee_percentage,
    credit_card_single_customer_fee_share_percent = excluded.credit_card_single_customer_fee_share_percent,
    credit_card_installments_fee_mode = excluded.credit_card_installments_fee_mode,
    credit_card_installments_customer_fee_share_percent = excluded.credit_card_installments_customer_fee_share_percent,
    updated_at = now();

  delete from public.event_payment_method_installment_fees where event_id = p_event_id;
  if jsonb_typeof(p_installment_fees) = 'array' then
    for v_row in select * from jsonb_array_elements(p_installment_fees)
    loop
      v_installments := (v_row ->> 'installments')::integer;
      if v_installments is not null and v_installments >= 1 then
        insert into public.event_payment_method_installment_fees (event_id, installments, fixed_fee, percentage_fee, updated_at)
        values (p_event_id, v_installments, coalesce((v_row ->> 'fixed_fee')::numeric, 0), coalesce((v_row ->> 'percentage_fee')::numeric, 0), now())
        on conflict (event_id, installments) do update set
          fixed_fee = excluded.fixed_fee, percentage_fee = excluded.percentage_fee, updated_at = now();
      end if;
    end loop;
  end if;
end;
$$;

revoke all on function public.upsert_event_payment_methods(uuid, boolean, boolean, boolean, text, numeric, numeric, numeric, text, numeric, numeric, numeric, text, numeric, jsonb, integer) from public;
grant execute on function public.upsert_event_payment_methods(uuid, boolean, boolean, boolean, text, numeric, numeric, numeric, text, numeric, numeric, numeric, text, numeric, jsonb, integer) to authenticated, service_role;

commit;
