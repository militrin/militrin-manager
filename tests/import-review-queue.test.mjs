import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const actions = await readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8');
const client = await readFile(new URL('../src/app/importacoes/ImportacoesClient.tsx', import.meta.url), 'utf8');
const queue = await readFile(new URL('../src/app/importacoes/revisoes/page.tsx', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260941000000_import_review_operational_queue.sql', import.meta.url), 'utf8');
const materializationMigration = await readFile(new URL('../supabase/migrations/20260943000000_import_review_decision_materialization.sql', import.meta.url), 'utf8');

test('match por CPF exato vincula deterministicamente', () => {
  assert.match(actions, /cpfMap\.get\(row\.cpf\)/);
  assert.match(actions, /reason: emailCandidate \? 'cpf_and_email_exact' : 'cpf_exact'/);
  assert.match(actions, /resolution = 'link_existing'/);
});

test('match apenas por e-mail exige revisão explícita', () => {
  assert.match(actions, /emailMap\.get\(row\.email\)/);
  assert.match(actions, /reason: 'email_exact_requires_review'/);
});

test('CPF e e-mail apontando pessoas diferentes gera conflito com ambos candidatos', () => {
  assert.match(actions, /cpfContactId !== emailContactId/);
  assert.match(actions, /strong_identifier_conflict/);
  assert.match(actions, /candidates: \[cpfCandidate, emailCandidate\]/);
});

test('nome sem identificador forte nunca vincula automaticamente', () => {
  assert.match(actions, /name_only_suggestion/);
  assert.match(actions, /Nome semelhante encontrado; nenhum identificador forte confirmou/);
});

test('mesma pessoa exige candidato auditado e persiste o cadastro escolhido', () => {
  assert.match(migration, /jsonb_array_elements[\s\S]*registration_contact_id/);
  assert.match(migration, /resolution='link_existing',registration_contact_id=v_contact\.id/);
});

test('nova pessoa limpa vínculos candidatos e permite criação', () => {
  assert.match(migration, /resolution='create_new',registration_contact_id=null,matched_participant_id=null/);
});

test('reprocessamento usa totais persistidos e não duplica contadores', () => {
  assert.match(actions, /const totalImportedRows = \(finalRows \?\? \[\]\)\.filter/);
  assert.match(actions, /imported_rows: totalImportedRows/);
});

test('linha resolvida sai da fila e decisão fica auditada', () => {
  assert.match(queue, /eq\('status', 'review_required'\)\.eq\('resolution', 'pending'\)/);
  assert.match(migration, /import_row_review_resolved/);
  assert.match(migration, /reviewed_by=v_actor,reviewed_at=now\(\)/);
});

test('relatório com revisão pendente mostra CTA e mensagem correta', () => {
  assert.match(client, /Importação processada com \$\{result\.report\.reviewRequired\} linha\(s\) aguardando revisão/);
  assert.match(client, /Revisar pendências/);
  assert.match(client, /\/importacoes\/revisoes\?batchId=/);
});

test('ticket não é emitido antes da revisão', () => {
  assert.match(actions, /if \(!isRowReadyToImport\(status, resolution\)\)/);
  assert.match(actions, /status === 'review_required'\) return resolution === 'link_existing' \|\| resolution === 'create_new'/);
});

test('depois da revisão o fluxo continua pela importação e reconciliação canônicas', () => {
  assert.match(actions, /import_current_event_contact_first/);
  assert.match(actions, /finalize_imported_ticket_after_issue_resolution/);
  assert.match(queue, /Abrir e reprocessar batch/);
});

test('fila mostra dados, candidatos, motivo, comparação, batch e impacto', () => {
  for (const text of ['Linha importada', 'Candidatos encontrados', 'CPF:', 'E-mail:', 'batch', 'A decisão fica registrada em auditoria']) {
    assert.match(queue, new RegExp(text));
  }
});

// Caso real TIEVENT: candidato de nome era montado a partir da projecao
// legada "participants" (nunca atualizada quando o cadastro e' editado em
// Cadastros -> Editar), exibindo full_name/email ANTIGOS ao administrador
// mesmo apos o cadastro real ja ter sido renomeado. O vinculo
// (registration_contact_id) sempre foi correto -- so o texto era obsoleto.
test('candidato de nome usa dados atuais de registration_contacts, nunca a projecao legada obsoleta', () => {
  assert.match(actions, /nameMatchContactIds = Array\.from\(new Set/);
  assert.match(actions, /from\('registration_contacts'\)\.select\('id,full_name,cpf,email,user_id'\)\.in\('id', nameMatchContactIds\)/);
  assert.match(actions, /liveContact \? \{ \.\.\.participant, full_name: liveContact\.full_name, cpf: liveContact\.cpf, email: liveContact\.email \} : participant/);
});

// A decisao "outra pessoa / criar novo cadastro" so pode ser considerada
// resolvida depois que a materializacao (registration_contact/participant/
// order/order_item) tiver concluido com sucesso -- nunca antes. Migration
// 20260943000000 move a materializacao para dentro da mesma transacao da
// RPC de decisao, reusando import_current_event_contact_first (nunca
// duplicando a logica de identidade/pedido/ingresso em TypeScript).
test('revisao de inscrito atual materializa create_new/link_existing na mesma transacao da decisao', () => {
  assert.match(materializationMigration, /public\.import_current_event_contact_first\(/);
  assert.match(materializationMigration, /if \(v_materialize->>'order_item_id'\) is null then raise exception 'Falha ao materializar a linha revisada\.'; end if;/);
  assert.match(materializationMigration, /status='imported',resolution=p_decision/);
});

test('RPC canonica de materializacao ganhou idempotencia por linha (nunca duplica pedido ao ser chamada de novo)', () => {
  assert.match(materializationMigration, /if v_row\.order_item_id is not null then/);
  assert.match(materializationMigration, /'created_contact',false,'created_participant_projection',false/);
});
