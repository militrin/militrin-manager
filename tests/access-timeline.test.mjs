import assert from "node:assert/strict";
import test from "node:test";
import { readFile as readFileRaw } from "node:fs/promises";
import {
  accessTimelineActorLine,
  accessTimelineTieRank,
  buildAccountAccessTimeline,
  collectAccessTimelineActorIds,
  deduplicateAccessTimelineEvents,
  presentAccessTimelineDescription,
  presentAccessTimelineTitle,
  sortAccessTimelineEvents,
} from "../src/lib/account/access-timeline.ts";

async function readFile(url) {
  return (await readFileRaw(url, "utf8")).replace(/\r\n/g, "\n");
}

test("1. ordenacao DESC correta entre fontes diferentes", () => {
  const events = buildAccountAccessTimeline({
    ticketId: "t1",
    issuedAt: "2026-09-09T14:23:09.793Z",
    confirmedAt: "2026-09-09T14:23:09.793Z",
    usedAt: "2026-09-21T00:50:03.578Z",
    kitFullyDelivered: true,
    kitDeliveredAt: "2026-09-21T00:49:50.000Z",
    auditRows: [],
  });
  assert.deepEqual(events.map((event) => event.type), [
    "ticket_checkin_entry",
    "ticket_kit_item_delivered",
    "ticket_issued",
    "payment_confirmed",
  ]);
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index - 1].occurredAt >= events[index].occurredAt);
  }
});

test("2. timestamps iguais usam desempate semantico, nao alfabetico", () => {
  assert.ok(accessTimelineTieRank("owner_assigned") > accessTimelineTieRank("ticket_issued"));
  assert.ok(accessTimelineTieRank("ticket_issued") > accessTimelineTieRank("payment_confirmed"));
  assert.ok(accessTimelineTieRank("ticket_checkin_entry") > accessTimelineTieRank("ticket_kit_item_delivered"));
  const sorted = sortAccessTimelineEvents([
    { id: "pay", occurredAt: "2026-09-09T14:23:09.793Z", type: "payment_confirmed" },
    { id: "owner", occurredAt: "2026-09-09T14:23:09.793Z", type: "owner_assigned" },
    { id: "issued-b", occurredAt: "2026-09-09T14:23:09.793Z", type: "manual_ticket_issued" },
    { id: "issued-a", occurredAt: "2026-09-09T14:23:09.793Z", type: "manual_ticket_issued" },
  ]);
  assert.deepEqual(sorted.map((event) => event.id), ["owner", "issued-a", "issued-b", "pay"]);
});

test("3. mapping dos tipos conhecidos", () => {
  assert.equal(presentAccessTimelineTitle("ticket_issued"), "Acesso emitido");
  assert.equal(presentAccessTimelineTitle("manual_ticket_issued"), "Acesso emitido");
  assert.equal(presentAccessTimelineTitle("payment_confirmed"), "Pagamento confirmado");
  assert.equal(presentAccessTimelineTitle("ticket_kit_item_delivered"), "Kit retirado");
  assert.equal(presentAccessTimelineTitle("ticket_checkin_entry"), "Check-in realizado");
  assert.equal(presentAccessTimelineTitle("combined_kit_delivery_and_checkin"), "Kit retirado + check-in realizado");
  assert.equal(presentAccessTimelineTitle("ticket_shirt_changed"), "Tamanho da camiseta alterado");
  assert.equal(presentAccessTimelineTitle("holder_changed"), "Titular alterado");
  assert.equal(presentAccessTimelineTitle("holder_removed"), "Titular removido");
  assert.equal(presentAccessTimelineTitle("owner_assigned"), "Acesso vinculado à conta");
  assert.equal(presentAccessTimelineTitle("owner_transferred"), "Propriedade transferida");
  assert.equal(presentAccessTimelineTitle("ticket_category_changed"), "Categoria alterada");
  assert.equal(presentAccessTimelineTitle("wristband_linked"), "Pulseira vinculada");
  assert.equal(presentAccessTimelineTitle("ticket_checkin_undo"), "Check-in desfeito");
  assert.equal(presentAccessTimelineTitle("ticket_kit_item_delivery_undone"), "Retirada do kit desfeita");
  assert.equal(presentAccessTimelineTitle("ticket_shirt_admin_corrected_after_operation"), "Camiseta corrigida");
  assert.doesNotMatch(presentAccessTimelineTitle("ticket_checkin_entry"), /Ação registrada/);
});

test("4. alteracao com previous/new value", () => {
  assert.equal(presentAccessTimelineDescription("ticket_shirt_changed", { previous_size: "M", next_size: "G" }), "M → G");
  assert.equal(presentAccessTimelineDescription("holder_changed", { previous_holder_name: "João Silva", new_holder_name: "Maria Silva" }), "João Silva → Maria Silva");
  assert.equal(presentAccessTimelineDescription("ticket_category_changed", { previous_category_name: "Pista", new_category_name: "Open Bar" }), "Pista → Open Bar");
  assert.equal(presentAccessTimelineDescription("wristband_linked", { code: "AB1234" }), "Código •••1234");
  assert.equal(presentAccessTimelineDescription("payment_confirmed", { payment_method: "courtesy" }), "Cortesia");
});

test("5. actor presente e resolvido para nome humano", () => {
  const events = buildAccountAccessTimeline({
    ticketId: "t1",
    ownerUserId: "owner-1",
    operatorNames: new Map([["admin-1", "Douglas Hobold"]]),
    auditRows: [{
      id: "audit-checkin",
      action: "ticket_checkin_entry",
      entity_type: "tickets",
      entity_id: "t1",
      created_at: "2026-09-21T00:50:03.578Z",
      details: { actor_user_id: "admin-1", ticket_id: "t1" },
    }],
  });
  const checkin = events.find((event) => event.type === "ticket_checkin_entry");
  assert.equal(checkin?.actorName, "Douglas Hobold");
  assert.equal(checkin?.actorSource, "Painel administrativo");
  assert.equal(accessTimelineActorLine(checkin), "Por Douglas Hobold · Painel administrativo");
  assert.doesNotMatch(accessTimelineActorLine(checkin) ?? "", /Operador|undefined|null|[0-9a-f-]{36}/i);
});

test("6. actor ausente nao e inventado", () => {
  const events = buildAccountAccessTimeline({
    ticketId: "t1",
    usedAt: "2026-09-21T00:50:03.578Z",
    auditRows: [],
  });
  const checkin = events.find((event) => event.type === "ticket_checkin_entry");
  assert.equal(checkin?.actorName, null);
  assert.equal(checkin?.actorSource, null);
  assert.equal(accessTimelineActorLine(checkin), null);
});

test("7. eventos desconhecidos nao viram Acao registrada", () => {
  assert.equal(presentAccessTimelineTitle("some_new_admin_action"), "Alteração administrativa");
  assert.equal(presentAccessTimelineDescription("some_new_admin_action", { previous_status: "pending", new_status: "confirmed" }), "pending → confirmed");
  assert.equal(presentAccessTimelineDescription("some_new_admin_action", {}), "some_new_admin_action");
  const events = buildAccountAccessTimeline({
    ticketId: "t1",
    auditRows: [{
      id: "unknown",
      action: "legacy_unclassified_action",
      entity_type: "tickets",
      entity_id: "t1",
      created_at: "2026-09-09T14:23:09.793Z",
      details: { ticket_id: "t1" },
    }],
  });
  assert.equal(events[0]?.title, "Alteração administrativa");
  assert.equal(events[0]?.description, "legacy_unclassified_action");
  assert.equal(events.some((event) => event.title === "Ação registrada"), false);
});

test("8. deduplicacao somente com correlacao segura", () => {
  const events = deduplicateAccessTimelineEvents([
    { id: "combined", occurredAt: "2026-09-21T00:50:03.000Z", type: "combined_kit_delivery_and_checkin", title: "Kit retirado + check-in realizado", description: null, actorName: "Douglas Hobold", actorSource: "Painel administrativo", source: "audit", metadata: {}, status: "confirmed", showStatus: false },
    { id: "checkin", occurredAt: "2026-09-21T00:50:03.000Z", type: "ticket_checkin_entry", title: "Check-in realizado", description: null, actorName: "Douglas Hobold", actorSource: "Painel administrativo", source: "audit", metadata: {}, status: "confirmed", showStatus: false },
    { id: "kit-1", occurredAt: "2026-09-21T00:50:02.000Z", type: "ticket_kit_item_delivered", title: "Kit retirado", description: null, actorName: "Douglas Hobold", actorSource: "Painel administrativo", source: "audit", metadata: {}, status: "confirmed", showStatus: false },
    { id: "kit-2", occurredAt: "2026-09-21T00:50:02.100Z", type: "ticket_kit_item_delivered", title: "Kit retirado", description: null, actorName: "Douglas Hobold", actorSource: "Painel administrativo", source: "audit", metadata: {}, status: "confirmed", showStatus: false },
  ]);
  assert.deepEqual(events.map((event) => event.id), ["combined"]);
});

test("9. nao junta eventos apenas por proximidade temporal", () => {
  const events = buildAccountAccessTimeline({
    ticketId: "t1",
    auditRows: [
      {
        id: "shirt",
        action: "ticket_shirt_changed",
        entity_type: "tickets",
        entity_id: "t1",
        created_at: "2026-09-21T00:50:03.000Z",
        details: { previous_size: "M", next_size: "G", ticket_id: "t1" },
      },
      {
        id: "checkin",
        action: "ticket_checkin_entry",
        entity_type: "tickets",
        entity_id: "t1",
        created_at: "2026-09-21T00:50:03.000Z",
        details: { ticket_id: "t1", actor_user_id: "admin-1" },
      },
    ],
  });
  assert.equal(events.some((event) => event.type === "ticket_shirt_changed"), true);
  assert.equal(events.some((event) => event.type === "ticket_checkin_entry"), true);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "ticket_checkin_entry");
});

test("10. caso real #1120 deixa de gerar Acao registrada", () => {
  const names = new Map([["admin-1", "Douglas Hobold"], ["owner-1", "Douglas Hobold"]]);
  const sameOps = "2026-09-21T00:50:03.578Z";
  const sameIssue = "2026-09-09T14:23:09.793Z";
  const events = buildAccountAccessTimeline({
    ticketId: "76efe71a-ticket",
    orderId: "order-1",
    orderItemId: "item-1",
    ownerUserId: "owner-1",
    issuedAt: sameIssue,
    confirmedAt: sameIssue,
    usedAt: sameOps,
    paymentMethod: "courtesy",
    orderReference: "1120",
    eventName: "Militrin",
    kitFullyDelivered: true,
    kitDeliveredAt: sameOps,
    shirtLabel: "Camiseta GG",
    operatorNames: names,
    auditRows: [
      {
        id: "checkin",
        action: "ticket_checkin_entry",
        entity_type: "tickets",
        entity_id: "76efe71a-ticket",
        created_at: sameOps,
        details: { actor_user_id: "admin-1", ticket_id: "76efe71a-ticket" },
      },
      {
        id: "kit-1",
        action: "ticket_kit_item_delivered",
        entity_type: "participant_kit_items",
        entity_id: "kit-1",
        created_at: sameOps,
        details: { actor_user_id: "admin-1", ticket_id: "76efe71a-ticket" },
      },
      {
        id: "kit-2",
        action: "ticket_kit_item_delivered",
        entity_type: "participant_kit_items",
        entity_id: "kit-2",
        created_at: sameOps,
        details: { actor_user_id: "admin-1", ticket_id: "76efe71a-ticket" },
      },
      {
        id: "reservation",
        action: "reservation_expired_released",
        entity_type: "participants",
        entity_id: "participant-1",
        created_at: "2026-09-20T18:15:00.130Z",
        details: { payment_id: "other-payment", shirt_size: "M", shirt_type: "Camiseta" },
      },
      {
        id: "issued",
        action: "ticket_issued",
        entity_type: "tickets",
        entity_id: "76efe71a-ticket",
        created_at: sameIssue,
        details: { order_id: "order-1", order_item_id: "item-1" },
      },
      {
        id: "manual-order",
        action: "manual_registration_order_created",
        entity_type: "orders",
        entity_id: "order-1",
        created_at: sameIssue,
        details: { actor_user_id: "admin-1", ticket_id: "76efe71a-ticket", order_item_id: "item-1" },
      },
      {
        id: "manual-ticket",
        action: "manual_ticket_issued",
        entity_type: "tickets",
        entity_id: "76efe71a-ticket",
        created_at: sameIssue,
        details: { actor_user_id: "admin-1", payment_method: "courtesy", issue_reason: "administrative_adjustment" },
      },
    ],
    ownerRows: [{
      id: "owner-1",
      operation: "owner_assigned",
      created_at: "2026-09-09T16:16:12.788Z",
      actor_user_id: "admin-1",
      new_owner_user_id: "owner-1",
      reason_code: "data_regularization",
      reason_text: "Propriedade materializada a partir da Pessoa canonica vinculada a conta.",
    }],
  });
  assert.equal(events.some((event) => event.title === "Ação registrada"), false);
  assert.equal(events.some((event) => event.type === "reservation_expired_released"), false);
  assert.equal(events.filter((event) => event.type === "ticket_kit_item_delivered").length, 1);
  assert.equal(events.filter((event) => [
    "ticket_issued",
    "manual_ticket_issued",
    "manual_registration_order_created",
  ].includes(event.type)).length, 1);
  assert.deepEqual(events.map((event) => event.title), [
    "Check-in realizado",
    "Kit retirado",
    "Proprietário materializado",
    "Acesso emitido",
    "Pagamento confirmado",
  ]);
  const ui = events.map((event) => ({
    title: event.title,
    detail: event.description,
    actor: accessTimelineActorLine(event),
  }));
  assert.deepEqual(ui, [
    { title: "Check-in realizado", detail: null, actor: "Por Douglas Hobold · Painel administrativo" },
    { title: "Kit retirado", detail: "Camiseta GG", actor: "Por Douglas Hobold · Painel administrativo" },
    { title: "Proprietário materializado", detail: "Regularização de dados", actor: "Por Douglas Hobold" },
    { title: "Acesso emitido", detail: "Cortesia", actor: "Por Douglas Hobold · Painel administrativo" },
    { title: "Pagamento confirmado", detail: "Cortesia", actor: "Sistema" },
  ]);
  const issued = events.find((event) => event.title === "Acesso emitido");
  assert.equal(issued?.type, "manual_ticket_issued");
  const checkin = events.find((event) => event.type === "ticket_checkin_entry");
  assert.equal(checkin?.source, "audit");
});

test("owner_assigned distingue vinculo, materializacao e transferencia", () => {
  assert.equal(presentAccessTimelineTitle("owner_assigned", {}), "Acesso vinculado à conta");
  assert.equal(presentAccessTimelineTitle("owner_assigned", { reason_code: "data_regularization" }), "Proprietário materializado");
  assert.equal(presentAccessTimelineTitle("owner_assigned", { reason_code: "intended_owner_materialized" }), "Proprietário pretendido materializado");
  assert.equal(presentAccessTimelineTitle("owner_transferred", { reason_code: "administrative_transfer", previous_owner_user_id: "prev" }), "Propriedade transferida");
  assert.notEqual(presentAccessTimelineTitle("owner_assigned", { reason_code: "data_regularization" }), "Propriedade transferida");
  assert.notEqual(presentAccessTimelineTitle("owner_transferred"), "Acesso vinculado à conta");
});

test("ator com user id sem nome resolvido nao vira Operador nem UUID", () => {
  const events = buildAccountAccessTimeline({
    ticketId: "t1",
    operatorNames: new Map(),
    auditRows: [{
      id: "checkin",
      action: "ticket_checkin_entry",
      entity_type: "tickets",
      entity_id: "t1",
      created_at: "2026-09-21T00:50:03.578Z",
      details: { actor_user_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ticket_id: "t1" },
    }],
  });
  const checkin = events.find((event) => event.type === "ticket_checkin_entry");
  assert.equal(checkin?.actorName, null);
  assert.equal(checkin?.actorSource, "Painel administrativo");
  assert.equal(accessTimelineActorLine(checkin), "Painel administrativo");
  assert.doesNotMatch(checkin?.actorName ?? "", /Operador|[0-9a-f-]{36}/i);
  assert.doesNotMatch(accessTimelineActorLine(checkin) ?? "", /Operador|[0-9a-f-]{36}/i);
});

test("titular autenticado so aparece com origin portal", () => {
  const events = buildAccountAccessTimeline({
    ticketId: "t1",
    ownerUserId: "owner-1",
    operatorNames: new Map([["owner-1", "Marciele Blum"]]),
    holderRows: [{
      id: "h1",
      operation: "holder_changed",
      created_at: "2026-09-10T12:00:00.000Z",
      actor_user_id: "owner-1",
      actor_origin: "portal",
      previous_holder_name: "João Silva",
      new_holder_name: "Maria Silva",
      reason_code: "holder_request",
    }],
  });
  assert.equal(accessTimelineActorLine(events[0]), "Por Marciele Blum · Titular autenticado");
});

test("isolamento: outro ticket, outra reserva e outro pedido nao entram", () => {
  const events = buildAccountAccessTimeline({
    ticketId: "ticket-a",
    orderId: "order-a",
    orderItemId: "item-a",
    auditRows: [
      {
        id: "other-ticket",
        action: "ticket_shirt_changed",
        entity_type: "participants",
        entity_id: "participant-shared",
        created_at: "2026-09-21T00:50:03.000Z",
        details: { ticket_id: "ticket-b", previous_size: "M", next_size: "G" },
      },
      {
        id: "reservation",
        action: "reservation_expired_released",
        entity_type: "participants",
        entity_id: "participant-shared",
        created_at: "2026-09-20T18:15:00.130Z",
        details: { payment_id: "other-payment", shirt_size: "M" },
      },
      {
        id: "other-order",
        action: "manual_registration_order_created",
        entity_type: "orders",
        entity_id: "order-b",
        created_at: "2026-09-09T14:23:09.793Z",
        details: { ticket_id: "ticket-b" },
      },
      {
        id: "own-checkin",
        action: "ticket_checkin_entry",
        entity_type: "tickets",
        entity_id: "ticket-a",
        created_at: "2026-09-21T00:51:00.000Z",
        details: { ticket_id: "ticket-a" },
      },
    ],
  });
  assert.deepEqual(events.map((event) => event.type), ["ticket_checkin_entry"]);
  assert.equal(events.some((event) => event.type === "reservation_expired_released"), false);
  assert.equal(events.some((event) => event.type === "ticket_shirt_changed"), false);
});

test("pagina do acesso usa o builder e nao o fallback Acao registrada", async () => {
  const page = await readFile(new URL("../src/app/minha-conta/ingressos/[ticketId]/page.tsx", import.meta.url));
  const timeline = await readFile(new URL("../src/components/militrin/MilitrinTimeline.tsx", import.meta.url));
  assert.match(page, /buildAccountAccessTimeline/);
  assert.match(page, /reason_code,reason_text/);
  assert.doesNotMatch(page, /Ação registrada/);
  assert.match(timeline, /item\.meta/);
  assert.equal(collectAccessTimelineActorIds({
    auditRows: [{ details: { actor_user_id: "admin-1" } }],
    ownerRows: [{ actor_user_id: "admin-1", new_owner_user_id: "owner-1" }],
  }).sort().join(","), "admin-1,owner-1");
});
