import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

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

const migration = await readFile(new URL("../supabase/migrations/20260868000000_admin_role_permissions_manual_editor.sql", import.meta.url), "utf8");
const remoteSchema = await readFile(new URL("../supabase/migrations/20260815001914_remote_schema.sql", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/app/configuracoes/equipe/actions.ts", import.meta.url), "utf8");
const teamListPage = await readFile(new URL("../src/app/configuracoes/equipe/page.tsx", import.meta.url), "utf8");
const roleEditorPage = await readFile(new URL("../src/app/configuracoes/equipe/funcoes/[roleId]/page.tsx", import.meta.url), "utf8");
const roleEditor = await readFile(new URL("../src/app/configuracoes/equipe/funcoes/[roleId]/role-permissions-editor.tsx", import.meta.url), "utf8");
const painelPageShim = await readFile(new URL("../src/app/painel/configuracoes/equipe/funcoes/[roleId]/page.tsx", import.meta.url), "utf8");
const moduleLabels = await readFile(new URL("../src/lib/admin/permission-module-labels.ts", import.meta.url), "utf8");

// ── Fonte de verdade: nenhum RBAC paralelo ──────────────────────────────────

test("editor de permissoes por funcao reaproveita 100% admin_roles/admin_permissions/admin_role_permissions -- nenhuma tabela de autorizacao nova", () => {
  assert.match(migration, /delete from public\.admin_role_permissions where role_id = p_role_id;/);
  assert.match(migration, /insert into public\.admin_role_permissions \(role_id, permission_id\)/);
  assert.doesNotMatch(migration, /create table[\s\S]{0,80}admin_permissions\b/i);
  assert.doesNotMatch(migration, /create table[\s\S]{0,80}admin_roles\b/i);
});

test("precedencia role -> override (resolve_user_permission) nao foi alterada por esta migration -- Owner sempre true, deny > allow > role", () => {
  assert.doesNotMatch(migration, /create or replace function public\.resolve_user_permission/);
  const fn = slice(remoteSchema, 'CREATE OR REPLACE FUNCTION "public"."resolve_user_permission"', "ALTER FUNCTION");
  assert.match(fn, /if v_is_owner then\s*\n\s*return true;/);
  assert.match(fn, /effect = 'deny'/);
  assert.match(fn, /if v_has_deny then\s*\n\s*return false;/);
  assert.match(fn, /effect = 'allow'/);
  assert.match(fn, /if v_has_allow then\s*\n\s*return true;/);
  assert.match(fn, /from public\.admin_role_permissions arp/);
});

test("alteracao na funcao e lida AO VIVO por resolve_user_permission (sem cache) -- usuario 'Herdar' reflete a mudanca imediatamente", () => {
  // list_admin_role_permissions/upsert_admin_role_permissions escrevem
  // diretamente em admin_role_permissions; resolve_user_permission consulta
  // essa MESMA tabela em toda chamada (nao ha coluna/tabela de cache
  // intermediaria pra invalidar).
  assert.match(migration, /from public\.admin_role_permissions arp\s*\n\s*join public\.admin_permissions ap on ap\.id = arp\.permission_id\s*\n\s*where arp\.role_id = p_role_id;/);
});

// ── Protecao da funcao Owner ─────────────────────────────────────────────────

test("RPC rejeita incondicionalmente editar a funcao 'owner' -- Owner sempre tem acesso total, nao pode ser limitado pela UI", () => {
  const fn = slice(migration, "create or replace function public.upsert_admin_role_permissions", "revoke all on function public.upsert_admin_role_permissions");
  assert.match(fn, /if v_role_code = 'owner' then/);
  assert.match(fn, /raise exception 'A funcao Owner sempre tem acesso total; as permissoes dela nao podem ser editadas\.';/);
});

test("UI mostra aviso 'Owner possui acesso total e nao pode ser limitado' em vez de lista editavel", () => {
  assert.match(roleEditorPage, /isOwnerRole/);
  assert.match(roleEditorPage, /Owner possui acesso total e não pode ser limitado/);
  assert.match(roleEditorPage, /<RolePermissionsEditor roleId=\{roleId\} roleName=\{String\(role\.name\)\} permissions=\{permissions\} \/>/);
});

// ── Seguranca: backend valida, nao so a UI ──────────────────────────────────

test("RPC upsert_admin_role_permissions exige team.edit_permissions (ou Owner) DENTRO do proprio banco -- chamada direta sem permissao falha mesmo sem passar pela UI", () => {
  const fn = slice(migration, "create or replace function public.upsert_admin_role_permissions", "revoke all on function public.upsert_admin_role_permissions");
  assert.match(fn, /v_actor_is_owner := public\.is_active_owner\(v_actor_user_id\);/);
  assert.match(fn, /if not \(v_actor_is_owner or public\.current_user_has_permission\('team\.edit_permissions'\)\) then/);
  assert.match(fn, /raise exception 'Sem permissao para editar permissoes de funcoes\.';/);
});

test("server actions reexigem team.edit_permissions antes de chamar o RPC -- nao dependem so do redirect da pagina", () => {
  assert.match(actions, /export async function saveRolePermissionsAction[\s\S]{0,200}\n\s*await assertPermission\('team\.edit_permissions'\);/);
  assert.match(actions, /export async function restoreRolePermissionsDefaultAction[\s\S]{0,200}\n\s*await assertPermission\('team\.edit_permissions'\);/);
});

test("pagina do editor de funcao exige team.edit_permissions no server antes de renderizar (requirePermission redireciona quem nao tem)", () => {
  assert.match(roleEditorPage, /await requirePermission\('team\.edit_permissions'\);/);
});

test("nao permite elevar a propria funcao: quem nao e Owner so pode conceder a uma funcao permissao que ele mesmo ja possui", () => {
  const fn = slice(migration, "create or replace function public.upsert_admin_role_permissions", "revoke all on function public.upsert_admin_role_permissions");
  assert.match(fn, /if not v_actor_is_owner then/);
  assert.match(fn, /where code_input <> all \(v_before_codes\)\s*\n\s*and not public\.resolve_user_permission\(v_actor_user_id, code_input\)/);
  assert.match(fn, /raise exception 'Voce nao pode conceder a uma funcao uma permissao que voce mesmo nao possui: %', v_forbidden_grant;/);
});

test("nunca permite deixar zero usuarios com acesso pra administrar equipe/permissoes -- checado DEPOIS de aplicar a mudanca, na mesma transacao", () => {
  const fn = slice(migration, "create or replace function public.upsert_admin_role_permissions", "revoke all on function public.upsert_admin_role_permissions");
  const afterDelete = fn.indexOf("delete from public.admin_role_permissions where role_id = p_role_id;");
  const guardIndex = fn.indexOf("Esta alteracao deixaria nenhum usuario com permissao para administrar equipe/permissoes.");
  assert.ok(afterDelete !== -1 && guardIndex !== -1 && guardIndex > afterDelete, "o guard precisa vir DEPOIS de aplicar a mudanca, pra refletir o estado real pos-update");
  assert.match(fn, /public\.is_active_owner\(au\.user_id\) or public\.resolve_user_permission\(au\.user_id, 'team\.edit_permissions'\)/);
});

// ── Auditoria ────────────────────────────────────────────────────────────────

test("toda alteracao registra em audit_logs: funcao, permissoes adicionadas/removidas, ator e reason -- data/hora vem do default created_at", () => {
  const fn = slice(migration, "create or replace function public.upsert_admin_role_permissions", "revoke all on function public.upsert_admin_role_permissions");
  assert.match(fn, /insert into public\.audit_logs \(action, entity_type, entity_id, event_id, details\)/);
  assert.match(fn, /'admin_role_permissions_updated', 'admin_roles', p_role_id, null,/);
  assert.match(fn, /'actor_user_id', v_actor_user_id, 'actor_email', v_actor_email,/);
  assert.match(fn, /'role_id', p_role_id, 'role_code', v_role_code, 'role_name', v_role_name,/);
  assert.match(fn, /'added_permissions', coalesce\(v_added, array\[\]::text\[\]\),/);
  assert.match(fn, /'removed_permissions', coalesce\(v_removed, array\[\]::text\[\]\),/);
  assert.match(fn, /'reason', nullif\(trim\(coalesce\(p_reason, ''\)\), ''\)/);
});

// ── Isolamento entre funcoes ─────────────────────────────────────────────────

test("upsert e delete sao sempre escopados por role_id = p_role_id -- editar uma funcao nunca toca as permissoes de outra", () => {
  const fn = slice(migration, "create or replace function public.upsert_admin_role_permissions", "revoke all on function public.upsert_admin_role_permissions");
  assert.match(fn, /delete from public\.admin_role_permissions where role_id = p_role_id;/);
  assert.match(fn, /select p_role_id, ap\.id\s*\n\s*from unnest\(coalesce\(p_permission_codes, array\[\]::text\[\]\)\) as code_input/);
  assert.doesNotMatch(fn, /delete from public\.admin_role_permissions;/);
});

// ── Restaurar padrao do sistema ──────────────────────────────────────────────

test("'Restaurar padrao do sistema' usa um snapshot congelado de admin_role_permissions (nunca reescrito depois) e delega 100% das protecoes pro RPC de escrita", () => {
  assert.match(migration, /create table if not exists public\.admin_role_permissions_system_default/);
  assert.match(migration, /insert into public\.admin_role_permissions_system_default \(role_id, permission_id\)\s*\n\s*select role_id, permission_id from public\.admin_role_permissions/);
  const restoreFn = slice(migration, "create or replace function public.restore_admin_role_permissions_default", "revoke all on function public.restore_admin_role_permissions_default");
  assert.match(restoreFn, /return public\.upsert_admin_role_permissions\(/);
});

test("botao 'Restaurar padrao do sistema' existe na UI e chama a action correspondente", () => {
  assert.match(roleEditor, /Restaurar padrao do sistema/);
  assert.match(roleEditor, /restoreRolePermissionsDefaultAction/);
});

// ── UX pedida: busca, agrupamento, contador, aviso de nao salvo, lote ───────

test("editor tem busca, agrupamento por modulo, selecionar\/remover todas do modulo, contador X de Y e aviso de alteracoes nao salvas", () => {
  assert.match(roleEditor, /setSearch/);
  assert.match(roleEditor, /const grouped = useMemo/);
  assert.match(roleEditor, /Selecionar todas/);
  assert.match(roleEditor, /Remover todas/);
  assert.match(roleEditor, /\{selectedCount\}<\/span> de <span[^>]*>\{totalCount\}/);
  assert.match(roleEditor, /Voce tem alteracoes nao salvas nesta funcao/);
});

test("salvar e sempre em LOTE (um clique em 'Salvar alteracoes'), nunca checkbox por checkbox chamando o servidor", () => {
  assert.doesNotMatch(roleEditor, /onChange=\{\(event\) => \{[\s\S]{0,80}saveRolePermissionsAction/);
  assert.match(roleEditor, /function saveChanges\(\)/);
  assert.match(roleEditor, /onClick=\{saveChanges\}/);
  assert.match(roleEditor, /disabled=\{isPending \|\| !isDirty\}/);
});

test("editor por funcao reusa o mesmo moduleLabel do editor por usuario -- nenhum mapeamento de modulo duplicado e divergente", () => {
  assert.match(roleEditor, /import \{ moduleLabel \} from '@\/lib\/admin\/permission-module-labels';/);
  assert.match(moduleLabels, /checkin: 'Check-in'/);
  assert.match(moduleLabels, /kits: 'Kits'/);
});

// ── Rotas ────────────────────────────────────────────────────────────────────

test("nova aba 'Funcoes e permissoes' existe em /painel/configuracoes/equipe, e /painel/configuracoes/equipe/funcoes/[roleId] espelha a rota canonica", () => {
  assert.match(teamListPage, /Funções e permissões/);
  assert.match(teamListPage, /\['roles', 'Funções e permissões'\]/);
  assert.match(teamListPage, /href=\{`\/painel\/configuracoes\/equipe\?tab=\$\{code\}`\}/);
  assert.match(painelPageShim, /export \{ default \} from '@\/app\/configuracoes\/equipe\/funcoes\/\[roleId\]\/page';/);
});
