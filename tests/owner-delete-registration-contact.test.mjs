import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync('supabase/migrations/20260921000000_safe_registration_contact_account_deletion.sql', 'utf8');
const page = fs.readFileSync('src/app/cadastros/[id]/editar/page.tsx', 'utf8');
const actions = fs.readFileSync('src/app/cadastros/[id]/editar/actions.ts', 'utf8');
const button = fs.readFileSync('src/app/cadastros/[id]/editar/delete-cadastro-button.tsx', 'utf8');

test('somente Owner autenticado prepara e finaliza a exclusao', () => {
  assert.match(page, /organizationContext\.isOrgOwner/);
  assert.match(actions, /!context\.organization\?\.id \|\| !context\.isOrgOwner/);
  assert.ok((migration.match(/m\.is_owner and m\.is_active/g) ?? []).length >= 3);
  assert.match(migration, /v_actor is null/);
});

test('confirmacao explicita exige nome exato e motivo', () => {
  assert.match(button, /digite o nome completo/);
  assert.match(migration, /p_confirmation[\s\S]*<> btrim\(v_contact\.full_name\)/);
  assert.match(migration, /p_reason[\s\S]*< 5/);
});

test('conta Auth vinculada, isoladamente, nao bloqueia a exclusao', () => {
  const prepare = migration.match(/create or replace function public\.prepare_owner[\s\S]*?create or replace function public\.mark_owner/)?.[0] ?? '';
  assert.doesNotMatch(prepare, /if v_contact\.user_id is not null then\s+raise/);
  assert.match(prepare, /'auth_user_id',v_request\.auth_user_id/);
  assert.match(button, /Excluir cadastro e conta/);
});

test('contato vazio sem Auth segue pela mesma finalizacao idempotente', () => {
  assert.match(actions, /if \(prepared\.auth_user_id\)/);
  assert.match(actions, /finalize_owner_registration_contact_deletion/);
  assert.match(migration, /if v_request\.status='completed'/);
});

test('cadastro importado incompleto limpa apenas auxiliares descartaveis', () => {
  assert.match(migration, /delete from public\.participant_account_invites/);
  assert.match(migration, /delete from public\.participant_data_issues/);
  assert.match(migration, /delete from public\.participants where id=any\(v_ids\)/);
  assert.doesNotMatch(migration, /delete from public\.(orders|tickets|payments|participation_history|audit_logs)/);
});

test('pedido ingresso pagamento e historico de participacao bloqueiam', () => {
  for (const dependency of ['public.orders', 'public.tickets', 'public.payments', 'public.participation_history']) assert.match(migration, new RegExp(dependency.replaceAll('.', '\\.')));
  assert.match(migration, /'blocked', true/);
});

test('dependencias operacionais adicionais tambem bloqueiam sem cascade indiscriminado', () => {
  for (const dependency of ['public.store_orders', 'public.financial_entries', 'public.coupon_redemptions', 'public.kit_deliveries', 'public.participant_kit_items', 'public.participant_wristbands', 'public.ticket_holder_history', 'public.sponsors']) assert.match(migration, new RegExp(dependency.replaceAll('.', '\\.')));
});

test('falha ao remover Auth preserva dados locais e retorna erro seguro', () => {
  assert.ok(actions.indexOf('admin.auth.admin.deleteUser') < actions.indexOf('finalize_owner_registration_contact_deletion'));
  assert.match(actions, /if \(authError && !authAlreadyAbsent\)/);
  assert.match(actions, /Nenhum cadastro foi removido/);
});

test('falha depois da remocao Auth pode ser retomada pela solicitacao duravel', () => {
  assert.match(migration, /registration_contact_deletion_requests/);
  assert.match(migration, /status in \('prepared', 'auth_deleted', 'completed', 'failed'\)/);
  assert.match(actions, /operacao e segura para repeticao/);
  assert.match(migration, /already_completed/);
});

test('auditoria registra IDs ator e motivo sem nome email ou cpf', () => {
  assert.match(migration, /registration_contact_deletion_requested/);
  assert.match(migration, /registration_contact_account_deleted/);
  assert.match(migration, /'actor_user_id'/);
  assert.match(migration, /'auth_user_id'/);
  assert.doesNotMatch(migration, /jsonb_build_object\([^;]*(full_name|email|cpf)/);
});

test('RPCs nao ficam expostas a anon e Admin API permanece server-side', () => {
  assert.ok((migration.match(/revoke all on function/g) ?? []).length >= 3);
  assert.match(migration, /to authenticated,service_role/);
  assert.match(actions, /createServiceRoleSupabaseClient/);
  assert.doesNotMatch(button, /createServiceRoleSupabaseClient|deleteUser/);
});

test('sucesso retorna a Cadastros', () => {
  assert.match(button, /router\.replace\("\/cadastros"\)/);
});
