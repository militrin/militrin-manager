import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const managerPath = new URL('../src/app/painel/eventos/[id]/single-ticket-batches-manager.tsx', import.meta.url);
const pagePath = new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url);
const actionsPath = new URL('../src/app/eventos/actions.ts', import.meta.url);
const migrationPath = new URL('../supabase/migrations/20260865000000_single_ticket_multi_batch_gender_split.sql', import.meta.url);

test('UI administrativa gerencia varios lotes e estados independentes por genero', async () => {
  const source = await readFile(managerPath, 'utf8');
  assert.match(source, /\+ Adicionar lote/);
  assert.match(source, /Preço masculino/);
  assert.match(source, /Preço feminino/);
  assert.match(source, /Limite masculino/);
  assert.match(source, /Limite feminino/);
  assert.match(source, /Esgotar \/ Encerrar masculino/);
  assert.match(source, /Esgotar \/ Encerrar feminino/);
  assert.match(source, /Reabrir masculino/);
  assert.match(source, /Reabrir feminino/);
});

test('preco zero continua permitido e limites de vagas precisam ser positivos', async () => {
  const source = await readFile(managerPath, 'utf8');
  assert.doesNotMatch(source, /malePrice (?:<=|===) 0/);
  assert.doesNotMatch(source, /femalePrice (?:<=|===) 0/);
  assert.match(source, /maleMax <= 0/);
  assert.match(source, /femaleMax <= 0/);
});

test('pagina escolhe o gerenciador pela contagem de categorias ativas', async () => {
  const source = await readFile(pagePath, 'utf8');
  assert.match(source, /const activeCategoryCount = categories\.filter\(\(category: \{ is_active: boolean \}\) => category\.is_active\)\.length/);
  assert.match(source, /activeCategoryCount === 0 \? \(/);
  assert.match(source, /<SingleTicketBatchesManager eventId=\{event\.id\} batches=\{singleTicketBatches\} \/>/);
  assert.match(source, /<BatchesManager eventId=\{event\.id\} batches=\{batches\} categories=\{categories\} \/>/);
});

test('server actions usam somente as RPCs do fluxo multi-lote', async () => {
  const source = await readFile(actionsPath, 'utf8');
  assert.match(source, /export async function createSingleTicketBatchAction/);
  assert.match(source, /export async function updateSingleTicketBatchAction/);
  assert.match(source, /export async function setSingleTicketBatchGenderClosedAction/);
  assert.match(source, /supabase\.rpc\('create_single_ticket_batch'/);
  assert.match(source, /supabase\.rpc\('update_single_ticket_batch'/);
  assert.match(source, /supabase\.rpc\('set_single_ticket_batch_gender_closed'/);
  assert.doesNotMatch(source, /export async function setEventSingleTicketPriceAction/);
});

test('migration resolve lote elegivel por genero e preserva o fluxo com categoria', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /create or replace function public\.resolve_single_ticket_batch_for_gender/);
  assert.match(source, /rb\.male_closed else rb\.female_closed/);
  assert.match(source, /oi\.pricing_gender = v_gender/);
  assert.match(source, /order by \(case when v_gender = 'male' then rb\.male_price else rb\.female_price end\) asc/);
  assert.match(source, /get_registration_pricing_preview_categorized_legacy/);
});

test('batch_id persistido acompanha o genero de cada item quando lotes divergem', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /create or replace function public\.assign_single_ticket_batch_by_gender\(\)/);
  assert.match(source, /resolve_single_ticket_batch_for_gender\(new\.event_id, new\.pricing_gender\)/);
  assert.match(source, /new\.batch_id := v_batch\.id/);
  assert.match(source, /before insert or update of event_id, ticket_category_id, pricing_gender, batch_id/);
});

test('RPCs administrativas exigem permissao e acesso a organizacao', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /current_user_has_permission\('events\.view'\)/);
  assert.match(source, /current_user_has_permission\('events\.edit'\)/);
  assert.match(source, /user_can_access_organization\(v_actor, v_event\.organization_id\)/);
  assert.match(source, /revoke all on function public\.resolve_single_ticket_batch_for_gender\(uuid, text\) from public, anon, authenticated/);
});
