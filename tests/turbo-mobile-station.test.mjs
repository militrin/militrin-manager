import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

const turbo = await readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url), "utf8");
const scanner = await readFile(new URL("../src/app/operacoes/components/QrScanner.tsx", import.meta.url), "utf8");

test("primeira dobra do Turbo e o scanner quadrado + busca manual como fallback", () => {
  assert.match(turbo, /square hideManual/);
  assert.match(turbo, /Buscar participante/);
  assert.match(turbo, /kind: 'searching'/);
  assert.match(turbo, /OPEN_SEARCH/);
  assert.match(scanner, /aspect-square/);
});

test("ficha pos-scan mostra nome, categoria, camiseta, kit e acao principal no polegar", () => {
  const review = turbo.slice(turbo.indexOf("function TicketReview("), turbo.indexOf("function OperationSearch("));
  assert.match(review, /QR identificado/);
  assert.match(review, /Camiseta/);
  assert.match(review, /Kit pendente/);
  assert.match(review, /ENTREGAR \+ CHECK-IN/);
  assert.match(review, /ESCANEAR PULSEIRA/);
  assert.match(review, /Mais ações/);
  assert.doesNotMatch(review, /grid-cols-2/);
});

test("sucesso pede LER PRÓXIMO QR e volta ao scanner sem navegar para outra rota", () => {
  assert.match(turbo, /LER PRÓXIMO QR/);
  assert.match(turbo, /Operação concluída/);
  assert.match(turbo, /function SuccessStation\(/);
  const success = turbo.slice(turbo.indexOf("function SuccessStation("), turbo.indexOf("function TicketReview("));
  assert.match(success, /onNext/);
  assert.match(turbo, /onNext=\{backToScanner\}/);
});

test("acoes perigosas ficam em Mais acoes, nunca como botao principal", () => {
  const review = turbo.slice(turbo.indexOf("function TicketReview("), turbo.indexOf("function OperationSearch("));
  const primarySlice = review.slice(0, review.indexOf("Mais ações"));
  assert.doesNotMatch(primarySlice, /Desfazer entrega/);
  assert.doesNotMatch(primarySlice, /Desfazer check-in/);
  assert.match(review, /Desfazer entrega/);
  assert.match(review, /Desfazer check-in/);
});

test("multiplos ingressos da mesma compra aparecem como lista vertical, nao tabela", () => {
  const review = turbo.slice(turbo.indexOf("function TicketReview("), turbo.indexOf("function OperationSearch("));
  assert.match(review, /Outros ingressos desta compra/);
  assert.doesNotMatch(review, /<table/);
});

test("falta de conexao e QR invalido usam banner de bloqueio, nao so texto pequeno", () => {
  assert.match(turbo, /Sem conexão/);
  assert.match(turbo, /QR não reconhecido/);
  assert.match(turbo, /function StatusBanner\(/);
  assert.match(turbo, /tone === 'success'/);
  assert.match(turbo, /tone === 'attention'/);
});

test("estados bloqueados usam VOLTAR AO SCANNER como acao principal, sucesso usa LER PROXIMO QR", () => {
  const review = turbo.slice(turbo.indexOf("function TicketReview("), turbo.indexOf("function OperationSearch("));
  assert.match(review, /VOLTAR AO SCANNER/);
  assert.match(review, /remainingAction && canCompleteTicket \?/);
  assert.match(review, /onCancel/);
  assert.doesNotMatch(review, /disabled=\{!canProceed\}/);
  const error = turbo.slice(turbo.indexOf("{screen.kind === 'error'"), turbo.indexOf("function SuccessStation("));
  assert.match(error, /VOLTAR AO SCANNER/);
  assert.doesNotMatch(error, /LER PRÓXIMO QR/);
  const success = turbo.slice(turbo.indexOf("function SuccessStation("), turbo.indexOf("function TicketReview("));
  assert.match(success, /LER PRÓXIMO QR/);
});

test("layout do Turbo e viewport de celular, nao desktop amplo", () => {
  const chrome = turbo.slice(turbo.indexOf("function Chrome("), turbo.indexOf("function BigButton("));
  assert.match(chrome, /max-w-md/);
  assert.match(chrome, /100dvh/);
  assert.doesNotMatch(chrome, /max-w-3xl/);
});

test("busca manual cita CPF e recupera a camera sem reload", () => {
  assert.match(turbo, /Nome, CPF, pedido ou código/);
  assert.match(scanner, /Tentar câmera de novo/);
  assert.match(scanner, /setRestartGeneration/);
});

test("perfil sem kit\+check-in identifica o ingresso e esconde o CTA de mutacao", () => {
  const review = turbo.slice(turbo.indexOf("function TicketReview("), turbo.indexOf("function OperationSearch("));
  assert.match(review, /canCompleteTicket/);
  assert.match(review, /Este perfil não entrega kit nem faz check-in/);
  assert.match(turbo, /canCompleteTicket=\{capabilities\?\.canCombined !== false\}/);
});

test("falha de conexao e sessao nao aparecem como Erro de rede cru", () => {
  assert.match(turbo, /describeTurboCaughtError/);
  assert.match(turbo, /OFFLINE_COPY/);
  assert.doesNotMatch(turbo, /title: 'Erro de rede'/);
});
