import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const migration46Url = new URL('../supabase/migrations/20260846000000_persist_and_edit_order_item_pricing_gender.sql', import.meta.url);
const migration47Url = new URL('../supabase/migrations/20260847000000_backfill_order_item_pricing_gender.sql', import.meta.url);
const shirtsUrl = new URL('../src/lib/constants/shirts.ts', import.meta.url);
const editTicketsStepUrl = new URL('../src/app/inscricao/[eventSlug]/edit-tickets-step.tsx', import.meta.url);
const wizardUrl = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const cartStepUrl = new URL('../src/app/inscricao/[eventSlug]/cart-step.tsx', import.meta.url);

// Historia completa pedida no bug report: male -> grava male -> snapshot
// retorna male -> edicao mostra Masculino. Como nao ha banco local nesta
// suite (mesmo padrao ja usado por tests/operations-shirt-stock.test.mjs),
// cada elo da cadeia e verificado no texto-fonte que efetivamente roda.
test('criacao (create_multi_ticket_order_checkout_legacy) grava pricing_gender por item, nunca descarta apos calcular preco', async () => {
  const sql = await readFile(migration46Url, 'utf8');
  assert.match(sql, /alter table public\.order_items add column if not exists pricing_gender text/);
  assert.match(sql, /check \(pricing_gender is null or pricing_gender in \('male', 'female'\)\)/);

  // O loop que faz o INSERT real (segundo loop da funcao) recalcula o
  // genero por item a partir do MESMO payload usado pro calculo de preco
  // (v_item_payload ->> 'pricing_gender', com fallback pro escalar
  // p_gender) e grava a coluna nova.
  assert.match(sql, /v_item_gender := lower\(trim\(coalesce\(v_item_payload ->> 'pricing_gender', p_gender, ''\)\)\)/);
  assert.match(sql, /when v_item_gender in \('male', 'masculino', 'm'\) then 'male'/);
  assert.match(sql, /when v_item_gender in \('female', 'feminino', 'f'\) then 'female'/);

  const insertMatch = sql.match(/insert into public\.order_items \(([\s\S]*?)\) values \(([\s\S]*?)\);/);
  assert.ok(insertMatch, 'insert into order_items nao encontrado');
  assert.match(insertMatch[1], /pricing_gender/);
  assert.match(insertMatch[2], /v_item_pricing_gender/);
});

test('snapshot (get_cart_order_details) devolve pricing_gender no payload de cada item', async () => {
  const sql = await readFile(migration46Url, 'utf8');
  const fnMatch = sql.match(/create or replace function public\.get_cart_order_details[\s\S]*?end; \$\$;/);
  assert.ok(fnMatch, 'get_cart_order_details nao encontrada na migration 46');
  assert.match(fnMatch[0], /'pricing_gender', oi\.pricing_gender/);
});

test('edicao mostra Masculino/Feminino a partir do valor real (item.pricing_gender), nunca inferido de shirt_type/tamanho/titular', async () => {
  const source = await readFile(editTicketsStepUrl, 'utf8');
  // Hidrata do valor persistido, nao de um default arbitrario.
  assert.match(source, /item\.pricing_gender \?\? ''/);
  assert.match(source, /function genderLabel/);
  assert.match(source, /'male'.*'Masculino'/);
  assert.match(source, /'female'.*'Feminino'/);
  // Nunca deriva genero a partir de shirt_type/shirt_size dentro deste
  // arquivo (nao existe nenhum mapeamento Camiseta/Babylook -> male/female
  // aqui -- so change_pending_order_item_gender, via RPC propria, altera
  // pricing_gender).
  assert.doesNotMatch(source, /shirt_type[\s\S]{0,40}(male|female)/i);
});

test('shirtDisplayLabel nunca embute genero no rotulo do tipo de camiseta', async () => {
  const source = await readFile(shirtsUrl, 'utf8');
  const fnMatch = source.match(/export function shirtDisplayLabel[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'shirtDisplayLabel nao encontrada');
  // So o CODIGO da funcao (nao os comentarios explicando a regra, que citam
  // "Masculina"/"Feminina" de proposito ao dizer o que NAO fazer) precisa
  // estar livre de qualquer inferencia de genero.
  assert.doesNotMatch(fnMatch[0], /Masculina/);
  assert.doesNotMatch(fnMatch[0], /Feminina/);
  assert.match(fnMatch[0], /return shirtType\.trim\(\) \|\| null;/);
});

test('change_pending_order_item_gender recalcula pelo LOTE ja travado no proprio item, nunca re-resolve o lote atual, e reaplica cupom/PIX', async () => {
  const sql = await readFile(migration46Url, 'utf8');
  const fnMatch = sql.match(/create or replace function public\.change_pending_order_item_gender[\s\S]*?end; \$\$;/);
  assert.ok(fnMatch, 'change_pending_order_item_gender nao encontrada');
  const body = fnMatch[0];

  // Preco vem de registration_batches pelo batch_id do PROPRIO item (nunca
  // get_registration_pricing_preview, que resolveria o lote ATUAL/mais
  // recente em vez do lote que o comprador ja garantiu).
  assert.match(body, /select \* into v_batch from public\.registration_batches where id = v_item\.batch_id/);
  assert.doesNotMatch(body, /get_registration_pricing_preview/);
  assert.match(body, /v_new_unit_price := round\(case when v_new_gender = 'female' then v_batch\.female_price else v_batch\.male_price end, 2\)/);

  // Nunca mexe em delivered_quantity/shirt_type/shirt_size (essas RPCs sao
  // conceitos independentes).
  assert.doesNotMatch(body, /delivered_quantity/);
  assert.doesNotMatch(body, /shirt_type = /);

  // Reaplica cupom/total/PIX -- mesmo ponto unico das demais mutacoes de
  // carrinho.
  assert.match(body, /perform public\.apply_cart_coupon\(v_order\.id/);

  // Idempotencia: mesmo genero, no-op explicito.
  assert.match(body, /if v_new_gender = v_item\.pricing_gender then/);
});

test('backfill so infere pricing_gender quando o preco bate EXATAMENTE com um preco do lote e os dois precos do lote sao diferentes entre si', async () => {
  const sql = await readFile(migration47Url, 'utf8');
  // So as instrucoes SQL executaveis (depois de "begin;") -- o cabecalho de
  // comentarios cita "shirt_type/shirt_size" de proposito ao documentar o
  // que a regra de seguranca proibe, o que faria um doesNotMatch ingenuo
  // falhar mesmo com o SQL correto.
  const executable = sql.slice(sql.indexOf('begin;'));

  // Nunca mexe em item ja preenchido.
  assert.match(executable, /oi\.pricing_gender is null/);

  // male_price = female_price -> nao mexe (ambiguo por definicao: o preco
  // nao distingue os generos nesse lote).
  assert.match(executable, /rb\.male_price is distinct from rb\.female_price/);

  // Comparacao exata (arredondada a 2 casas, mesma precisao numeric(10,2)
  // de registration_batches) -- nunca "mais proximo de" nem tolerancia.
  assert.match(executable, /round\(oi\.unit_price, 2\) = round\(rb\.male_price, 2\)/);
  assert.match(executable, /round\(oi\.unit_price, 2\) = round\(rb\.female_price, 2\)/);

  // Nunca deriva de shirt_type/shirt_size/holder_full_name/participant no
  // SQL que de fato executa.
  assert.doesNotMatch(executable, /shirt_type/);
  assert.doesNotMatch(executable, /shirt_size/);
  assert.doesNotMatch(executable, /holder_full_name/);

  // So toca ingressos.
  assert.match(executable, /oi\.item_kind = 'ticket'/);
});

test('resumo lateral (summaryValues) usa o snapshot canonico do pedido assim que ele existe, nunca form.quantity/checkoutItems/itemTotals', async () => {
  const source = await readFile(wizardUrl, 'utf8');

  // Existe uma prioridade explicita: registration > cartSnapshot > rascunho
  // pre-pedido -- nunca o contrario.
  const summaryBlockMatch = source.match(/const summaryValues = registration([\s\S]*?);\n\n {2}return \(/);
  assert.ok(summaryBlockMatch, 'bloco summaryValues nao encontrado (ou marcador de fim mudou)');
  const summaryBlock = summaryBlockMatch[0];

  assert.match(summaryBlock, /: cartSnapshot\s*\?/, 'summaryValues precisa ter um branch dedicado pra cartSnapshot entre registration e o rascunho pre-pedido');
  assert.match(summaryBlock, /quantity: ticketLines\(cartSnapshot\.items\)\.length/);
  assert.match(summaryBlock, /original: money\(cartSnapshot\.base_amount\)/);
  assert.match(summaryBlock, /total: money\(cartSnapshot\.final_amount\)/);

  // cartSnapshot e sempre alimentado por CartStep/EditTicketsStep via
  // onSnapshotChange, nunca por um segundo calculo dentro do proprio
  // wizard.
  assert.match(source, /setCartSnapshot\(cart as unknown as OrderSnapshotPayload\)/);
});

test('CartStep e EditTicketsStep notificam o wizard pai (onSnapshotChange) em TODA atualizacao de carrinho, nao so no fetch inicial', async () => {
  const cartStepSource = await readFile(cartStepUrl, 'utf8');
  const editTicketsSource = await readFile(editTicketsStepUrl, 'utf8');

  for (const source of [cartStepSource, editTicketsSource]) {
    assert.match(source, /function updateCart\(next: CartDetails\) \{/);
    assert.match(source, /onSnapshotChange\?\.\(next\);/);
    // updateCart(next) chama setCart(next) uma vez -- qualquer outra
    // ocorrencia de "setCart(" no arquivo (fora da declaracao inicial
    // "const [cart, setCart] = useState", que nao conta como chamada) seria
    // uma mutacao que esqueceu de notificar o wizard pai.
    const totalSetCartCalls = (source.match(/setCart\(/g) ?? []).length;
    assert.equal(totalSetCartCalls, 1, `esperado exatamente 1 chamada a setCart() (dentro de updateCart), achou ${totalSetCartCalls}`);
  }
});
