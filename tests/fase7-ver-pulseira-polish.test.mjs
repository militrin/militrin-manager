import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";
import { getStatusLabel } from "../src/lib/status-labels.ts";

async function read(rel) {
  return (await readFileRaw(new URL(rel, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.notEqual(end, -1, `marcador de fim nao encontrado: ${endMarker}`);
  return source.slice(start, end);
}

const actions = await read("../src/app/operacoes/actions.ts");
const client = await read("../src/app/operacoes/pulseira/WristbandLookupClient.tsx");
const page = await read("../src/app/operacoes/pulseira/page.tsx");
const qrScanner = await read("../src/app/operacoes/components/QrScanner.tsx");
const turbo = await read("../src/app/operacoes/components/TurboMode.tsx");
const replaceDialog = await read("../src/app/operacoes/components/ReplaceWristbandDialog.tsx");
const lookupFn = slice(actions, "export async function lookupWristbandByQrAction", "export async function searchLinkedWristbandsAction");
const replaceFn = slice(actions, "export async function replaceWristbandAction", "const WRISTBAND_HISTORY_ACTIONS");
const operatorFn = slice(actions, "async function resolveLookupOperator", "export async function lookupWristbandByQrAction");
const activeCard = slice(client, "function ActiveCard", "function Field");
const resultCard = slice(client, "function WristbandResultCard", "function ActiveCard");
const scannerBlock = slice(client, "<QrScanner", "/>");

test("operador conhecido vem de participant_wristbands.linked_by, nao do ultimo ator do ingresso", () => {
  assert.match(lookupFn, /\.select\("id, code, status, linked_at, linked_by, ticket_id"\)/);
  assert.match(lookupFn, /resolveLookupOperator\(linkedBy\)/);
  assert.match(operatorFn, /resolveOperatorNames\(\[linkedBy\]\)/);
  assert.doesNotMatch(lookupFn, /audit_logs/);
  assert.doesNotMatch(lookupFn, /wristband_linked/);
  assert.match(client, /linkedByName/);
  assert.match(client, /Vinculada por/);
});

test("vinculo antigo sem operador identificavel mostra Operador não identificado", () => {
  assert.match(actions, /LOOKUP_UNKNOWN_OPERATOR = "Operador não identificado"/);
  assert.match(operatorFn, /if \(!linkedBy\)/);
  assert.match(operatorFn, /formatted === "Operador" \|\| formatted === "Sistema"/);
  assert.match(operatorFn, /name: LOOKUP_UNKNOWN_OPERATOR/);
  assert.match(client, /UNKNOWN_OPERATOR_LABEL = "Operador não identificado"/);
  assert.doesNotMatch(operatorFn, /name: "Sistema"/);
});

test("Abrir ingresso aponta para a ficha canonica /ingressos/{ticket_id}", () => {
  assert.match(resultCard, /href=\{\`\/ingressos\/\$\{ticketId\}\`\}/);
  assert.match(resultCard, /Abrir ingresso/);
  assert.doesNotMatch(resultCard, /href="\/cadastros"|href=\{\`\/inscricoes/);
  assert.doesNotMatch(activeCard, /ticket_id/);
});

test("CTA Abrir ingresso respeita RBAC da ficha (participants.view ou orders.view)", () => {
  assert.match(page, /hasPermission\("participants\.view"\)/);
  assert.match(page, /hasPermission\("orders\.view"\)/);
  assert.match(page, /canViewTicket = canViewParticipants \|\| canViewOrders/);
  assert.match(page, /canViewTicket=\{canViewTicket\}/);
  assert.match(resultCard, /showOpenTicket = Boolean\(linked && ticketId && canViewTicket\)/);
  assert.match(client, /canViewTicket \? \(/);
});

test("Substituir pulseira so aparece com wristbands.replace, pulseira ativa e ingresso operacional", () => {
  assert.match(page, /hasPermission\("wristbands\.replace"\)/);
  assert.match(resultCard, /showReplace = Boolean\(linked && ticketId && canReplace && ticketEligible\)/);
  assert.match(resultCard, /isOperationalTicketStatus\(ticket\.ticket_status\)/);
  assert.match(client, /canReplace=\{canReplace\}/);
});

test("substituicao reusa dialog + replaceWristbandAction + RPC canonica, sem writer novo", () => {
  assert.match(client, /ReplaceWristbandDialog/);
  assert.match(client, /replaceWristbandAction/);
  assert.match(replaceDialog, /Selecione um motivo/);
  assert.match(replaceFn, /assertPermission\("wristbands\.replace"\)/);
  assert.match(replaceFn, /replace_wristband_for_ticket/);
  assert.match(replaceFn, /p_reason_code/);
  assert.match(client, /lookupWristbandByQrAction\(newCode\)/);
  assert.doesNotMatch(client, /rpc\("replace_wristband/);
});

test("status used nao aparece cru — usa helper operacional Check-in realizado", () => {
  assert.equal(getStatusLabel("active"), "Ativo");
  assert.equal(getStatusLabel("cancelled"), "Cancelado");
  assert.equal(getStatusLabel("used"), "Utilizado");
  assert.match(client, /from "@\/components\/militrin\/status-chips"/);
  assert.match(client, /from "@\/lib\/status-labels"/);
  assert.match(client, /normalized === "used"/);
  assert.match(client, /checkinStatusChip\(true\)\.label/);
  assert.match(client, /getStatusLabel\(status/);
  assert.match(activeCard, /label="Status do ingresso"/);
  assert.match(activeCard, /humanTicketStatus\(ticket\.ticket_status\)/);
  assert.doesNotMatch(activeCard, /value=\{ticket\.ticket_status\}/);
});

test("scanner Ver pulseira reusa QrScanner square do Turbo, aspect 1/1, object-cover, max 22rem", () => {
  assert.match(scannerBlock, /\bsquare\b/);
  assert.match(scannerBlock, /\bhideManual\b/);
  assert.match(qrScanner, /aspect-square w-full rounded-\[1\.75rem\] bg-black object-cover/);
  assert.match(qrScanner, /max-w-\[min\(100%,22rem\)\]/);
  assert.match(turbo, /square hideManual/);
  assert.doesNotMatch(scannerBlock, /aspect-video/);
  assert.doesNotMatch(client, /min-h-\[min\(70dvh/);
  assert.match(client, /overflow-x-hidden/);
});

test("hierarquia do card: titular, evento, categoria, status humano, CTAs", () => {
  const titular = activeCard.indexOf('label="Titular"');
  const evento = activeCard.indexOf('label="Evento"');
  const categoria = activeCard.indexOf('label="Categoria"');
  const status = activeCard.indexOf('label="Status do ingresso"');
  assert.ok(titular !== -1 && evento !== -1 && categoria !== -1 && status !== -1);
  assert.ok(titular < evento && evento < categoria && categoria < status);
  assert.match(lookupFn, /event_name:/);
  assert.match(lookupFn, /category_name:/);
  assert.match(lookupFn, /ticket_status:/);
  assert.match(client, /SCAN_ANOTHER_LABEL = "Ler outra pulseira"/);
  assert.match(resultCard, /SCAN_ANOTHER_LABEL/);
  assert.match(resultCard, /flex-col gap-2 sm:flex-row/);
});
