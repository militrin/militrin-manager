import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

const turbo = await readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url), "utf8");

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  return source.slice(start, end === -1 ? undefined : end);
}

test("copy operacional do reset e VOLTAR AO LEITOR, nao SCANNER", () => {
  assert.match(turbo, /const BACK_TO_READER_LABEL = '← VOLTAR AO LEITOR'/);
  assert.doesNotMatch(turbo, /VOLTAR AO SCANNER|Voltar ao scanner|Cancelar leitura/);
  assert.match(turbo, /function BackToReaderButton\(/);
});

test("5. abrir ingresso mostra VOLTAR AO LEITOR e o reset volta ao scanner ativo", () => {
  const review = slice(turbo, "function TicketReview(", "function OperationSearch(");
  assert.match(review, /<BackToReaderButton onClick=\{onCancel\}/);
  const beforeMore = review.slice(0, review.indexOf("Mais ações"));
  assert.match(beforeMore, /BackToReaderButton/);
  const reset = slice(turbo, "const backToScanner = useCallback", "const otherEventMessage");
  assert.match(reset, /type: 'RESET'/);
  assert.match(reset, /setScannerEpoch/);
  assert.match(turbo, /kind: 'scanning_initial'/);
  assert.match(turbo, /<QrScanner key=\{scannerEpoch\}/);
});

test("6. resultado bloqueado mostra VOLTAR AO LEITOR fora de Mais acoes", () => {
  const review = slice(turbo, "function TicketReview(", "function OperationSearch(");
  assert.match(review, /Operação bloqueada|Ingresso já utilizado|Ingresso cancelado/);
  assert.match(review, /prominent=\{!remainingAction \|\| !canCompleteTicket\}/);
  const beforeMore = review.slice(0, review.indexOf("Mais ações"));
  assert.match(beforeMore, /BackToReaderButton/);
  assert.doesNotMatch(beforeMore, /Cancelar leitura/);
});

test("7. Store mostra VOLTAR AO LEITOR na ficha, nas escolhas e no ja entregue", () => {
  const review = slice(turbo, "function ProductReview(", "function ProductAlreadyDelivered(");
  assert.match(review, /ENTREGAR ITEM/);
  assert.match(review, /<BackToReaderButton onClick=\{onCancel\}/);
  const choices = slice(turbo, "function ProductChoices(", "function ProductReview(");
  assert.match(choices, /BackToReaderButton/);
  const delivered = slice(turbo, "function ProductAlreadyDelivered(", "title={isUnit ? 'Desfazer entrega da unidade'");
  assert.match(delivered, /<BackToReaderButton prominent onClick=\{onBack\} \/>/);
});

test("8. busca manual tem VOLTAR AO LEITOR e o resultado aberto usa o mesmo reset", () => {
  const search = slice(turbo, "function OperationSearch(", "function ProductChoices(");
  assert.match(search, /BackToReaderButton/);
  assert.match(search, /onCancel/);
  assert.match(turbo, /kind: 'searching'/);
  assert.match(turbo, /type: 'SCAN_TICKET'/);
  assert.match(turbo, /onSelectTicket=\{\(participant\) => dispatch\(\{ type: 'SCAN_TICKET', participant \}\)\}/);
  assert.match(turbo, /onCancel=\{backToScanner\}/);
});

test("9. voltar ao leitor nao faz mutacao", () => {
  const reset = slice(turbo, "const backToScanner = useCallback", "const otherEventMessage");
  assert.match(reset, /dispatch\(\{ type: 'RESET' \}\)/);
  assert.doesNotMatch(reset, /deliverKitAndCheckinAction|undoFullKitDeliveryAction|undoCheckinEntryAction|deliverOperationalProductItemAction|undoOperationalProductDeliveryAction|deliverKitCheckinAndLinkWristbandAction/);
  const review = slice(turbo, "function TicketReview(", "function OperationSearch(");
  const beforeMore = review.slice(0, review.indexOf("Mais ações"));
  assert.doesNotMatch(beforeMore, /Desfazer entrega/);
  assert.doesNotMatch(beforeMore, /Desfazer check-in/);
});

test("10. depois do reset o proximo QR pode ser lido normalmente", () => {
  const reset = slice(turbo, "const backToScanner = useCallback", "const otherEventMessage");
  assert.match(reset, /setScannerEpoch\(\(n\) => n \+ 1\)/);
  assert.match(reset, /processingRef\.current = false/);
  assert.match(reset, /setBusyLabel\(null\)/);
  assert.match(turbo, /case 'RESET':\s*\n\s*return \{ kind: 'scanning_initial' \}/);
  assert.match(turbo, /<QrScanner key=\{scannerEpoch\} title="Aponte para o QR"/);
  assert.match(turbo, /onRead=\{handleInitialScan\}/);
  const success = slice(turbo, "function SuccessStation(", "function TicketReview(");
  assert.match(success, /LER PRÓXIMO QR/);
  assert.match(turbo, /onNext=\{backToScanner\}/);
});

test("11. Voltar ao leitor remonta o scanner", () => {
  assert.match(turbo, /<QrScanner key=\{scannerEpoch\}/);
  const reset = slice(turbo, "const backToScanner = useCallback", "const otherEventMessage");
  assert.match(reset, /type: 'RESET'/);
  assert.match(reset, /setScannerEpoch\(\(n\) => n \+ 1\)/);
  assert.match(turbo, /case 'RESET':\s*\n\s*return \{ kind: 'scanning_initial' \}/);
});

test("12. Voltar ao leitor nao faz mutacao", () => {
  const reset = slice(turbo, "const backToScanner = useCallback", "const otherEventMessage");
  assert.match(reset, /dispatch\(\{ type: 'RESET' \}\)/);
  assert.doesNotMatch(reset, /deliverKitAndCheckinAction|undoFullKitDeliveryAction|undoCheckinEntryAction|deliverOperationalProductItemAction|undoOperationalProductDeliveryAction|deliverKitCheckinAndLinkWristbandAction/);
});

test("13. Store tem Voltar ao leitor", () => {
  const review = slice(turbo, "function ProductReview(", "function ProductAlreadyDelivered(");
  assert.match(review, /<BackToReaderButton onClick=\{onCancel\}/);
  const choices = slice(turbo, "function ProductChoices(", "function ProductReview(");
  assert.match(choices, /BackToReaderButton/);
  const delivered = slice(turbo, "function ProductAlreadyDelivered(", "title={isUnit ? 'Desfazer entrega da unidade'");
  assert.match(delivered, /<BackToReaderButton prominent onClick=\{onBack\} \/>/);
});

test("14. bloqueado tem Voltar ao leitor", () => {
  const review = slice(turbo, "function TicketReview(", "function OperationSearch(");
  assert.match(review, /Operação bloqueada|Ingresso já utilizado|Ingresso cancelado/);
  const beforeMore = review.slice(0, review.indexOf("Mais ações"));
  assert.match(beforeMore, /BackToReaderButton/);
});

test("VOLTAR AO LEITOR aparece em erro operacional e na pulseira, nunca so em Mais acoes", () => {
  const error = slice(turbo, "{screen.kind === 'error'", "function SuccessStation(");
  assert.match(error, /BackToReaderButton/);
  const wristband = slice(turbo, "screen.kind === 'scanning_wristband'", "screen.kind === 'ticket_success'");
  assert.match(wristband, /BackToReaderButton/);
  const review = slice(turbo, "function TicketReview(", "function OperationSearch(");
  const more = review.slice(review.indexOf("Mais ações"));
  assert.doesNotMatch(more, /BackToReaderButton/);
  assert.doesNotMatch(more, /Cancelar leitura/);
});
