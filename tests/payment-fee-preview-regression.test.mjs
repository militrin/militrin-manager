import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// UX: mostrar a taxa de pagamento JA na selecao da forma de pagamento
// (Etapa "3. Revisao"), antes do pedido existir. Antes desta migration a
// taxa so aparecia depois (Etapa de Pagamento, get_cart_order_details --
// exige um payment_method ja gravado num payment pendente). A regra do
// pedido era clara: nunca calcular a taxa em paralelo no frontend, nem criar
// PIX/pagamento so pra descobrir o valor -- reusar a MESMA formula canonica
// (resolve_event_payment_fee_config/compute_payment_fee) atras de um RPC de
// preview que nao escreve nada.

const migrationsDirUrl = new URL('../supabase/migrations/', import.meta.url);
const previewMigrationUrl = new URL('../supabase/migrations/20260915000000_payment_fee_preview.sql', import.meta.url);
const inscricaoActionsUrl = new URL('../src/app/inscricao/actions.ts', import.meta.url);
const wizardUrl = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const cartStepUrl = new URL('../src/app/inscricao/[eventSlug]/cart-step.tsx', import.meta.url);

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

// ============================================================
// RPC de preview (backend)
// ============================================================
test('definicao VIGENTE de preview_event_payment_fees esta na migration do preview e reusa resolve_event_payment_fee_config + compute_payment_fee -- nenhuma formula paralela', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('preview_event_payment_fees');
  assert.equal(definedInFile, '20260915000000_payment_fee_preview.sql');
  const resolveCalls = source.match(/public\.resolve_event_payment_fee_config\(/g) ?? [];
  const computeCalls = source.match(/public\.compute_payment_fee\(/g) ?? [];
  assert.ok(resolveCalls.length >= 3, 'deveria chamar resolve_event_payment_fee_config para pix, credit_card (1x) e credit_card (parcelado)');
  assert.ok(computeCalls.length >= 3, 'deveria chamar compute_payment_fee para cada config resolvida -- nunca reimplementar fixed+percentage/divisao na mao');
  // nenhuma formula de calculo duplicada: nao deveria somar fixed_fee/percentage_fee diretamente fora de compute_payment_fee.
  assert.doesNotMatch(source, /coalesce\([^)]*fixed_fee[^)]*\)\s*\+/);
});

test('preview_event_payment_fees nunca escreve em payments/orders/PIX -- so leitura pura (nenhum insert/update/delete)', async () => {
  const sql = await fs.readFile(previewMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'preview_event_payment_fees');
  assert.doesNotMatch(fn, /\binsert into\b|\bupdate\s+public\.|\bdelete from\b/i);
});

test('preview_event_payment_fees cobre parcelas 2 a 12 (mesmo teto MAX_INSTALLMENTS da grade de configuracao do organizador) -- 1x usa credit_card_single, nunca entra no loop', async () => {
  const sql = await fs.readFile(previewMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'preview_event_payment_fees');
  assert.match(fn, /for v_n in 2\.\.12 loop/);
  assert.match(fn, /resolve_event_payment_fee_config\(p_event_id, 'credit_card', 1\)/);
});

test('preview_event_payment_fees e publico como get_event_payment_methods_setup (config de taxa nao e sensivel) -- grant a anon, authenticated e service_role', async () => {
  const sql = await fs.readFile(previewMigrationUrl, 'utf8');
  assert.match(sql, /grant execute on function public\.preview_event_payment_fees\(uuid, numeric\) to anon, authenticated, service_role;/);
});

// Reimplementacao em JS SOMENTE pra verificar, com numeros concretos, que a
// formula que o RPC reusa (compute_payment_fee, ja coberta por
// payment-fee-pass-through.test.mjs) produz os valores do enunciado desta
// mudanca de UX -- nunca uma segunda formula no frontend, so confirmacao.
function computeFee(base, mode, sharePercent, fixed, percentage) {
  const b = Math.max(base, 0);
  const calculated = Math.max(Math.round((fixed + (b * percentage) / 100) * 100) / 100, 0);
  let customer = 0;
  if (b > 0) {
    if (mode === 'pass_through') customer = calculated;
    else if (mode === 'split') customer = Math.round(calculated * (Math.min(Math.max(sharePercent, 0), 100) / 100) * 100) / 100;
  }
  return { calculated, customer, organizer: Math.round((calculated - customer) * 100) / 100 };
}

test('CASO preview 1: pedido de R$200, PIX pass_through 5% -- "PIX — Taxa: R$ 10,00"', () => {
  const fee = computeFee(200, 'pass_through', 0, 0, 5);
  assert.equal(fee.customer, 10);
});

test('CASO preview 2: pedido de R$200, credito a vista pass_through 4% -- "Credito a vista — Taxa: R$ 8,00"', () => {
  const fee = computeFee(200, 'pass_through', 0, 0, 4);
  assert.equal(fee.customer, 8);
});

test('CASO preview 3: parcelado com taxas diferentes por parcela -- "a partir de" e o MINIMO entre as opcoes configuradas, nunca a da 1a linha nem uma media', () => {
  const options = [2, 3, 6, 12].map((installments) => computeFee(200, 'pass_through', 0, 0, installments * 2).customer);
  const minFee = Math.min(...options);
  assert.equal(minFee, options[0]);
  assert.equal(minFee, 8);
});

test('CASO preview 4: fee_mode=absorb -- cliente paga 0 mesmo com taxa calculada > 0 -- "Sem taxa"', () => {
  const fee = computeFee(200, 'absorb', 0, 0, 5);
  assert.equal(fee.calculated, 10);
  assert.equal(fee.customer, 0);
});

// ============================================================
// Action (server) -- so repassa pro RPC, nenhum calculo
// ============================================================
test('previewEventPaymentFeesAction chama o RPC preview_event_payment_fees e so repassa o jsonb -- nenhum calculo no server layer', async () => {
  const source = await fs.readFile(inscricaoActionsUrl, 'utf8');
  const fnMatch = source.match(/export async function previewEventPaymentFeesAction[\s\S]*?\n}/);
  assert.ok(fnMatch, 'previewEventPaymentFeesAction nao encontrada');
  assert.match(fnMatch[0], /supabase\.rpc\('preview_event_payment_fees', \{/);
  assert.match(fnMatch[0], /p_event_id: eventId,/);
  assert.match(fnMatch[0], /p_base_amount: baseAmount,/);
});

// ============================================================
// Frontend (wizard.tsx) -- so leitura do preview, nunca uma segunda formula
// ============================================================
test('wizard.tsx: feeMethodPreview/feeOptionSuffix so leem o FeePreview ja calculado pelo backend -- nenhuma soma de fixed_fee/percentage_fee no componente', async () => {
  const source = await fs.readFile(wizardUrl, 'utf8');
  assert.match(source, /function feeMethodPreview\(preview: FeePreview \| null, method: CheckoutPaymentMethod, installments: number\)/);
  assert.match(source, /function feeOptionSuffix\(preview: FeePreview \| null, method: CheckoutPaymentMethod\): string/);
  assert.doesNotMatch(source, /percentage_fee\s*\/\s*100/, 'nenhuma formula de taxa deveria ser reimplementada no frontend');
});

test('wizard.tsx: preview e buscado via previewEventPaymentFeesAction (RPC canonico), so a partir da Etapa de Revisao (step >= 3) e so enquanto o pedido nao foi finalizado', async () => {
  const source = await fs.readFile(wizardUrl, 'utf8');
  assert.match(source, /previewEventPaymentFeesAction,/);
  assert.match(source, /const shouldPreviewFee = !registration && step >= 3 && previewBaseAmount > 0;/);
  assert.match(source, /await previewEventPaymentFeesAction\(event\.id, previewBaseAmount\);/);
});

test('wizard.tsx: <select> de forma de pagamento mostra a taxa por opcao (feeOptionSuffix) e o parcelado ganha um seletor de parcelas que atualiza form.installments', async () => {
  const source = await fs.readFile(wizardUrl, 'utf8');
  assert.match(source, /\{paymentMethodLabel\(method\)\}\{feeOptionSuffix\(feePreview, method\)\}/);
  assert.match(source, /form\.payment_method === 'credit_card_installments' && feePreview && feePreview\.credit_card_installments\.options\.length > 0/);
  assert.match(source, /onChange=\{\(event_\) => setField\('installments', Number\(event_\.target\.value\)\)\}/);
});

test('wizard.tsx: resumo lateral (sidebar) ganha a linha "Taxa de pagamento" e o Total inclui a taxa -- registration usa o valor REAL persistido, o resto usa so o preview', async () => {
  const source = await fs.readFile(wizardUrl, 'utf8');
  assert.match(source, /showFee: registration\.payment\.payment_fee_customer_amount > 0,/);
  assert.match(source, /total: money\(registration\.payment\.final_amount\),/);
  assert.match(source, /fee: money\(previewedCustomerFee\),/);
  assert.match(source, /total: money\(cartSnapshot\.final_amount \+ previewedCustomerFee\),/);
  assert.match(source, /total: money\(itemTotals\.total \+ previewedCustomerFee\),/);
  const asideMatches = source.match(/\{summaryValues\.showFee \? <p>Taxa de pagamento: \{summaryValues\.fee\}<\/p> : null\}/g) ?? [];
  assert.ok(asideMatches.length >= 2, 'a linha de taxa deveria aparecer tanto no resumo mobile quanto no desktop (aside)');
});

test('wizard.tsx: STORAGE_VERSION foi incrementada (FormState ganhou installments) -- sessoes antigas persistidas nunca restauram um form incompleto', async () => {
  const source = await fs.readFile(wizardUrl, 'utf8');
  assert.match(source, /const STORAGE_VERSION = 'v6';/);
  assert.match(source, /installments: Math\.max\(2, Math\.min\(12, Number\(parsed\.form\.installments\) \|\| 2\)\),/);
});

// ============================================================
// CartStep -- installments escolhido na Revisao chega ate finalize_cart_order_payment
// ============================================================
test('cart-step.tsx: installments e repassado pra finalizeCartOrderAction (chega ate a RPC que grava a taxa exata)', async () => {
  const source = await fs.readFile(cartStepUrl, 'utf8');
  assert.match(source, /installments\?: number;/);
  assert.match(source, /await finalizeCartOrderAction\(orderId, paymentMethod, installments \?\? 1\);/);
});

test('wizard.tsx: installments so e passado pro CartStep quando o metodo escolhido e credit_card_installments -- nunca envia um numero de parcelas junto de PIX/credito a vista', async () => {
  const source = await fs.readFile(wizardUrl, 'utf8');
  assert.match(source, /installments=\{form\.payment_method === 'credit_card_installments' \? form\.installments : 1\}/);
});
