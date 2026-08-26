begin;

-- Redesign do cabecalho global / area do usuario (Minha conta) trouxe junto
-- uma regra de negocio faltante: admin_update_ticket_category (RPC criada em
-- 20260905000000) ainda deixa trocar a categoria de um ingresso mesmo depois
-- do pedido estar pago, ou mesmo depois do check-in -- categoria decide o
-- preco/lote do ingresso, entao mudar isso depois desses pontos pode
-- divergir o valor cobrado (ou o kit ja retirado) da categoria "correta",
-- sem nenhum ajuste financeiro/fisico.
--
-- REVISAO (antes de qualquer aplicacao em banco -- nenhuma versao anterior
-- desta migration chegou a ser aplicada): a primeira versao bloqueava
-- olhando exclusivamente orders.status = 'confirmed'. Isso reproduziria,
-- pro bloqueio de categoria, o MESMO bug ja documentado e corrigido pro
-- Dashboard (ver cabecalho de src/lib/dashboard/commercial-status.ts):
-- orders.status/order_items.status podem ficar presos em valores
-- pre-confirmacao mesmo com o pagamento ja liquidado -- confirmado com
-- pedidos reais em producao onde payments.payment_status ja diverge de
-- orders.status por um tempo (ou permanentemente, no caso de
-- apply_gateway_payment_status recebendo um webhook aprovado depois do
-- pedido ja ter expirado/cancelado localmente -- ela marca
-- payments.payment_status='paid' e deliberadamente NAO confirma o pedido,
-- registrando needs_manual_reconciliation). "Pago" aqui usa a MESMA
-- semantica canonica ja estabelecida (resolveCommercialStatus): confirmado
-- se orders.status OU order_items.status = 'confirmed', OU
-- payments.payment_status = 'paid' -- nunca uma definicao nova de "pago".
--
-- Tambem adiciona: (1) bloqueio quando o ingresso ja teve check-in (kit
-- normalmente ja foi retirado atrelado a categoria antiga), e (2) exige
-- motivo textual (p_override_reason) pra qualquer override administrativo
-- pos-pagamento/check-in, seguindo o mesmo padrao ja usado por
-- owner_cancel_ticket/admin_transfer_ticket_ownership (reason_code/
-- reason_text obrigatorios em audit_logs pra correcoes administrativas
-- sensiveis) -- override nunca acontece silenciosamente.
--
-- Escopo desta migration: cobre exclusivamente admin_update_ticket_category
-- (o unico fluxo de troca de categoria acessivel a partir da tela do
-- participante). A auditoria completa encontrou mais dois escritores de
-- order_items.ticket_category_id, ambos tratados separadamente: (1)
-- resolve_import_ticket_options -- fluxo de correcao de importacao que
-- tambem recalcula valores financeiros -- ganha bloqueio proprio (sem
-- override) na migration 20260907000000; (2) o UPDATE direto em
-- assignParticipantCategoryAndBatchAction (src/app/operacoes/actions.ts) --
-- comprovadamente codigo morto (nenhum caller em toda a base) e ja um no-op
-- silencioso hoje por falta de policy de UPDATE em order_items -- foi
-- removido do codigo-fonte em vez de ganhar protecao para um fluxo que
-- ninguem usa.
create or replace function public.admin_update_ticket_category(
  p_ticket_id uuid,
  p_ticket_category_id uuid,
  p_confirm_after_payment boolean default false,
  p_override_reason text default null
)
returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_order_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_payment_status text;
  v_event_id uuid;
  v_previous_category_id uuid;
  v_is_paid boolean := false;
  v_is_checked_in boolean := false;
  v_block_reason text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Usuario sem permissao para alterar a categoria deste ingresso.';
  end if;

  if p_ticket_id is null or p_ticket_category_id is null then
    raise exception 'Ingresso e categoria sao obrigatorios.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id;
  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;
  v_event_id := v_ticket.event_id;

  if v_ticket.order_item_id is null then
    raise exception 'Este ingresso nao possui item de pedido vinculado.';
  end if;

  select * into v_order_item from public.order_items where id = v_ticket.order_item_id for update;
  if not found then
    raise exception 'Item de pedido nao encontrado.';
  end if;
  v_previous_category_id := v_order_item.ticket_category_id;

  if v_ticket.order_id is not null then
    select * into v_order from public.orders where id = v_ticket.order_id;
    if found and v_order.payment_id is not null then
      select payment_status into v_payment_status from public.payments where id = v_order.payment_id;
    end if;
  end if;

  -- Semantica canonica de "pago" (mesma do Dashboard, resolveCommercialStatus
  -- em src/lib/dashboard/commercial-status.ts): nunca confiar so em
  -- orders.status -- payments.payment_status e o sinal mais confiavel.
  v_is_paid := coalesce(v_order.status, '') = 'confirmed'
    or v_order_item.status = 'confirmed'
    or coalesce(v_payment_status, '') = 'paid';
  v_is_checked_in := v_ticket.used_at is not null or v_ticket.status = 'used';

  if v_is_checked_in then
    v_block_reason := 'Este ingresso ja teve check-in realizado.';
  elsif v_is_paid then
    v_block_reason := 'O pagamento deste pedido ja esta confirmado.';
  end if;

  if v_block_reason is not null and not p_confirm_after_payment then
    raise exception '% Alterar a categoria agora exige confirmacao administrativa explicita.', v_block_reason;
  end if;

  if v_block_reason is not null and p_confirm_after_payment
     and nullif(trim(coalesce(p_override_reason, '')), '') is null then
    raise exception 'Informe o motivo da alteracao de categoria pos-pagamento/check-in.';
  end if;

  if not exists (
    select 1 from public.ticket_categories where id = p_ticket_category_id and event_id = v_event_id
  ) then
    raise exception 'Categoria nao pertence ao evento do ingresso.';
  end if;

  update public.order_items
  set ticket_category_id = p_ticket_category_id, updated_at = now()
  where id = v_order_item.id;

  -- Acao de auditoria distingue a causa do override (checkin vs pagamento)
  -- sem perder informacao: was_paid/was_checked_in ficam sempre gravados nos
  -- details, mesmo quando so um dos dois motivou o bloqueio -- e os dois
  -- podem ser true ao mesmo tempo (ingresso com check-in quase sempre tambem
  -- esta pago), caso em que o nome da acao prioriza o motivo mais severo
  -- (checkin) mas o details.was_paid continua registrando o outro sinal.
  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values(
    case
      when v_is_checked_in then 'ticket_category_changed_after_checkin'
      when v_is_paid then 'ticket_category_changed_after_payment'
      else 'ticket_category_changed'
    end,
    'tickets', p_ticket_id, v_event_id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'previous_category_id', v_previous_category_id,
      'ticket_category_id', p_ticket_category_id,
      'order_status', v_order.status,
      'payment_status', v_payment_status,
      'was_paid', v_is_paid,
      'was_checked_in', v_is_checked_in,
      'block_reason', v_block_reason,
      'override_reason', p_override_reason
    )
  );
end;
$$;

revoke all on function public.admin_update_ticket_category(uuid, uuid, boolean, text) from public, anon;
grant execute on function public.admin_update_ticket_category(uuid, uuid, boolean, text) to authenticated, service_role;

-- A assinatura antiga (2 argumentos, criada em 20260905000000) fica orfa
-- apos o create or replace acima criar a nova sobrecarga de 4 argumentos --
-- remove explicitamente pra nao deixar duas versoes coexistindo
-- (Server Action/PostgREST devem chamar sempre a nova).
drop function if exists public.admin_update_ticket_category(uuid, uuid);

commit;
