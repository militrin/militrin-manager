import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const migrationUrl = new URL('../supabase/migrations/20260855000000_store_item_lifecycle_and_discount_pricing.sql', import.meta.url);
const couponEngineUrl = new URL('../supabase/migrations/20260836000000_cart_product_quantity_consolidation.sql', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

// Confirma que o ajuste ficou DENTRO da propria migration 55 (ainda nao
// aplicada) -- nenhuma migration 56 foi criada so pra corrigir isso.
test('a correcao esta na propria migration 55 -- nenhuma migration 56 foi criada', async () => {
  const fs = await import('node:fs/promises');
  const files = await fs.readdir(new URL('../supabase/migrations', import.meta.url));
  assert.ok(!files.some((f) => f.startsWith('20260856000000')), 'nao deveria existir migration 56 pra este ajuste');
  assert.ok(files.includes('20260855000000_store_item_lifecycle_and_discount_pricing.sql'));
});

// ============================================================
// Investigacao: order_items ja tem estrutura suficiente? So parcialmente --
// unit_price/discount_amount/final_amount sao insuficientes pra reconstruir
// o preco BASE do produto (discount_amount e exclusivo do motor de cupom).
// Por isso 1 campo novo, nulavel, so pra linhas de produto.
// ============================================================
test('investigacao: order_items ganha APENAS 1 campo novo (product_base_unit_price), nulavel -- discount_type/discount_value do produto NAO sao duplicados ali (reconstrutiveis por subtracao)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /alter table public\.order_items\s*\n\s*add column if not exists product_base_unit_price numeric\(10,2\);/);
  assert.doesNotMatch(sql, /alter table public\.order_items[\s\S]{0,200}add column if not exists discount_type/);
  assert.doesNotMatch(sql, /alter table public\.order_items[\s\S]{0,200}add column if not exists discount_value/);
});

test('order_item_discounts (tabela de snapshot de CUPOM) nao e reaproveitada nem alterada para o desconto do produto -- e exclusiva do cupom (coupon_id/coupon_code not null, unique por order_item_id)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(sql, /alter table public\.order_item_discounts/);
  assert.doesNotMatch(sql, /insert into public\.order_item_discounts/);
  assert.doesNotMatch(sql, /update public\.order_item_discounts/);
});

// ============================================================
// produto sem desconto / desconto percentual / desconto fixo / 100% no
// compre junto -- add_product_to_cart_order chama compute_store_item_final_
// price com os MESMOS parametros usados pela loja solo e pela concessao.
// ============================================================
test('add_product_to_cart_order calcula v_base_unit_price (preco + ajuste de variante) e aplica compute_store_item_final_price -- mesma funcao da loja solo, nenhum calculo duplicado', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'add_product_to_cart_order');
  assert.match(fn, /v_base_unit_price := v_store_item\.price;/);
  assert.match(fn, /v_base_unit_price := v_base_unit_price \+ coalesce\(v_variant\.price_adjustment, 0\);/);
  assert.match(fn, /v_unit_price := public\.compute_store_item_final_price\(v_base_unit_price, v_store_item\.discount_type, v_store_item\.discount_value\);/);
});

test('produto SEM desconto: discount_type e null -- compute_store_item_final_price (ja testada) devolve o proprio preco base quando discount_type nao e stock/fixed, entao unit_price = v_base_unit_price', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const computeFn = sql.match(/create or replace function public\.compute_store_item_final_price[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(computeFn, /else p_unit_price\s*\n\s*end/);
});

test('add_product_to_cart_order grava unit_price (JA promocional) e product_base_unit_price (preco antes do desconto proprio) tanto no INSERT quanto no UPDATE (consolidacao de quantidade)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'add_product_to_cart_order');
  assert.match(fn, /set quantity = v_new_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,\s*\n\s*final_amount = round\(v_unit_price \* v_new_quantity, 2\), updated_at = now\(\)/);
  assert.match(fn, /insert into public\.order_items\(order_id, event_id, item_kind, store_item_id, store_item_variant_id, quantity, unit_price, product_base_unit_price, discount_amount, final_amount, status, ownership_status\)/);
  assert.match(fn, /values\(p_order_id, v_order\.event_id, 'product', v_store_item\.id, p_variant_id, p_quantity, v_unit_price, v_base_unit_price, 0, round\(v_unit_price \* p_quantity, 2\), 'reserved', 'unassigned'\)/);
});

test('desconto 100%: compute_store_item_final_price ja garante piso em 0 (greatest) -- add_product_to_cart_order nao precisa de logica extra pra esse caso, reaproveita a mesma protecao', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const computeFn = sql.match(/create or replace function public\.compute_store_item_final_price[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(computeFn, /select greatest\(/);
  const addToCart = extractFunction(sql, 'add_product_to_cart_order');
  assert.doesNotMatch(addToCart, /greatest\(/); // nao duplica a protecao -- confia inteiramente na funcao centralizada
});

// ============================================================
// produto com desconto + cupom -- ordem deterministica: 1) preco original,
// 2) desconto proprio (baked em unit_price por add_product_to_cart_order),
// 3) cupom (calculado por apply_cart_coupon sobre unit_price*quantity,
// SEM alteracao), 4) preco final. Exemplo do enunciado: R$100 -10% = R$90;
// cupom 20% sobre R$90 = R$72.
// ============================================================
test('apply_cart_coupon (motor de cupom) NAO foi redefinida nesta migration -- preservado exatamente como estava, so o INSUMO (unit_price) que ela recebe mudou', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(sql, /create (or replace )?function public\.apply_cart_coupon/);
});

test('apply_cart_coupon calcula o subtotal elegivel e o desconto de cupom sobre unit_price*quantity (v_line_subtotal) -- ao chegar ja promocional, o cupom incide automaticamente sobre o subtotal promocional, sem duplicar desconto', async () => {
  const sql = await readFile(couponEngineUrl, 'utf8');
  const fn = extractFunction(sql, 'apply_cart_coupon');
  assert.match(fn, /v_line_subtotal := round\(v_item\.unit_price \* coalesce\(v_item\.quantity, 1\), 2\);/);
  assert.match(fn, /v_total_subtotal := v_total_subtotal \+ v_line_subtotal;/);
});

test('add_product_to_cart_order chama apply_cart_coupon LOGO DEPOIS de gravar o unit_price ja promocional -- garante que um cupom ja aplicado no pedido e recalculado em cima do novo subtotal', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'add_product_to_cart_order');
  const insertIdx = fn.indexOf('insert into public.order_items');
  const couponIdx = fn.indexOf('perform public.apply_cart_coupon');
  assert.ok(insertIdx !== -1 && couponIdx !== -1 && couponIdx > insertIdx, 'apply_cart_coupon deveria rodar depois de gravar o item no carrinho');
});

test('exemplo do enunciado (R$100, desconto proprio 10%, cupom 20% => R$72) e matematicamente consistente com compute_store_item_final_price + a formula de apply_cart_coupon', () => {
  const computeFinal = (unitPrice, type, value) => {
    if (type === 'percentage') return Math.max(unitPrice * (1 - Math.min(value, 100) / 100), 0);
    if (type === 'fixed') return Math.max(unitPrice - value, 0);
    return unitPrice;
  };
  const baseUnitPrice = 100;
  const unitPriceAfterProductDiscount = computeFinal(baseUnitPrice, 'percentage', 10);
  assert.equal(unitPriceAfterProductDiscount, 90);
  const couponDiscountValue = 20; // cupom percentual de 20%, aplicado sobre o subtotal ja promocional
  const lineSubtotal = unitPriceAfterProductDiscount * 1;
  const couponDiscount = Math.round((lineSubtotal * couponDiscountValue) / 100 * 100) / 100;
  const finalAmount = Math.round((lineSubtotal - couponDiscount) * 100) / 100;
  assert.equal(couponDiscount, 18);
  assert.equal(finalAmount, 72);
});

// ============================================================
// snapshot permanece apos mudanca posterior do preco/desconto do produto
// ============================================================
test('snapshot permanece apos mudanca posterior do produto: product_base_unit_price e unit_price sao gravados como VALOR, nunca como referencia viva a store_items -- mudar store_items.price/discount depois nunca reescreve linhas ja existentes em order_items', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'add_product_to_cart_order');
  // So grava valores calculados (v_base_unit_price/v_unit_price), nunca uma
  // subquery/join dinamico contra store_items dentro do UPDATE/INSERT.
  const writeBlock = fn.slice(fn.indexOf('if found and v_existing.id is not null then'));
  assert.doesNotMatch(writeBlock, /select\s+.*\s+from public\.store_items/);
});

// ============================================================
// loja solo e compre junto produzem o mesmo preco antes de cupom
// ============================================================
test('loja solo (create_store_order) e compre junto (add_product_to_cart_order) chamam compute_store_item_final_price com os MESMOS insumos (preco+ajuste de variante, discount_type, discount_value do produto) -- mesmo resultado antes de cupom', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const createOrder = extractFunction(sql, 'create_store_order');
  const addToCart = extractFunction(sql, 'add_product_to_cart_order');
  assert.match(createOrder, /public\.compute_store_item_final_price\(v_unit_price, v_store_item\.discount_type, v_store_item\.discount_value\)/);
  assert.match(addToCart, /public\.compute_store_item_final_price\(v_base_unit_price, v_store_item\.discount_type, v_store_item\.discount_value\)/);
});

// ============================================================
// concessao administrativa cobrada usa o mesmo preco promocional; cortesia
// continua R$0
// ============================================================
test('admin_grant_store_item usa a MESMA compute_store_item_final_price -- concessao cobrada usa o mesmo preco promocional dos outros canais', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const grant = extractFunction(sql, 'admin_grant_store_item');
  assert.match(grant, /v_final_unit_price := public\.compute_store_item_final_price\(v_unit_price, v_store_item\.discount_type, v_store_item\.discount_value\);/);
});

test('cortesia administrativa continua R$0 independente do desconto do produto -- case coalesce(p_is_courtesy,false) then 0 tem prioridade sobre v_final_unit_price', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const grant = extractFunction(sql, 'admin_grant_store_item');
  assert.match(grant, /v_line_total := case when coalesce\(p_is_courtesy, false\) then 0 else round\(v_final_unit_price \* p_quantity, 2\) end;/);
  assert.match(grant, /case when coalesce\(p_is_courtesy, false\) then 0 else v_final_unit_price end\)/);
});

// ============================================================
// totais do pedido continuam corretos
// ============================================================
test('totais do pedido (orders.base_amount/discount_amount/final_amount e payments) continuam calculados por apply_cart_coupon, inalterada -- nenhuma duplicacao de logica de totais', async () => {
  const sql = await readFile(couponEngineUrl, 'utf8');
  const fn = extractFunction(sql, 'apply_cart_coupon');
  assert.match(fn, /update public\.orders set applied_coupon_id = v_coupon\.id, base_amount = v_total_subtotal,/);
  assert.match(fn, /update public\.payments set amount = v_total_subtotal, discount_amount = v_allocated,/);
});

test('set_cart_order_item_quantity tambem recalcula o preco JA promocional ao mudar quantidade (nao reverte pro preco cheio) e reaciona o cupom ja aplicado', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'set_cart_order_item_quantity');
  assert.match(fn, /v_unit_price := public\.compute_store_item_final_price\(v_base_unit_price, v_store_item\.discount_type, v_store_item\.discount_value\);/);
  assert.match(fn, /set quantity = p_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,/);
  assert.match(fn, /perform public\.apply_cart_coupon\(v_order\.id, \(select c\.code from public\.coupons c where c\.id = v_order\.applied_coupon_id\)\);/);
});

test('regras existentes de estoque (reserve_store_item_stock) e visibilidade continuam intocadas em add_product_to_cart_order -- so o calculo de preco mudou', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'add_product_to_cart_order');
  assert.match(fn, /perform public\.reserve_store_item_stock\(v_store_item\.id, p_variant_id, p_quantity\);/);
  assert.match(fn, /if v_store_item\.visibility <> 'public' then raise exception 'Produto nao esta disponivel para compra publica\.'; end if;/);
});
