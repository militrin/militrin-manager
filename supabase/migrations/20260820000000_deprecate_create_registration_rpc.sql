-- NEXORA/Militrin: restringe (sem remover) a RPC legada
-- public.create_registration -- ver auditoria completa na tarefa que
-- originou esta migration.
--
-- O QUE E: public.create_registration(...) e uma RPC pre-Fase-2 que grava
-- diretamente em `participants`/`payments`/`participant_kit_items`, fora do
-- modelo canonico atual ticket-first/contact-first (`orders` ->
-- `order_items` -> `tickets`, identidade em `registration_contacts`). Ela
-- nunca cria `orders`, `order_items` nem `tickets` -- uma inscricao
-- resultante nao aparece em Minha Conta, nao tem QR Code e nao passa pela
-- unicidade de titular (que opera sobre `tickets`/`order_items`).
--
-- POR QUE ESTA SENDO RESTRINGIDA AGORA: auditoria confirmou zero
-- consumidores vivos -- os dois unicos wrappers em TS
-- (`createPublicRegistrationAction` em src/app/inscricao/actions.ts e
-- `createRegistrationWithRpc` em src/lib/supabase/rpc.ts) existem no
-- codigo mas nao sao importados por nenhuma tela; o checkout publico atual
-- (src/app/inscricao/[eventSlug]/wizard.tsx) usa exclusivamente
-- create_multi_ticket_order_checkout. Nenhuma outra funcao SQL chama
-- create_registration internamente, nenhum teste a exercita.
--
-- Apesar de morta na aplicacao, a funcao estava exposta via GRANT a
-- anon/authenticated/public (visivel na migration de baseline
-- 20260815001914_remote_schema.sql) -- ou seja, qualquer requisicao HTTP
-- nao autenticada ao endpoint REST do Supabase podia chama-la diretamente,
-- inclusive auto-declarando p_payment_status='paid'/p_payment_method=
-- 'courtesy' sem nenhum pagamento real, ja que a funcao nunca checa
-- auth.uid() nem valida organizacao a partir da sessao. Essa exposicao,
-- nao a regra de idade desatualizada que motivou a investigacao original,
-- e o risco real.
--
-- ESTRATEGIA: restricao reversivel, nao DROP. O corpo da funcao, a regra de
-- idade legada (baseada em "hoje" em vez da data do evento) e os dados ja
-- gravados por ela permanecem intocados -- so o acesso muda. Mesmo padrao
-- ja usado no modulo de integridade (20260818000000_operational_integrity_
-- module.sql): revoke de public/anon/authenticated, grant só a
-- service_role. O owner (postgres) mantém EXECUTE por ownership, sem
-- precisar de grant explicito.
begin;

revoke all on function public.create_registration(
  p_full_name text, p_cpf text, p_birth_date date, p_gender text,
  p_phone text, p_email text, p_city text, p_shirt_type text,
  p_shirt_size text, p_registration_status text, p_notes text,
  p_payment_method text, p_payment_status text, p_event_id uuid,
  p_coupon_code text, p_ticket_category_id uuid
) from public, anon, authenticated;

grant execute on function public.create_registration(
  p_full_name text, p_cpf text, p_birth_date date, p_gender text,
  p_phone text, p_email text, p_city text, p_shirt_type text,
  p_shirt_size text, p_registration_status text, p_notes text,
  p_payment_method text, p_payment_status text, p_event_id uuid,
  p_coupon_code text, p_ticket_category_id uuid
) to service_role;

commit;
