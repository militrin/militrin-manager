-- Corrige o achado do Security Advisor (rls_disabled_in_public) confirmado
-- por auditoria somente leitura: public.admin_role_permissions_system_default
-- nunca teve "ENABLE ROW LEVEL SECURITY" em nenhuma migration (criada em
-- 20260868000000_admin_role_permissions_manual_editor.sql, sem nenhuma
-- ALTER TABLE de RLS depois disso -- confirmado buscando todo o historico).
-- Como toda tabela nova deste projeto, ela recebeu o grant default do
-- projeto (SELECT/INSERT/UPDATE/DELETE para "anon" e "authenticated" --
-- mesmo padrao ja documentado em 20260838000000_rls_disabled_public_tables_remediation.sql).
-- Sem RLS, isso permite que a chave publica (anon, embarcada no bundle do
-- site) leia a tabela inteira via PostgREST -- confirmado empiricamente pela
-- auditoria (271 linhas retornadas para uma requisicao anonima).
--
-- Reauditoria de TODOS os leitores/escritores desta tabela feita antes desta
-- migration (buscando toda referencia a "admin_role_permissions_system_default"
-- em supabase/migrations/ e em src/):
--
--   Leitores:
--     - list_admin_role_permissions(uuid) -- RPC SECURITY DEFINER, grant
--       apenas para authenticated/service_role, ja exige
--       current_user_has_permission('team.view') no corpo.
--     - restore_admin_role_permissions_default(uuid, text) -- RPC SECURITY
--       DEFINER, grant apenas para authenticated/service_role, delega toda
--       a escrita (e toda a checagem de autorizacao) para
--       upsert_admin_role_permissions.
--   Escritores:
--     - Nenhuma RPC escreve nesta tabela. As unicas escritas sao INSERT/DELETE
--       diretos dentro de migrations de feature (20260868000000, 20260878000000,
--       20260879000000, 20260883000000, 20260884000000), sempre executados
--       como o dono da tabela (role de migration) -- nunca por anon/authenticated
--       em runtime.
--     - Nenhum arquivo em src/ referencia esta tabela (grep vazio) -- zero
--       consumidores client-side, diretos ou via .from(...).
--
-- Ou seja: 100% do uso legitimo em runtime e leitura via RPC SECURITY
-- DEFINER. Nao ha nenhum caso de leitura direta autenticada que precise de
-- policy -- criar "USING (true)" so pra silenciar o Advisor seria abrir de
-- novo exatamente o que esta sendo fechado. Nenhuma policy e criada.
--
-- RLS sozinha (sem nenhuma policy) ja bloquearia anon/authenticated via
-- PostgREST -- e o padrao ja usado nas tabelas irmãs admin_permissions,
-- admin_role_permissions e admin_roles (RLS habilitada, zero policies,
-- nenhum REVOKE explicito de SELECT/INSERT/UPDATE/DELETE). Aqui vamos alem
-- e tambem revogamos o grant direto de anon/authenticated (defesa em
-- profundidade explicita), ja que nenhum uso legitimo depende dele.
-- service_role fica intocado (sempre ignora RLS; e quem roda as migrations
-- de feature futuras que ainda escrevem nesta tabela).
--
-- Nao usa FORCE ROW LEVEL SECURITY -- isso quebraria as duas RPCs SECURITY
-- DEFINER acima (rodam OWNER TO igual ao dono da tabela) e nenhuma outra
-- tabela deste schema usa FORCE, por consistencia com o restante do projeto.
--
-- Fora de escopo desta migration (dívida separada, não tratada aqui):
-- limpeza das 56 roles legadas e reconstrução do snapshot de Owner.
begin;

alter table public.admin_role_permissions_system_default enable row level security;

revoke all on public.admin_role_permissions_system_default from anon, authenticated;

commit;
