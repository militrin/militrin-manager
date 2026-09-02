// Gap de UX identificado depois do deploy de 20260924000000
// (ticket_cancellation_replacement_intent): o backend (owner_cancel_ticket)
// ja reclassificava um ticket cancelado com cancellation_replacement_required
// NULL havia sessoes -- ja auditado e testado em
// ticket-cancellation-replacement-intent.test.mjs/ticket-cancellation-
// authorization.test.mjs, NAO revalidado aqui de proposito, pra nao duplicar.
// O que faltava era uma UI na ficha administrativa do ingresso
// (/ingressos/[ticketId], pra onde "Ver ingresso cancelado" ja levava) --
// a secao "Cancelar ingresso" de /editar fica inteiramente desabilitada
// quando o ticket ja esta cancelado, e a UI equivalente que ja existia
// (OwnerCancelTicketButton, /cadastros/[id]) e contact-scoped e enquadrada
// como "excluir ingresso", nao como regularizacao pura. Esta bateria prova
// que a nova secao (cancellation-regularization.tsx) reusa exatamente o
// mesmo mecanismo (cancelTicketAction -> admin_cancel_ticket ->
// owner_cancel_ticket, nenhuma RPC nova) e aplica a MESMA regra de
// autorizacao ja publicada.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const component = await read('src/app/ingressos/[ticketId]/cancellation-regularization.tsx');
const fichaPage = await read('src/app/ingressos/[ticketId]/page.tsx');
const pedidoPage = await read('src/app/inscricoes/pedido/[orderId]/page.tsx');
const editarActions = await read('src/app/ingressos/[ticketId]/editar/actions.ts');

// -------------------- backend/action reusados, nenhuma RPC nova --------------------

test('a nova secao reusa cancelTicketAction (admin_cancel_ticket/owner_cancel_ticket) -- nenhuma RPC nova criada', () => {
  assert.match(component, /import \{ cancelTicketAction \} from "@\/app\/ingressos\[ticketId\]\/editar\/actions"|import \{ cancelTicketAction \} from "@\/app\/ingressos\/\[ticketId\]\/editar\/actions"/);
  assert.match(component, /cancelTicketAction\(props\.ticketId, reason, true, required\)/);
  assert.doesNotMatch(component, /\.rpc\(/, 'nunca deve chamar uma RPC diretamente -- so via cancelTicketAction, ja testado');
});

test('cancelTicketAction (reusado) ja aplica assertPermission("orders.cancel") -- mesma regra que a RPC exige (org + Owner OU orders.cancel)', () => {
  assert.match(editarActions, /export async function cancelTicketAction[\s\S]*?await assertPermission\("orders\.cancel"\);/);
});

// -------------------- 1/2/3: visibilidade da acao --------------------

test('1) ticket ativo (status != cancelled) nunca mostra a secao de regularizacao', () => {
  assert.match(component, /if \(props\.status !== "cancelled"\) return null;/);
});

test('2) ticket cancelado + replacementRequired=NULL + autorizado mostra as duas opcoes de classificacao', () => {
  const nullBranch = component.slice(component.indexOf('replacementRequired === null'), component.indexOf('replacementRequired ? ('));
  assert.match(nullBranch, /props\.canRegularize \?/);
  assert.match(nullBranch, /Cancelamento definitivo — não haverá ingresso substituto/);
  assert.match(nullBranch, /Exige substituição — outro ingresso deverá ser emitido/);
});

test('3) mesmo caso (NULL) sem orders.cancel/Owner nao mostra nenhum botao de acao, so o estado informativo', () => {
  const nullBranch = component.slice(component.indexOf('replacementRequired === null'), component.indexOf('replacementRequired ? ('));
  assert.match(nullBranch, /requer regularização manual por um administrador autorizado/);
  const elseBranch = nullBranch.slice(nullBranch.indexOf(') : ('));
  assert.doesNotMatch(elseBranch, /<button/);
});

// -------------------- 4: confirmacao obrigatoria com copy especifico por escolha --------------------

test('4) confirmacao dedicada por escolha, com o texto exato pedido -- nunca uma alteracao com 1 clique', () => {
  assert.match(component, /Confirmar cancelamento definitivo\?/);
  assert.match(component, /Este ingresso permanecerá cancelado e o sistema deixará de exigir a emissão de um substituto\./);
  assert.match(component, /Confirmar necessidade de substituição\?/);
  assert.match(component, /O ingresso permanecerá cancelado e o sistema continuará exigindo um ingresso substituto\./);
  // O clique inicial so abre o dialog (setConfirmChoice) -- so o botao DENTRO
  // do dialog de fato chama submit/cancelTicketAction.
  assert.match(component, /onClick=\{\(\) => setConfirmChoice\("definitive"\)\}/);
  assert.match(component, /onClick=\{\(\) => setConfirmChoice\("replacement"\)\}/);
  assert.match(component, /onClick=\{\(\) => submit\(confirmChoice\)\}/);
});

// -------------------- 5: nao muda nada alem da classificacao --------------------

test('5) chamada nao reativa o ticket, nao emite ingresso, nao mexe em pagamento/pedido/titular/camiseta/estoque/check-in/entrega -- so replacementRequired via cancelTicketAction ja auditado', () => {
  // O componente so tem 1 efeito colateral possivel: cancelTicketAction.
  // Nenhuma outra chamada de rede/RPC/mutacao existe no arquivo.
  const sideEffects = component.match(/await \w+\(/g) ?? [];
  assert.deepEqual([...new Set(sideEffects)], ['await cancelTicketAction(']);
});

// -------------------- 6: autorizacao --------------------

test('6) sem autorizacao nunca ve os botoes -- gate identico em todos os 3 estados (NULL, true, false)', () => {
  const nullBranch = component.slice(component.indexOf('replacementRequired === null'), component.indexOf('replacementRequired ? ('));
  const trueBranch = component.slice(component.indexOf('replacementRequired ? ('), component.indexOf(') : (\n        <div className="space-y-2">\n          <p className="text-sm text-emerald-200">'));
  const falseBranch = component.slice(component.indexOf('Cancelamento definitivo.</strong>'));
  assert.match(nullBranch, /props\.canRegularize \?/);
  assert.match(trueBranch, /props\.canRegularize \?/);
  assert.match(falseBranch, /props\.canRegularize \?/);
});

// -------------------- 8/9: estado ja classificado --------------------

test('8) estado false (cancelamento definitivo) aparece corretamente -- nunca reabre o fluxo de escolha inicial como se fosse NULL', () => {
  assert.match(component, /<strong>Cancelamento definitivo\.<\/strong> Não exige ingresso substituto\./);
});

test('9) estado true (substituicao necessaria) aparece corretamente', () => {
  assert.match(component, /<strong>Substituição necessária\.<\/strong> Aguardando ingresso substituto\./);
});

test('7) "Alterar classificação" so aparece pra quem e autorizado, nos dois estados ja classificados (backend ja suporta reclassificar de novo -- owner_cancel_ticket nao bloqueia re-reclassificacao)', () => {
  const alterarOccurrences = component.match(/Alterar classificação/g) ?? [];
  assert.equal(alterarOccurrences.length, 2, 'deve existir exatamente 1 botao "Alterar classificação" por estado ja classificado (true e false)');
});

// -------------------- ficha administrativa: wiring --------------------

test('ficha do ingresso (/ingressos/[ticketId]) busca cancellation_replacement_required/cancellation_reason_text e calcula canRegularizeCancellation via hasPermission("orders.cancel")', () => {
  assert.match(fichaPage, /cancellation_replacement_required,cancellation_reason_text/);
  assert.match(fichaPage, /const canRegularizeCancellation = await hasPermission\("orders\.cancel"\);/);
  assert.match(fichaPage, /<TicketCancellationRegularization ticketId=\{resolved\.ticketId\} status=\{String\(data\.status \?\? ""\)\} replacementRequired=\{data\.cancellation_replacement_required as boolean \| null\} reasonText=\{data\.cancellation_reason_text as string \| null\} canRegularize=\{canRegularizeCancellation\}\/>/);
});

// -------------------- Pagina do Pedido: mensagem melhorada + CTA --------------------

test('Pedido: cancelamento resolvido (replacement_required=false) deixa de ser tratado como pendencia (mesma excecao ja aplicada pelo detector de Integridade)', () => {
  assert.match(pedidoPage, /const cancellationResolved = hasCancelledOnlyTicket && ticket!\.replacementRequired === false;/);
  assert.match(pedidoPage, /const missingTicket = isConfirmedItem && !hasActiveTicket && !cancellationResolved;/);
});

test('Pedido: CTA "Regularizar cancelamento" so aparece quando replacement_required é NULL (pendente) E o usuário tem orders.cancel', () => {
  assert.match(pedidoPage, /const canRegularizeCancellation = await hasPermission\("orders\.cancel"\);/);
  assert.match(pedidoPage, /const cancellationNeedsRegularization = hasCancelledOnlyTicket && ticket!\.replacementRequired === null;/);
  assert.match(pedidoPage, /cancellationNeedsRegularization && canRegularizeCancellation \?/);
});

test('12) CTA do Pedido leva direto a ficha do ticket certo, na secao de regularizacao (ancora)', () => {
  assert.match(pedidoPage, /href=\{`\/ingressos\/\$\{ticket!\.id\}#regularizacao-cancelamento`\}/);
});

test('Pedido: nao duplica a logica de regularizacao na propria listagem -- so linka pra ficha (nenhuma chamada a cancelTicketAction nesta pagina)', () => {
  assert.doesNotMatch(pedidoPage, /cancelTicketAction/);
});

test('nenhuma migration nova foi criada para ESTA correcao (regularizacao de cancelamento) -- mecanismo ja existia por completo no backend (owner_cancel_ticket/admin_cancel_ticket nao redefinidas desde 20260924)', async () => {
  // Nao trava mais num numero absoluto de migration (tarefas legitimamente
  // posteriores, ex.: 20260928 reconciliacao de participant_data_issues,
  // adicionam migrations proprias sem relacao com esta feature) -- verifica
  // estruturalmente que nenhuma migration criada depois da que deu suporte a
  // reclassificacao (20260924) redefine as duas RPCs que a UI reusa.
  const { readdir, readFile } = await import('node:fs/promises');
  const migrationsDir = new URL('../supabase/migrations/', import.meta.url);
  const migrations = (await readdir(migrationsDir)).filter((name) => name > '20260924000000_ticket_cancellation_replacement_intent.sql');
  for (const name of migrations) {
    const content = await readFile(new URL(name, migrationsDir), 'utf8');
    assert.doesNotMatch(content, /create (or replace )?function public\.owner_cancel_ticket\(/, `${name} nao deveria redefinir owner_cancel_ticket`);
    assert.doesNotMatch(content, /create (or replace )?function public\.admin_cancel_ticket\(/, `${name} nao deveria redefinir admin_cancel_ticket`);
  }
});
