import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const managerPath = new URL('../src/app/painel/eventos/[id]/single-ticket-price-manager.tsx', import.meta.url);
const pagePath = new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url);
const actionsPath = new URL('../src/app/eventos/actions.ts', import.meta.url);
const migrationPath = new URL('../supabase/migrations/20260815006300_admin_single_ticket_price.sql', import.meta.url);

test('UI de preco do ingresso unico nunca expoe termos tecnicos', async () => {
  const source = await readFile(managerPath, 'utf8');
  assert.doesNotMatch(source, /flat_price_confirmed/);
  assert.doesNotMatch(source, /ticket_category_id/);
  assert.doesNotMatch(source, /set_event_single_ticket_price/);
  assert.doesNotMatch(source, /get_event_single_ticket_price_status/);
  assert.match(source, /Modelo de ingresso: Ingresso único/);
  assert.match(source, /Preço masculino/);
  assert.match(source, /Preço feminino/);
});

test('alerta de preco nao configurado e acionavel e so aparece com vendas abertas e sem confirmacao', async () => {
  const source = await readFile(managerPath, 'utf8');
  assert.match(source, /Preço do ingresso ainda não configurado/);
  assert.match(source, /Configurar agora/);
  assert.match(source, /const needsAttention = initialStatus\.registration_enabled && !priceConfirmed/);
});

test('preco zero e explicitamente permitido como ingresso gratuito, nunca bloqueado', async () => {
  const source = await readFile(managerPath, 'utf8');
  assert.match(source, /gratuito/i);
  assert.doesNotMatch(source, /malePrice (<=|===) 0/);
  assert.doesNotMatch(source, /femalePrice (<=|===) 0/);
});

test('apos salvar, a UI mostra "Preço configurado" e nao qualquer termo de cortesia', async () => {
  const source = await readFile(managerPath, 'utf8');
  assert.match(source, /Preço configurado/);
  assert.doesNotMatch(source, /[Cc]ortesia/);
});

test('pagina do evento decide entre ingresso unico e lotes por categoria pela contagem de categorias ATIVAS', async () => {
  const source = await readFile(pagePath, 'utf8');
  assert.match(source, /const activeCategoryCount = categories\.filter\(\(category: \{ is_active: boolean \}\) => category\.is_active\)\.length/);
  assert.match(source, /activeCategoryCount === 0 && singleTicketPriceStatus \? \(/);
  assert.match(source, /<SingleTicketPriceManager eventId={event\.id} initialStatus={singleTicketPriceStatus} \/>/);
  assert.match(source, /<BatchesManager eventId={event\.id} batches={batches} categories={categories} \/>/);
  assert.doesNotMatch(source, /Crie ao menos uma categoria antes de configurar lotes/, 'nao deve mais forcar criacao de categoria so para definir preco');
});

test('server actions expoem apenas o fluxo canonico de leitura e escrita do preco', async () => {
  const source = await readFile(actionsPath, 'utf8');
  assert.match(source, /export async function getEventSingleTicketPriceStatusAction/);
  assert.match(source, /export async function setEventSingleTicketPriceAction/);
  assert.match(source, /supabase\.rpc\('set_event_single_ticket_price'/);
});

test('migration fecha a experiencia administrativa: categorias ativas invalidam a confirmacao antiga', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /v_active_categories/);
  assert.match(source, /create or replace function public\.set_event_single_ticket_price/);
  assert.match(source, /create or replace function public\.get_event_single_ticket_price_status/);
  assert.match(source, /create trigger trg_invalidate_single_ticket_price/);
  assert.match(source, /after insert or update of is_active on public\.ticket_categories/);
  assert.match(source, /update public\.registration_batches set flat_price_confirmed=false/);
});
