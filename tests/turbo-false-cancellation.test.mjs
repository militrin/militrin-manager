import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  remainingTurboTicketAction,
  resolveTicketOperationGate,
} from "../src/lib/operations/ticket-operation-gate.ts";

const actions = await readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url), "utf8");
const turbo = await readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url), "utf8");
const checkinRpc = await readFile(
  new URL("../supabase/migrations/20261017000000_legacy_paid_operational_payment.sql", import.meta.url),
  "utf8",
);

const DOUGLAS_ACTIVE = {
  ticketStatus: "active",
  paymentStatus: "paid",
  paymentMethod: "courtesy",
  priceOrigin: null,
  registrationStatus: "cancelled",
  reservationStatus: "expired",
  orderStatus: "confirmed",
  itemStatus: "confirmed",
};

test("ticket ativo + registration_status cancelled NAO vira Inscricao cancelada", () => {
  const gate = resolveTicketOperationGate({
    ticketStatus: DOUGLAS_ACTIVE.ticketStatus,
    paymentStatus: DOUGLAS_ACTIVE.paymentStatus,
    paymentMethod: DOUGLAS_ACTIVE.paymentMethod,
    priceOrigin: DOUGLAS_ACTIVE.priceOrigin,
  });
  assert.equal(gate.canOperate, true);
  assert.equal(gate.blockReason, null);
  assert.notEqual(gate.blockReason, "Inscrição cancelada.");
});

test("pedido/pagamento/historico cancelados de OUTRO registro nao contaminam o ticket ativo", () => {
  const activeGate = resolveTicketOperationGate({
    ticketStatus: "active",
    paymentStatus: "paid",
    paymentMethod: "courtesy",
  });
  const otherCancelled = resolveTicketOperationGate({
    ticketStatus: "cancelled",
    paymentStatus: "paid",
    paymentMethod: "courtesy",
  });
  assert.equal(activeGate.canOperate, true);
  assert.equal(otherCancelled.canOperate, false);
  assert.match(otherCancelled.blockReason ?? "", /Ingresso cancelado/);
});

test("ticket.status cancelled continua bloqueado", () => {
  const gate = resolveTicketOperationGate({
    ticketStatus: "cancelled",
    paymentStatus: "paid",
    paymentMethod: "pix",
    priceOrigin: "catalog",
  });
  assert.equal(gate.canOperate, false);
  assert.match(gate.blockReason ?? "", /Ingresso cancelado/);
});

test("pagamento pendente real descreve a causa, nao Inscricao cancelada", () => {
  const gate = resolveTicketOperationGate({
    ticketStatus: "active",
    paymentStatus: "pending",
    paymentMethod: "pix",
    priceOrigin: "catalog",
  });
  assert.equal(gate.canOperate, false);
  assert.match(gate.blockReason ?? "", /Pagamento ainda não confirmado/);
  assert.doesNotMatch(gate.blockReason ?? "", /Inscrição cancelada/);
});

test("mapper de operacoes nao usa mais registration_status como cancelamento de ingresso", () => {
  assert.match(actions, /resolveTicketOperationGate/);
  assert.doesNotMatch(actions, /registrationStatus === ["']cancelled["']/);
  assert.doesNotMatch(actions, /Inscrição cancelada\./);
});

test("RPC atual de check-in tambem nao bloqueia por registration_status", () => {
  const fn = checkinRpc.slice(checkinRpc.indexOf("create or replace function public.checkin_ticket_entry"));
  const body = fn.slice(0, fn.indexOf("create or replace function public.deliver_ticket_kit_item"));
  assert.doesNotMatch(body, /registration_status/);
  assert.match(body, /if v_ticket\.status='cancelled'/);
});

test("QR do Turbo resolve por token unico, nao por nome/owner", () => {
  const resolve = actions.slice(actions.indexOf("export async function resolveTurboScanAction"));
  const body = resolve.slice(0, resolve.indexOf("export async function searchTurboOperationsAction"));
  assert.match(body, /\.eq\("token", tokenCandidate\)/);
  assert.doesNotMatch(body, /full_name|owner_user_id|participant_id/);
});

test("kit entregue + check-in pendente oferece acao; kit+check-in feitos voltam ao scanner", () => {
  assert.equal(
    remainingTurboTicketAction({
      ticketStatus: "active",
      checkinStatus: "pending",
      canOperate: true,
      kitPending: false,
      wristbandRequired: false,
    }),
    "checkin",
  );
  assert.equal(
    remainingTurboTicketAction({
      ticketStatus: "active",
      checkinStatus: "pending",
      canOperate: true,
      kitPending: true,
      wristbandRequired: true,
    }),
    "wristband",
  );
  assert.equal(
    remainingTurboTicketAction({
      ticketStatus: "used",
      checkinStatus: "done",
      canOperate: true,
      kitPending: false,
      wristbandRequired: false,
    }),
    null,
  );
  assert.equal(
    remainingTurboTicketAction({
      ticketStatus: "cancelled",
      checkinStatus: "pending",
      canOperate: false,
      kitPending: true,
      wristbandRequired: true,
    }),
    null,
  );
});
