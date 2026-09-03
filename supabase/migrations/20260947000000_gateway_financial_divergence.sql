begin;

-- Release Gate #1: divergência financeira de gateway.
-- Separada das migrations 45 (PIX/emissão) e 46 (lease de webhook) de propósito:
-- esta migration trata somente a visibilidade operacional de eventos de pagamento
-- do gateway que chegaram mas não puderam ser correlacionados a um pagamento local.
--
-- Princípios:
-- - NÃO emite ingresso automaticamente sem correlação segura
-- - NÃO expõe PII/PIX desnecessário (payload já sanitizado em migration 45/webhook)
-- - Visível ao administrador (finance.confirm_payment ou integrity.view)
-- - Fornece caminho operacional para investigação
-- - Deixa audit trail via payment_gateway_events.last_error + processing_status
-- - Isolado por organização quando possível; quando orphan (org_id null), visível
--   apenas para service_role e roles com permissão explícita

-- ============================================================
-- 1. Ampliar o CHECK de processing_status para incluir 'financial_divergence'
-- ============================================================

alter table public.payment_gateway_events
  drop constraint if exists payment_gateway_events_processing_status_check;

alter table public.payment_gateway_events
  add constraint payment_gateway_events_processing_status_check
    check (processing_status in (
      'received',
      'processing',
      'processed',
      'failed',
      'ignored',
      'financial_divergence'
    ));

comment on column public.payment_gateway_events.processing_status is
  'received: aguardando processamento. processing: em processamento (lease ativo). '
  'processed: processado com sucesso e correlacionado a um payment local. '
  'failed: erro de processamento (elegível para retry). '
  'ignored: evento conhecido mas irrelevante (ex: evento de provider sem payment_id). '
  'financial_divergence: pagamento confirmado pelo gateway sem correlação local — '
  'dinheiro recebido sem pedido associável. Requer investigação manual.';

-- ============================================================
-- 2. Índice para acesso rápido às divergências
-- ============================================================

create index if not exists idx_payment_gateway_events_financial_divergence
  on public.payment_gateway_events (received_at desc)
  where processing_status = 'financial_divergence';

-- ============================================================
-- 3. RPC de listagem para o painel de integridade
--    Mostra somente o necessário: provider, provider_payment_id, horário,
--    event_type, last_error.
--    NÃO expõe: payload completo, CPF, PIX copia-e-cola, segredo.
-- ============================================================

create or replace function public.list_gateway_financial_divergences()
returns table(
  id             uuid,
  provider       text,
  provider_payment_id text,
  event_type     text,
  received_at    timestamptz,
  last_error     text
)
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    e.id,
    e.provider,
    e.provider_payment_id,
    e.event_type,
    e.received_at,
    e.last_error
  from public.payment_gateway_events e
  where e.processing_status = 'financial_divergence'
  order by e.received_at desc
  limit 200;
$$;

-- Apenas roles administrativas (via service_role no server action autenticado)
revoke all on function public.list_gateway_financial_divergences() from public, anon, authenticated;
grant execute on function public.list_gateway_financial_divergences() to service_role;

comment on function public.list_gateway_financial_divergences() is
  'Lista eventos de pagamento do gateway com status financial_divergence: '
  'pagamentos confirmados pelo gateway sem correlação local. '
  'NÃO expõe payload completo, CPF, PIX copia-e-cola ou segredos. '
  'Acesso restrito a service_role (chamado via server action com permissão finance.confirm_payment ou integrity.view).';

-- ============================================================
-- 4. Atualizar mark_payment_gateway_event_processed para aceitar
--    'financial_divergence' como status terminal válido.
--    A função original valida p_status contra uma lista fixada;
--    recriamos com a lista estendida, mesma ACL.
-- ============================================================

create or replace function public.mark_payment_gateway_event_processed(
  p_event_id        uuid,
  p_status          text,
  p_organization_id uuid default null,
  p_error           text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_status not in ('processed', 'failed', 'ignored', 'financial_divergence') then
    raise exception 'Status de processamento invalido.';
  end if;

  update public.payment_gateway_events
  set processing_status = p_status,
      processed_at      = now(),
      attempt_count     = attempt_count + 1,
      organization_id   = coalesce(p_organization_id, organization_id),
      last_error        = p_error
  where id = p_event_id;
end;
$$;

revoke all on function public.mark_payment_gateway_event_processed(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_payment_gateway_event_processed(uuid, text, uuid, text)
  to service_role;

comment on function public.mark_payment_gateway_event_processed(uuid, text, uuid, text) is
  'Fecha o ciclo de processamento de um evento de gateway. '
  'Status válidos: processed, failed, ignored, financial_divergence. '
  'financial_divergence = pagamento confirmado pelo gateway sem correlação local — '
  'requer investigação manual, visível no painel de Integridade.';

commit;
