import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260887000000_import_account_invite_jobs.sql', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
const panel = await readFile(new URL('../src/app/importacoes/import-account-invites.tsx', import.meta.url), 'utf8');
const importer = await readFile(new URL('../src/app/importacoes/ImportacoesClient.tsx', import.meta.url), 'utf8');

test('job deriva candidatos somente do import_batch_id canonico', () => {
  assert.match(migration, /participation_history ph where ph\.import_batch_id=v_batch\.id/);
  assert.match(migration, /ph\.source='import'/);
  assert.doesNotMatch(actions.slice(actions.indexOf('previewImportAccountInviteJobAction')), /participantIds:\s*string\[\]/);
  assert.match(actions, /startImportAccountInviteJobAction\(importBatchId: string\)/);
});

test('duplo clique e dois admins convergem para um job ativo', () => {
  assert.match(migration, /create unique index ux_account_invite_jobs_active_import/);
  assert.match(migration, /where status in \('pending','processing'\)/);
  assert.match(migration, /exception when unique_violation/);
});

test('processamento reivindica no maximo 25 com skip locked e recupera lease', () => {
  assert.match(migration, /for update skip locked limit least\(greatest\(coalesce\(p_limit,25\),1\),25\)/);
  assert.match(migration, /claimed_at<now\(\)-interval '10 minutes'/);
  assert.match(actions, /p_limit: 25/);
  assert.doesNotMatch(actions.slice(actions.indexOf('processImportAccountInviteJobChunkAction')), /Promise\.all/);
});

test('cada item reusa convite individual canonico e registra retry sem token', () => {
  assert.match(actions, /check_account_invite_job_item_turn/);
  assert.match(migration, /other\.status='processing'[\s\S]*other\.created_at,other\.id/);
  assert.match(actions, /inviteCadastroFirstAccessAction\(String\(item\.participant_id\)\)/);
  assert.match(actions, /finish_account_invite_job_item/);
  assert.match(migration, /attempt_count=attempt_count\+1/);
  assert.match(migration, /retry_failed_account_invite_job/);
  assert.doesNotMatch(migration, /access_token|refresh_token|token_hash/);
});

test('backend exige permissao e isolamento organizacional', () => {
  assert.match(migration, /current_user_has_permission\('participants\.edit_basic'\)/);
  assert.match(migration, /user_can_access_organization\(v_actor,v_batch\.organization_id\)/);
  assert.match(actions, /assertPermission\("participants\.edit_basic"\)/);
});

test('resultado da importacao exibe UX de resumo, progresso e retry', () => {
  assert.match(importer, /ImportAccountInvites/);
  assert.match(importer, /showInvitePanel/);
  assert.match(importer, /Lote reaberto/);
  assert.match(panel, /Gerenciar convites/);
  assert.match(panel, /Convites para criação de conta/);
  assert.match(panel, /Enviar convites/);
  assert.match(panel, /Sem convite/);
  assert.match(panel, /processados/);
  assert.match(panel, /Tentar novamente falhas/);
  assert.match(actions, /getImportAccountInviteOperationalStatusAction/);
  assert.doesNotMatch(
    actions.slice(actions.indexOf('export async function getImportAccountInviteOperationalStatusAction'), actions.indexOf('export async function processImportAccountInviteJobChunkAction')),
    /createServiceRoleSupabaseClient/,
  );
});
