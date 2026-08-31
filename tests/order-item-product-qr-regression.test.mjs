import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// UX: acesso ao QR Code de CADA produto "compre junto" (order_items com
// item_kind='product', dentro do MESMO pedido do ingresso) na Etapa
// "Concluido" do checkout de /inscricao -- hoje so o ingresso tinha QR, os
// produtos apareciam so como texto.
//
// INVESTIGACAO (resumo -- ver relatorio completo dado ao usuario fora desta
// migration): store_order_items (loja standalone, /loja) e order_items
// item_kind='product' (compre junto) sao dois dominios PARALELOS e
// desconectados por decisao de projeto ja documentada em
// 20260825000000_order_items_product_lines.sql -- nao existe FK, RPC nem
// trigger que ligue os dois, e order_items nunca teve qr_token. A rota
// EXISTENTE de QR por item (/api/loja/pedidos/[storeOrderId]/itens/[itemId]/
// qrcode) so opera sobre store_order_items -- reutiliza-la literalmente
// para produtos "compre junto" e impossivel (tabela errada). Esta migration
// aplica o MESMO padrao (coluna qr_token opaca + unique + rota GET com a
// MESMA regra de autorizacao) a order_items, numa rota nova que espelha a
// existente byte a byte na composicao visual e na autorizacao.

const migrationsDirUrl = new URL('../supabase/migrations/', import.meta.url);
const qrMigrationUrl = new URL('../supabase/migrations/20260916000000_order_item_product_qr.sql', import.meta.url);
const storeItemQrRouteUrl = new URL('../src/app/api/loja/pedidos/[storeOrderId]/itens/[itemId]/qrcode/route.ts', import.meta.url);
const orderItemQrRouteUrl = new URL('../src/app/api/inscricao/pedidos/[orderId]/itens/[itemId]/qrcode/route.ts', import.meta.url);
const wizardUrl = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const turboMigrationUrl = new URL('../supabase/migrations/20260860000000_turbo_mode_wristband_and_store_item_qr.sql', import.meta.url);

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
// order_items.qr_token -- coluna nova
// ============================================================
test('order_items ganha qr_token NULLABLE (ao contrario de store_order_items) -- so item_kind=product recebe token, ingresso continua usando tickets.token', async () => {
  const sql = await fs.readFile(qrMigrationUrl, 'utf8');
  assert.match(sql, /alter table public\.order_items\s*\n\s*add column if not exists qr_token text;/);
  assert.doesNotMatch(sql, /alter column qr_token set not null/, 'qr_token nao deveria virar NOT NULL -- linhas de ingresso nunca tem token');
});

test('backfill de qr_token cobre SOMENTE item_kind=product -- nunca gera token pra linha de ingresso existente', async () => {
  const sql = await fs.readFile(qrMigrationUrl, 'utf8');
  assert.match(sql, /update public\.order_items\s*\n\s*set qr_token = 'ITEM-' \|\| upper\(substr\(replace\(gen_random_uuid\(\)::text, '-', ''\), 1, 12\)\)\s*\n\s*where item_kind = 'product' and qr_token is null;/);
});

test('unique index de qr_token e PARCIAL (where qr_token is not null) -- coluna nullable nao pode ter unique index incondicional', async () => {
  const sql = await fs.readFile(qrMigrationUrl, 'utf8');
  assert.match(sql, /create unique index if not exists order_items_qr_token_key on public\.order_items \(qr_token\) where qr_token is not null;/);
});

test('mesmo formato de token ja usado por store_order_items.qr_token (20260860000000) -- nenhum formato novo inventado', async () => {
  const turboSql = await fs.readFile(turboMigrationUrl, 'utf8');
  const qrSql = await fs.readFile(qrMigrationUrl, 'utf8');
  const tokenExpr = "'ITEM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))";
  assert.ok(turboSql.includes(tokenExpr), 'expressao de referencia deveria existir em store_order_items (20260860000000)');
  assert.ok(qrSql.includes(tokenExpr), 'order_items deveria reusar EXATAMENTE a mesma expressao');
});

// ============================================================
// add_product_to_cart_order -- token gerado 1x no INSERT, nunca no UPDATE
// ============================================================
test('definicao VIGENTE de add_product_to_cart_order esta na migration do QR e gera qr_token SOMENTE no branch de INSERT (linha nova)', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('add_product_to_cart_order');
  assert.equal(definedInFile, '20260916000000_order_item_product_qr.sql');
  assert.match(source, /insert into public\.order_items\([^)]*qr_token\)/);
  assert.match(source, /'ITEM-' \|\| upper\(substr\(replace\(gen_random_uuid\(\)::text, '-', ''\), 1, 12\)\)\)\s*\n\s*returning id into v_item_id;/);
});

test('branch de CONSOLIDACAO (produto ja no carrinho, so soma quantidade) nunca toca qr_token -- CASO quantidade>1: 1 linha = 1 token estavel, nunca um token por unidade', async () => {
  const { source } = await resolveCurrentFunctionDefinition('add_product_to_cart_order');
  const updateBranch = source.match(/if found and v_existing\.id is not null then\s*\n[\s\S]*?returning id into v_item_id;\s*\n\s*else/);
  assert.ok(updateBranch, 'branch de consolidacao (UPDATE) nao encontrado');
  assert.doesNotMatch(updateBranch[0], /qr_token/, 'aumentar quantidade da MESMA linha nunca deveria regenerar ou tocar qr_token');
});

// ============================================================
// Rota de QR (nova) -- espelha a rota da loja, mesma autorizacao
// ============================================================
test('rota nova de QR por item "compre junto" existe, filtra por item_kind=product, order_id (nunca outro pedido) e usa qr_token (nunca order_number) como conteudo', async () => {
  const source = await fs.readFile(orderItemQrRouteUrl, 'utf8');
  assert.match(source, /from\("order_items"\)/);
  assert.match(source, /\.eq\("id", itemId\)/);
  assert.match(source, /\.eq\("order_id", orderId\)/);
  assert.match(source, /\.eq\("item_kind", "product"\)/);
  assert.match(source, /data=\$\{encodeURIComponent\(String\(item\.qr_token\)\)\}/);
  assert.doesNotMatch(source, /order_number\}\`.*data=|data=.*order_number/s);
});

test('rota nova aplica a MESMA regra de autorizacao ja confirmada (dono do pedido OU store.deliver OU store.manage) -- byte a byte igual a rota da loja', async () => {
  const [storeItemRoute, orderItemRoute] = await Promise.all([
    fs.readFile(storeItemQrRouteUrl, 'utf8'),
    fs.readFile(orderItemQrRouteUrl, 'utf8'),
  ]);
  const authLine = /if \(order\?\.user_id !== user\.id && !canDeliver && !canManage\) \{\s*\n\s*return new NextResponse\("Sem permissão para gerar este QR", \{ status: 403 \}\);\s*\n\s*\}/;
  assert.match(storeItemRoute, authLine);
  assert.match(orderItemRoute, authLine);
  assert.match(orderItemRoute, /hasPermission\("store\.deliver"\)/);
  assert.match(orderItemRoute, /hasPermission\("store\.manage"\)/);
});

test('rota nova exige sessao (401 sem user) e valida UUID de orderId/itemId (404 se invalido) -- mesma defesa da rota da loja', async () => {
  const source = await fs.readFile(orderItemQrRouteUrl, 'utf8');
  assert.match(source, /if \(!user\) return new NextResponse\("Sessão expirada", \{ status: 401 \}\);/);
  assert.match(source, /if \(!isUuid\(orderId\) \|\| !isUuid\(itemId\)\) return new NextResponse\("Item inválido", \{ status: 404 \}\);/);
});

test('rota nova le com service role (bypassa RLS) so porque a autorizacao real e o `if` explicito -- RLS de orders/order_items nao cobre store.deliver/store.manage (so dono ou orders.view/finance.*/participants.view), diferente de store_orders_select (qualquer staff da org)', async () => {
  const source = await fs.readFile(orderItemQrRouteUrl, 'utf8');
  assert.match(source, /import \{ createServiceRoleSupabaseClient \} from "@\/lib\/supabase\/admin";/);
  assert.match(source, /const adminClient = createServiceRoleSupabaseClient\(\);/);
  assert.match(source, /adminClient\s*\n\s*\.from\("order_items"\)/);
});

test('item sem qr_token (ex.: linha de ingresso, ou item_kind filtrado) retorna 404 -- nunca gera QR pra linha que nao e produto', async () => {
  const source = await fs.readFile(orderItemQrRouteUrl, 'utf8');
  assert.match(source, /if \(error \|\| !item\?\.qr_token\) return new NextResponse\("Item não encontrado", \{ status: 404 \}\);/);
});

// ============================================================
// Frontend (wizard.tsx) -- botao "Ver QR Code" por produto, nunca gerado
// manualmente a partir do qr_token
// ============================================================
test('wizard.tsx: "Produtos do pedido" ganha um link "Ver QR Code" por item, apontando pra rota autorizada (nunca lendo/gerando qr_token no cliente)', async () => {
  const source = await fs.readFile(wizardUrl, 'utf8');
  assert.match(source, /href=\{`\/api\/inscricao\/pedidos\/\$\{registration\.order_id\}\/itens\/\$\{item\.order_item_id\}\/qrcode\?inline=1`\}/);
  assert.match(source, /target="_blank"/);
  assert.doesNotMatch(source, /item\.qr_token/, 'o snapshot do frontend nunca deveria expor/usar qr_token diretamente -- so order_item_id + order_id, ja existentes');
});

// ============================================================
// Nao quebrar dominios adjacentes (Modo Turbo, loja, ingresso)
// ============================================================
test('migration do QR de produto "compre junto" nunca EXECUTA nada sobre store_orders/store_order_items/deliver_store_order_item nem tickets -- dominios adjacentes so citados em comentario (contexto/investigacao), nunca tocados de fato', async () => {
  const sql = await fs.readFile(qrMigrationUrl, 'utf8');
  const executableSql = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  // "comment on column" carrega uma string de documentacao que MENCIONA
  // store_order_items a titulo descritivo (mesmo padrao/formato de token) --
  // nunca uma referencia executavel (from/into/join/update daquela tabela).
  const withoutColumnComments = executableSql.replace(/comment on column[^;]*;/gs, '');
  assert.doesNotMatch(withoutColumnComments, /\b(from|into|join|update|table)\s+public\.(store_orders|store_order_items)\b/i);
  assert.doesNotMatch(withoutColumnComments, /deliver_store_order_item\s*\(/);
  assert.doesNotMatch(withoutColumnComments, /create (or replace )?function public\.confirm_order_item_and_issue_ticket|alter table public\.tickets/);
});

test('rota de QR da loja (Modo Turbo/entrega de item) permanece exatamente a mesma -- migration/rota nova nao a redefine', async () => {
  const source = await fs.readFile(storeItemQrRouteUrl, 'utf8');
  assert.match(source, /from\("store_order_items"\)/);
  assert.match(source, /store_order_id/);
});
