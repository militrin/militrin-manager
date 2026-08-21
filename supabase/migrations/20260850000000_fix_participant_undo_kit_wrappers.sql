-- Correcao cirurgica: supabase db lint --linked (rodado apos aplicar as
-- migrations 47/48/49 no remoto) apontou 2 erros reais causados pela
-- migration 20260848000000 -- ela tornou reason_code obrigatorio em
-- undo_ticket_kit_item(uuid,uuid,text,text) e
-- undo_ticket_full_kit(uuid,text,text), o que MUDA a assinatura dessas
-- funcoes (Postgres nunca substitui uma assinatura por CREATE OR REPLACE,
-- so cria overload -- por isso a 20260848000000 ja fazia DROP explicito das
-- assinaturas antigas dessas duas funcoes). Isso deixou dois wrappers
-- "participant-first" legados chamando uma assinatura que nao existe mais:
--
--   undo_participant_kit_item(p_participant_id, p_kit_item_id)
--     -> chamava undo_ticket_kit_item(uuid, uuid)               [inexistente]
--   undo_participant_full_kit(p_participant_id)
--     -> chamava undo_ticket_full_kit(uuid)                     [inexistente]
--
-- INVESTIGACAO DE CONSUMIDORES (antes de decidir corrigir vs. remover):
--   - grep em todo src/ por "undo_participant_kit_item"/"undo_participant_full_kit":
--     ZERO ocorrencias -- nenhuma action, componente ou script do app chama
--     essas duas RPCs.
--   - grep em toda supabase/migrations por chamada (nao definicao) das duas:
--     ZERO -- nenhuma outra RPC delega pra elas internamente.
--   - Privilegios ja concedidos SOMENTE a service_role (REVOKE ALL FROM
--     PUBLIC + GRANT ALL TO service_role, ver remote_schema.sql linhas
--     20344-20350) -- nunca authenticated nem anon. Ou seja, mesmo hoje,
--     nada no app publico jamais poderia te-las chamado.
--   - Por comparacao: o terceiro membro dessa familia "participant-first",
--     undo_participant_checkin(p_participant_id), NAO delega pra
--     undo_ticket_checkin -- tem logica inline propria (nunca foi afetada
--     pela migration 20260848000000) e continua concedida a anon/authenticated/
--     service_role. Por isso db lint nao acusou nada nela, e ela fica
--     FORA do escopo desta correcao (nao e a que foi reportada, nao esta
--     quebrada, e mexer nela seria alem do pedido).
--
-- DECISAO: corrigir (nao remover). Apesar de zero consumidores confirmados
-- no repositorio, sao funcoes SECURITY DEFINER expostas a service_role --
-- superficie plausivel de uso por ferramenta/runbook administrativo fora
-- deste repo, que este agente nao tem como auditar com certeza. Corrigir e
-- estritamente mais barato/seguro que remover: os dois wrappers sao puros
-- delegadores (nenhuma logica de negocio propria alem de resolver o ticket
-- do participante), entao a correcao e so repassar os mesmos parametros de
-- motivo que a funcao ticket-first agora exige. A regra "toda reversao deve
-- ter motivo e historico" e preservada INTEGRALMENTE tambem neste caminho
-- legado -- p_reason_code continua obrigatorio (sem default), exatamente
-- como em undo_ticket_kit_item/undo_ticket_full_kit. Nenhum default
-- silencioso foi introduzido em lugar nenhum.
--
-- Nenhuma regra de pulseira/estoque/check-in/entrega/historico/permissao e
-- alterada por esta migration -- so a assinatura destes 2 wrappers.
begin;

drop function if exists public.undo_participant_kit_item(uuid, uuid);

create or replace function public.undo_participant_kit_item(
  p_participant_id uuid, p_kit_item_id uuid, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  return public.undo_ticket_kit_item(public.resolve_unique_ticket_for_participant(p_participant_id), p_kit_item_id, p_reason_code, p_reason_text);
end;
$$;

revoke all on function public.undo_participant_kit_item(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.undo_participant_kit_item(uuid, uuid, text, text) to service_role;

drop function if exists public.undo_participant_full_kit(uuid);

create or replace function public.undo_participant_full_kit(
  p_participant_id uuid, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  return public.undo_ticket_full_kit(public.resolve_unique_ticket_for_participant(p_participant_id), p_reason_code, p_reason_text);
end;
$$;

revoke all on function public.undo_participant_full_kit(uuid, text, text) from public, anon, authenticated;
grant execute on function public.undo_participant_full_kit(uuid, text, text) to service_role;

commit;
