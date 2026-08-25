import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration87 = await readFile(new URL('../supabase/migrations/20260887000000_import_account_invite_jobs.sql', import.meta.url), 'utf8');
const migration88 = await readFile(new URL('../supabase/migrations/20260888000000_fix_claim_account_invite_job_items_ambiguous_participant.sql', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');

test('documenta exatamente o statement ambiguo da 87', () => {
  assert.match(migration87, /returns table\(item_id uuid,participant_id uuid\)[\s\S]*\) select id,participant_id from claimed;/);
});

test('migration 88 substitui somente a RPC de claim e torna conflito um erro de compilacao', () => {
  assert.match(migration88, /create or replace function public\.claim_account_invite_job_items/);
  assert.match(migration88, /#variable_conflict error/);
  assert.doesNotMatch(migration88, /create table|alter table|drop table|create index|drop index/i);
  assert.equal((migration88.match(/create or replace function/g) ?? []).length, 1);
});

test('participant_id e todas as projecoes do claim ficam explicitamente qualificadas', () => {
  assert.match(migration88, /claimed_item\.participant_id as claimed_participant_id/);
  assert.match(migration88, /select claimed_result\.claimed_item_id,[\s\S]*claimed_result\.claimed_participant_id[\s\S]*from claimed as claimed_result/);
  assert.doesNotMatch(migration88, /select\s+id\s*,\s*participant_id\s+from/i);
  assert.doesNotMatch(migration88, /attempt_count\s*=\s*attempt_count\s*\+/i);
});

test('preserva paginacao, lease, permissao e isolamento por organizacao', () => {
  assert.match(migration88, /current_user_has_permission\('participants\.edit_basic'\)/);
  assert.match(migration88, /user_can_access_organization\(auth\.uid\(\),job_access\.organization_id\)/);
  assert.match(migration88, /stale_item\.claimed_at<now\(\)-interval '10 minutes'/);
  assert.match(migration88, /for update of candidate_item skip locked/);
  assert.match(migration88, /limit least\(greatest\(coalesce\(p_limit,25\),1\),25\)/);
});

test('aplicacao continua consumindo apenas itens retornados pela RPC do job', () => {
  const chunk = actions.slice(actions.indexOf('export async function processImportAccountInviteJobChunkAction'));
  assert.match(chunk, /claim_account_invite_job_items/);
  assert.match(chunk, /item_id: string; participant_id: string/);
  assert.match(chunk, /inviteCadastroFirstAccessAction\(String\(item\.participant_id\)\)/);
});
