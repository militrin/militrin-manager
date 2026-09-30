import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  clampCentralPage,
  clampCentralPageSize,
  filterFallbackCentralRow,
  isCentralTicketPending,
  mergeCentralFacets,
  parseOperationTicketPage,
  windowTicketsThenFallbacks,
} from "../src/lib/operations/central-list-query.ts";
import {
  participantIdsRepresentedByTickets,
  withoutTicketFallbackParticipants,
} from "../src/lib/operations/without-ticket-fallback.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function sliceFn(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} nao encontrada`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("paginacao da Central nunca mais usa cap 250 antes do filtro", async () => {
  const actions = await read("src/app/operacoes/actions.ts");
  const list = sliceFn(actions, "listOperationTicketsAction");
  assert.match(list, /list_operation_ticket_page/);
  assert.match(list, /p_shirt_type/);
  assert.match(list, /p_only_pending/);
  assert.match(list, /p_offset: from/);
  assert.doesNotMatch(list, /pageSize \?\? 250/);
  assert.doesNotMatch(list, /\.order\("issued_at"[\s\S]*\.range\(/);
  assert.doesNotMatch(list, /\.range\(from, to\)/);
});

test("RPC aplica filtros/count/order antes do recorte da pagina", async () => {
  const sql = await read("supabase/migrations/20261118000000_list_operation_tickets.sql");
  assert.match(sql, /create or replace function public\.list_operation_ticket_page\(/);
  assert.match(sql, /filtered_count/);
  assert.match(sql, /operational_total/);
  assert.match(sql, /t\.status in \('active', 'used'\)/);
  assert.match(sql, /oi\.shirt_type/);
  assert.match(sql, /oi\.shirt_size/);
  assert.match(sql, /holder_full_name/);
  assert.match(sql, /left join public\.participants p on p\.id = t\.participant_id/);
  assert.doesNotMatch(sql, /\n\s*join public\.participants p on p\.id = t\.participant_id/);
  assert.match(sql, /not coalesce\(p_only_pending, false\)/);
  assert.match(sql, /u\.payment_kind = 'pending'/);
  assert.match(sql, /u\.checkin_status is distinct from 'done'/);
  assert.match(sql, /v_wristband_enabled and u\.wristband_status is distinct from 'active'/);
  const matchedStart = sql.indexOf("matched as (");
  const orderedStart = sql.indexOf("ordered as (");
  const intoStart = sql.indexOf("into v_filtered_count, v_ticket_ids");
  assert.ok(matchedStart > -1 && orderedStart > matchedStart && intoStart > orderedStart);
  assert.ok(sql.indexOf("ranked.ord > v_offset") > orderedStart);
});

test("RPC nao exige participant_id para incluir ticket", async () => {
  const sql = await read("supabase/migrations/20261118000000_list_operation_tickets.sql");
  const fn = sql.slice(sql.indexOf("create or replace function public.list_operation_ticket_page"));
  assert.match(fn, /left join public\.participants p on p\.id = t\.participant_id/);
  assert.doesNotMatch(fn, /t\.participant_id is not null/);
  assert.match(fn, /security definer/);
  assert.match(fn, /participants\.view/);
  assert.match(fn, /user_can_access_organization/);
});

test("hydrate da action so carrega os IDs da pagina e preserva a ordem do RPC", async () => {
  const actions = await read("src/app/operacoes/actions.ts");
  const list = sliceFn(actions, "listOperationTicketsAction");
  assert.match(list, /\.in\("id", ticketIds\)/);
  assert.match(list, /ticketIdOrder\.get\(a\.id\)/);
  assert.match(list, /filterFallbackCentralRow/);
  assert.match(list, /windowTicketsThenFallbacks/);
  assert.match(list, /filtered_count: filteredCount/);
  assert.match(list, /operational_total: operationalTotal/);
});

test("dropdowns da Central nao derivam da pagina carregada", async () => {
  const page = await read("src/app/operacoes/page.tsx");
  assert.match(page, /const shirtTypes = facets\.shirt_types/);
  assert.match(page, /const cities = facets\.cities/);
  assert.doesNotMatch(page, /items\.map\(\(item\) => item\.shirt_type\)/);
  assert.doesNotMatch(page, /items\.map\(\(item\) => item\.city\)/);
  const sql = await read("supabase/migrations/20261118000000_list_operation_tickets.sql");
  assert.match(sql, /'facets', coalesce\(v_facets/);
});

test("troca de filtro volta para pagina 1 e a busca dispara consulta server-side", async () => {
  const page = await read("src/app/operacoes/page.tsx");
  const filterChange = page.slice(page.indexOf("function handleFilterChange"), page.indexOf("function handleSort"));
  assert.match(filterChange, /setListPage\(1\)/);
  assert.match(page, /listOperationTicketsAction\(\{/);
  assert.match(page, /search: active\.filters\.search/);
  assert.match(page, /shirtType: active\.filters\.shirtType/);
  assert.match(page, /onlyPending: active\.filters\.onlyPending/);
  assert.match(page, /page: active\.page/);
  assert.doesNotMatch(page, /function buildLocalView/);
});

test("copy separa resultados filtrados de ingressos operacionais", async () => {
  const filters = await read("src/app/operacoes/components/OperationsFilters.tsx");
  assert.match(filters, /ingressos operacionais no evento/);
  assert.match(filters, /Página \{pagination\.page\} de \{pagination\.totalPages\}/);
  assert.match(filters, /Anterior/);
  assert.match(filters, /Próxima/);
  assert.doesNotMatch(filters, /ingressos do evento \(filtros ativos\)/);
});

test("pending da Central permanece amplo: pagamento OU check-in OU kit OU pulseira", () => {
  assert.equal(isCentralTicketPending({
    kind: "ticket",
    payment_kind: "paid",
    checkin_status: "done",
    event_has_kit: true,
    kit_status: "delivered",
    event_wristband_enabled: true,
    wristband_status: "active",
  }), false);
  assert.equal(isCentralTicketPending({
    kind: "ticket",
    payment_kind: "pending",
    checkin_status: "done",
    event_has_kit: true,
    kit_status: "delivered",
    event_wristband_enabled: true,
    wristband_status: "active",
  }), true);
  assert.equal(isCentralTicketPending({
    kind: "ticket",
    payment_kind: "paid",
    checkin_status: "pending",
    event_has_kit: true,
    kit_status: "delivered",
    event_wristband_enabled: true,
    wristband_status: "active",
  }), true);
  assert.equal(isCentralTicketPending({
    kind: "ticket",
    payment_kind: "paid",
    checkin_status: "done",
    event_has_kit: true,
    kit_status: "pending",
    event_wristband_enabled: false,
    wristband_status: "none",
  }), true);
  assert.equal(isCentralTicketPending({
    kind: "ticket",
    payment_kind: "paid",
    checkin_status: "done",
    event_has_kit: true,
    kit_status: "configuration_pending",
    event_wristband_enabled: false,
    wristband_status: "none",
  }), true);
  assert.equal(isCentralTicketPending({
    kind: "ticket",
    payment_kind: "paid",
    checkin_status: "done",
    event_has_kit: true,
    kit_status: "delivered",
    event_wristband_enabled: true,
    wristband_status: "none",
  }), true);
  assert.equal(isCentralTicketPending({
    kind: "participant_without_ticket",
    payment_kind: "pending",
    checkin_status: "pending",
    event_has_kit: true,
    kit_status: "configuration_pending",
    event_wristband_enabled: true,
    wristband_status: null,
  }), false);
});

test("somente pendencias nao se reduz a camiseta pendente", async () => {
  const sql = await read("supabase/migrations/20261118000000_list_operation_tickets.sql");
  const pendingBlock = sql.slice(
    sql.indexOf("not coalesce(p_only_pending, false)"),
    sql.indexOf("age_filtered as"),
  );
  assert.match(pendingBlock, /payment_kind = 'pending'/);
  assert.match(pendingBlock, /checkin_status is distinct from 'done'/);
  assert.match(pendingBlock, /kit_status not in \('delivered', 'none'\)/);
  assert.doesNotMatch(pendingBlock, /shirt_type/);
});

test("window tickets-then-fallbacks pagina depois do filtro e nao usa rows.length como total", () => {
  const page1 = windowTicketsThenFallbacks({ ticketCount: 842, fallbackCount: 3, page: 1, pageSize: 50 });
  assert.equal(page1.ticketOffset, 0);
  assert.equal(page1.ticketLimit, 50);
  assert.equal(page1.fallbackLimit, 0);
  assert.equal(page1.filteredCount, 845);
  assert.equal(page1.totalPages, 17);

  const lastTickets = windowTicketsThenFallbacks({ ticketCount: 842, fallbackCount: 3, page: 17, pageSize: 50 });
  assert.equal(lastTickets.ticketOffset, 800);
  assert.equal(lastTickets.ticketLimit, 42);
  assert.equal(lastTickets.fallbackOffset, 0);
  assert.equal(lastTickets.fallbackLimit, 3);

  const afterTickets = windowTicketsThenFallbacks({ ticketCount: 842, fallbackCount: 3, page: 18, pageSize: 50 });
  assert.equal(afterTickets.ticketLimit, 0);
  assert.equal(afterTickets.fallbackOffset, 8);
  assert.equal(afterTickets.fallbackLimit, 0);

  const filtered = windowTicketsThenFallbacks({ ticketCount: 21, fallbackCount: 0, page: 1, pageSize: 50 });
  assert.equal(filtered.filteredCount, 21);
  assert.notEqual(filtered.filteredCount, 50);
});

test("parse da pagina RPC separa filtered_count de operational_total e de ids da pagina", () => {
  const parsed = parseOperationTicketPage({
    ticket_ids: ["t-1", "t-2"],
    filtered_count: 21,
    operational_total: 842,
    facets: { categories: ["Geral"], cities: ["Gaspar"], shirt_types: ["Babylook"], shirt_sizes: ["M"] },
  });
  assert.equal(parsed.ticket_ids.length, 2);
  assert.equal(parsed.filtered_count, 21);
  assert.equal(parsed.operational_total, 842);
  assert.notEqual(parsed.filtered_count, parsed.ticket_ids.length);
  assert.notEqual(parsed.operational_total, parsed.ticket_ids.length);
});

test("merge de facets usa fonte canonica de camiseta, nao so a pagina", () => {
  const merged = mergeCentralFacets(
    { categories: ["Geral"], cities: ["Gaspar"], shirt_types: ["Babylook"], shirt_sizes: ["M"] },
    ["Camiseta", "Babylook"],
    ["PP", "P", "M", "G", "GG"],
  );
  assert.deepEqual(merged.shirt_types, ["Camiseta", "Babylook"]);
  assert.ok(merged.shirt_sizes.includes("GG"));
  assert.ok(merged.shirt_sizes.includes("M"));
});

test("filtro de fallback encontra titular textual, imported_holder e participant null sem phantom", () => {
  const textual = {
    kind: "participant_without_ticket",
    participant_name: "Titular textual Silva",
    category_name: "Geral",
    city: "Gaspar",
    gender: "female",
    payment_status: "paid",
    kit_status: "configuration_pending",
    checkin_status: "pending",
    shirt_type: "Babylook",
    shirt_size: "M",
  };
  assert.equal(filterFallbackCentralRow(textual, { search: "textual silva", shirtType: "Babylook", shirtSize: "M" }), true);

  const imported = {
    ...textual,
    participant_name: "Juciele Blum",
    buyer_type: "imported_holder",
  };
  assert.equal(filterFallbackCentralRow(imported, { search: "juciele" }), true);

  const represented = participantIdsRepresentedByTickets({
    tickets: [
      { participant_id: null, order_id: "order-1", intended_owner_contact_id: "contact-natalia", status: "active" },
      { participant_id: "cadastro-normal", order_id: "order-2", intended_owner_contact_id: null, status: "used" },
    ],
    orderItems: [{ participant_id: "titular-textual" }],
    orders: [{ id: "order-1", participant_id: "buyer" }],
    participants: [
      { id: "cadastro-normal", registration_contact_id: "c1" },
      { id: "titular-textual", registration_contact_id: "c2" },
      { id: "buyer", registration_contact_id: "c3" },
      { id: "natalia", registration_contact_id: "contact-natalia" },
      { id: "real-without", registration_contact_id: "c4" },
    ],
  });
  const fallback = withoutTicketFallbackParticipants([
    { id: "cadastro-normal", registration_contact_id: "c1" },
    { id: "titular-textual", registration_contact_id: "c2" },
    { id: "buyer", registration_contact_id: "c3" },
    { id: "natalia", registration_contact_id: "contact-natalia" },
    { id: "real-without", registration_contact_id: "c4" },
  ], represented);
  assert.deepEqual(fallback.map((row) => row.id), ["real-without"]);
});

test("pageSize da Central fica entre 25 e 100, default 50", () => {
  assert.equal(clampCentralPageSize(250), 100);
  assert.equal(clampCentralPageSize(50), 50);
  assert.equal(clampCentralPageSize(10), 25);
  assert.equal(clampCentralPage(0), 1);
});

test("QR da Central continua resolvendo o evento inteiro por tickets.token", async () => {
  const actions = await read("src/app/operacoes/actions.ts");
  const qr = sliceFn(actions, "searchPickupParticipantByQrAction");
  assert.match(qr, /from\("tickets"\)/);
  assert.match(qr, /token/);
  assert.doesNotMatch(qr, /\.range\(/);
  assert.doesNotMatch(qr, /list_operation_ticket_page/);
});

test("Turbo deixa de varrer paginas de 250/500 e usa a busca server-side da Central", async () => {
  const actions = await read("src/app/operacoes/actions.ts");
  const turbo = sliceFn(actions, "searchTurboOperationsAction");
  assert.match(turbo, /listOperationTicketsAction\(\{/);
  assert.match(turbo, /search: payload\.search/);
  assert.doesNotMatch(turbo, /page >= 4/);
  assert.doesNotMatch(turbo, /pageSize = 500/);
});

test("kit pending SQL replica resolveKitStatus: configuration_pending vs pending vs delivered", async () => {
  const sql = await read("supabase/migrations/20261118000000_list_operation_tickets.sql");
  assert.match(sql, /when v_kit_count = 0 then 'none'/);
  assert.match(sql, /when coalesce\(ks\.linked_count, 0\) < v_kit_count then 'configuration_pending'/);
  assert.match(sql, /when coalesce\(ks\.delivered_count, 0\) = 0 then 'pending'/);
  assert.match(sql, /when ks\.delivered_count = ks\.linked_count then 'delivered'/);
});
