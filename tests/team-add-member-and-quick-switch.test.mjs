import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

// Normaliza CRLF->LF (mesmo motivo dos outros testes de contrato deste
// projeto: o ambiente Windows pode salvar arquivos-fonte com CRLF
// independente do que a ferramenta escreveu).
async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.notEqual(end, -1, `marcador de fim nao encontrado: ${endMarker}`);
  return source.slice(start, end);
}

const migration = await readFile(new URL("../supabase/migrations/20260862000000_team_add_member_search_rpc.sql", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/app/configuracoes/equipe/actions.ts", import.meta.url), "utf8");
const addMemberModal = await readFile(new URL("../src/app/configuracoes/equipe/add-member-modal.tsx", import.meta.url), "utf8");
const teamListPage = await readFile(new URL("../src/app/configuracoes/equipe/page.tsx", import.meta.url), "utf8");
const userAccessPage = await readFile(new URL("../src/app/configuracoes/equipe/[userId]/page.tsx", import.meta.url), "utf8");
const accessEditor = await readFile(new URL("../src/app/configuracoes/equipe/[userId]/access-editor.tsx", import.meta.url), "utf8");
const remoteSchema = await readFile(new URL("../supabase/migrations/20260815001914_remote_schema.sql", import.meta.url), "utf8");
const sidebar = await readFile(new URL("../src/components/dashboard/Sidebar.tsx", import.meta.url), "utf8");
const accountNav = await readFile(new URL("../src/app/minha-conta/account-nav.tsx", import.meta.url), "utf8");
const adminMenu = await readFile(new URL("../src/lib/navigation/admin-menu.ts", import.meta.url), "utf8");

// ── RPC de busca (search_promotable_admin_users) ────────────────────────────

test("RPC de busca exige team.edit_permissions -- protecao de BACKEND, nao so escondendo o botao na UI", () => {
  const fn = slice(migration, 'CREATE OR REPLACE FUNCTION "public"."search_promotable_admin_users"', "GRANT ALL");
  assert.match(fn, /not public\.current_user_has_permission\('team\.edit_permissions'\)/);
  assert.match(fn, /raise exception 'Sem permissao para buscar usuarios para a equipe\.'/);
});

test("RPC busca por e-mail E por nome (full_name de customer_profiles, com fallback pro metadata do auth)", () => {
  const fn = slice(migration, 'CREATE OR REPLACE FUNCTION "public"."search_promotable_admin_users"', "GRANT ALL");
  assert.match(fn, /coalesce\(cp\.full_name, u\.raw_user_meta_data ->> 'full_name', ''\) ilike/);
  assert.match(fn, /coalesce\(u\.email, ''\) ilike/);
  assert.match(fn, /left join public\.customer_profiles cp on cp\.user_id = u\.id/);
});

test("RPC NUNCA lista usuario que ja e membro (qualquer linha em admin_users, ativa ou inativa) -- 'nao listar usuarios ja membros como adicionaveis'", () => {
  const fn = slice(migration, 'CREATE OR REPLACE FUNCTION "public"."search_promotable_admin_users"', "GRANT ALL");
  assert.match(fn, /not exists \(select 1 from public\.admin_users au where au\.user_id = u\.id\)/);
});

test("RPC exclui o proprio ator dos resultados, exige minimo de 3 caracteres, mascara o e-mail e limita resultados -- nao expor dado sensivel desnecessario", () => {
  const fn = slice(migration, 'CREATE OR REPLACE FUNCTION "public"."search_promotable_admin_users"', "GRANT ALL");
  assert.match(fn, /where u\.id <> v_actor/);
  assert.match(fn, /if length\(v_term\) < 3 then/);
  assert.match(fn, /left\(u\.email, 2\) \|\| '\*\*\*@' \|\| split_part\(u\.email, '@', 2\)/);
  assert.match(fn, /limit 20/);
});

test("RPC concede execucao a authenticated (nao a PUBLIC) -- mesmo padrao de todo outro RPC administrativo do sistema", () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION "public"\."search_promotable_admin_users"\("p_term" "text"\) FROM PUBLIC;/);
  assert.match(migration, /GRANT ALL ON FUNCTION "public"\."search_promotable_admin_users"\("p_term" "text"\) TO "authenticated";/);
});

// ── Server actions ───────────────────────────────────────────────────────────

test("searchPromotableUsersAction e addTeamMemberAction reexigem team.edit_permissions no servidor -- nunca confiam so no botao estar escondido", () => {
  const searchFn = slice(actions, "export async function searchPromotableUsersAction", "export async function");
  assert.match(searchFn, /await assertPermission\('team\.edit_permissions'\);/);
  assert.match(searchFn, /supabase\.rpc\('search_promotable_admin_users', \{ p_term: parsed\.data \}\)/);

  const addFn = slice(actions, "export async function addTeamMemberAction", null);
  assert.match(addFn, /await assertPermission\('team\.edit_permissions'\);/);
});

test("addTeamMemberAction exige roleId (funcao base obrigatoria) -- diferente do editor completo, que aceita 'Sem funcao'", () => {
  const schemaBlock = slice(actions, "const addMemberSchema = z.object({", "});");
  assert.match(schemaBlock, /userId: z\.string\(\)\.uuid\(\)/);
  assert.match(schemaBlock, /roleId: z\.string\(\)\.uuid\(\)/);
  assert.doesNotMatch(schemaBlock, /roleId:[^\n]*nullable/);
});

test("addTeamMemberAction bloqueia se o alvo for a propria conta do ator -- 'nao permitir promover a propria conta de forma incoerente'", () => {
  const addFn = slice(actions, "export async function addTeamMemberAction", null);
  assert.match(addFn, /actor\.id === parsed\.data\.userId/);
  assert.match(addFn, /não é possível se adicionar por este fluxo/);
});

test("addTeamMemberAction reaproveita o RPC canonico existente (upsert_admin_user_access) -- nenhum sistema de permissao paralelo, status tem default ativo e sem overrides", () => {
  const addFn = slice(actions, "export async function addTeamMemberAction", null);
  assert.match(addFn, /supabase\.rpc\('upsert_admin_user_access', \{/);
  assert.match(addFn, /p_target_user_id: parsed\.data\.userId/);
  assert.match(addFn, /p_role_id: parsed\.data\.roleId/);
  assert.match(addFn, /p_is_active: parsed\.data\.isActive \?\? true/);
  assert.match(addFn, /p_overrides: \[\]/);
  assert.doesNotMatch(addFn, /insert into public\.admin_users|update public\.admin_users/);
});

test("addTeamMemberAction revalida a lista de equipe -- membro novo aparece imediatamente, sem precisar de reload manual", () => {
  const addFn = slice(actions, "export async function addTeamMemberAction", null);
  assert.match(addFn, /revalidatePath\('\/painel\/configuracoes\/equipe'\)/);
  assert.match(addFn, /revalidatePath\('\/configuracoes\/equipe'\)/);
});

// ── UI do fluxo "Adicionar membro" ──────────────────────────────────────────

test("modal 'Adicionar membro': busca -> selecionar -> escolher funcao -> confirmar, mostrando nome/e-mail/funcao antes de confirmar", () => {
  assert.match(addMemberModal, /\+ Adicionar membro/);
  assert.match(addMemberModal, /searchPromotableUsersAction/);
  assert.match(addMemberModal, /addTeamMemberAction/);
  const confirmStep = slice(addMemberModal, ": selected ? (", "</label>");
  assert.match(confirmStep, /selected\.fullName/);
  assert.match(confirmStep, /selected\.maskedEmail/);
  assert.match(confirmStep, /Função base/);
  const confirmButtonArea = slice(addMemberModal, "onClick={confirmAdd}", "</button>");
  assert.match(confirmButtonArea, /disabled=\{isPending \|\| !roleId\}/);
});

test("tela de equipe so mostra o botao 'Adicionar membro' pra quem tem team.edit_permissions -- calculado no server, condicional no render (nao so CSS escondendo)", () => {
  assert.match(teamListPage, /hasPermission\('team\.edit_permissions'\)/);
  assert.match(teamListPage, /canEditPermissions \? <AddTeamMemberButton roleOptions=\{roleOptions\} \/> : null/);
});

// ── Ultimo Owner -- aviso preventivo na UI, sem tocar na protecao do banco ──

test("trigger de protecao do ultimo Owner no banco continua intocado (nao foi alterado nesta rodada)", () => {
  assert.match(remoteSchema, /CREATE OR REPLACE FUNCTION "public"\."prevent_last_owner_admin_user_mutation"/);
  assert.match(remoteSchema, /Nao e permitido remover o ultimo Owner ativo\./);
  assert.match(remoteSchema, /Nao e permitido desativar ou rebaixar o ultimo Owner ativo\./);
  assert.match(remoteSchema, /CREATE OR REPLACE TRIGGER "trg_prevent_last_owner_admin_user_mutation" BEFORE DELETE OR UPDATE ON "public"\."admin_users"/);
});

test("pagina do editor calcula isLastActiveOwner a partir dos MESMOS dados ja buscados (list_admin_team) -- nenhuma query nova, e repassa pro editor", () => {
  assert.match(userAccessPage, /const activeOwnerCount = \(teamRows \?\? \[\]\)\.filter/);
  assert.match(userAccessPage, /String\(item\.role_name \?\? ''\) === 'Owner' && Boolean\(item\.is_active\)/);
  assert.match(userAccessPage, /const isLastActiveOwner = isTargetActiveOwner && activeOwnerCount <= 1;/);
  assert.match(userAccessPage, /isLastActiveOwner=\{isLastActiveOwner\}/);
});

test("editor mostra aviso preventivo quando a alteracao em rascunho removeria o unico Owner ativo -- nunca bloqueia o clique (quem bloqueia de verdade e o trigger no banco)", () => {
  assert.match(accessEditor, /isLastActiveOwner: boolean/);
  assert.match(accessEditor, /const wouldRemoveLastOwner = props\.isLastActiveOwner && /);
  assert.match(accessEditor, /único Owner ativo da equipe/);
  // O aviso e so um <p>, nunca desabilita o botao de salvar.
  const saveButtonArea = slice(accessEditor, "onClick={saveChanges}", "</button>");
  assert.doesNotMatch(saveButtonArea, /wouldRemoveLastOwner/);
});

// ── Troca rapida de area (Minha Conta <-> Painel) ───────────────────────────

test("Minha Conta -> Painel: atalho 'Painel administrativo' continua so pra quem tem acesso administrativo, no topo do menu (desktop e mobile)", () => {
  assert.match(accountNav, /if \(!isAdministrativeUser && !isSponsorUser\) return null;/);
  assert.match(accountNav, /isAdministrativeUser \? \([\s\S]*?Painel administrativo/);
  // Usado no TOPO de ambas as apresentacoes -- primeiro filho de cada <nav>.
  const desktopNav = slice(accountNav, "export function AccountSidebarNav", "function MenuSheet(");
  assert.match(desktopNav, /<nav className="mt-4 space-y-5"[\s\S]*?<AdminAndSponsorShortcuts/);
  const mobileNav = slice(accountNav, "function MenuSheet(", "function MobileNavLink");
  assert.match(mobileNav, /<nav className="flex-1 space-y-5[\s\S]*?<AdminAndSponsorShortcuts/);
});

test("Painel -> Minha Conta: link 'Ir para Minha Conta' existe no desktop (perto do topo, antes da navegacao) e no mobile (header em 1 toque + topo do drawer)", () => {
  // Desktop: antes do <nav> que renderiza os grupos.
  const desktopAside = slice(sidebar, '<aside className="hidden w-72', "</aside>");
  const desktopLinkIdx = desktopAside.indexOf('href="/minha-conta"');
  const desktopNavIdx = desktopAside.indexOf("<nav className=\"space-y-6\">");
  assert.ok(desktopLinkIdx !== -1 && desktopLinkIdx < desktopNavIdx, "link precisa vir ANTES do <nav> de grupos no desktop");
  assert.match(desktopAside, /Ir para Minha Conta/);

  // Header mobile: botao de icone, sempre visivel, 1 toque, sem precisar abrir o drawer.
  const header = slice(sidebar, "<header", "</header>");
  assert.match(header, /href="\/minha-conta"/);
  assert.match(header, /aria-label="Ir para Minha Conta"/);

  // Drawer mobile: perto do topo, ANTES de renderGroups (grupos filtrados por permissao).
  const drawerNav = slice(sidebar, '<nav className="flex-1 space-y-6 px-4 py-5">', "</nav>");
  const drawerLinkIdx = drawerNav.indexOf('href="/minha-conta"');
  const drawerGroupsIdx = drawerNav.indexOf("renderGroups(false, () => setDrawerOpen(false))");
  assert.ok(drawerLinkIdx !== -1 && drawerLinkIdx < drawerGroupsIdx, "link precisa vir ANTES dos grupos de navegacao no drawer");
});

test("troca de area NUNCA e feita via 'Sair' -- Sair continua exclusivo pra logout, em formulario separado com signOut", () => {
  assert.match(sidebar, /form action=\{signOutAdministrativePanelAction\}/);
  assert.match(sidebar, /Sair da conta/);
  // O link de troca de area e um <Link>, nao um <form>/<button> de submit.
  const desktopAside = slice(sidebar, '<aside className="hidden w-72', "</aside>");
  const switchAreaBlock = slice(desktopAside, 'href="/minha-conta"', "</Link>");
  assert.doesNotMatch(switchAreaBlock, /type="submit"|signOut/);
});

test("bottom nav administrativa (Painel/Pessoas/Scanner/Pedidos/Mais) continua com exatamente os mesmos 4 slots fixos + Mais -- sem regressao, nada novo adicionado ali", () => {
  const slotsBlock = slice(sidebar, "const BOTTOM_NAV_SLOTS: BottomNavSlot[] = [", "];");
  const slotCount = (slotsBlock.match(/key:\s*"/g) ?? []).length;
  assert.equal(slotCount, 4, "BOTTOM_NAV_SLOTS precisa continuar com exatamente 4 slots (painel/pessoas/scanner/pedidos) -- Mais e renderizado a parte, fora do array");
  assert.match(sidebar, /key: "painel"/);
  assert.match(sidebar, /key: "pessoas"/);
  assert.match(sidebar, /key: "scanner".*emphasize: true/);
  assert.match(sidebar, /key: "pedidos"/);
});

test("Equipe e permissões tem entrada clara no menu administrativo (grupo Organização, mesma fonte compartilhada por desktop e mobile)", () => {
  assert.match(adminMenu, /label: "Equipe e permissões"/);
  const orgGroup = slice(adminMenu, 'label: "Organização"', "];");
  assert.match(orgGroup, /href: "\/painel\/configuracoes\/equipe"/);
  assert.match(orgGroup, /permissionAny: \["team\.view"\]/);
});
