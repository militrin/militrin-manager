import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolvePricingPreviewGender } from '../src/lib/checkout/pricing.ts';

const managerPath = new URL('../src/app/painel/eventos/[id]/single-ticket-batches-manager.tsx', import.meta.url);
const pagePath = new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url);
const actionsPath = new URL('../src/app/eventos/actions.ts', import.meta.url);
const pickerPath = new URL('../src/app/painel/eventos/[id]/ticket-sale-model-picker.tsx', import.meta.url);
const wizardPath = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const legacyMigrationPath = new URL('../supabase/migrations/20260865000000_single_ticket_multi_batch_gender_split.sql', import.meta.url);
const unisexMigrationPath = new URL('../supabase/migrations/20260955000000_single_ticket_unisex_lots.sql', import.meta.url);

test('UI de ingresso unico novo usa um preco, um limite e encerrar lote', async () => {
  const source = await readFile(managerPath, 'utf8');
  assert.match(source, /\+ Adicionar lote/);
  assert.match(source, /Esgotar \/ Encerrar lote/);
  assert.match(source, /createSingleTicketUnisexBatchAction/);
  assert.match(source, /setSingleTicketBatchClosedAction/);
});

test('lote legado gender-split continua editavel com masculino/feminino', async () => {
  const source = await readFile(managerPath, 'utf8');
  assert.match(source, /batch\.genderSplit/);
  assert.match(source, /Preço masculino/);
  assert.match(source, /Preço feminino/);
  assert.match(source, /Limite masculino/);
  assert.match(source, /Limite feminino/);
  assert.match(source, /Esgotar \/ Encerrar masculino/);
  assert.match(source, /Esgotar \/ Encerrar feminino/);
  assert.match(source, /Reabrir masculino/);
  assert.match(source, /Reabrir feminino/);
  assert.match(source, /maleMax <= 0/);
  assert.match(source, /femaleMax <= 0/);
});

test('preco zero continua permitido no lote unissex e limite precisa ser positivo', async () => {
  const source = await readFile(managerPath, 'utf8');
  assert.match(source, /max <= 0/);
  assert.doesNotMatch(source, /price (?:<=|===) 0/);
});

test('pagina escolhe o gerenciador pela contagem de categorias ativas e expoe o modelo', async () => {
  const source = await readFile(pagePath, 'utf8');
  assert.match(source, /const activeCategoryCount = categories\.filter\(\(category: \{ is_active: boolean \}\) => category\.is_active\)\.length/);
  assert.match(source, /activeCategoryCount === 0 \? \(/);
  assert.match(source, /<SingleTicketBatchesManager eventId=\{event\.id\} batches=\{singleTicketBatches\} \/>/);
  assert.match(source, /<BatchesManager eventId=\{event\.id\} batches=\{batches\} categories=\{categories\}/);
  assert.match(source, /<TicketSaleModelPicker eventId=\{event\.id\} activeCategoryCount=\{activeCategoryCount\} \/>/);
});

test('admin escolhe ingresso unico ou por categorias sem campo redundante', async () => {
  const source = await readFile(pickerPath, 'utf8');
  assert.match(source, /Modelo de ingresso/);
  assert.match(source, /Ingresso único/);
  assert.match(source, /Por categorias/);
  assert.match(source, /setEventTicketSaleModelAction/);
  assert.match(source, /activeCategoryCount === 0/);
});

test('server actions de ingresso unico unissex usam RPCs novas e preservam as de split', async () => {
  const source = await readFile(actionsPath, 'utf8');
  assert.match(source, /export async function createSingleTicketUnisexBatchAction/);
  assert.match(source, /export async function updateSingleTicketUnisexBatchAction/);
  assert.match(source, /export async function setSingleTicketBatchClosedAction/);
  assert.match(source, /export async function setEventTicketSaleModelAction/);
  assert.match(source, /supabase\.rpc\('create_single_ticket_unisex_batch'/);
  assert.match(source, /supabase\.rpc\('update_single_ticket_unisex_batch'/);
  assert.match(source, /supabase\.rpc\('set_single_ticket_batch_closed'/);
  assert.match(source, /supabase\.rpc\('create_single_ticket_batch'/);
  assert.match(source, /supabase\.rpc\('update_single_ticket_batch'/);
  assert.match(source, /supabase\.rpc\('set_single_ticket_batch_gender_closed'/);
});

test('migration 55 resolve lote unissex sem genero e nao converte split legado', async () => {
  const source = await readFile(unisexMigrationPath, 'utf8');
  assert.match(source, /create or replace function public\.resolve_single_ticket_batch_for_gender/);
  assert.match(source, /rb\.male_max_confirmed_registrations is null/);
  assert.match(source, /create or replace function public\.create_single_ticket_unisex_batch/);
  assert.match(source, /male_max_confirmed_registrations, female_max_confirmed_registrations/);
  assert.match(source, /create or replace function public\.get_public_single_ticket_offer/);
  assert.match(source, /Este lote e ingresso unico unissex/);
  assert.match(source, /create or replace function public\.set_event_ticket_sale_model/);
  assert.match(source, /v_unisex := v_batch\.male_max_confirmed_registrations is null/);
});

test('migration 65 de split por genero permanece como contrato legado', async () => {
  const source = await readFile(legacyMigrationPath, 'utf8');
  assert.match(source, /create or replace function public\.create_single_ticket_batch/);
  assert.match(source, /oi\.pricing_gender = v_gender/);
  assert.match(source, /get_registration_pricing_preview_categorized_legacy/);
});

test('checkout de ingresso unico unissex nao pede genero como tipo de ingresso', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /singleTicketUnisex/);
  assert.match(source, /singleTicketUnisex \? null/);
  assert.match(source, /singleTicketUnisex \? 'male'/);
});

test('preview de preco unissex nao espera genero do comprador', () => {
  assert.equal(resolvePricingPreviewGender({}, null, { unisex: true }), 'male');
  assert.equal(resolvePricingPreviewGender({}, null), null);
});

test('importacao nao marca genderRequiredForPricing; so exige genero quando precos M/F divergem', async () => {
  const source = await readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8');
  assert.match(source, /genderRequiredForPricing: false/);
  assert.match(source, /price\.malePrice !== price\.femalePrice && !row\.gender/);
  assert.match(source, /missing_required_for_pricing/);
  assert.doesNotMatch(source, /genderRequiredForPricing:\s*true/);
});
