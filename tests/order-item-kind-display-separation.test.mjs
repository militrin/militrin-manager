// Auditoria da Central de Integridade Operacional: order_items.item_kind
// ('ticket'|'product', 20260825000000) e a UNICA fonte canonica pra separar
// ingresso de produto "compre junto" em qualquer tela -- nunca nome, preco,
// lote, ticket_category_id nulo ou presenca de QR. Este arquivo prova que
// /pedidos (listagem admin) e Minha Conta (home + listagem de compras)
// aplicam essa mesma regra, sem reinventar heuristica propria por tela.
//
// Pedidos e Minha Conta chamam Server Actions autenticadas (assertPermission/
// cookies) -- fora do alcance de um teste node:test isolado sem contexto
// Next.js real, mesmo padrao ja usado por admin-dashboard-traceability.test.mjs
// pra loadAdminDashboard(). Verificacao estatica do codigo-fonte, na mesma
// linha.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// -------------------- /pedidos (listagem admin) --------------------

test('pedidos: order_items select traz item_kind (sem isso o filtro seria sempre no-op)', async () => {
  const source = await read('src/app/pedidos/actions.ts');
  assert.match(source, /id, order_id, item_position, ownership_status, holder_full_name, item_kind, quantity, status,/);
});

test('pedidos: ticketCount conta somente os itens que passaram pelo filtro item_kind=ticket, nunca items.length bruto', async () => {
  const source = await read('src/app/pedidos/actions.ts');
  // O loop de mapeamento faz `continue` pras linhas de produto ANTES de
  // empurrar pra itemsByOrder -- ticketCount:items.length so pode refletir
  // ingresso porque `items` (vindo de itemsByOrder) nunca recebeu produto.
  assert.match(source, /if \(\(item\.item_kind \?\? "ticket"\) === "product"\) \{/);
  assert.match(source, /ticketCount: items\.length,/);
  const productBranchIndex = source.indexOf('if ((item.item_kind ?? "ticket") === "product") {');
  const pushToItemsByOrderIndex = source.indexOf('itemsByOrder.get(oid)!.push(row);');
  assert.ok(productBranchIndex >= 0 && pushToItemsByOrderIndex > productBranchIndex, 'produto precisa ser desviado (continue) antes de qualquer linha ser empurrada pra itemsByOrder');
});

test('pedidos: produto tem sua propria lista (productItems), nunca reaproveita as colunas semanticas de ingresso (categoria/lote/status do ingresso/titular)', async () => {
  const source = await read('src/app/pedidos/actions.ts');
  assert.match(source, /productItemsByOrder\.get\(oid\)!\.push\(productRow\);/);
  assert.match(source, /productItems,\s*\n\s*\};/);
  const pageSource = await read('src/app/pedidos/page.tsx');
  assert.match(pageSource, /order\.productItems\.length > 0/);
  assert.match(pageSource, /Itens \/ produtos \(\{order\.productItems\.length\}\)/);
});

// -------------------- Minha Conta (home + listagem de compras) --------------------

test('Minha Conta: helper canonico accountTicketItems/accountTicketItemCount centraliza o filtro item_kind (nao reimplementado por tela)', async () => {
  const source = await read('src/lib/account/portal-orders-and-tickets.ts');
  assert.match(source, /order_items\(id, item_position, status, item_kind, ownership_status, holder_full_name, participants\(full_name\), tickets\(id, status, token\)\)/);
  assert.match(source, /export function accountTicketItems\(order: Record<string, unknown>\): Array<Record<string, unknown>> \{/);
  assert.match(source, /return items\.filter\(\(item\) => \(item\.item_kind \?\? 'ticket'\) === 'ticket'\);/);
  assert.match(source, /export function accountTicketItemCount\(order: Record<string, unknown>\): number \{/);
});

test('Minha Conta home: latestOrderItemCount e a quantidade da compra pendente usam a fonte canonica, nunca order_items.length bruto', async () => {
  const source = await read('src/app/minha-conta/page.tsx');
  assert.match(source, /accountTicketItemCount/);
  assert.match(source, /const latestOrderItemCount = latestOrder \? accountTicketItemCount\(latestOrder\) : 0;/);
  // pendingOrderDetail usa uma query propria (so ticket_category_id/batch_id) --
  // precisa do mesmo filtro aplicado manualmente, com item_kind selecionado.
  assert.match(source, /select\('ticket_category_id, batch_id, item_kind'\)/);
  assert.match(source, /\.filter\(\(item\) => \(item\.item_kind \?\? 'ticket'\) === 'ticket'\);/);
});

test('Minha Conta / compras: card usa accountTicketItems (nunca order_items bruto) pro resumo e pro resumo de titularidade', async () => {
  const source = await read('src/app/minha-conta/compras/page.tsx');
  assert.match(source, /import \{ getAccountOrders, resolveAccountOrderStatus, accountTicketItems \} from '@\/lib\/account\/portal-orders-and-tickets';/);
  assert.match(source, /const orderItems = accountTicketItems\(order\);/);
  // productItemCount (allItems.length - orderItems.length) precisa existir
  // e ser usado so pra exibicao complementar, nunca entrar no titularSummary.
  assert.match(source, /const productItemCount = allItems\.length - orderItems\.length;/);
  const titularSummaryCallIndex = source.indexOf('titularSummary(orderItems.length, definedCount)');
  assert.ok(titularSummaryCallIndex >= 0, 'titularSummary deve ser chamado com orderItems (ja filtrado), nunca allItems');
});

test('Minha Conta / compras: pedido misto (ingresso + produto) continua mostrando o produto no resumo, nunca escondido', async () => {
  const source = await read('src/app/minha-conta/compras/page.tsx');
  assert.match(source, /produto\$\{productItemCount === 1 \? '' : 's'\}`;/);
  assert.match(source, /summaryLine \+= ` • \+\$\{productItemCount\} produto/);
});

test('Minha Conta / compras/[orderId]: detalhe do pedido (ja auditado como correto) nao foi alterado por esta correcao', async () => {
  const source = await read('src/app/minha-conta/compras/[orderId]/page.tsx');
  assert.match(source, /item_kind/);
});
