import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

async function readFile(url, encoding = "utf8") {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  return source.slice(start, end === -1 ? undefined : end);
}

const [actions, turbo, scanner, hook, errors] = await Promise.all([
  readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url)),
  readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url)),
  readFile(new URL("../src/app/operacoes/components/QrScanner.tsx", import.meta.url)),
  readFile(new URL("../src/app/operacoes/components/useQrCameraScanner.ts", import.meta.url)),
  readFile(new URL("../src/app/operacoes/error-messages.ts", import.meta.url)),
]);

test("busca manual do Turbo varre paginas de ingresso, nao so os primeiros 40", () => {
  const fn = slice(actions, "export async function searchTurboOperationsAction", "export async function deliverKitCheckinAndLinkWristbandAction");
  assert.doesNotMatch(fn, /pageSize: 40/);
  assert.match(fn, /const pageSize = 500/);
  assert.match(fn, /if \(!tickets\.hasMore \|\| page >= 4\) break/);
  assert.match(fn, /matchesTicketOperationSearch/);
  assert.match(actions, /function matchesOperationSearch/);
  assert.match(actions, /digitSearch\.length < 3/);
});

test("busca de Loja inclui CPF do comprador e token ITEM/UNIT", () => {
  const fn = slice(actions, "export async function searchTurboOperationsAction", "export async function deliverKitCheckinAndLinkWristbandAction");
  assert.match(fn, /registration_contacts\(full_name, cpf\)/);
  assert.match(fn, /contactCpf/);
  assert.match(fn, /\.limit\(1000\)/);
});

test("catch do Turbo mapeia permissao, sessao e rede sem vazar digest", () => {
  const fn = slice(errors, "export function describeTurboCaughtError", "");
  assert.match(fn, /title: "Sem permissão"/);
  assert.match(fn, /title: "Sessão encerrada"/);
  assert.match(fn, /title: "Falha de conexão"/);
  assert.match(fn, /Leia o QR de novo/);
  assert.doesNotMatch(fn, /Erro de rede/);
  assert.match(turbo, /describeTurboCaughtError/);
  assert.doesNotMatch(turbo, /title: 'Erro de rede'/);
});

test("camera com erro oferece retry sem reload da pagina", () => {
  assert.match(scanner, /Tentar câmera de novo/);
  assert.match(scanner, /setRestartGeneration\(\(current\) => current \+ 1\)/);
  assert.match(hook, /restartGeneration/);
  assert.match(hook, /\[smallQrMode, isDev, restartGeneration\]/);
});

test("ingresso e Loja continuam separados na busca e o CTA de kit some sem permissao combinada", () => {
  const search = slice(turbo, "function OperationSearch(", "function ProductChoices(");
  assert.match(search, /Ingressos/);
  assert.match(search, /Loja/);
  assert.match(search, /Nome, CPF, pedido ou código/);
  const review = slice(turbo, "function TicketReview(", "function OperationSearch(");
  assert.match(review, /Este perfil não entrega kit nem faz check-in/);
  const product = slice(turbo, "function ProductReview(", "function ProductAlreadyDelivered(");
  assert.match(product, /Você não tem permissão para entregar itens da Loja/);
});

test("CTA de mutacao fica disabled e troca o texto enquanto processa", () => {
  assert.match(turbo, /ENTREGANDO\.\.\./);
  assert.match(turbo, /FAZENDO CHECK-IN\.\.\./);
  assert.match(turbo, /VINCULANDO PULSEIRA\.\.\./);
  assert.match(turbo, /PROCESSANDO\.\.\./);
  const review = slice(turbo, "function TicketReview(", "function OperationSearch(");
  assert.match(review, /busy=\{busy\}/);
  assert.match(review, /disabled=\{busy\}/);
  const product = slice(turbo, "function ProductReview(", "function ProductAlreadyDelivered(");
  assert.match(product, /busy=\{busy\}/);
  assert.match(turbo, /aria-busy=\{busy \|\| undefined\}/);
  assert.match(turbo, /endBusy\(\)/);
});
