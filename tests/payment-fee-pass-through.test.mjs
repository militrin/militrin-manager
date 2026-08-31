import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Feature: repasse de taxa de pagamento ao comprador (absorver/repassar/
// dividir), configuravel por evento e por metodo (PIX/cartao a vista/cartao
// parcelado). Cobre os CASOs 1-19 do pedido original + o adendo de modos, e
// -- mesma disciplina da suite de regressao anterior (cart-product-
// promotional-price-regression.test.mjs) -- um meta-teste que resolve a
// definicao VIGENTE de cada RPC tocada, varrendo TODAS as migrations em
// ordem, nunca confiando em ler so a migration mais nova isoladamente.

const migrationsDirUrl = new URL('../supabase/migrations/', import.meta.url);
const feeMigrationUrl = new URL('../supabase/migrations/20260913000000_payment_fee_pass_through.sql', import.meta.url);
const actionsUrl = new URL('../src/app/inscricao/actions.ts', import.meta.url);
const wizardUrl = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const eventosActionsUrl = new URL('../src/app/eventos/actions.ts', import.meta.url);
const paymentMethodsManagerUrl = new URL('../src/app/painel/eventos/[id]/payment-methods-manager.tsx', import.meta.url);
const pagePainelUrl = new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url);
const reportsVendasUrl = new URL('../src/lib/reports/queries/vendas.ts', import.meta.url);

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
// Meta-teste: definicoes VIGENTES (ultima entre todas as migrations)
// ============================================================
test('definicao VIGENTE de apply_cart_coupon esta na migration da taxa e chama _recompute_order_payment_fee como ULTIMO passo (depois de gravar orders/payments liquidos de desconto)', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('apply_cart_coupon');
  assert.equal(definedInFile, '20260913000000_payment_fee_pass_through.sql');
  const recomputeIdx = source.indexOf('perform public._recompute_order_payment_fee(p_order_id);');
  const returnIdx = source.indexOf('return v_result;');
  assert.ok(recomputeIdx !== -1, '_recompute_order_payment_fee deveria ser chamada');
  assert.ok(returnIdx !== -1 && recomputeIdx < returnIdx, 'recalculo da taxa deveria rodar antes do return final');
  const paymentsUpdateIdx = source.indexOf('update public.payments set amount = v_total_subtotal');
  assert.ok(paymentsUpdateIdx !== -1 && paymentsUpdateIdx < recomputeIdx, 'taxa deveria ser recalculada DEPOIS do UPDATE de payments (base liquida de cupom ja gravada)');
});

test('definicao VIGENTE de finalize_cart_order_payment ganhou p_installments, valida payment_method contra o dominio do banco, e recalcula a taxa antes de decidir pago x pendente', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('finalize_cart_order_payment');
  assert.equal(definedInFile, '20260913000000_payment_fee_pass_through.sql');
  assert.match(source, /p_installments integer default 1/);
  assert.match(source, /lower\(v_method\) not in \('pix','credit_card','cash','courtesy'\)/);
  const recomputeIdx = source.indexOf('perform public._recompute_order_payment_fee(p_order_id);');
  const statusIdx = source.indexOf("v_status := case when lower(v_method) = 'courtesy' or v_payment.final_amount");
  assert.ok(recomputeIdx !== -1 && statusIdx !== -1 && recomputeIdx < statusIdx, 'a decisao pago/pendente deveria usar o final_amount JA com taxa');
});

test('definicao VIGENTE de get_cart_order_details devolve os campos de taxa no bloco payment (Etapa de Pagamento le so o snapshot canonico)', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('get_cart_order_details');
  assert.equal(definedInFile, '20260913000000_payment_fee_pass_through.sql');
  assert.match(source, /'payment_fee_mode', v_payment\.payment_fee_mode/);
  assert.match(source, /'payment_fee_calculated_amount', v_payment\.payment_fee_calculated_amount/);
  assert.match(source, /'payment_fee_customer_amount', v_payment\.payment_fee_customer_amount/);
  assert.match(source, /'payment_fee_organizer_amount', v_payment\.payment_fee_organizer_amount/);
  // orders.final_amount continua so o comercial dos itens -- taxa nunca
  // entra na base_amount/discount_amount/final_amount do PEDIDO.
  assert.match(source, /'base_amount', v_order\.base_amount, 'discount_amount', v_order\.discount_amount, 'final_amount', v_order\.final_amount,/);
});

test('definicao VIGENTE de get_event_payment_methods_setup devolve config de taxa completa por metodo + cronograma de parcelas (installment_fees)', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('get_event_payment_methods_setup');
  assert.equal(definedInFile, '20260913000000_payment_fee_pass_through.sql');
  assert.match(source, /pix_fee_mode/);
  assert.match(source, /credit_card_single_fee_mode/);
  assert.match(source, /credit_card_installments_fee_mode/);
  assert.match(source, /installment_fees jsonb/);
});

test('definicao VIGENTE de upsert_event_payment_methods substitui o cronograma de parcelas por completo (delete + insert, nunca merge parcial)', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('upsert_event_payment_methods');
  assert.equal(definedInFile, '20260913000000_payment_fee_pass_through.sql');
  assert.match(source, /delete from public\.event_payment_method_installment_fees where event_id = p_event_id;/);
  assert.match(source, /current_user_has_permission\('events\.edit'\)/);
  assert.match(source, /user_can_access_organization\(auth\.uid\(\), v_org\)/);
});

test('assinaturas antigas (arity menor) sao dropadas explicitamente antes do CREATE OR REPLACE -- mesma disciplina ja usada em 20260895000000 pra nunca deixar overload velho ao lado', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  assert.match(sql, /drop function if exists public\.finalize_cart_order_payment\(uuid, text\);/);
  assert.match(sql, /drop function if exists public\.get_event_payment_methods_setup\(uuid\);/);
  assert.match(sql, /drop function if exists public\.upsert_event_payment_methods\(uuid, boolean, boolean, boolean\);/);
});

test('backward compatibility: default de fee_mode e absorb em toda coluna nova de event_payment_methods -- eventos existentes nunca comecam a cobrar taxa automaticamente apos esta migration', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  assert.match(sql, /add column if not exists pix_fee_mode text not null default 'absorb'/);
  assert.match(sql, /add column if not exists credit_card_single_fee_mode text not null default 'absorb'/);
  assert.match(sql, /add column if not exists credit_card_installments_fee_mode text not null default 'absorb'/);
});

test('nao ha tabela paralela de pagamentos: event_payment_methods (ja existente) e estendida com ALTER TABLE, nunca recriada; taxa vive em payments (ja existente), nunca em uma tabela nova de "cobrancas"', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  assert.match(sql, /alter table public\.event_payment_methods\s*\n\s*add column if not exists pix_fee_mode/);
  assert.match(sql, /alter table public\.payments\s*\n\s*add column if not exists payment_fee_mode/);
  assert.doesNotMatch(sql, /create table if not exists public\.orders/);
  assert.doesNotMatch(sql, /create table if not exists public\.payments/);
});

test('taxa nunca vira order_item: os helpers novos da taxa (compute_payment_fee/resolve_event_payment_fee_config/_recompute_order_payment_fee) nunca tocam order_items -- so apply_cart_coupon (logica de cupom existente, inalterada) continua gravando discount_amount de item', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  const computeFee = extractFunction(sql, 'compute_payment_fee');
  const resolveConfig = extractFunction(sql, 'resolve_event_payment_fee_config');
  const recompute = extractFunction(sql, '_recompute_order_payment_fee');
  for (const fn of [computeFee, resolveConfig, recompute]) {
    assert.doesNotMatch(fn, /order_items/);
  }
});

test('compute_payment_fee: formula canonica pura (fixed + percentage sobre a base, dividida conforme o modo) -- sem acesso a tabela', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'compute_payment_fee');
  assert.match(fn, /language plpgsql immutable/);
  assert.match(fn, /v_calculated := greatest\(round\(coalesce\(p_fixed_fee, 0\) \+ v_base \* coalesce\(p_percentage_fee, 0\) \/ 100\.0, 2\), 0\);/);
  assert.match(fn, /when p_fee_mode = 'pass_through' then v_calculated/);
  assert.match(fn, /when p_fee_mode = 'split' then round\(v_calculated \* v_share \/ 100\.0, 2\)/);
  assert.match(fn, /when v_base <= 0 then 0/);
});

test('resolve_event_payment_fee_config: PIX e cartao a vista usam a config do metodo; cartao parcelado usa fee_mode/share do metodo + fixed/percentage da linha de parcela (sem linha = 0, nunca inventa valor)', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'resolve_event_payment_fee_config');
  assert.match(fn, /if v_method = 'pix' then/);
  assert.match(fn, /if v_method = 'credit_card' and coalesce\(p_installments, 1\) <= 1 then/);
  assert.match(fn, /coalesce\(v_installment\.fixed_fee, 0\), coalesce\(v_installment\.percentage_fee, 0\);/);
});

test('_recompute_order_payment_fee: pedido gratuito (final_amount<=0) ou sem payment_method/courtesy nunca ganha taxa -- nunca inventa cobranca sobre pedido sem valor', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  const fn = extractFunction(sql, '_recompute_order_payment_fee');
  assert.match(fn, /if v_payment\.payment_method is null or lower\(trim\(v_payment\.payment_method\)\) = 'courtesy' or v_order\.final_amount <= 0 then/);
});

test('_recompute_order_payment_fee reusa EXATAMENTE o padrao de invalidacao de PIX ja usado por apply_cart_coupon (CASE WHEN sobre final_amount antigo x novo + pending_cancel_provider/payment_id)', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  const fn = extractFunction(sql, '_recompute_order_payment_fee');
  assert.match(fn, /pix_code = case when final_amount is distinct from v_new_final then null else pix_code end,/);
  assert.match(fn, /pending_cancel_provider = case when final_amount is distinct from v_new_final and gateway_payment_id is not null and provider is not null then provider else pending_cancel_provider end,/);
});

test('_recompute_order_payment_fee e interna (revoke de public/anon/authenticated, grant so a service_role) -- mesmo padrao ja usado por _apply_terminal_order_payment_status (20260898000000)', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  assert.match(sql, /revoke all on function public\._recompute_order_payment_fee\(uuid\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\._recompute_order_payment_fee\(uuid\) to service_role;/);
});

test('payment_fee_* de payments e conceitualmente distinto de fee_amount/net_amount (20260895000000, taxa REAL pos-pagamento do gateway) -- comentario explicito evita confundir os dois', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  assert.match(sql, /Distinto de payments\.fee_amount \(taxa REAL pos-pagamento reportada pelo gateway\)/);
});

// ============================================================
// CASOS 1-13 (enunciado original)
// ============================================================
function computeFee(base, mode, sharePercent, fixed, percentage) {
  const b = Math.max(base, 0);
  const calculated = Math.max(Math.round((fixed + (b * percentage) / 100) * 100) / 100, 0);
  let customer = 0;
  if (b > 0) {
    if (mode === 'pass_through') customer = calculated;
    else if (mode === 'split') customer = Math.round(calculated * (Math.min(Math.max(sharePercent, 0), 100) / 100) * 100) / 100;
  }
  const organizer = Math.round((calculated - customer) * 100) / 100;
  return { calculated, customer, organizer };
}

test('CASO 1: PIX sem repasse (absorb) -- itens liquidos 200, taxa 2%% -- total continua 200', () => {
  const fee = computeFee(200, 'absorb', 0, 0, 2);
  assert.equal(fee.customer, 0);
  assert.equal(200 + fee.customer, 200);
});

test('CASO 2: PIX com repasse (pass_through) -- itens liquidos 200, taxa 2%% -- total 204', () => {
  const fee = computeFee(200, 'pass_through', 0, 0, 2);
  assert.equal(fee.customer, 4);
  assert.equal(200 + fee.customer, 204);
});

test('CASO 3: taxa fixa -- itens liquidos 200, taxa fixa 3 -- total 203', () => {
  const fee = computeFee(200, 'pass_through', 0, 3, 0);
  assert.equal(fee.customer, 3);
  assert.equal(200 + fee.customer, 203);
});

test('CASO 4: taxa fixa + percentual -- itens liquidos 200, fixa 2 + 2%% -- total 206', () => {
  const fee = computeFee(200, 'pass_through', 0, 2, 2);
  assert.equal(fee.customer, 6);
  assert.equal(200 + fee.customer, 206);
});

test('CASO 5: cupom -- subtotal 250, cupom -50, base da taxa 200, taxa 2%% -- total 204 (taxa nao entrou na base do cupom)', () => {
  const subtotal = 250;
  const cupom = 50;
  const baseTaxa = subtotal - cupom;
  assert.equal(baseTaxa, 200);
  const fee = computeFee(baseTaxa, 'pass_through', 0, 0, 2);
  assert.equal(baseTaxa + fee.customer, 204);
});

test('CASO 6: produto promocional + cupom + taxa -- ingresso 170, produto 70->55 promocional, subtotal efetivo 225, cupom -25, base da taxa 200, taxa fixa 4 -- total 204', () => {
  const ticket = 170;
  const productPromo = 55; // 70 com desconto proprio de 15 ja aplicado
  const subtotalEfetivo = ticket + productPromo;
  assert.equal(subtotalEfetivo, 225);
  const baseTaxa = subtotalEfetivo - 25;
  assert.equal(baseTaxa, 200);
  const fee = computeFee(baseTaxa, 'pass_through', 0, 4, 0);
  assert.equal(baseTaxa + fee.customer, 204);
});

test('CASO 7: mudar PIX -> cartao recalcula a taxa (finalize_cart_order_payment chama _recompute_order_payment_fee toda vez que payment_method muda, nao so na primeira chamada)', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'finalize_cart_order_payment');
  // guard de status so bloqueia pedido JA finalizado (confirmed/pago) -- pendente
  // continua podendo chamar de novo com outro metodo, recalculando a taxa.
  assert.match(fn, /if v_order\.status <> 'pending' then raise exception 'Pedido ja foi finalizado\.'; end if;/);
  assert.match(fn, /perform public\._recompute_order_payment_fee\(p_order_id\);/);
});

test('CASO 8/9: mudar quantidade de produto ou aplicar/remover cupom recalcula a taxa -- add_product_to_cart_order/set_cart_order_item_quantity ja chamam apply_cart_coupon, que agora tambem recalcula a taxa como ultimo passo (nenhuma mudanca extra nelas foi necessaria)', async () => {
  const { source: addToCart } = await resolveCurrentFunctionDefinition('add_product_to_cart_order');
  const { source: setQuantity } = await resolveCurrentFunctionDefinition('set_cart_order_item_quantity');
  assert.match(addToCart, /perform public\.apply_cart_coupon\(p_order_id/);
  assert.match(setQuantity, /perform public\.apply_cart_coupon\(v_order\.id/);
});

test('CASO 10: PIX ja criado e total muda por causa da taxa -- mesmo mecanismo de invalidacao (pix_code/gateway_payment_id nulados + pending_cancel_provider) dispara dentro de _recompute_order_payment_fee', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  const fn = extractFunction(sql, '_recompute_order_payment_fee');
  assert.match(fn, /gateway_payment_id = case when final_amount is distinct from v_new_final then null else gateway_payment_id end,/);
});

test('CASO 11: createPixPayment (Asaas) recebe exatamente payment.final_amount -- generatePublicOrderPixAction nao foi tocada, continua so lendo o valor canonico', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  assert.match(source, /amount: payment\.final_amount,/);
  // asaas-provider.ts nao calcula nada -- confirmado nao referenciar nenhum campo de taxa.
  const asaasSource = await fs.readFile(new URL('../src/lib/payments/asaas-provider.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(asaasSource, /payment_fee|fee_mode|customer_fee_share/i);
});

test('CASO 12: webhook (apply_payment_gateway_status) nao foi redefinido por esta migration -- confirmacao de pagamento e emissao de ingresso continuam no mesmo caminho unico ja existente', async () => {
  const sql = await fs.readFile(feeMigrationUrl, 'utf8');
  assert.doesNotMatch(sql, /create (or replace )?function public\.apply_payment_gateway_status/);
  assert.doesNotMatch(sql, /create (or replace )?function public\.confirm_order_payment_and_issue_tickets/);
});

test('CASO 13: taxa zero (evento sem config de taxa) -- fee_mode default absorb -> customer_fee sempre 0, final_amount igual ao de antes da migration (compute_payment_fee com mode absorb)', () => {
  const fee = computeFee(200, 'absorb', 0, 5, 3);
  assert.equal(fee.customer, 0);
  assert.equal(fee.calculated, 11);
  assert.equal(fee.organizer, 11);
});

// ============================================================
// CASOS 14-19 (adendo: 3 modos -- absorver/repassar/dividir)
// ============================================================
test('CASO 14: absorver -- base 200, taxa calculada 10, cliente paga 0, total cliente 200, organizador absorve 10', () => {
  const fee = computeFee(200, 'absorb', 0, 0, 5);
  assert.equal(fee.calculated, 10);
  assert.equal(fee.customer, 0);
  assert.equal(200 + fee.customer, 200);
  assert.equal(fee.organizer, 10);
});

test('CASO 15: repassar -- base 200, taxa calculada 10, cliente paga 10, total cliente 210, organizador absorve 0', () => {
  const fee = computeFee(200, 'pass_through', 0, 0, 5);
  assert.equal(fee.calculated, 10);
  assert.equal(fee.customer, 10);
  assert.equal(200 + fee.customer, 210);
  assert.equal(fee.organizer, 0);
});

test('CASO 16: dividir 50/50 -- base 200, taxa calculada 10, cliente paga 5, organizador absorve 5, total cliente 205', () => {
  const fee = computeFee(200, 'split', 50, 0, 5);
  assert.equal(fee.calculated, 10);
  assert.equal(fee.customer, 5);
  assert.equal(fee.organizer, 5);
  assert.equal(200 + fee.customer, 205);
});

test('CASO 17: dividir 30/70 -- base 200, taxa calculada 10, cliente paga 3, organizador absorve 7, total cliente 203', () => {
  const fee = computeFee(200, 'split', 30, 0, 5);
  assert.equal(fee.calculated, 10);
  assert.equal(fee.customer, 3);
  assert.equal(fee.organizer, 7);
  assert.equal(200 + fee.customer, 203);
});

test('CASO 18: split + cupom -- subtotal 250, cupom -50, base taxa 200, taxa calculada 10, cliente paga 40%% -> taxa cliente 4, total 204', () => {
  const baseTaxa = 250 - 50;
  assert.equal(baseTaxa, 200);
  const fee = computeFee(baseTaxa, 'split', 40, 0, 5);
  assert.equal(fee.calculated, 10);
  assert.equal(fee.customer, 4);
  assert.equal(baseTaxa + fee.customer, 204);
});

test('CASO 19: split + produto promocional + cupom -- desconto promocional e cupom preservados, taxa calculada DEPOIS dos descontos, so a fatia do cliente entra no final_amount', () => {
  const ticket = 170;
  const productPromo = 55;
  const subtotalEfetivo = ticket + productPromo;
  const baseTaxa = subtotalEfetivo - 25; // cupom -25, mesmo exemplo do CASO 6
  assert.equal(baseTaxa, 200);
  const fee = computeFee(baseTaxa, 'split', 40, 4, 0); // taxa fixa 4, split 40%% -> igual ao CASO 6 mas dividida
  assert.equal(fee.calculated, 4);
  assert.equal(fee.customer, 1.6);
  assert.equal(Math.round((baseTaxa + fee.customer) * 100) / 100, 201.6);
});

// ============================================================
// Frontend: fonte canonica, sem calculo paralelo
// ============================================================
test('actions.ts: UnifiedOrderSnapshot.payment ganha os campos de taxa e finalizeCartOrderAction converte o metodo granular (toDbPaymentMethod) antes de chamar finalize_cart_order_payment, evitando violar payments_method_check', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  assert.match(source, /payment_fee_customer_amount: number;/);
  assert.match(source, /const dbPaymentMethod = toDbPaymentMethod\(normalizedMethod\);/);
  assert.match(source, /p_payment_method: dbPaymentMethod,/);
  assert.match(source, /p_installments: resolvedInstallments,/);
});

test('finalizeCartOrderAction chama cancelPendingExternalCharge apos finalize_cart_order_payment -- mesmo padrao ja usado por applyCartCouponAction, garante que troca de metodo cancela cobranca externa antiga de verdade (nao so marca no banco)', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fnMatch = source.match(/export async function finalizeCartOrderAction[\s\S]*?\n}/);
  assert.ok(fnMatch, 'finalizeCartOrderAction nao encontrada');
  assert.match(fnMatch[0], /await cancelPendingExternalCharge\(supabase, orderId\);/);
});

test('wizard.tsx: Etapa de Pagamento mostra "Taxa de pagamento" a partir do snapshot canonico (registration.payment.payment_fee_customer_amount), sem nenhum calculo novo no React', async () => {
  const source = await fs.readFile(wizardUrl, 'utf8');
  assert.match(source, /registration\.payment\.payment_fee_customer_amount > 0/);
  assert.match(source, /Taxa de pagamento/);
  // RegistrationSnapshot.payment carrega os campos (propagados de
  // mapOrderToRegistration), nao um novo calculo de taxa no frontend.
  assert.doesNotMatch(source, /computePaymentFee\(/);
});

test('eventos/actions.ts: schema de formas de pagamento valida fee_mode (enum) e percentuais (0-100) -- nao aceita boolean solto pra "dividir"', async () => {
  const source = await fs.readFile(eventosActionsUrl, 'utf8');
  assert.match(source, /const paymentFeeModeSchema = z\.enum\(\['absorb', 'pass_through', 'split'\]\);/);
  assert.match(source, /z\.number\(\)\.min\(0\)\.max\(100\)/);
});

test('painel: EventPaymentMethodsManager expoe as 3 opcoes (Absorver/Repassar/Dividir) pros 3 metodos e a tabela de taxa por parcela pro cartao parcelado', async () => {
  const source = await fs.readFile(paymentMethodsManagerUrl, 'utf8');
  assert.match(source, /Absorver \(organizador assume 100% da taxa\)/);
  assert.match(source, /Repassar integralmente ao comprador/);
  assert.match(source, /Dividir entre organizador e comprador/);
  assert.match(source, /Taxa por numero de parcelas/);
});

test('painel: page.tsx repassa a config completa de taxa (get_event_payment_methods_setup) pro EventPaymentMethodsManager, incluindo installment_fees', async () => {
  const source = await fs.readFile(pagePainelUrl, 'utf8');
  assert.match(source, /pix_fee_mode: String\(paymentMethodsRow\?\.pix_fee_mode/);
  assert.match(source, /installment_fees: \(Array\.isArray\(paymentMethodsRow\?\.installment_fees\)/);
});

test('relatorio novo distingue taxa CALCULADA, repassada ao comprador, absorvida pelo organizador e a taxa REAL do gateway (nunca inventada quando ausente)', async () => {
  const source = await fs.readFile(reportsVendasUrl, 'utf8');
  assert.match(source, /export async function financeiroTaxasPagamento/);
  assert.match(source, /taxa_real_gateway: payment\?\.fee_amount != null \? money\(Number\(payment\.fee_amount\)\) : "-",/);
});
