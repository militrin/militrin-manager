-- UX do pagamento PIX: botao "Simular pagamento aprovado" na tela publica de
-- checkout, disponivel SOMENTE quando o provider efetivo for 'fake'.
--
-- Substitui o mecanismo antigo (simulatePublicOrderPaymentAction, gate por
-- NODE_ENV, chamando a RPC generica simulate_order_payment_paid) por um
-- caminho que:
--   1) e validado no BANCO (nao so na UI/Server Action) contra o provider
--      REALMENTE persistido no pagamento -- nunca confia em NODE_ENV nem em
--      nenhum parametro vindo do cliente;
--   2) reusa 100% o fluxo canonico ja existente de aplicacao de status de
--      gateway (apply_gateway_payment_status, Fase 1) -- o mesmo caminho que
--      um webhook real da Asaas percorre. Nenhuma logica de emissao de
--      ticket nova, nenhum caminho paralelo: so chama a funcao que ja existe.
--      Isso automaticamente herda toda a idempotencia/guardas ja testadas
--      (retry nao duplica ticket, nao reativa ticket cancelado, etc. --
--      migrations 20260897000000/20260900000000).
create or replace function public.simulate_fake_gateway_payment_paid(p_order_id uuid)
returns table(payment_id uuid, order_id uuid, organization_id uuid, applied_status text)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  if v_actor is null then raise exception 'Usuario autenticado obrigatorio.'; end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  -- Qualificado explicitamente (public.payments.order_id): RETURNS TABLE(...,
  -- order_id uuid, ...) declara "order_id" como variavel PL/pgSQL no escopo
  -- desta funcao, entao uma referencia solta a coluna order_id aqui seria
  -- ambigua entre a coluna da tabela e essa variavel de saida.
  select * into v_payment from public.payments where public.payments.order_id = p_order_id order by created_at desc limit 1;
  if not found then raise exception 'Pagamento nao encontrado para o pedido.'; end if;

  -- Defesa em profundidade: a validacao real de "isto e o provider fake" e
  -- aqui, contra o que esta de fato gravado no pagamento -- nunca confia em
  -- NODE_ENV, em uma flag do cliente, ou na variavel de ambiente do
  -- processo que chamou esta funcao.
  if v_payment.provider is distinct from 'fake' then
    raise exception using errcode='P0001', message='SIMULATION_NOT_ALLOWED',
      detail=jsonb_build_object('code','SIMULATION_NOT_ALLOWED','message','Simulacao de pagamento so e permitida quando o provider da cobranca e fake.')::text;
  end if;
  if v_payment.gateway_payment_id is null then
    raise exception 'Nenhuma cobranca PIX foi gerada para este pedido ainda.';
  end if;

  return query
  select g.payment_id, g.order_id, g.organization_id, g.applied_status
  from public.apply_gateway_payment_status(
    'fake', v_payment.gateway_payment_id, 'SIMULATED_CONFIRMED', 'paid'
  ) g;
end;
$$;

revoke all on function public.simulate_fake_gateway_payment_paid(uuid) from public, anon;
grant execute on function public.simulate_fake_gateway_payment_paid(uuid) to authenticated, service_role;
