import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminTicketDetailHref,
  adminTicketFiltersAreDefault,
  adminTicketsClearHref,
  buildAdminTicketsHref,
  parseAdminTicketListFilters,
  sanitizeAdminTicketsReturnTo,
} from '../src/lib/admin/admin-ticket-filters.ts';

test('admin abre em situacao=ativos por padrao', () => {
  const filters = parseAdminTicketListFilters({});
  assert.equal(filters.situacao, 'ativos');
  assert.equal(filters.pagina, 1);
  assert.equal(adminTicketFiltersAreDefault(filters), true);
});

test('situacao todos e cancelados sao persistidas na URL', () => {
  const todos = parseAdminTicketListFilters({ situacao: 'todos' });
  const cancelados = parseAdminTicketListFilters({ situacao: 'cancelados', evento: '11111111-1111-4111-8111-111111111111' });
  assert.equal(todos.situacao, 'todos');
  assert.match(buildAdminTicketsHref(todos), /situacao=todos/);
  assert.match(buildAdminTicketsHref(cancelados), /situacao=cancelados/);
  assert.match(buildAdminTicketsHref(cancelados), /evento=11111111-1111-4111-8111-111111111111/);
});

test('filtros combinaveis e busca entram juntos no href', () => {
  const filters = parseAdminTicketListFilters({
    evento: '11111111-1111-4111-8111-111111111111',
    situacao: 'ativos',
    categoria: '22222222-2222-4222-8222-222222222222',
    checkin: 'pendente',
    q: 'Maria 123',
  });
  const href = buildAdminTicketsHref(filters);
  assert.match(href, /evento=/);
  assert.match(href, /situacao=ativos/);
  assert.match(href, /categoria=/);
  assert.match(href, /checkin=pendente/);
  assert.match(href, /q=Maria/);
  assert.equal(filters.q, 'Maria 123');
});

test('refresh e voltar do detalhe preservam a query da listagem', () => {
  const listHref = buildAdminTicketsHref(parseAdminTicketListFilters({
    situacao: 'cancelados',
    pagamento: 'pago',
    pagina: '2',
  }));
  const detailHref = adminTicketDetailHref('33333333-3333-4333-8333-333333333333', listHref);
  assert.match(detailHref, /returnTo=/);
  const encoded = new URL(detailHref, 'http://localhost').searchParams.get('returnTo');
  assert.equal(sanitizeAdminTicketsReturnTo(encoded), listHref);
  assert.equal(sanitizeAdminTicketsReturnTo('https://evil.example/ingressos'), '/ingressos');
  assert.equal(sanitizeAdminTicketsReturnTo('/ingressos/emitir'), '/ingressos');
});

test('limpar filtros volta ao padrao ativos sem apagar o recorte por conta', () => {
  const filters = parseAdminTicketListFilters({
    situacao: 'todos',
    q: 'x',
    userId: '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(adminTicketsClearHref(filters), '/ingressos?userId=44444444-4444-4444-8444-444444444444');
  assert.equal(adminTicketsClearHref(parseAdminTicketListFilters({ q: 'x' })), '/ingressos');
});
