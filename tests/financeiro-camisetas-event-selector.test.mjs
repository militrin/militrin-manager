// Mesmo bug de /pedidos (ver pedidos-event-selector.test.mjs), encontrado
// tambem em /financeiro e /camisetas: nenhuma das duas paginas
// auto-selecionava o unico evento acessivel, e cada uma tinha seu proprio
// mecanismo de selecao (Financeiro so usava EventContextSelector nas abas
// de livro, nunca em "Receitas"; Camisetas usava um <select> proprio,
// ShirtEventSelector). Corrigido reusando o MESMO padrao ja validado em
// /pedidos: 0 eventos -> AdminEmptyState com CTA condicional a
// events.create; 1 evento sem eventId explicito -> auto-selecao; 2+ ->
// EventContextSelector (nenhum segundo mecanismo). ShirtEventSelector foi
// removido (nenhum outro consumidor).
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const financeiroSource = await read('src/app/financeiro/page.tsx');
const camisetasSource = await read('src/app/camisetas/page.tsx');

// -------------------- Financeiro --------------------

test('1) Financeiro com exatamente 1 evento acessivel: loadContext auto-seleciona esse evento sem exigir clique', () => {
  assert.match(financeiroSource, /const explicit = eventId \? eventList\.find\(\(event\) => event\.id === eventId\) \?\? null : null;/);
  assert.match(financeiroSource, /const selected = explicit \?\? \(!eventId && eventList\.length === 1 \? eventList\[0\] : null\);/);
});

test('2) Financeiro com varios eventos: aba nao-overview mostra o seletor compartilhado (EventContextSelector), nunca um segundo mecanismo', () => {
  assert.match(financeiroSource, /import \{ EventContextSelector \} from "@\/components\/admin\/EventContextSelector";/);
  assert.match(financeiroSource, /<EventContextSelector events=\{eventOptions\} selectedEventId=\{selectedEventId \|\| null\} pathname="\/financeiro"\/>/);
});

test('Financeiro: id invalido/inacessivel nunca "gruda" -- explicit so pode casar com um evento ja escopado (RLS)', () => {
  const eventsQueryIndex = financeiroSource.indexOf('.from("events")');
  const explicitIndex = financeiroSource.indexOf('const explicit =');
  assert.ok(eventsQueryIndex >= 0 && explicitIndex > eventsQueryIndex, 'explicit so pode ser calculado depois da consulta escopada de events');
});

test('Financeiro: organizacao sem nenhum evento (fora de overview): estado vazio "Nenhum evento disponível" com CTA condicional a permissao', () => {
  assert.match(financeiroSource, /eventOptions\.length === 0 \?/);
  assert.match(financeiroSource, /title="Nenhum evento disponível"/);
  assert.match(financeiroSource, /canCreateEvent \? <Link href="\/painel\/eventos"/);
  assert.match(financeiroSource, /hasPermission\("events\.create"\)/);
});

test('Financeiro: aba Receitas (sales) nunca renderiza a tabela vazia sem evento selecionado -- gate exige selectedEventId', () => {
  assert.match(financeiroSource, /active === "sales" && sales && selectedEventId \?/);
});

test('Financeiro: mensagem antiga "Selecione um evento para usar esta operação" (que excluia "sales" da explicacao) foi removida -- EventContextSelector ja mostra seu proprio aviso', () => {
  assert.doesNotMatch(financeiroSource, /Selecione um evento para usar esta operação/);
});

test('Financeiro: aba overview continua usando seu proprio mecanismo de agregacao multi-evento (viewEventIds/FinancialOverviewControls), intocado por este fix', () => {
  assert.match(financeiroSource, /active === "overview" \? \(\s*<FinancialOverviewControls/);
});

// -------------------- Camisetas --------------------

test('3) Camisetas com exatamente 1 evento acessivel: getStock auto-seleciona esse evento sem exigir clique', () => {
  assert.match(camisetasSource, /const explicitEvent = requestedEventId \? events\.find\(\(event\) => event\.id === requestedEventId\) \?\? null : null;/);
  assert.match(camisetasSource, /const effectiveSelectedEvent = explicitEvent \?\? \(!requestedEventId && events\.length === 1 \? events\[0\] : null\);/);
});

test('4) Camisetas com varios eventos: pagina mostra o seletor compartilhado (EventContextSelector), nunca mais o ShirtEventSelector proprio', () => {
  assert.match(camisetasSource, /import \{ EventContextSelector \} from "@\/components\/admin\/EventContextSelector";/);
  assert.match(camisetasSource, /<EventContextSelector events=\{eventOptions\} selectedEventId=\{resolvedEventId\} pathname="\/camisetas" \/>/);
  assert.doesNotMatch(camisetasSource, /ShirtEventSelector/);
});

test('ShirtEventSelector foi removido do projeto (nenhum outro consumidor existia)', async () => {
  await assert.rejects(access(new URL('../src/components/mvp/ShirtEventSelector.tsx', import.meta.url)));
});

test('Camisetas: id invalido/inacessivel nunca "gruda" -- explicitEvent so pode casar com um evento ja escopado (RLS)', () => {
  const eventsQueryIndex = camisetasSource.indexOf('.from("events")');
  const explicitEventIndex = camisetasSource.indexOf('const explicitEvent =');
  assert.ok(eventsQueryIndex >= 0 && explicitEventIndex > eventsQueryIndex, 'explicitEvent so pode ser calculado depois da consulta escopada de events');
});

test('Camisetas: organizacao sem nenhum evento: estado vazio "Nenhum evento disponível" com CTA condicional a permissao, nunca a mensagem antiga sem saida', () => {
  assert.match(camisetasSource, /eventOptions\.length === 0 \?/);
  assert.match(camisetasSource, /title="Nenhum evento disponível"/);
  assert.match(camisetasSource, /canCreateEvent \?/);
  assert.match(camisetasSource, /hasPermission\("events\.create"\)|getCurrentPermissionMap|import \{ getCurrentPermissionMap, hasPermission \}/);
});

test('Camisetas: mensagem enganosa "Selecione um evento para visualizar o estoque." foi removida do estado de 1-evento-auto-selecionado (errorMessage so cobre falhas reais de consulta)', () => {
  assert.doesNotMatch(camisetasSource, /Selecione um evento para visualizar o estoque\./);
});

test('Camisetas: trocar evento continua funcionando via ?eventId= (getStock ja escopa por effectiveSelectedEventId)', () => {
  assert.match(camisetasSource, /\.eq\("event_id", effectiveSelectedEventId\)/);
});
