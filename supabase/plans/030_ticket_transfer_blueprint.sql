/*
==================================================

TICKET TRANSFER BLUEPRINT

Este arquivo NAO e uma migration.

Objetivo:

Planejar a transferencia oficial de ingresso
com seguranca, rastreabilidade e sem duplicacao.

Status:
PLANEJAMENTO

Nao executar.

==================================================
*/

-- Blueprint only: DO NOT APPLY in current sprint.
-- Scope: arquitetura futura da transferencia oficial.
-- Dependency: order_items e pagamento real ja implementados.

-- ==================================================
-- 1) PRE-REQUISITOS DE ORDEM DE ENTREGA
-- ==================================================
-- 1. Finalizar compra unitaria.
-- 2. Implementar multiplos ingressos e order_items.
-- 3. Integrar Mercado Pago real.
-- 4. Implementar transferencia oficial de ingresso.  <-- este plano
-- 5. Implementar pulseiras.
-- 6. Finalizar check-in e retirada.

-- ==================================================
-- 2) CONFIGURACAO POR EVENTO (FUTURO)
-- ==================================================
-- Opcao A: colunas diretas em public.events
-- ticket_transfer_enabled boolean not null default false
-- ticket_transfer_deadline timestamptz
-- ticket_transfer_limit_per_ticket integer not null default 1
-- ticket_transfer_fee numeric(10,2) not null default 0
-- ticket_transfer_requires_approval boolean not null default false
-- kit_change_deadline timestamptz
--
-- Opcao B (preferida para evolucao): tabela event_settings/event_transfer_rules
-- para evitar inflar events com regras operacionais.

-- ==================================================
-- 3) ESTRUTURA PRINCIPAL (FUTURA)
-- ==================================================
-- Importante: a transferencia deve ser vinculada a order_item/ticket,
-- nunca ao pedido inteiro.

-- create table public.ticket_transfers (
--   id uuid primary key default gen_random_uuid(),
--   event_id uuid not null references public.events(id),
--   order_item_id uuid references public.order_items(id),
--   source_ticket_id uuid not null references public.tickets(id),
--   new_ticket_id uuid references public.tickets(id),
--   from_user_id uuid not null references auth.users(id),
--   to_user_id uuid references auth.users(id),
--   recipient_name text not null,
--   recipient_cpf text not null,
--   recipient_email text not null,
--   status text not null default 'pending',
--   fee_amount numeric(10,2) not null default 0,
--   expires_at timestamptz,
--   accepted_at timestamptz,
--   completed_at timestamptz,
--   cancelled_at timestamptz,
--   created_at timestamptz not null default now(),
--   updated_at timestamptz not null default now(),
--   constraint ticket_transfers_status_check check (
--     status in ('pending', 'awaiting_payment', 'awaiting_acceptance', 'completed', 'rejected', 'expired', 'cancelled')
--   )
-- );

-- Indices recomendados (futuros):
-- idx_ticket_transfers_event_id
-- idx_ticket_transfers_source_ticket_id
-- idx_ticket_transfers_order_item_id
-- idx_ticket_transfers_status
-- idx_ticket_transfers_recipient_cpf
-- idx_ticket_transfers_recipient_email

-- ==================================================
-- 4) REGRAS DE NEGOCIO (FUTURAS)
-- ==================================================
-- A transferencia so pode ocorrer quando:
-- - pedido confirmado e nao reembolsado/cancelado
-- - ticket ativo
-- - agora < ticket_transfer_deadline
-- - check-in nao realizado
-- - pulseira nao vinculada/entregue (ou liberacao administrativa explicita)
-- - limite de transferencias por ticket nao atingido
-- - itens de kit ja entregues nao permitem nova transferencia
--
-- CPF destino:
-- - validar CPF
-- - bloquear conflito de regra de evento (ingresso incompatível)

-- ==================================================
-- 5) FLUXO TRANSACIONAL (FUTURO)
-- ==================================================
-- 1. Owner inicia solicitacao.
-- 2. Sistema valida regras de elegibilidade.
-- 3. Cria ticket_transfers em pending/awaiting_payment/awaiting_acceptance.
-- 4. Se houver taxa, cobrar e confirmar pagamento da transferencia.
-- 5. Destinatario aceita (conta existente ou convite + criacao de conta).
-- 6. Em transacao atomica:
--    a) invalidar ticket antigo (status = transferred/cancelled por transferencia)
--    b) emitir novo ticket com novo token
--    c) manter mesmo order_item_id
--    d) atualizar participante responsavel do item
--    e) registrar historico e auditoria
-- 7. Concluir ticket_transfers como completed.

-- ==================================================
-- 6) SEGURANCA E ANTIDUPLICACAO (FUTURO)
-- ==================================================
-- Nunca sobrescrever apenas nome no ticket existente.
-- Token antigo deve ser invalidado de forma definitiva.
-- A troca deve ser idempotente por transfer_request_id.
-- Bloquear duas transferencias simultaneas para o mesmo source_ticket_id.

-- ==================================================
-- 7) PULSEIRA E CHECK-IN (FUTURO)
-- ==================================================
-- Quando pulseiras existirem:
-- - bloquear transferencia apos vinculacao/entrega,
--   ou exigir cancelamento administrativo previo.
-- - nunca transferir pulseira fisica entregue automaticamente.
--
-- Check-in e retirada nao devem depender obrigatoriamente da pulseira.

-- ==================================================
-- 8) AUDITORIA (FUTURA)
-- ==================================================
-- Registrar em trilha imutavel:
-- - owner anterior e novo owner
-- - source_ticket_id e new_ticket_id
-- - operador (quando admin)
-- - ip e user_agent (quando disponiveis)
-- - motivo
-- - taxa
-- - aceite de termos
-- - timestamps

-- ==================================================
-- 9) UX E COMUNICACAO (FUTURAS)
-- ==================================================
-- Em Meus Ingressos:
-- - mostrar deadline da transferencia
-- - alerta quando faltar menos de 48h
-- - mensagem de prazo encerrado
--
-- E-mails:
-- - solicitacao
-- - convite de conta
-- - confirmacao remetente
-- - confirmacao destinatario
-- - novo ingresso/QR
-- - cancelamento/expiracao

-- ==================================================
-- 10) ITENS EXPLICITAMENTE FORA DE ESCOPO AGORA
-- ==================================================
-- - Nao criar migration executavel nesta sprint.
-- - Nao alterar fluxo atual de compra.
-- - Nao implementar scanner ou vinculo de pulseiras agora.
