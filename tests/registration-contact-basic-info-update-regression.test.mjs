import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Bug: "Editar cadastro" informava sucesso ("Cadastro atualizado e pendencias
// reavaliadas.") mas o nome (e nenhum outro campo) nao era persistido, nem
// apos F5. Causa raiz: registration_contacts tem RLS habilitado mas SOMENTE
// uma policy de SELECT (registration_contacts_org_select, 20260815001914) --
// nunca existiu policy de UPDATE/INSERT. updateCadastroAction fazia um
// .update() direto na tabela com o client autenticado: RLS descartava a
// operacao silenciosamente (0 linhas afetadas, sem erro do Postgres/
// PostgREST), e a action seguia pro redirect de sucesso mesmo sem gravar
// nada. Fix: escrita passa a ser SOMENTE via RPC SECURITY DEFINER (mesmo
// padrao ja usado por owner_delete_empty_registration_contact,
// 20260894000000), que confirma via GET DIAGNOSTICS que a linha foi
// efetivamente afetada antes de reportar sucesso.

const migrationsDirUrl = new URL('../supabase/migrations/', import.meta.url);
const fixMigrationUrl = new URL('../supabase/migrations/20260914000000_fix_registration_contact_basic_info_update.sql', import.meta.url);
const actionsUrl = new URL('../src/app/cadastros/[id]/editar/actions.ts', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

async function resolveCurrentFunctionDefinition(functionName) {
  const files = (await fs.readdir(migrationsDirUrl)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const pattern = new RegExp(`create (?:or replace )?function public\\.${functionName}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  let source = null;
  let definedInFile = null;
  for (const file of files) {
    const sql = await fs.readFile(new URL(file, migrationsDirUrl), 'utf8');
    const match = sql.match(pattern);
    if (match) {
      source = match[0];
      definedInFile = file;
    }
  }
  if (!source) throw new Error(`funcao ${functionName} nunca foi definida em nenhuma migration`);
  return { source, definedInFile };
}

test('causa raiz: registration_contacts tem RLS habilitado mas so possui policy de SELECT -- confirma que um .update() direto realmente seria descartado pelo RLS', async () => {
  const sql = await fs.readFile(new URL('20260815001914_remote_schema.sql', migrationsDirUrl), 'utf8');
  assert.match(sql, /ALTER TABLE "public"\."registration_contacts" ENABLE ROW LEVEL SECURITY;/);
  const policyMatches = [...sql.matchAll(/CREATE POLICY "[^"]+" ON "public"\."registration_contacts"[^;]*;/g)];
  assert.equal(policyMatches.length, 1, 'deveria haver exatamente 1 policy (SELECT) em registration_contacts em toda a base de migrations');
  assert.match(policyMatches[0][0], /FOR SELECT/);
});

test('definicao VIGENTE de update_registration_contact_basic_info esta na migration do fix, e a UNICA gravadora de registration_contacts fora de RPCs internas ja existentes', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('update_registration_contact_basic_info');
  assert.equal(definedInFile, '20260914000000_fix_registration_contact_basic_info_update.sql');
  assert.match(source, /security definer/);
  assert.match(source, /current_user_has_permission\('participants\.edit_basic'\)/);
  assert.match(source, /user_can_access_organization\(v_actor, v_contact\.organization_id\)/);
});

test('update_registration_contact_basic_info confirma linhas afetadas via GET DIAGNOSTICS antes de reportar sucesso -- nunca reporta sucesso com 0 linhas gravadas', async () => {
  const sql = await fs.readFile(fixMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'update_registration_contact_basic_info');
  assert.match(fn, /get diagnostics v_count = row_count;/);
  assert.match(fn, /if v_count = 0 then\s*\n\s*raise exception 'Nao foi possivel salvar o cadastro\.';/);
  const diagnosticsIdx = fn.indexOf('get diagnostics');
  const successIdx = fn.indexOf("jsonb_build_object('success', true");
  assert.ok(diagnosticsIdx !== -1 && successIdx !== -1 && diagnosticsIdx < successIdx, 'a checagem de linhas afetadas deveria rodar ANTES de montar a resposta de sucesso');
});

test('update_registration_contact_basic_info grava full_name (e so os campos basicos) -- nunca toca orders/order_items/participants/tickets (cadastro independente de comprador/titular/propriedade)', async () => {
  const sql = await fs.readFile(fixMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'update_registration_contact_basic_info');
  assert.match(fn, /update public\.registration_contacts set\s*\n\s*full_name = v_full_name,/);
  assert.doesNotMatch(fn, /public\.order_items|public\.orders\b|public\.participants\b|public\.tickets\b/);
});

test('RPC e interna (revoke de public/anon, grant so a authenticated/service_role) -- mesmo padrao ja usado por owner_delete_empty_registration_contact', async () => {
  const sql = await fs.readFile(fixMigrationUrl, 'utf8');
  assert.match(sql, /revoke all on function public\.update_registration_contact_basic_info\([^)]*\)\s*\n\s*from public, anon;/);
  assert.match(sql, /grant execute on function public\.update_registration_contact_basic_info\([^)]*\)\s*\n\s*to authenticated, service_role;/);
});

test('updateCadastroAction chama a RPC (nao faz mais .update() direto na tabela) e so redireciona com sucesso depois de checar error da RPC', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  assert.doesNotMatch(source, /from\("registration_contacts"\)\.update\(/, 'nao deveria mais existir update direto na tabela -- RLS descarta silenciosamente');
  assert.match(source, /supabase\.rpc\("update_registration_contact_basic_info", \{/);
  assert.match(source, /p_full_name: values\.full_name,/);
  const rpcCallIdx = source.indexOf('supabase.rpc("update_registration_contact_basic_info"');
  const errorCheckIdx = source.indexOf('if (error) redirect(`/cadastros/${id}/editar?erro=');
  const successRedirectIdx = source.indexOf('redirect(`/cadastros/${id}/editar?sucesso=1`)');
  assert.ok(rpcCallIdx !== -1 && errorCheckIdx !== -1 && successRedirectIdx !== -1);
  assert.ok(rpcCallIdx < errorCheckIdx && errorCheckIdx < successRedirectIdx, 'a checagem de erro da RPC deveria acontecer entre a chamada e o redirect de sucesso');
});
