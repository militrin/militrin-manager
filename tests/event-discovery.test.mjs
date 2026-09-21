import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";
import {
  isEventEnded,
  isEventSalesOpen,
  presentPublicEventDiscovery,
  sortPublicEventsForDiscovery,
} from "../src/lib/public/event-discovery.ts";

async function readFile(rel) {
  return (await readFileRaw(new URL(`../${rel}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

const now = new Date("2026-09-21T22:00:00.000Z").getTime();

function event(overrides = {}) {
  return {
    id: "evt-a",
    name: "Evento Alfa",
    slug: "evento-alfa",
    year: 2026,
    location: "Parque",
    startsAt: "2026-10-09T22:00:00.000Z",
    endsAt: "2026-10-09T23:00:00.000Z",
    registrationEnabled: true,
    registrationOpenAt: null,
    registrationCloseAt: null,
    bannerCardUrl: null,
    bannerHeroUrl: null,
    ...overrides,
  };
}

test("A. menu Eventos aponta para a listagem, nao para um evento hardcoded", async () => {
  const nav = await readFile("src/app/minha-conta/account-nav.tsx");
  const comprar = await readFile("src/app/minha-conta/comprar/page.tsx");
  assert.match(nav, /href: '\/minha-conta\/eventos', label: 'Eventos'/);
  assert.match(nav, /href="\/minha-conta\/eventos"[^>]*label="Eventos"/s);
  assert.doesNotMatch(nav, /href: '\/minha-conta\/comprar'/);
  assert.doesNotMatch(nav, /inscricao\/militrin/);
  assert.match(comprar, /redirect\('\/minha-conta\/eventos'\)/);
  assert.doesNotMatch(comprar, /openEvents\.length === 1/);
  assert.doesNotMatch(comprar, /inscricao/);
});

test("B. pagina geral lista multiplos eventos sem redirecionar para um unico", async () => {
  const page = await readFile("src/app/minha-conta/eventos/page.tsx");
  const grid = await readFile("src/app/minha-conta/eventos/event-discovery-grid.tsx");
  assert.match(page, /getPublicEvents/);
  assert.match(page, /presentPublicEventDiscovery/);
  assert.match(page, /AccountEventDiscoveryGrid/);
  assert.match(grid, /events\.map/);
  assert.doesNotMatch(page, /redirect\(/);
});

test("C. destaque da Home nao determina presenca na listagem geral", async () => {
  const eventsLib = await readFile("src/lib/public/events.ts");
  const home = await readFile("src/app/minha-conta/page.tsx");
  const listing = await readFile("src/app/minha-conta/eventos/page.tsx");
  const adminUi = await readFile("src/app/eventos/ui.tsx");

  assert.match(eventsLib, /\.eq\('is_active', true\)/);
  assert.match(eventsLib, /\.is\('archived_at', null\)/);
  assert.doesNotMatch(eventsLib.slice(eventsLib.indexOf("export async function getPublicEvents"), eventsLib.indexOf("export async function getEventBySlug")), /event_highlights|get_featured_events_for_dashboard|featured_on_account|\.eq\('registration_enabled'/);
  assert.match(home, /get_featured_events_for_dashboard/);
  assert.match(home, /\.slice\(0, 3\)/);
  assert.match(listing, /getPublicEvents/);
  assert.doesNotMatch(listing, /get_featured_events_for_dashboard|event_highlights|featured_on_account/);
  assert.match(adminUi, /Controla só o bloco de destaques da Home/);
});

test("D. evento ativo + vendas fechadas continua estado valido e nao abre compra", () => {
  const closed = event({ registrationEnabled: false });
  assert.equal(isEventSalesOpen(closed, now), false);
  assert.equal(isEventEnded(closed, now), false);
  const card = presentPublicEventDiscovery(closed, now);
  assert.equal(card.status, "sales_closed");
  assert.equal(card.statusLabel, "Vendas fechadas");
  assert.equal(card.footnote, "Inscrições/vendas ainda não estão abertas");
  assert.equal(card.eventHref, "/eventos/evento-alfa");
  assert.equal(card.buyHref, null);
  assert.equal(card.primaryCtaLabel, "Ver evento");
  assert.equal(card.primaryCtaHref, "/eventos/evento-alfa");
});

test("E. evento com vendas abertas oferece CTA de compra no slug do evento", () => {
  const open = presentPublicEventDiscovery(event({ registrationEnabled: true }), now);
  assert.equal(open.status, "open");
  assert.equal(open.statusLabel, "Vendas abertas");
  assert.equal(open.footnote, null);
  assert.equal(open.buyHref, "/inscricao/evento-alfa");
  assert.equal(open.primaryCtaLabel, "Comprar ingresso");
  assert.equal(open.primaryCtaHref, "/inscricao/evento-alfa");
});

test("F. evento encerrado nao oferece compra", () => {
  const ended = presentPublicEventDiscovery(event({
    startsAt: "2026-08-01T19:00:00.000Z",
    endsAt: "2026-08-01T22:00:00.000Z",
    registrationEnabled: true,
  }), now);
  assert.equal(ended.status, "ended");
  assert.equal(ended.statusLabel, "Encerrado");
  assert.equal(ended.buyHref, null);
  assert.equal(ended.primaryCtaLabel, "Ver evento");
  assert.equal(ended.primaryCtaHref, "/eventos/evento-alfa");
});

test("F2. grid e ficha publica omitem compra quando vendas fechadas ou encerradas", async () => {
  const grid = await readFile("src/app/minha-conta/eventos/event-discovery-grid.tsx");
  const details = await readFile("src/app/eventos/[eventSlug]/page.tsx");
  assert.match(grid, /event\.status === 'open' && event\.buyHref/);
  assert.match(grid, /Evento encerrado/);
  assert.match(grid, /Comprar ingresso/);
  assert.match(grid, /Ver evento/);
  assert.match(details, /presentPublicEventDiscovery/);
  assert.match(details, /discovery\.buyHref/);
  assert.doesNotMatch(details, /Comprar pacote Militrin/);
});

test("G. nenhum evento especifico esta hardcoded na listagem/nav/discovery", async () => {
  const files = [
    "src/app/minha-conta/eventos/page.tsx",
    "src/app/minha-conta/eventos/event-discovery-grid.tsx",
    "src/lib/public/event-discovery.ts",
    "src/app/minha-conta/account-nav.tsx",
    "src/app/minha-conta/comprar/page.tsx",
  ];
  for (const file of files) {
    const source = await readFile(file);
    assert.doesNotMatch(source, /17e8ecdd|stammtisch|esquenta-militrin|militrin-2026|inscricao\/militrin/i);
  }
});

test("H. listagem e bottom nav mobile continuam funcionais", async () => {
  const grid = await readFile("src/app/minha-conta/eventos/event-discovery-grid.tsx");
  const nav = await readFile("src/app/minha-conta/account-nav.tsx");
  assert.match(grid, /sm:grid-cols-2/);
  assert.match(grid, /lg:max-h-\[12\.5rem\]/);
  assert.match(nav, /AccountMobileNav/);
  assert.match(nav, /href="\/minha-conta\/eventos"/);
});

test("ativar evento nao acopla abrir vendas; Abrir vendas usa a action independente", async () => {
  const actions = await readFile("src/app/eventos/actions.ts");
  const ui = await readFile("src/app/eventos/ui.tsx");
  const activateStart = actions.indexOf("export async function activateEventAction");
  const activateEnd = actions.indexOf("export async function deactivateEventAction");
  const activate = actions.slice(activateStart, activateEnd);
  assert.match(activate, /set_event_active/);
  assert.doesNotMatch(activate, /set_event_registration_enabled|registration_enabled/);
  assert.match(activate, /As vendas continuam fechadas/);
  assert.match(ui, /Evento: \{item\.is_active \? "Ativo" : "Inativo"\}/);
  assert.match(ui, /Vendas: \{item\.registration_enabled \? "Abertas" : "Fechadas"\}/);
  assert.match(ui, /setEventRegistrationEnabledAction\(item\.id, !item\.registration_enabled\)/);
  assert.match(ui, /\{item\.registration_enabled \? "Fechar vendas" : "Abrir vendas"\}/);
});

test("proximos eventos vem primeiro; passados depois", () => {
  const upcomingLate = event({ id: "b", name: "Beta", slug: "beta", startsAt: "2026-10-10T22:00:00.000Z", endsAt: "2026-10-10T23:00:00.000Z" });
  const upcomingSoon = event({ id: "a", name: "Alfa", slug: "alfa", startsAt: "2026-10-03T22:00:00.000Z", endsAt: "2026-10-03T23:00:00.000Z" });
  const past = event({ id: "c", name: "Gama", slug: "gama", startsAt: "2026-08-01T22:00:00.000Z", endsAt: "2026-08-01T23:00:00.000Z" });
  const sorted = sortPublicEventsForDiscovery([upcomingLate, past, upcomingSoon], now);
  assert.deepEqual(sorted.map((item) => item.id), ["a", "b", "c"]);
});
