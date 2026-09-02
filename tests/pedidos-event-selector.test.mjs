// Bug real: /pedidos mostrava "Nenhum evento selecionado" + "0 pedidos" sem
// nenhum controle visivel pra selecionar um evento -- o seletor inline
// (hand-rolled) so renderizava com events.length > 1, e listOrdersAction
// nunca auto-selecionava o unico evento existente. Corrigido reusando
// EventContextSelector (o mesmo componente ja usado por /categorias,
// /lotes e /financeiro -- nenhuma segunda arquitetura de selecao de evento)
// e auto-selecionando quando ha exatamente 1 evento acessivel.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const actionsSource = await read('src/app/pedidos/actions.ts');
const pageSource = await read('src/app/pedidos/page.tsx');

test('11) organizacao com exatamente 1 evento acessivel: listOrdersAction auto-seleciona esse evento sem exigir clique', () => {
  assert.match(actionsSource, /const explicitEvent = params\.eventId \? events\.find\(\(e\) => e\.id === params\.eventId\) \?\? null : null;/);
  assert.match(actionsSource, /const selectedEvent = explicitEvent \?\? \(!params\.eventId && events\.length === 1 \? events\[0\] : null\);/);
});

test('12) organizacao com varios eventos: pagina mostra o seletor compartilhado (EventContextSelector), nunca um segundo mecanismo proprio', () => {
  assert.match(pageSource, /import \{ EventContextSelector \} from "@\/components\/admin\/EventContextSelector";/);
  assert.match(pageSource, /<EventContextSelector events=\{events\} selectedEventId=\{selectedEvent\?\.id \?\? null\} pathname="\/pedidos" \/>/);
  // O seletor antigo (pills hand-rolled com buildUrl) nao existe mais.
  assert.doesNotMatch(pageSource, /events\.map\(\(e\) => \(\s*<Link/);
});

test('13) trocar evento continua funcionando via ?eventId= (EventContextSelector so troca o query param, listOrdersAction ja escopa por selectedEvent.id)', () => {
  assert.match(actionsSource, /\.eq\("event_id", selectedEvent\.id\)/);
});

test('14) selecao invalida (eventId que nao esta na lista de eventos acessiveis) cai no mesmo estado de "nenhum evento selecionado" -- nunca "gruda" um evento fora da lista', () => {
  // explicitEvent so pode ser um item de `events` (ja escopado pela RLS/
  // organizacao do usuario) -- um eventId invalido nunca aparece em
  // events.find, entao explicitEvent fica null e cai no fallback seguro.
  assert.match(actionsSource, /events\.find\(\(e\) => e\.id === params\.eventId\) \?\? null/);
});

test('15) organizacao sem nenhum evento: estado vazio "Nenhum evento disponível" com CTA condicional a permissao, nunca a mensagem antiga sem saida', () => {
  assert.match(pageSource, /!events\.length \?/);
  assert.match(pageSource, /title="Nenhum evento disponível"/);
  assert.match(pageSource, /canCreateEvent \?/);
  assert.match(pageSource, /hasPermission\("events\.create"\)/);
});

test('17) eventId por URL nunca seleciona evento fora da organizacao do usuario -- events ja vem escopado (RLS), find() so pode casar com um id acessivel', () => {
  assert.match(actionsSource, /await assertPermission\("orders\.view"\);/);
  const eventsQueryIndex = actionsSource.indexOf('.from("events")');
  const explicitEventIndex = actionsSource.indexOf('const explicitEvent');
  assert.ok(eventsQueryIndex >= 0 && explicitEventIndex > eventsQueryIndex, 'explicitEvent so pode ser calculado depois da consulta escopada de events');
});

test('subtitulo do header reflete os 3 estados (evento selecionado / selecione um evento / nenhum evento disponivel), nunca mais "Nenhum evento selecionado" cru', () => {
  assert.match(pageSource, /selectedEvent \? `Evento: \$\{selectedEvent\.name\}` : events\.length \? "Selecione um evento" : "Nenhum evento disponível"/);
});
