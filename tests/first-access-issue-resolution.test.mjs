import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const inviteContext = await readFile(new URL('../src/lib/account/participant-invite.ts', import.meta.url), 'utf8');
const firstAccessAction = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
const importPhase2 = await readFile(new URL('../supabase/migrations/20260815003331_contact_first_import_phase2.sql', import.meta.url), 'utf8');
const importActions = await readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8');
const priceRecalc = await readFile(new URL('../supabase/migrations/20260922000000_resolve_ticket_data_issues_price_recalc.sql', import.meta.url), 'utf8');
const inscricoesActions = await readFile(new URL('../src/app/inscricoes/actions.ts', import.meta.url), 'utf8');

// Cenario 1: importacao sem dado obrigatorio para preco continua abrindo a
// pendencia -- comportamento pre-existente do import contact-first, nao
// alterado por esta correcao (a auditoria de Integridade confirmou que a
// causa raiz era na RESOLUCAO, nao na criacao da pendencia).
test('1) importacao sem genero necessario para preco abre participant_data_issues', () => {
  assert.match(importActions, /field_code: 'gender', issue_type: 'missing_required_for_pricing'/);
  assert.match(importActions, /price\.malePrice !== price\.femalePrice && !row\.gender/);
});

// Cenario 2 (bug real corrigido): convites ancorados em registration_contact
// (o caminho canonico do import contact-first, usado por TIEVENT) tinham
// `issues` fixado em [] -- getParticipantInviteContext nunca olhava pra
// participant_data_issues reais nesse ramo, entao nenhuma correcao feita no
// primeiro acesso (genero, CPF, data de nascimento, telefone, e-mail,
// cidade -- QUALQUER campo do mesmo formulario) conseguia reabastecer
// openIssueIds/userResolvableFields, e resolve_ticket_data_issues nunca era
// chamada.
test('2) convite ancorado em contact consulta participant_data_issues reais (nao mais [])', () => {
  const contactBranch = inviteContext.slice(inviteContext.indexOf('const { data: issues } = participant'));
  assert.doesNotMatch(contactBranch.split('\n').slice(0, 4).join('\n'), /:\s*\{\s*data:\s*\[\]\s*\}/);
  assert.match(inviteContext, /eq\('registration_contact_id',\s*invite\.registration_contact_id\)\.eq\('status',\s*'open'\)/);
  // O ramo participant-anchored (ja funcionava) permanece intocado.
  assert.match(inviteContext, /eq\('participant_id',\s*participant\.id\)\.eq\('status',\s*'open'\)/);
});

test('2b) primeiro acesso so chama resolve_ticket_data_issues quando ha pendencias abertas e valores para resolver -- agora alcancavel pelo caminho contact-anchored', () => {
  assert.match(firstAccessAction, /if \(participantId && inviteContext\?\.openIssueIds\.length && Object\.keys\(issueValues\)\.length\)/);
  assert.match(firstAccessAction, /resolve_ticket_data_issues/);
});

// Cenario 3: a pendencia resolvida deixa de bloquear -- resolve_ticket_data_issues
// so marca 'resolved' as pendencias cujo field_code foi de fato submetido
// (nunca todas de uma vez), e finalize_imported_ticket_after_issue_resolution
// e chamada logo em seguida com a MESMA condicao de openIssueIds -- ou seja,
// o mesmo bug do cenario 2 tambem bloqueava a finalizacao/emissao para
// convites contact-anchored, e a mesma correcao destrava as duas etapas.
test('3) issue resolvida libera a finalizacao/emissao no mesmo fluxo contact-anchored', () => {
  assert.match(firstAccessAction, /if \(participantId && inviteContext\?\.openIssueIds\.length\) \{/);
  assert.match(firstAccessAction, /finalize_imported_ticket_after_issue_resolution/);
});

// Cenario 4: pagamento confirmado + requisitos satisfeitos -> ingresso emitido.
// finalize_imported_ticket_after_issue_resolution ja fazia isso (nao e novo
// nesta correcao) -- o teste garante que continua fazendo, ja que agora e
// alcancavel por todo import contact-first.
test('4) finalizacao emite o ingresso quando nao ha pendencia bloqueante e o pagamento ja foi tratado', () => {
  assert.match(importPhase2, /if v_blocked then v_finalization:='issues_remaining'/);
  assert.match(importPhase2, /confirm_order_item_and_issue_ticket/);
  assert.match(importPhase2, /v_finalization:='paid_and_ticket_issued'/);
});

// Cenario 5: campo ainda ausente continua bloqueando -- resolve_ticket_data_issues
// so resolve o field_code que veio em p_values; um campo nao enviado
// permanece 'open', e finalize_imported_ticket_after_issue_resolution
// re-checa blocks_ticket_issuance antes de emitir.
test('5) campo nao enviado nao e resolvido e continua bloqueando a emissao', () => {
  assert.match(priceRecalc, /field_code in\(select jsonb_object_keys\(coalesce\(p_values,'\{\}'::jsonb\)\)\)/);
  assert.match(importPhase2, /i\.status='open' and i\.blocks_ticket_issuance/);
});

// Cenario 6: correcao pelo admin (fora do primeiro acesso, tela de pendencias
// do pedido) usa a MESMA RPC -- resolve genericamente, sem depender do
// fluxo de convite.
test('6) correcao administrativa de pendencia usa a mesma RPC de resolucao', () => {
  const occurrences = inscricoesActions.match(/rpc\("resolve_ticket_data_issues"/g) ?? [];
  assert.ok(occurrences.length >= 1, 'esperava pelo menos uma chamada administrativa a resolve_ticket_data_issues');
});

// Cenario 1b (calculo dependente): resolver a pendencia de genero recalcula o
// preco quando a categoria/lote ja tem preco diferenciado por genero -- bug
// adicional encontrado na mesma auditoria (resolve_ticket_data_issues
// marcava a pendencia como resolvida sem nunca tocar em order_items/orders/
// payments quando so o genero mudava).
test('1b) resolver pendencia de genero recalcula preco quando categoria/lote ja estao definidos', () => {
  assert.match(priceRecalc, /elsif v_personal\?'gender' and v_item\.ticket_category_id is not null and v_item\.batch_id is not null\s*\n\s*and coalesce\(v_payment\.payment_status,'pending'\)<>'paid' then/);
  assert.match(priceRecalc, /registration_batch_prices/);
  assert.match(priceRecalc, /update public\.order_items set unit_price=v_amount,final_amount=v_amount/);
  assert.match(priceRecalc, /update public\.orders set base_amount=v_amount,final_amount=v_amount/);
  assert.match(priceRecalc, /update public\.payments set amount=v_amount,final_amount=v_amount,updated_at=now\(\) where id=v_payment\.id/);
});

// Revisao de seguranca pedida explicitamente: o recalculo NUNCA pode alterar
// um pedido/pagamento ja efetivamente processado. O guard fica na condicao
// do bloco inteiro (coalesce(v_payment.payment_status,'pending')<>'paid'),
// protegendo as TRES tabelas -- nao so payments como o resolve_import_ticket_options
// pre-existente faz (que so protege payments, deixando orders/order_items
// atualizaveis mesmo com pagamento ja pago -- por isso o recalculo por
// genero carrega o pagamento ANTES de decidir, em vez de reusar esse padrao).
test('1c) recalculo de preco por genero nunca altera pedido/pagamento ja pago (protege as 3 tabelas, nao so payments)', () => {
  const block = priceRecalc.slice(priceRecalc.indexOf("elsif v_personal?'gender'"), priceRecalc.indexOf("v_shirt_type:=nullif"));
  assert.match(block, /coalesce\(v_payment\.payment_status,'pending'\)<>'paid'/);
  assert.doesNotMatch(block, /update public\.order_items[\s\S]*payment_status/);
  assert.match(priceRecalc, /select \* into v_payment from public\.payments where id=v_order\.payment_id for update;/);
});

test('1d) recalculo de preco e idempotente (mesma formula deterministica a partir de dados ja persistidos)', () => {
  assert.match(priceRecalc, /v_amount:=case when lower\(coalesce\(p_values->>'gender',''\)\) in\('feminino','female','f'\) then v_price\.female_price else v_price\.male_price end;/);
});

// Cenario 16 (falso positivo em registro ja resolvido): uma pendencia com
// status='resolved' nunca e considerada pelo detector de bloqueio -- ver
// detect_integrity_open_blocking_data_issue, que filtra por status='open'.
test('16) issue ja resolvida nao aparece mais como pendencia de cadastro na Integridade', async () => {
  const enrichment = await readFile(new URL('../supabase/migrations/20260819000000_operational_integrity_entity_enrichment.sql', import.meta.url), 'utf8');
  const fn = enrichment.slice(enrichment.indexOf('detect_integrity_open_blocking_data_issue'));
  assert.match(fn, /pdi\.status = 'open'/);
});
