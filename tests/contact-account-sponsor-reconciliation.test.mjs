import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260889000000_reconcile_contact_account_tickets_and_sponsor_people.sql', import.meta.url), 'utf8');
const remoteSchema = await readFile(new URL('../supabase/migrations/20260815001914_remote_schema.sql', import.meta.url), 'utf8');
const sponsorActions = await readFile(new URL('../src/app/painel/patrocinadores/actions.ts', import.meta.url), 'utf8');
const sponsorUi = await readFile(new URL('../src/app/painel/patrocinadores/sponsors-manager.tsx', import.meta.url), 'utf8');
const portal = await readFile(new URL('../src/lib/account/portal-orders-and-tickets.ts', import.meta.url), 'utf8');
const inviteActions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');

test('Pessoa canonica materializa conta em participants e tickets sem depender do comprador', () => {
  assert.match(migration, /update public\.participants as linked_participant[\s\S]*registration_contact_id=v_contact\.id[\s\S]*user_id=p_user_id/);
  assert.match(migration, /update public\.tickets as ticket[\s\S]*owner_user_id=p_user_id/);
  assert.match(migration, /ticket\.owner_user_id is null/);
  assert.match(migration, /item\.registration_contact_id=v_contact\.id/);
  assert.doesNotMatch(migration.slice(migration.indexOf('with owned as')), /orders[\s\S]*user_id/);
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
});

test('historico de propriedade usa operacao e motivo aceitos pelas constraints reais', () => {
  const ownerHistoryDefinition = remoteSchema.slice(
    remoteSchema.indexOf('CREATE TABLE IF NOT EXISTS "public"."ticket_owner_history"'),
    remoteSchema.indexOf('ALTER TABLE "public"."ticket_owner_history" OWNER TO "postgres"'),
  );

  assert.match(ownerHistoryDefinition, /ticket_owner_history_operation_check[\s\S]*'owner_assigned'/);
  assert.match(ownerHistoryDefinition, /ticket_owner_history_reason_code_check[\s\S]*'data_regularization'/);
  assert.match(migration, /'owner_assigned',null,p_user_id,coalesce\(v_actor,p_user_id\),'data_regularization'/);
  assert.doesNotMatch(migration, /'contact_account_reconciled'/);
});

test('claim e vinculo direto de contato disparam a mesma reconciliacao idempotente', () => {
  assert.match(migration, /after update of user_id on public\.registration_contacts/);
  assert.match(migration, /after update of user_id on public\.participants/);
  assert.match(migration, /pg_trigger_depth\(\)>1/);
  assert.match(migration, /where contact\.user_id is not null/);
  assert.doesNotMatch(migration, /insert into public\.(tickets|participants|registration_contacts)/);
});

test('nome real do contato preenche somente perfil vazio ou placeholder', () => {
  assert.match(migration, /set full_name=v_contact\.full_name/);
  assert.match(migration, /lower\(trim\(profile\.full_name\)\)='participante'/);
  assert.match(migration, /nullif\(trim\(v_contact\.full_name\),''\) is not null/);
  assert.match(inviteActions, /registration_contacts\(full_name\)/);
  assert.match(inviteActions, /full_name: canonicalFullName/);
});

test('patrocinador persiste Pessoa e busca por nome CPF ou email com escopo e permissao', () => {
  assert.match(migration, /add column if not exists registration_contact_id uuid/);
  assert.match(migration, /admin_search_sponsor_candidate_contacts/);
  assert.match(migration, /contact\.full_name ilike/);
  assert.match(migration, /contact\.email/);
  assert.match(migration, /v_digits<>''/);
  assert.match(migration, /current_user_has_permission\('sponsors\.manage'\)/);
  assert.match(migration, /contact\.organization_id=v_org/);
  assert.match(migration, /admin_set_sponsor_contact/);
  assert.match(sponsorActions, /admin_set_sponsor_contact/);
});

test('Pessoa sem conta pode ser vinculada e recebe CTA do convite canonico', () => {
  assert.match(sponsorUi, /Conta ainda não criada/);
  assert.match(sponsorUi, /Enviar convite para criar conta/);
  assert.match(sponsorUi, /inviteCadastroFirstAccessAction/);
  assert.match(sponsorUi, /Buscar pessoa por nome, CPF ou e-mail/);
  assert.match(sponsorUi, /candidate\.registration_contact_id/);
});
