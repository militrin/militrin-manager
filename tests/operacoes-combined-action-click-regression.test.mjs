import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const expandedTicketDetailsUrl = new URL('../src/app/operacoes/components/ExpandedTicketDetails.tsx', import.meta.url);
const operationRowUrl = new URL('../src/app/operacoes/components/OperationRow.tsx', import.meta.url);
const operationsTableUrl = new URL('../src/app/operacoes/components/OperationsTable.tsx', import.meta.url);
const pageUrl = new URL('../src/app/operacoes/page.tsx', import.meta.url);
const actionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const triggerFixUrl = new URL('../supabase/migrations/20260851000000_scope_holder_uniqueness_trigger_to_identity_changes.sql', import.meta.url);
const baselineSchemaUrl = new URL('../supabase/migrations/20260815001914_remote_schema.sql', import.meta.url);

// Bug relatado no teste manual: clicar em "Entregar + check-in" num ingresso
// com titular ja definido, kit pendente e check-in pendente aparentava nao
// fazer nada. Investigacao ponta a ponta (sem tentativa e erro) mostrou que o
// clique SEMPRE chegou ate a RPC -- o problema real era o erro tecnico
// HOLDER_ALREADY_HAS_TICKET_FOR_EVENT sendo exibido cru, e a causa desse erro
// era o trigger de unicidade de titular reavaliando titularidade durante uma
// simples transicao de status (check-in), sem que titularidade estivesse de
// fato sendo alterada. Estes testes travam as duas partes da correcao.

test('cenario A -- botao "Entregar + check-in" da ficha expandida abre a confirmacao obrigatoria, e so a confirmacao chama onDeliverKitAndCheckin com o ticket_id correto', async () => {
  const sql = await readFile(expandedTicketDetailsUrl, 'utf8');
  // O clique no botao NUNCA dispara a RPC diretamente -- so abre o dialogo de
  // confirmacao (ConfirmDeliverAndCheckinDialog); a RPC so acontece depois do
  // clique explicito em "Confirmar entrega + check-in" dentro do dialogo.
  assert.match(sql, /onClick=\{\(\) => setShowCombinedConfirm\(true\)\}[\s\S]{0,220}>\s*Entregar \+ check-in/);
  assert.match(
    sql,
    /async function handleCombinedConfirmed\(\)\s*\{\s*const result = await onDeliverKitAndCheckin\(detail!\.ticket_id, detail!\.participant_id\);/,
  );
});

test('cenario B -- WRISTBAND_REQUIRED na resposta de onDeliverKitAndCheckin (apos a confirmacao) abre o WristbandCodeModal ("mandatory-combined")', async () => {
  const sql = await readFile(expandedTicketDetailsUrl, 'utf8');
  const handler = sql.match(/async function handleCombinedConfirmed\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(handler, /result\.code === "WRISTBAND_REQUIRED"/);
  assert.match(handler, /setWristbandModal\("mandatory-combined"\)/);
});

test('cenario C -- ao enviar o codigo da pulseira, a MESMA operacao (onDeliverKitAndCheckin) e reenviada com o codigo', async () => {
  const sql = await readFile(expandedTicketDetailsUrl, 'utf8');
  const handler = sql.match(/async function handleMandatoryWristbandSubmit[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(handler, /mode === "mandatory-combined"\s*\n\s*\?\s*await onDeliverKitAndCheckin\(detail\.ticket_id, detail\.participant_id, code\)/);
});

test('cenario D -- runAction (page.tsx) nunca ignora erro em silencio: captura excecao, grava mensagem e retorna failure', async () => {
  const sql = await readFile(pageUrl, 'utf8');
  const runAction = sql.match(/async function runAction\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(runAction, '', 'runAction nao encontrada em page.tsx');
  assert.match(runAction, /catch \(error\)/);
  assert.match(runAction, /setMessage\(failure\.message\)/);
  assert.match(runAction, /return failure;/);
  // Em sucesso OU falha, sempre grava alguma mensagem -- nunca deixa o
  // operador sem nenhum feedback visual apos um clique.
  assert.match(runAction, /setMessage\(response\.message \?\? \(response\.success \? "Opera[cç][aã]o conclu[ií]da\." : "Opera[cç][aã]o n[aã]o conclu[ií]da\."\)\)/);
});

test('os tres botoes operacionais existem tanto na linha compacta (OperationRow) quanto na ficha expandida (ExpandedTicketDetails)', async () => {
  const rowSql = await readFile(operationRowUrl, 'utf8');
  const expandedSql = await readFile(expandedTicketDetailsUrl, 'utf8');

  for (const label of ['Entregar itens', 'Entregar + check-in', 'Fazer check-in']) {
    assert.ok(rowSql.includes(label), `OperationRow.tsx nao tem o botao "${label}"`);
    assert.ok(expandedSql.includes(label), `ExpandedTicketDetails.tsx nao tem o botao "${label}"`);
  }

  assert.match(rowSql, /onClick=\{\(\) => void onDeliverFullKit\(item\.ticket_id, item\.participant_id\)\}/);
  // "Entregar itens" e "Fazer check-in" continuam simples (sem confirmacao
  // extra); "Entregar + check-in" agora abre a confirmacao obrigatoria em vez
  // de chamar onDeliverKitAndCheckin diretamente no clique do botao.
  assert.match(rowSql, /onClick=\{\(\) => setShowCombinedConfirm\(true\)\}/);
  assert.match(rowSql, /async function handleCombinedConfirmed\(\)/);
  assert.match(rowSql, /await onDeliverKitAndCheckin\(item\.ticket_id, item\.participant_id\)/);
  assert.match(rowSql, /onClick=\{\(\) => void handleCheckinClick\(\)\}/);
});

test('OperationsTable repassa onDeliverFullKit/onDeliverKitAndCheckin/onCheckin para OperationRow e para ExpandedTicketDetails', async () => {
  const sql = await readFile(operationsTableUrl, 'utf8');
  for (const prop of ['onDeliverFullKit', 'onDeliverKitAndCheckin', 'onCheckin']) {
    const occurrences = sql.split(prop).length - 1;
    assert.ok(occurrences >= 3, `esperava >=3 usos de ${prop} em OperationsTable.tsx (tipo + OperationRow + ExpandedTicketDetails), achou ${occurrences}`);
  }
});

test('operationRpcError trata HOLDER_ALREADY_HAS_TICKET_FOR_EVENT com mensagem amigavel, sem repassar o codigo tecnico cru pro operador', async () => {
  const sql = await readFile(actionsUrl, 'utf8');
  const start = sql.indexOf('function operationRpcError(');
  assert.notEqual(start, -1, 'operationRpcError nao encontrada');
  const end = sql.indexOf('\nfunction normalizeSearch(', start);
  assert.notEqual(end, -1, 'nao foi possivel delimitar o fim de operationRpcError');
  const fn = sql.slice(start, end);
  assert.match(fn, /serialized\.includes\("HOLDER_ALREADY_HAS_TICKET_FOR_EVENT"\)/);
  assert.match(fn, /code: "HOLDER_ALREADY_HAS_TICKET_FOR_EVENT", message: detail\.message \?\? "Esta pessoa já é titular de outro ingresso neste evento\."/);
});

test('causa raiz real: DB confirma titular "Teste Importação F1" com 2 tickets ativos no mesmo evento -- migration documenta a evidencia, nao corrige dados automaticamente', async () => {
  const sql = await readFile(triggerFixUrl, 'utf8');
  assert.match(sql, /e87b532a-0017-481b-b9e0-1d8bae2ee871/);
  assert.match(sql, /533efbf0-7063-4f88-9c5b-850befeb4b29/);
  assert.match(sql, /6345e220-cd3d-486e-aad9-915f0a09b8f5/);
  // A migration nao deve conter nenhum UPDATE/DELETE corretivo sobre os dados
  // -- so a redefinicao da trigger function. So o SQL executavel (depois de
  // "begin;") -- o cabecalho de comentarios cita o UPDATE que o
  // checkin_ticket_entry ja fazia antes desta correcao, de proposito, ao
  // documentar a causa raiz.
  const executable = sql.slice(sql.indexOf('begin;'));
  assert.doesNotMatch(executable, /update public\.(tickets|participants|order_items)\s+set/i);
  assert.doesNotMatch(executable, /delete from public\.(tickets|participants|order_items)/i);
});

test('trigger corrigida NAO reavalia unicidade de titular quando participant_id/order_item_id nao mudam e o ticket nao esta sendo reativado a partir de cancelado', async () => {
  const sql = await readFile(triggerFixUrl, 'utf8');
  const fn = sql.match(/create or replace function public\.trg_enforce_ticket_holder_contact_uniqueness\(\)[\s\S]*?\nend; \$\$;/)?.[0] ?? '';
  assert.notEqual(fn, '', 'funcao da trigger nao encontrada na migration');
  assert.match(fn, /v_identity_unchanged := new\.participant_id is not distinct from old\.participant_id\s*\n\s*and new\.order_item_id is not distinct from old\.order_item_id;/);
  assert.match(fn, /v_reactivating := old\.status in \('cancelled','canceled','void','voided'\);/);
  assert.match(fn, /if v_identity_unchanged and not v_reactivating then\s*\n\s*return new;\s*\n\s*end if;/);
});

test('trigger corrigida CONTINUA chamando assert_ticket_holder_contact_available -- a regra de 1 titular por pessoa/evento nunca foi removida nem enfraquecida', async () => {
  const sql = await readFile(triggerFixUrl, 'utf8');
  assert.match(sql, /perform public\.assert_ticket_holder_contact_available\(v_ticket_id,v_event_id,v_contact\);/);
  // TG_OP='INSERT' nunca cai no early-return: so o branco tg_op='UPDATE' tem
  // o guard de v_identity_unchanged/v_reactivating.
  const fn = sql.match(/create or replace function public\.trg_enforce_ticket_holder_contact_uniqueness\(\)[\s\S]*?\nend; \$\$;/)?.[0] ?? '';
  assert.match(fn, /if tg_op='UPDATE' then/);
});

test('o trigger de order_items (sem coluna status) nao e alterado por esta correcao -- ele nunca teve o bug', async () => {
  const sql = await readFile(triggerFixUrl, 'utf8');
  assert.doesNotMatch(sql, /create trigger enforce_order_item_holder_contact_uniqueness/);
});

test('confirma no baseline vigente que "status" realmente fazia parte das colunas observadas em public.tickets antes desta correcao (motivo do bug)', async () => {
  const sql = await readFile(baselineSchemaUrl, 'utf8');
  assert.match(
    sql,
    /CREATE OR REPLACE TRIGGER "enforce_ticket_holder_contact_uniqueness" BEFORE INSERT OR UPDATE OF "participant_id", "event_id", "status", "order_item_id" ON "public"\."tickets"/,
  );
});
