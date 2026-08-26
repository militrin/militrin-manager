import assert from 'node:assert/strict';
import { readFile as readFileRaw } from 'node:fs/promises';
import test from 'node:test';

async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, '\n');
}

// Corrige "Sem itens de kit vinculados" aparecendo mesmo com camiseta
// configurada no resumo final. Estes testes sao estaticos (leem o
// texto-fonte) -- a prova de comportamento em runtime (materializacao,
// filtragem de cancelado, refresh, cortesia) esta em
// tests/checkout-kit-items-summary.integration.mjs.

const actions = await readFile(new URL('../src/app/inscricao/actions.ts', import.meta.url), 'utf8');
const wizard = await readFile(new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url), 'utf8');
const minhaContaItensPage = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/itens/page.tsx', import.meta.url), 'utf8');

test('getUnifiedOrderSnapshot busca kit_items de verdade -- kit_items nao e mais hardcoded como array vazio', () => {
  assert.doesNotMatch(wizard, /kit_items:\s*\[\]/, 'mapOrderToRegistration nao pode mais fixar kit_items em array vazio');
  assert.match(actions, /async function getUnifiedOrderKitItems/);
  assert.match(actions, /const kitItems = await getUnifiedOrderKitItems\(supabase, ticketIds\);/);
  assert.match(actions, /kit_items: kitItems,/);
});

test('a fonte usada e a MESMA tabela/join da pagina canonica de Minha Conta (participant_kit_items + event_kit_items) -- nenhuma segunda logica de kit', () => {
  assert.match(actions, /\.from\('participant_kit_items'\)/);
  assert.match(actions, /event_kit_items\(name, item_type\)/);
  // A pagina canonica ja usada em Minha Conta filtra por ticket_id -- a
  // correcao do checkout usa exatamente a mesma chave (nao participant_id
  // nem order_item_id), consistente com a policy RLS de dono do ticket.
  assert.match(minhaContaItensPage, /\.from\('participant_kit_items'\)\.select\('id,kit_item_id,variant_data,status,event_kit_items\(/);
  assert.match(minhaContaItensPage, /\.eq\('ticket_id', ticketId\)/);
  assert.match(actions, /\.in\('ticket_id', ticketIds\)/);
});

test('itens cancelados sao excluidos -- nunca aparecem como item ativo do kit', () => {
  const fnBody = actions.slice(actions.indexOf('async function getUnifiedOrderKitItems'));
  assert.match(fnBody, /\.filter\(\(row\) => row\.status !== 'cancelled'\)/);
});

test('o resumo final usa rotulos amigaveis (nome — variante — status) e nunca mais o texto tecnico "Sem itens de kit vinculados"', () => {
  assert.doesNotMatch(wizard, /Sem itens de kit vinculados/);
  assert.match(wizard, /Nenhum item de kit incluído neste ingresso\./);
  assert.match(wizard, /Itens do kit/);
  assert.match(wizard, /kitItemStatusLabel\(item\.status\)/);
});

test('produto de loja continua em secao separada do kit do ingresso (nenhuma fusao das duas listas)', () => {
  // "Itens do kit" tambem aparece em outra etapa do wizard (selecao de kit no
  // carrinho) -- busca especificamente o bloco do resumo final, ancorado em
  // kitItemStatusLabel (usado so ali).
  const kitBlockIndex = wizard.indexOf('kitItemStatusLabel(item.status)');
  const productBlockIndex = wizard.indexOf('Produtos do pedido');
  assert.ok(kitBlockIndex !== -1, 'bloco do resumo final de kit nao encontrado');
  assert.ok(productBlockIndex !== -1 && productBlockIndex < kitBlockIndex, 'a secao de produtos deve continuar distinta e anterior a secao de kit no resumo final');
});

test('a chave React da lista de kit usa o id da linha de participant_kit_items (nao o kit_item_id) -- evita colisao quando o mesmo item de kit aparece em varios tickets do pedido', () => {
  assert.match(wizard, /registration\.kit_items\.map\(\(item\) => \(\s*<li key=\{item\.id\}>/);
});
