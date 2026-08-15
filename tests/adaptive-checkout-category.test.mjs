import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wizardPath = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const actionsPath = new URL('../src/app/inscricao/actions.ts', import.meta.url);
const migrationPath = new URL('../supabase/migrations/20260815006000_adaptive_categoryless_checkout.sql', import.meta.url);
const reportPath = new URL('../src/lib/reports/queries/eventos.ts', import.meta.url);

test('wizard usa a lista canônica elegível para decidir se exibe seleção', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /categories\.filter\(\(category\) => category\.is_active[\s\S]*category\.available_slots[\s\S]*category\.current_batch_name/);
  assert.match(source, /const categorySelectionRequired = activeCategories\.length >= 2/);
  assert.match(source, /activeCategories\.length === 1[\s\S]*activeCategories\[0\]/);
  assert.match(source, /\{categorySelectionRequired \? \([\s\S]*name="category"/);
  assert.match(source, /const ticketTypeLabel = selectedCategory\?\.name \|\| 'Ingresso único'/);
});

test('mudança de configuração invalida categoria persistida', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /category_id: activeCategories\.length === 1/);
  assert.match(source, /activeCategories\.some\(\(category\) => category\.id === parsed\.form\.category_id\)/);
  assert.match(source, /activeCategories\.length >= 2[\s\S]*parsed\.form\.category_id[\s\S]*: ''/);
});

test('frontend envia categoria nullable e backend exige categoria apenas quando há opção elegível', async () => {
  const [actions, migration] = await Promise.all([
    readFile(actionsPath, 'utf8'),
    readFile(migrationPath, 'utf8'),
  ]);
  assert.match(actions, /ticket_category_id: string \| null/);
  assert.match(actions, /p_ticket_category_id: input\.ticket_category_id \? String\(input\.ticket_category_id\) : null/);
  assert.match(migration, /from public\.get_event_ticket_categories\(v_event_id\)/);
  assert.match(migration, /if v_eligible_categories>0 then[\s\S]*TICKET_CATEGORY_REQUIRED/);
  assert.match(migration, /v_batch\.female_price/);
  assert.match(migration, /v_batch\.male_price/);
});

test('relatório preserva ticket_category_id nulo como ingresso único', async () => {
  const source = await readFile(reportPath, 'utf8');
  assert.match(source, /item\.ticket_category_id \?\? "__single__"/);
  assert.match(source, /categoria: "Ingresso único"/);
  assert.doesNotMatch(source, /if \(!participant\.batch_id \|\| !participant\.ticket_category_id\) continue/);
});

test('forma de pagamento sem alternativa é aplicada sem seletor redundante', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /itemTotals\.total > 0 && availablePaymentMethods\.length >= 2/);
  assert.match(source, /Forma de pagamento: <strong>\{paymentMethodLabel\(form\.payment_method\)\}<\/strong>/);
});
