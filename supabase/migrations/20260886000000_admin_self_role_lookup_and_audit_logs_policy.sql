-- Duas causas-raiz relacionadas, corrigidas juntas:
--
-- 1) Cabecalho mostrando "Sem funcao" pra qualquer papel que nao seja Owner/
--    Administrador: admin_users e admin_roles tem RLS habilitado SEM NENHUMA
--    policy (confirmado por grep em todas as migrations -- zero "CREATE
--    POLICY ... ON admin_users/admin_roles"). RLS ligado + zero policies =
--    a role "authenticated" nunca enxerga nenhuma linha nessas duas tabelas
--    via .from(...), pra ninguem. A unica RPC existente que contorna isso
--    (get_admin_user_profile) exige 'team.view', que só Owner (bypass) e
--    Administrador (preset com todas as permissoes) tem -- Operacional/
--    Financeiro/Marketing/Visualizador continuavam sem saida.
--
--    Preferencia arquitetural do pedido: nao abrir uma policy ampla de
--    SELECT em admin_users (vazaria funcao/status de QUALQUER membro pra
--    QUALQUER membro). Em vez disso, RPC de autoconsulta nova --
--    get_current_admin_role() -- sem nenhum parametro (usa auth.uid()
--    internamente, nunca aceita um user_id arbitrario), devolve só a
--    propria role do chamador. Nunca vaza dado de outro membro porque não
--    há como pedir o de outro id.
--
-- 2) src/app/cadastros/[id]/page.tsx fazia
--    supabase.from("admin_users").select("user_id").eq("user_id", contactUserId)
--    pra decidir "essa pessoa ja e da equipe?" -- mesmo problema de RLS,
--    sempre devolvia null, entao isExistingTeamMember ficava sempre false
--    mesmo pra quem já era membro real. Precisa de uma checagem que baseie
--    em outro user_id (não é autoconsulta) -- por isso não dá pra usar
--    get_current_admin_role() ali. Adicionamos is_admin_team_member(uuid),
--    tambem minima (só um boolean, sem expor role/status/nome de ninguém),
--    e ela já exige 'team.view' -- é exatamente o mesmo dado que a tela de
--    Equipe já mostra pra quem tem essa permissão, sem gate novo inventado.
begin;

create or replace function public.get_current_admin_role()
returns table(role_id uuid, role_code text, role_name text, is_active boolean)
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return;
  end if;

  return query
  select ar.id, ar.code, ar.name, au.is_active
  from public.admin_users au
  join public.admin_roles ar on ar.id = au.role_id
  where au.user_id = v_actor;
end;
$$;

revoke all on function public.get_current_admin_role() from public, anon;
grant execute on function public.get_current_admin_role() to authenticated, service_role;

-- Boolean minimo pra telas que precisam saber "essa OUTRA pessoa (por user_id)
-- ja e membro da equipe?" sem expor role/status/nome -- exige a mesma
-- permissao (team.view) que a tela de Equipe ja exige pra listar membros,
-- entao nao e um gate novo, so uma forma de checar 1 pessoa sem listar todo
-- mundo.
create or replace function public.is_admin_team_member(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or p_user_id is null then return false; end if;
  if not (public.is_active_owner(v_actor) or public.current_user_has_permission('team.view')) then
    raise exception 'Sem permissao para consultar equipe.';
  end if;
  return exists(select 1 from public.admin_users where user_id = p_user_id);
end;
$$;

revoke all on function public.is_admin_team_member(uuid) from public, anon;
grant execute on function public.is_admin_team_member(uuid) to authenticated, service_role;

-- audit_logs: mesmo problema (RLS ligado, zero policies) -- o Relatorio de
-- Operacoes (src/lib/reports/queries/operacoes.ts) le audit_logs direto com
-- o client do proprio usuario e sempre voltava 0 linhas em producao, mesmo
-- havendo dados reais (confirmado: 10 linhas via service_role, 0 via cliente
-- sujeito a RLS, para o mesmo filtro exato). A correção imediata (sem
-- depender desta migration) usa o client de service role só nessa leitura;
-- esta policy é o fechamento estrutural pra qualquer leitura futura de
-- audit_logs pelo client do usuario nao precisar do mesmo contorno. Mesma
-- condicao ja usada em ticket_holder_history_select (organization scoping
-- via user_can_access_organization), sem abrir pra outras organizacoes.
create policy "audit_logs_org_select" on public.audit_logs
  for select to authenticated
  using (
    event_id is null
    or exists (
      select 1 from public.events e
      where e.id = audit_logs.event_id
        and public.user_can_access_organization(auth.uid(), e.organization_id)
    )
  );

commit;
