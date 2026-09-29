import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  participantIdsRepresentedByTickets,
  participantTicketRepresentation,
  withoutTicketFallbackParticipants,
} from "../src/lib/operations/without-ticket-fallback.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const BRUNA = {
  id: "participant-bruna",
  registration_contact_id: "contact-bruna",
  registration_status: "pending",
};
const MATHEUS = {
  id: "participant-matheus",
  registration_contact_id: "contact-matheus",
  registration_status: "pending",
};
const TITULAR = {
  id: "participant-titular",
  registration_contact_id: "contact-titular",
  registration_status: "pending",
};
const ORDER_ANCHOR = {
  id: "participant-order-anchor",
  registration_contact_id: "contact-order-anchor",
  registration_status: "pending",
};
const BUYER = {
  id: "participant-buyer",
  registration_contact_id: "contact-buyer",
  registration_status: "pending",
};
const REAL_WITHOUT = {
  id: "participant-real-without",
  registration_contact_id: "contact-real-without",
  registration_status: "pending",
};

function reasons(input, participantId) {
  return participantTicketRepresentation(input).get(participantId) ?? [];
}

test("Bruna: checkout atual + ticket existente nao gera fallback sem ingresso", () => {
  const input = {
    participants: [BRUNA],
    tickets: [{
      participant_id: null,
      order_id: "order-bruna",
      intended_owner_contact_id: null,
      status: "active",
    }],
    orderItems: [{ participant_id: null }],
    orders: [{ id: "order-bruna", participant_id: BRUNA.id }],
  };
  const represented = participantIdsRepresentedByTickets(input);
  assert.equal(reasons(input, BRUNA.id)[0], "orders.participant_id");
  assert.deepEqual(withoutTicketFallbackParticipants(input.participants, represented), []);
});

test("intended owner equivalente ao Matheus nao gera fantasma", () => {
  const input = {
    participants: [MATHEUS],
    tickets: [{
      participant_id: null,
      order_id: "order-other",
      intended_owner_contact_id: MATHEUS.registration_contact_id,
      status: "used",
    }],
    orderItems: [],
    orders: [{ id: "order-other", participant_id: null }],
  };
  const represented = participantIdsRepresentedByTickets(input);
  assert.deepEqual(reasons(input, MATHEUS.id), ["tickets.intended_owner_contact_id"]);
  assert.deepEqual(withoutTicketFallbackParticipants(input.participants, represented), []);
});

test("order participant nao gera fantasma quando o pedido ja possui ticket operacional", () => {
  const input = {
    participants: [ORDER_ANCHOR],
    tickets: [{
      participant_id: null,
      order_id: "order-anchor",
      intended_owner_contact_id: null,
      status: "active",
    }],
    orderItems: [],
    orders: [{ id: "order-anchor", participant_id: ORDER_ANCHOR.id }],
  };
  const represented = participantIdsRepresentedByTickets(input);
  assert.deepEqual(reasons(input, ORDER_ANCHOR.id), ["orders.participant_id"]);
  assert.deepEqual(withoutTicketFallbackParticipants(input.participants, represented), []);
});

test("ticket participant preserva o comportamento existente", () => {
  const input = {
    participants: [TITULAR],
    tickets: [{
      participant_id: TITULAR.id,
      order_id: "order-titular",
      intended_owner_contact_id: null,
      status: "active",
    }],
    orderItems: [],
    orders: [{ id: "order-titular", participant_id: null }],
  };
  const represented = participantIdsRepresentedByTickets(input);
  assert.deepEqual(reasons(input, TITULAR.id), ["tickets.participant_id"]);
  assert.deepEqual(withoutTicketFallbackParticipants(input.participants, represented), []);
});

test("paginacao: ticket em pagina posterior nao gera fantasma na anterior", () => {
  const page1Tickets = [{
    participant_id: TITULAR.id,
    order_id: "order-old",
    intended_owner_contact_id: null,
    status: "active",
  }];
  const laterPageTicket = {
    participant_id: null,
    order_id: "order-bruna",
    intended_owner_contact_id: null,
    status: "active",
  };
  const eventInput = {
    participants: [TITULAR, BRUNA, REAL_WITHOUT],
    tickets: [...page1Tickets, laterPageTicket],
    orderItems: [],
    orders: [
      { id: "order-old", participant_id: null },
      { id: "order-bruna", participant_id: BRUNA.id },
    ],
  };
  const represented = participantIdsRepresentedByTickets(eventInput);
  const fallback = withoutTicketFallbackParticipants(eventInput.participants, represented);
  assert.equal(represented.has(BRUNA.id), true, "a exclusao usa o evento inteiro, nao a pagina 1");
  assert.deepEqual(fallback.map((row) => row.id), [REAL_WITHOUT.id]);
});

test("pessoa realmente sem ingresso continua no fallback", () => {
  const input = {
    participants: [REAL_WITHOUT, BRUNA],
    tickets: [{
      participant_id: null,
      order_id: "order-bruna",
      intended_owner_contact_id: null,
      status: "active",
    }],
    orderItems: [],
    orders: [{ id: "order-bruna", participant_id: BRUNA.id }],
  };
  const fallback = withoutTicketFallbackParticipants(
    input.participants,
    participantIdsRepresentedByTickets(input),
  );
  assert.deepEqual(fallback.map((row) => row.id), [REAL_WITHOUT.id]);
});

test("comprador de ingresso para outra pessoa nao vira titular daquele ingresso", () => {
  const input = {
    participants: [BUYER, TITULAR],
    tickets: [{
      participant_id: TITULAR.id,
      order_id: "order-gift",
      intended_owner_contact_id: null,
      status: "active",
    }],
    orderItems: [{ participant_id: TITULAR.id }],
    orders: [{ id: "order-gift", participant_id: BUYER.id }],
  };
  const representation = participantTicketRepresentation(input);
  assert.ok(representation.get(TITULAR.id)?.includes("tickets.participant_id"));
  assert.ok(representation.get(BUYER.id)?.includes("orders.participant_id"));
  assert.equal((representation.get(BUYER.id) ?? []).includes("tickets.participant_id"), false);
  assert.equal(input.tickets[0].participant_id, TITULAR.id);
});

test("pedido so com ticket cancelado nao representa o orders.participant_id", () => {
  const input = {
    participants: [ORDER_ANCHOR, REAL_WITHOUT],
    tickets: [{
      participant_id: null,
      order_id: "order-cancelled",
      intended_owner_contact_id: null,
      status: "cancelled",
    }],
    orderItems: [],
    orders: [{ id: "order-cancelled", participant_id: ORDER_ANCHOR.id }],
  };
  const fallback = withoutTicketFallbackParticipants(
    input.participants,
    participantIdsRepresentedByTickets(input),
  );
  assert.deepEqual(fallback.map((row) => row.id).sort(), [ORDER_ANCHOR.id, REAL_WITHOUT.id].sort());
});

test("Central consulta fallback no evento inteiro e nao na pagina corrente", async () => {
  const actions = await read("src/app/operacoes/actions.ts");
  const start = actions.indexOf("export async function listOperationTicketsAction");
  const list = actions.slice(start, actions.indexOf("export async function listPickupParticipantsAction"));
  assert.match(list, /participantIdsRepresentedByTickets/);
  assert.match(list, /withoutTicketFallbackParticipants/);
  assert.match(list, /intended_owner_contact_id/);
  assert.match(list, /registration_contact_id/);
  assert.match(list, /from\("orders"\)[\s\S]*participant_id[\s\S]*eq\("event_id", eventId\)/);
  assert.match(list, /from\("order_items"\)[\s\S]*participant_id[\s\S]*eq\("event_id", eventId\)/);
  assert.doesNotMatch(list, /\.in\("order_id", orderIds\)[\s\S]*not\("participant_id", "is", null\)/);
});

test("rotulo de checkout publico nao aparece como importada", async () => {
  const [row, table] = await Promise.all([
    read("src/app/operacoes/components/OperationRow.tsx"),
    read("src/app/operacoes/components/OperationsTable.tsx"),
  ]);
  assert.match(row, /Inscrição sem ingresso/);
  assert.doesNotMatch(row, /Inscrição importada sem ingresso gerado/);
  assert.match(row, /item\.is_imported_without_ticket \? "Importação sem ingresso" : "Sem ingresso"/);
  assert.match(table, /group\.group_type === "imported_participant"/);
});
