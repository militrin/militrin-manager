import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const pageUrl = new URL('../src/app/operacoes/page.tsx', import.meta.url);
const actionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const errorMessagesUrl = new URL('../src/app/operacoes/error-messages.ts', import.meta.url);
const errorDialogUrl = new URL('../src/app/operacoes/components/OperationalErrorDialog.tsx', import.meta.url);
const confirmDialogUrl = new URL('../src/app/operacoes/components/ConfirmDeliverAndCheckinDialog.tsx', import.meta.url);
const ticketViewModalUrl = new URL('../src/app/operacoes/components/TicketViewModal.tsx', import.meta.url);
const expandedDetailsUrl = new URL('../src/app/operacoes/components/ExpandedTicketDetails.tsx', import.meta.url);
const operationRowUrl = new URL('../src/app/operacoes/components/OperationRow.tsx', import.meta.url);
const ticketViewerUrl = new URL('../src/components/public/TicketViewer.tsx', import.meta.url);
const statusLabelsUrl = new URL('../src/lib/status-labels.ts', import.meta.url);
const wristbandStockMigrationUrl = new URL('../supabase/migrations/20260848000000_wristband_requirement_and_reason_coded_undo.sql', import.meta.url);

// ============================================================
// 1/2/3 -- erro de negocio disparado por botao manual abre popup, com
// mensagem amigavel (nunca o codigo tecnico cru).
// ============================================================

test('1. runAction (page.tsx) abre o OperationalErrorDialog para qualquer falha de acao manual (ex.: "Entregar itens" com SHIRT_OUT_OF_STOCK)', async () => {
  const sql = await readFile(pageUrl, 'utf8');
  const runAction = sql.match(/async function runAction\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(runAction, '', 'runAction nao encontrada');
  assert.match(runAction, /openErrorDialogFor\(response\)/);
  assert.match(runAction, /openErrorDialogFor\(failure\)/);
  // handleDeliverFullKit ("Entregar itens") continua chamando runAction --
  // logo qualquer erro dele (incluindo SHIRT_OUT_OF_STOCK) passa por
  // openErrorDialogFor automaticamente, sem precisar de um caminho especial.
  const handler = sql.match(/async function handleDeliverFullKit\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(handler, /return runAction\(ticketId, \(\) =>\s*\n\s*deliverFullKitAction/);
});

test('1b. openErrorDialogFor nunca abre popup para WRISTBAND_REQUIRED (que ja abre o proprio WristbandCodeModal, mais util que um popup so informativo)', async () => {
  const sql = await readFile(pageUrl, 'utf8');
  const fn = sql.match(/function openErrorDialogFor\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(fn, '', 'openErrorDialogFor nao encontrada');
  assert.match(fn, /response\.success \|\| response\.code === "WRISTBAND_REQUIRED"\) return;/);
});

test('2. operationRpcError (SHIRT_OUT_OF_STOCK) inclui o tipo/tamanho da camiseta na mensagem devolvida ao popup', async () => {
  const sql = await readFile(actionsUrl, 'utf8');
  const start = sql.indexOf('function operationRpcError(');
  const end = sql.indexOf('\nfunction normalizeSearch(', start);
  const fn = sql.slice(start, end);
  assert.match(fn, /shirt_type: detail\.shirt_type \?\? "Camiseta", shirt_size: detail\.shirt_size \?\? ""/);
  assert.match(fn, /message: detail\.message \?\? "Camiseta sem estoque\. A entrega n[ãa]o foi confirmada\."/);
});

test('3. erro tecnico conhecido nunca aparece cru: getOperationalErrorTitle so devolve titulos amigaveis, e o popup nunca recebe/renderiza o "code"', async () => {
  const messagesSql = await readFile(errorMessagesUrl, 'utf8');
  // Nenhum retorno da funcao e o proprio codigo tecnico (SNAKE_CASE) --
  // todos os "return" devolvem uma frase com espaco.
  const returns = [...messagesSql.matchAll(/return "([^"]+)";/g)].map((m) => m[1]);
  assert.ok(returns.length >= 8, 'esperava varios titulos amigaveis mapeados');
  for (const title of returns) {
    assert.doesNotMatch(title, /^[A-Z_]+$/, `titulo "${title}" parece um codigo tecnico cru`);
  }
  const dialogSql = await readFile(errorDialogUrl, 'utf8');
  assert.doesNotMatch(dialogSql, /\bcode\b/, 'OperationalErrorDialog nao deve ter nenhuma prop/uso de "code"');
  const pageSql = await readFile(pageUrl, 'utf8');
  assert.match(pageSql, /<OperationalErrorDialog\s+title=\{errorDialog\.title\}\s+message=\{errorDialog\.message\}/);
});

// ============================================================
// 4/5/6 -- confirmacao obrigatoria antes de "Entregar + check-in".
// ============================================================

test('4. clicar em "Entregar + check-in" NAO chama onDeliverKitAndCheckin diretamente -- so abre a confirmacao (showCombinedConfirm)', async () => {
  const expandedSql = await readFile(expandedDetailsUrl, 'utf8');
  const rowSql = await readFile(operationRowUrl, 'utf8');
  assert.match(expandedSql, /onClick=\{\(\) => setShowCombinedConfirm\(true\)\}/);
  assert.match(rowSql, /onClick=\{\(\) => setShowCombinedConfirm\(true\)\}/);
  // Em nenhum dos dois arquivos o botao chama onDeliverKitAndCheckin
  // diretamente no onClick (so dentro do handler *Confirmed, chamado pelo
  // dialogo depois do clique em "Confirmar").
  assert.doesNotMatch(expandedSql, /onClick=\{\(\) => void onDeliverKitAndCheckin/);
  assert.doesNotMatch(rowSql, /onClick=\{\(\) => void onDeliverKitAndCheckin/);
});

test('5. cancelar a confirmacao (botao "Cancelar" ou fechar) nunca chama onConfirm -- so onClose', async () => {
  const dialogSql = await readFile(confirmDialogUrl, 'utf8');
  assert.match(dialogSql, /<button type="button" onClick=\{onClose\} disabled=\{submitting\}[\s\S]{0,220}>\s*\n\s*Cancelar/);
  // O overlay (clique fora) tambem so fecha, nunca confirma -- e fica
  // desabilitado enquanto submitting (nao fecha no meio de uma chamada em
  // andamento).
  assert.match(dialogSql, /onClick=\{submitting \? undefined : onClose\}/);
});

test('6. confirmar ("Confirmar entrega + check-in") chama onConfirm exatamente uma vez e sempre fecha o dialogo ao final (sucesso ou falha)', async () => {
  const dialogSql = await readFile(confirmDialogUrl, 'utf8');
  const handleConfirm = dialogSql.match(/async function handleConfirm\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(handleConfirm, '');
  assert.match(handleConfirm, /await onConfirm\(\);/);
  assert.match(handleConfirm, /finally \{\s*\n\s*setSubmitting\(false\);\s*\n\s*onClose\(\);/);
  // handleCombinedConfirmed (ExpandedTicketDetails) e o unico ponto que de
  // fato chama onDeliverKitAndCheckin -- a MESMA operacao combinada de
  // sempre, nunca entrega+checkin separados no frontend.
  const expandedSql = await readFile(expandedDetailsUrl, 'utf8');
  const handler = expandedSql.match(/async function handleCombinedConfirmed\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(handler, /await onDeliverKitAndCheckin\(detail!\.ticket_id, detail!\.participant_id\);/);
  assert.doesNotMatch(handler, /onDeliverFullKit|onCheckin\(/);
});

// ============================================================
// 7/8 -- WRISTBAND_REQUIRED depois da confirmacao reabre o MESMO
// WristbandCodeModal e reenvia a MESMA operacao combinada.
// ============================================================

test('7. WRISTBAND_REQUIRED devolvido apos a confirmacao abre o WristbandCodeModal em modo "mandatory-combined"', async () => {
  const sql = await readFile(expandedDetailsUrl, 'utf8');
  const handler = sql.match(/async function handleCombinedConfirmed\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(handler, /result && "code" in result && result\.code === "WRISTBAND_REQUIRED"/);
  assert.match(handler, /setWristbandModal\("mandatory-combined"\)/);
});

test('8. informar o codigo da pulseira no modal obrigatorio reenvia a MESMA operacao combinada (onDeliverKitAndCheckin), nunca entrega e check-in separados', async () => {
  const sql = await readFile(expandedDetailsUrl, 'utf8');
  const submitHandler = sql.match(/async function handleMandatoryWristbandSubmit[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(submitHandler, /mode === "mandatory-combined"\s*\n\s*\?\s*await onDeliverKitAndCheckin\(detail\.ticket_id, detail\.participant_id, code\)/);
});

// ============================================================
// 9 -- seguranca/atomicidade: a entrega+check-in continua sendo UMA UNICA
// chamada de RPC atomica; a confirmacao no frontend nunca duplica ou separa
// a operacao.
// ============================================================

test('9. deliverKitAndCheckinAction (server action) chama a RPC combinada UMA UNICA vez -- nenhuma chamada separada a checkin/deliver caso a combinada falhe por estoque', async () => {
  const sql = await readFile(actionsUrl, 'utf8');
  const fn = sql.match(/export async function deliverKitAndCheckinAction\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(fn, '');
  const rpcCalls = [...fn.matchAll(/supabase\.rpc\(/g)];
  assert.equal(rpcCalls.length, 1, 'deliverKitAndCheckinAction deve chamar exatamente 1 RPC (deliver_items_and_checkin)');
  assert.match(fn, /supabase\.rpc\("deliver_items_and_checkin"/);
  assert.doesNotMatch(fn, /"checkin_ticket_entry"|"deliver_ticket_full_kit"/);
});

test('9b. deliver_items_and_checkin (backend) permanece atomica: kit e check-in na MESMA transacao, sem bloco de excecao interno que permita sucesso parcial', async () => {
  const sql = await readFile(wristbandStockMigrationUrl, 'utf8');
  const fn = sql.match(/create or replace function public\.deliver_items_and_checkin\([\s\S]*?\nend; \$\$;/)?.[0] ?? '';
  assert.notEqual(fn, '', 'deliver_items_and_checkin nao encontrada');
  assert.match(fn, /perform public\.deliver_ticket_full_kit\(p_ticket_id, p_wristband_code\);/);
  assert.match(fn, /select public\.checkin_ticket_entry\(p_ticket_id, p_wristband_code\) into v_ok;/);
  assert.match(fn, /if v_ok is distinct from true then raise exception/);
  assert.doesNotMatch(fn, /exception\s+when/i, 'nao deve capturar excecao internamente -- qualquer erro precisa propagar e reverter a transacao inteira');
});

// ============================================================
// 10 -- erro de produto adicional (concessao/entrega) tambem abre popup.
// ============================================================

test('10. handleGrantStoreItem e handleDeliverAdditionalItem (produto adicional) passam por runAction -- logo erros deles (ex.: estoque insuficiente) tambem abrem o popup', async () => {
  const sql = await readFile(pageUrl, 'utf8');
  const grant = sql.match(/async function handleGrantStoreItem\([\s\S]*?\n  \}/)?.[0] ?? '';
  const deliverAdditional = sql.match(/async function handleDeliverAdditionalItem\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(grant, /return runAction\(ticketId, \(\) => grantStoreItemAction/);
  assert.match(deliverAdditional, /return runAction\(ticketId, \(\) => deliverAdditionalStoreItemAction/);
});

// ============================================================
// 11/12/13/14/15 -- "Ver ingresso": ficha real, QR real, sem gate de status.
// ============================================================

test('11. "Ver ingresso" aparece na ficha operacional, ao lado de "Copiar PIN"/"Emitir ingresso", e nunca e confundido com "Emitir ingresso"', async () => {
  const sql = await readFile(expandedDetailsUrl, 'utf8');
  const block = sql.match(/<CopyableId label="PIN do cadastro"[\s\S]*?\{detail\.can_issue_ticket \? \([\s\S]*?\) : null\}\s*\n\s*<\/div>/)?.[0] ?? '';
  assert.notEqual(block, '', 'bloco de acoes com Copiar PIN/Ver ingresso/Emitir ingresso nao encontrado');
  assert.match(block, /onClick=\{\(\) => setShowTicketView\(true\)\}/);
  assert.match(block, />\s*Ver ingresso\s*\n/);
  assert.match(block, />\s*Emitir ingresso\s*\n/);
});

test('12/13. "Ver ingresso" abre o TicketViewModal com o ticket_id da PROPRIA ficha (nunca outro ingresso), e o QR/token vem do mesmo registro buscado por esse id', async () => {
  const expandedSql = await readFile(expandedDetailsUrl, 'utf8');
  assert.match(expandedSql, /<TicketViewModal ticketId=\{detail\.ticket_id\} onClose=\{\(\) => setShowTicketView\(false\)\} \/>/);

  const actionSql = await readFile(actionsUrl, 'utf8');
  const action = actionSql.match(/export async function getOperationTicketViewAction\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(action, '');
  assert.match(action, /\.eq\("id", ticketId\)/);
  assert.match(action, /token: String\(row\.token \?\? ""\)/);

  const modalSql = await readFile(ticketViewModalUrl, 'utf8');
  assert.match(modalSql, /getOperationTicketViewAction\(ticketId\)/);
  assert.match(modalSql, /token=\{ticket\.token\}/);

  // O QR usado e o MESMO makeQrUrl(token) ja usado pelo resto do sistema --
  // nao existe QR alternativo criado pra esta tarefa.
  const viewerSql = await readFile(ticketViewerUrl, 'utf8');
  assert.match(viewerSql, /function makeQrUrl\(token: string\)/);
  assert.match(viewerSql, /const qr = makeQrUrl\(token\);/);
});

test('14. getOperationTicketViewAction nao filtra por status do ingresso -- ticket usado ou cancelado continua sendo devolvido (ficha administrativa, nao a vitrine do comprador)', async () => {
  const sql = await readFile(actionsUrl, 'utf8');
  const action = sql.match(/export async function getOperationTicketViewAction\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(action, /\.eq\("status"/);
  assert.doesNotMatch(action, /canShowTicket/);
});

test('15. status do ingresso (inclusive "cancelled") e repassado cru pro TicketViewer, que ja traduz via getStatusLabel', async () => {
  const modalSql = await readFile(ticketViewModalUrl, 'utf8');
  assert.match(modalSql, /status=\{ticket\.status\}/);
  const actionSql = await readFile(actionsUrl, 'utf8');
  const action = actionSql.match(/export async function getOperationTicketViewAction\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(action, /status: String\(row\.status \?\? "pending"\)/);
  const statusSql = await readFile(statusLabelsUrl, 'utf8');
  assert.match(statusSql, /cancelled: 'Cancelado'/);
  assert.match(statusSql, /used: 'Utilizado'/);
});

// ============================================================
// 16 -- fechar qualquer modal novo preserva o contexto da Central (filtros,
// busca, ticket expandido) -- nunca navega, nunca reseta o estado do pai.
// ============================================================

test('16. onClose dos 3 novos modais so limpa o proprio estado local -- nunca mexe em expandedId/filters nem navega pra outra tela', async () => {
  const pageSql = await readFile(pageUrl, 'utf8');
  assert.match(pageSql, /onClose=\{\(\) => setErrorDialog\(null\)\}/);

  const expandedSql = await readFile(expandedDetailsUrl, 'utf8');
  assert.match(expandedSql, /onClose=\{\(\) => setShowCombinedConfirm\(false\)\}/);
  assert.match(expandedSql, /onClose=\{\(\) => setShowTicketView\(false\)\}/);

  const rowSql = await readFile(operationRowUrl, 'utf8');
  assert.match(rowSql, /onClose=\{\(\) => setShowCombinedConfirm\(false\)\}/);

  // Nenhum dos 3 novos componentes importa navegacao (useRouter/redirect) --
  // sao overlays puros, fechar so troca estado local do componente pai.
  for (const url of [errorDialogUrl, confirmDialogUrl, ticketViewModalUrl]) {
    const sql = await readFile(url, 'utf8');
    assert.doesNotMatch(sql, /next\/navigation/, `${url.pathname} nao deveria importar next\/navigation`);
  }
});
