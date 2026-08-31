-- UX: mostrar a taxa de pagamento JA na selecao da forma de pagamento
-- (Etapa "3. Revisao"), antes de o pedido existir -- hoje a taxa so aparecia
-- depois, na Etapa de Pagamento (get_cart_order_details, que exige um
-- payment_method ja gravado num payment pendente).
--
-- Nao existia nenhuma forma de consultar a taxa sem persistir: as unicas
-- pecas hoje sao _recompute_order_payment_fee (escreve em payments, so roda
-- via apply_cart_coupon/finalize_cart_order_payment -- exige order_id
-- existente) e resolve_event_payment_fee_config/compute_payment_fee (puras,
-- mas exigem 2 chamadas + um valor de installments por metodo, nenhuma
-- pronta pra "me devolva os 3 metodos de uma vez"). Em vez de calcular a
-- taxa em paralelo no frontend (formula duplicada, podendo divergir do
-- backend), esta migration cria um RPC de PREVIEW que reusa EXATAMENTE as
-- mesmas duas funcoes puras ja usadas por _recompute_order_payment_fee --
-- nenhuma tabela e escrita, nenhum payment/PIX e criado so pra calcular.
begin;

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
begin
  if not exists (select 1 from public.events where id = p_event_id) then
    raise exception 'Evento nao encontrado.';
  end if;

  select * into v_pix_config from public.resolve_event_payment_fee_config(p_event_id, 'pix', 1);
  select * into v_pix_fee from public.compute_payment_fee(v_base, v_pix_config.fee_mode, v_pix_config.customer_fee_share_percent, v_pix_config.fixed_fee, v_pix_config.percentage_fee);

  select * into v_single_config from public.resolve_event_payment_fee_config(p_event_id, 'credit_card', 1);
  select * into v_single_fee from public.compute_payment_fee(v_base, v_single_config.fee_mode, v_single_config.customer_fee_share_percent, v_single_config.fixed_fee, v_single_config.percentage_fee);

  -- 2..12: mesmo teto (MAX_INSTALLMENTS) da grade de configuracao do
  -- organizador (src/app/painel/eventos/[id]/payment-methods-manager.tsx) --
  -- 1x usa credit_card_single, nunca entra aqui. Parcela sem linha
  -- configurada resolve fixed/percentage=0 (mesmo default de
  -- resolve_event_payment_fee_config), nunca inventa taxa.
  for v_n in 2..12 loop
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

-- Mesmo nivel de acesso de get_event_payment_methods_setup (20260913000000):
-- config de taxa e publica (a Etapa de Revisao pode ser alcancada antes do
-- login terminar de vincular a conta) -- nada sensivel exposto, so o
-- resultado ja-publico de compute_payment_fee pra um valor informado.
revoke all on function public.preview_event_payment_fees(uuid, numeric) from public;
grant execute on function public.preview_event_payment_fees(uuid, numeric) to anon, authenticated, service_role;

commit;
