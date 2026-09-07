import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const listPage = await readFile(new URL('../src/app/minha-conta/ingressos/page.tsx', import.meta.url), 'utf8');
const nav = await readFile(new URL('../src/app/minha-conta/ingressos/tickets-situation-nav.tsx', import.meta.url), 'utf8');
const scope = await readFile(new URL('../src/lib/account/portal-orders-and-tickets.ts', import.meta.url), 'utf8');
const home = await readFile(new URL('../src/app/minha-conta/page.tsx', import.meta.url), 'utf8');
const adminPage = await readFile(new URL('../src/app/ingressos/page.tsx', import.meta.url), 'utf8');
const adminForm = await readFile(new URL('../src/app/ingressos/tickets-filter-form.tsx', import.meta.url), 'utf8');
const adminHelper = await readFile(new URL('../src/lib/admin/list-admin-tickets.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260953000000_list_admin_tickets.sql', import.meta.url), 'utf8');
const migration54 = await readFile(new URL('../supabase/migrations/20260954000000_imported_ticket_payment_filter.sql', import.meta.url), 'utf8');
const detail = await readFile(new URL('../src/app/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');

test('usuario com so ativo: lista padrao nao mistura arquivo e mostra o controle', () => {
  assert.match(listPage, /includeCancelled: true/);
  assert.match(listPage, /showArchived \? archived : active/);
  assert.match(nav, /Ingressos ativos/);
  assert.match(nav, /Anteriores e inativos/);
  assert.match(nav, /ver=anteriores/);
});

test('usuario com ativo + evento passado ou cancelado consegue revelar o arquivo', () => {
  assert.match(listPage, /ver=anteriores/);
  assert.match(listPage, /ticketSituationLabel\(situation\)/);
  assert.match(listPage, /Evento encerrado|Anteriores e inativos/);
  assert.match(home, /classifyTicketOperationalSituation/);
  assert.match(home, /emptyHref=\{archivedTicketCount > 0 \? '\/minha-conta\/ingressos\?ver=anteriores'/);
});

test('escopo da conta continua omitindo cancelados nas outras telas', () => {
  assert.match(scope, /if \(!options\?\.includeCancelled\) ownerTicketsQuery = ownerTicketsQuery\.neq\('status', 'cancelled'\)/);
});

test('admin padrao ve so ativos e tem Situacao Todos visivel', () => {
  assert.match(adminPage, /parseAdminTicketListFilters/);
  assert.match(adminForm, /<option value="ativos">Ativos<\/option>/);
  assert.match(adminForm, /<option value="todos">Todos<\/option>/);
  assert.match(adminPage, /Padrão: apenas ingressos ativos/);
  assert.match(adminPage, /Não encontramos ingressos com esses filtros/);
});

test('admin filtra no backend e pagina sem carregar a base inteira no browser', () => {
  assert.match(adminHelper, /rpc\('list_admin_tickets'/);
  assert.match(adminPage, /ADMIN_TICKETS_PAGE_SIZE/);
  assert.match(migration, /p_situacao text default 'ativos'/);
  assert.match(migration, /v_search = ''/);
  assert.match(migration, /offset \(v_page - 1\) \* v_page_size/);
});

test('filtros combinaveis e busca existem na RPC', () => {
  assert.match(migration, /p_event_id uuid default null/);
  assert.match(migration, /p_ticket_status text default null/);
  assert.match(migration, /p_category_id uuid default null/);
  assert.match(migration, /p_titularidade text default null/);
  assert.match(migration, /p_conta text default null/);
  assert.match(migration, /p_checkin text default null/);
  assert.match(migration, /p_kit text default null/);
  assert.match(migration, /p_pagamento text default null/);
  assert.match(migration54, /ticket_admin_payment_class/);
  assert.match(migration54, /f\.payment_class = v_pagamento/);
  assert.match(migration, /p_search text default null/);
  assert.match(migration, /holder_cpf/);
  assert.match(migration, /wristband_code/);
  assert.match(adminForm, /Nome, CPF, e-mail, código, pedido ou pulseira/);
  assert.match(adminForm, /Limpar filtros/);
});

test('voltar do detalhe admin preserva returnTo da listagem', () => {
  assert.match(adminPage, /adminTicketDetailHref\(ticket\.ticketId, listHref\)/);
  assert.match(detail, /sanitizeAdminTicketsReturnTo\(filters\.returnTo\)/);
  assert.match(detail, /backHref=\{listHref\}/);
});

test('migration de listagem nao apaga historico de tickets, pedidos ou pagamentos', () => {
  assert.doesNotMatch(migration, /delete from public\.tickets/i);
  assert.doesNotMatch(migration, /delete from public\.orders/i);
  assert.doesNotMatch(migration, /delete from public\.payments/i);
  assert.doesNotMatch(migration, /truncate /i);
  assert.match(migration, /Nao altera dados: leitura pura/);
});
