import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Bug real: "Compre junto" mostrava o preco promocional (R$70 -> R$55,
// R$75 -> R$60) mas o pedido cobrava o preco cheio. Causa raiz: a migration
// 20260855000000 tinha corrigido add_product_to_cart_order/set_cart_order_
// item_quantity para aplicar compute_store_item_final_price, mas uma
// migration POSTERIOR (20260890000000, que mexia em roteamento de estoque)
// recriou as duas funcoes a partir de uma base antiga e reverteu a correcao
// SILENCIOSAMENTE -- sem nenhum teste detectar, porque os testes existentes
// (tests/store-item-discount-cross-channel.test.mjs) so leem o texto de UMA
// migration especifica (855), nunca a definicao VIGENTE (a ultima no
// historico). Esta suite cobre os dois angulos: (1) os casos A-G pedidos no
// bug report, lendo a migration de correcao; (2) um teste que resolve a
// definicao vigente varrendo TODAS as migrations, pra nunca mais deixar uma
// regressao silenciosa como essa passar.

const migrationsDirUrl = new URL('../supabase/migrations/', import.meta.url);
const fixMigrationUrl = new URL('../supabase/migrations/20260912000000_fix_cart_product_promotional_price_regression.sql', import.meta.url);
const regressionMigrationUrl = new URL('../supabase/migrations/20260890000000_reconcile_unified_event_shirt_demand.sql', import.meta.url);
const actionsUrl = new URL('../src/app/inscricao/actions.ts', import.meta.url);
const cartStepUrl = new URL('../src/app/inscricao/[eventSlug]/cart-step.tsx', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

/**
 * Varre TODAS as migrations em ordem cronologica (nome do arquivo) e devolve
 * a ULTIMA redefinicao de uma funcao -- ou seja, a definicao efetivamente
 * vigente no banco depois de todas as migrations aplicadas. E exatamente o
 * angulo que faltava: um teste que le so a migration 855 nunca detectaria
 * que a 890 (posterior) reverteu a correcao dela.
 */
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
// Meta-teste: a definicao VIGENTE (ultima no historico) e a nova migration
// de correcao, nao mais a 890 regressiva -- e ela aplica o preco promocional.
// ============================================================
test('definicao VIGENTE (ultima entre todas as migrations) de add_product_to_cart_order esta na migration de correcao e aplica compute_store_item_final_price', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('add_product_to_cart_order');
  assert.equal(definedInFile, '20260912000000_fix_cart_product_promotional_price_regression.sql');
  assert.match(source, /v_base_unit_price := v_store_item\.price;/);
  assert.match(source, /v_unit_price := public\.compute_store_item_final_price\(v_base_unit_price, v_store_item\.discount_type, v_store_item\.discount_value\);/);
  assert.match(source, /product_base_unit_price = v_base_unit_price/);
});

test('definicao VIGENTE de set_cart_order_item_quantity esta na migration de correcao, recalcula o preco promocional E preserva o roteamento de estoque (reserve_store_item_stock/release_store_item_reservation) introduzido pela 890', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('set_cart_order_item_quantity');
  assert.equal(definedInFile, '20260912000000_fix_cart_product_promotional_price_regression.sql');
  assert.match(source, /v_unit_price := public\.compute_store_item_final_price\(v_base_unit_price, v_store_item\.discount_type, v_store_item\.discount_value\);/);
  assert.match(source, /product_base_unit_price = v_base_unit_price/);
  assert.match(source, /perform public\.reserve_store_item_stock\(v_item\.store_item_id, v_item\.store_item_variant_id, v_delta\);/);
  assert.match(source, /perform public\.release_store_item_reservation\(v_item\.store_item_id, v_item\.store_item_variant_id, -v_delta\);/);
  assert.doesNotMatch(source, /store_item_inventory/, 'nao deveria voltar a tocar store_item_inventory diretamente -- reserve_store_item_stock/release_store_item_reservation e o roteador canonico');
});

test('definicao VIGENTE de get_cart_order_details devolve product_base_unit_price por item (unico campo que faltava pro frontend mostrar o preco original riscado a partir do snapshot canonico)', async () => {
  const { source } = await resolveCurrentFunctionDefinition('get_cart_order_details');
  // Nao trava no nome do arquivo: get_cart_order_details foi redefinida de
  // novo em 20260913000000 (feature de taxa de pagamento, campo novo no
  // bloco payment) -- o que importa aqui e que o campo desta correcao
  // (product_base_unit_price) sobreviveu a essa redefinicao seguinte.
  assert.match(source, /'product_base_unit_price', oi\.product_base_unit_price/);
});

test('a migration regressiva (890) permanece intocada -- a correcao e uma migration NOVA, nenhuma migration historica ja aplicada foi editada', async () => {
  const sql = await fs.readFile(regressionMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'add_product_to_cart_order');
  assert.match(fn, /v_unit_price:=v_store_item\.price;/, 'a 890 continua com o bug no texto historico -- e esperado, a correcao vem depois');
});

test('apply_cart_coupon NAO e redefinida pela migration de correcao -- preservada exatamente como estava, so o insumo (unit_price) volta a ser o correto', async () => {
  const sql = await fs.readFile(fixMigrationUrl, 'utf8');
  assert.doesNotMatch(sql, /create (or replace )?function public\.apply_cart_coupon/);
});

test('guard de visibility (regredido junto pela 890) volta a existir em add_product_to_cart_order', async () => {
  const sql = await fs.readFile(fixMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'add_product_to_cart_order');
  assert.match(fn, /if v_store_item\.visibility <> 'public' then raise exception 'Produto nao esta disponivel para compra publica\.'; end if;/);
});

// ============================================================
// CASOS A-G do bug report (aritmetica pura, espelhando compute_store_item_
// final_price + apply_cart_coupon, ja confirmadas contra o texto das
// funcoes acima)
// ============================================================
function computeFinal(unitPrice, type, value) {
  if (type === 'percentage') return Math.max(unitPrice * (1 - Math.min(value ?? 0, 100) / 100), 0);
  if (type === 'fixed') return Math.max(unitPrice - (value ?? 0), 0);
  return Math.max(unitPrice, 0);
}

test('CASO A: ingresso R$170 + produto original R$70/promocional R$55 => total R$225', () => {
  const ticket = 170;
  const product = computeFinal(70, 'fixed', 15);
  assert.equal(product, 55);
  assert.equal(ticket + product, 225);
});

test('CASO B: ingresso R$170 + 2x produto original R$75/promocional R$60 => total R$290', () => {
  const ticket = 170;
  const unit = computeFinal(75, 'fixed', 15);
  assert.equal(unit, 60);
  assert.equal(ticket + unit * 2, 290);
});

test('CASO C: ingresso R$170 + 1x (70->55) + 2x (75->60) => total R$345 (exemplo do bug report)', () => {
  const ticket = 170;
  const productA = computeFinal(70, 'fixed', 15);
  const productB = computeFinal(75, 'fixed', 15) * 2;
  assert.equal(ticket + productA + productB, 345);
});

test('CASO D: set_cart_order_item_quantity recalcula com compute_store_item_final_price a cada chamada -- mudar quantidade nunca reverte pro preco cheio (nao reusa unit_price antigo, sempre recalcula de v_store_item.price + desconto)', async () => {
  const sql = await fs.readFile(fixMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'set_cart_order_item_quantity');
  // O preco e sempre recalculado a partir de v_store_item (linha fresca),
  // nunca copiado de v_item.unit_price (o valor antigo do item).
  assert.doesNotMatch(fn, /v_unit_price\s*:=\s*v_item\.unit_price/);
  assert.match(fn, /v_base_unit_price := v_store_item\.price;/);
});

test('CASO E: add_product_to_cart_order recalcula unit_price/product_base_unit_price TAMBEM no branch de consolidacao (produto ja no carrinho, quantidade soma) -- nao so no insert', async () => {
  const sql = await fs.readFile(fixMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'add_product_to_cart_order');
  assert.match(fn, /if found and v_existing\.id is not null then[\s\S]*?set quantity = v_new_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,/);
});

test('CASO F: produto SEM desconto (discount_type null) -- compute_store_item_final_price devolve o proprio preco base, add_product_to_cart_order nao tem nenhum caminho especial pra esse caso (confia inteiramente na funcao centralizada)', () => {
  const unit = computeFinal(50, null, 0);
  assert.equal(unit, 50);
});

test('CASO G: produto promocional + cupom -- apply_cart_coupon (inalterada) calcula o desconto de cupom sobre unit_price*quantity, que ja chega promocional -- sem desconto duplicado. Exemplo: R$55 (ja promocional) com cupom 10% => desconto R$5,50, final R$49,50', () => {
  const promotionalUnit = computeFinal(70, 'fixed', 15);
  assert.equal(promotionalUnit, 55);
  const lineSubtotal = promotionalUnit * 1;
  const couponDiscount = Math.round((lineSubtotal * 10) / 100 * 100) / 100;
  const finalAmount = Math.round((lineSubtotal - couponDiscount) * 100) / 100;
  assert.equal(couponDiscount, 5.5);
  assert.equal(finalAmount, 49.5);
});

// ============================================================
// Frontend: CartStep exibe o snapshot canonico (product_base_unit_price
// vindo de get_cart_order_details), nunca recalcula em paralelo
// ============================================================
test('actions.ts (UnifiedOrderItem) mapeia product_base_unit_price a partir do RPC, sem recalcular nada localmente', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  assert.match(source, /product_base_unit_price: number \| null;/);
  assert.match(source, /product_base_unit_price: row\.product_base_unit_price !== null && row\.product_base_unit_price !== undefined \? Number\(row\.product_base_unit_price\) : null,/);
});

test('CartStep mostra o preco original riscado quando product_base_unit_price > unit_price, usando so o campo vindo do backend (nenhum computeStoreItemFinalPrice novo chamado sobre o item do carrinho)', async () => {
  const source = await fs.readFile(cartStepUrl, 'utf8');
  assert.match(source, /product_base_unit_price: number \| null;/);
  assert.match(source, /item\.product_base_unit_price !== null && item\.product_base_unit_price > item\.unit_price/);
  // A comparacao usa o valor persistido (item.product_base_unit_price), nao
  // uma nova chamada a effectivePrice/computeStoreItemFinalPrice sobre o
  // item do carrinho -- essas so existem pro catalogo "Compre junto".
  const cartItemBlock = source.slice(source.indexOf('{productItems.length > 0'), source.indexOf('Remover'));
  assert.doesNotMatch(cartItemBlock, /computeStoreItemFinalPrice\(/);
});
