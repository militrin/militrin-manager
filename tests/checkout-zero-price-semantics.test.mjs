import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { describeZeroPaymentReason } from '../src/lib/checkout/pricing.ts';

const wizardPath = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const actionsPath = new URL('../src/app/inscricao/actions.ts', import.meta.url);
const migrationPath = new URL('../supabase/migrations/20260815006200_fix_adaptive_checkout_zero_price.sql', import.meta.url);

test('ingresso pago sem cupom nunca e rotulado como gratuito, cupom ou cortesia', () => {
  const result = describeZeroPaymentReason({ baseAmount: 200, discountAmount: 0, finalAmount: 200, paymentMethod: 'pix', couponApplied: false });
  assert.equal(result, null);
});

test('ingresso pago com cupom parcial continua exigindo pagamento', () => {
  const result = describeZeroPaymentReason({ baseAmount: 200, discountAmount: 50, finalAmount: 150, paymentMethod: 'pix', couponApplied: true });
  assert.equal(result, null);
});

test('cupom de 100% e rotulado como cupom aplicado, nao cortesia', () => {
  const result = describeZeroPaymentReason({ baseAmount: 200, discountAmount: 200, finalAmount: 0, paymentMethod: 'pix', couponApplied: true });
  assert.equal(result?.reason, 'coupon');
  assert.match(result.message, /Cupom aplicado/);
});

test('ingresso realmente gratuito sem cupom e rotulado como gratuito, nao cortesia', () => {
  const result = describeZeroPaymentReason({ baseAmount: 0, discountAmount: 0, finalAmount: 0, paymentMethod: 'pix', couponApplied: false });
  assert.equal(result?.reason, 'free');
  assert.match(result.message, /Ingresso gratuito/);
});

test('campo de cupom vazio nunca produz rotulo de cupom mesmo com desconto zero e final zero', () => {
  const result = describeZeroPaymentReason({ baseAmount: 0, discountAmount: 0, finalAmount: 0, paymentMethod: 'pix', couponApplied: false });
  assert.notEqual(result?.reason, 'coupon');
});

test('cortesia administrativa so e assumida quando payment_method e courtesy explicitamente', () => {
  const result = describeZeroPaymentReason({ baseAmount: 0, discountAmount: 0, finalAmount: 0, paymentMethod: 'courtesy', couponApplied: false });
  assert.equal(result?.reason, 'courtesy');
});

test('final_amount positivo nunca gera mensagem, mesmo com metodo courtesy indevidamente presente', () => {
  const result = describeZeroPaymentReason({ baseAmount: 200, discountAmount: 0, finalAmount: 200, paymentMethod: 'courtesy', couponApplied: false });
  assert.equal(result, null);
});

test('wizard nao infere mais cortesia apenas de final_amount/itemTotals <= 0', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.doesNotMatch(source, /Cortesia/);
  assert.doesNotMatch(source, /final_amount <= 0 \? 'Cortesia aplicada/);
  assert.doesNotMatch(source, /itemTotals\.total <= 0 \? 'Cortesia/);
  assert.match(source, /describeZeroPaymentReason/);
});

test('falha ao calcular preco de um item nunca vira R$ 0,00 silencioso no wizard', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.doesNotMatch(source, /unitPrice: 0,\s*\n\s*discountAmount: 0,\s*\n\s*finalAmount: 0,\s*\n\s*visualStatus: 'missing',/);
  assert.match(source, /visualStatus: item\.pricingError\s*\n\s*\? 'pricing_error'/);
  assert.match(source, /if \(item\.pricingError\) itemErrors\.push\(item\.pricingError\)/);
});

test('action de inscricao unica usa a mesma semantica compartilhada de pagamento zero', async () => {
  const source = await readFile(actionsPath, 'utf8');
  assert.doesNotMatch(source, /final_amount \?\? 0\) <= 0 \? 'Cortesia aplicada\. Nenhum pagamento sera necessario\.' : null/);
  assert.match(source, /describeZeroPaymentReason/);
  assert.match(source, /couponApplied: Boolean\(input\.coupon_code\?\.trim\(\)\)/);
});

test('sessao do wizard e isolada por evento e por jornada de checkout (troca de evento ou nova compra nao reaproveita estado comercial)', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /`militrin:wizard:\$\{event\.id\}:\$\{journeyId\}:\$\{STORAGE_VERSION\}`/);
  assert.match(source, /journeyId \? `militrin:wizard:/);
});

test('refresh so reaplica preco/lote persistidos se a configuracao de categorias nao mudou', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /if \(parsed\.pricing && parsed\.categoryConfigurationKey === categoryConfigurationKey\) setPricing\(parsed\.pricing\);/);
  assert.match(source, /else setPricing\(null\);/);
});

test('migration de correcao nunca deixa ticket_category_id nulo virar preco zero silencioso', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /flat_price_confirmed boolean not null default false/);
  assert.match(source, /TICKET_CATEGORY_UNAVAILABLE/);
  assert.match(source, /BATCH_FLAT_PRICE_NOT_CONFIRMED/);
  assert.match(source, /if not coalesce\(v_batch\.flat_price_confirmed,false\) then/);
});
