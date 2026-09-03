// Cobre o bug real reportado (caso TIEVENT): a decisao "Outra pessoa / criar
// novo cadastro" na fila /importacoes/revisoes fazia a linha sumir da fila
// (aparentando sucesso) sem JAMAIS criar registration_contact/participant/
// order/order_item -- porque resolve_import_batch_row_review
// (20260941000000) sempre foi so um registro de METADADO da decisao, nunca
// chamou import_current_event_contact_first (a RPC que de fato materializa).
// Corrigido em 20260943000000: a revisao materializa de imediato, na MESMA
// transacao, reusando a RPC canonica -- nunca duplicando a logica de
// identidade/pedido/ingresso em TypeScript.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

const apiUrl = 'http://127.0.0.1:54321';
const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYm8tZGVtbyIsInJvbGUiOiJhbm9uIiwiZXhwIjoxOTgzODEyOTk2fQ.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const serviceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(apiUrl, serviceKey, options);

async function must(query, label) {
  const result = await query;
  assert.equal(result.error, null, `${label}: ${result.error?.message}`);
  return result.data;
}

function freshCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const digit = (slice, factor) => {
    let sum = 0;
    for (let i = 0; i < slice.length; i += 1) sum += slice[i] * (factor - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  const d1 = digit(base, 10);
  const d2 = digit([...base, d1], 11);
  return [...base, d1, d2].join('');
}

async function setupOrgAndEvent(suffix) {
  const adminEmail = `tievent-admin-${suffix}@example.test`;
  const adminPassword = 'TievEnt-admin-123!';
  const adminCreated = await service.auth.admin.createUser({ email: adminEmail, password: adminPassword, email_confirm: true });
  assert.equal(adminCreated.error, null, adminCreated.error?.message);
  const adminId = adminCreated.data.user.id;
  const org = await must(service.from('organizations').insert({ name: 'TIEVENT Org', slug: `tievent-org-${suffix}`, status: 'active' }).select('id').single(), 'organization');
  let role = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  assert.equal(role.error, null, role.error?.message);
  if (!role.data) role = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  await must(service.from('admin_users').insert({ user_id: adminId, role_id: role.data.id, is_active: true }), 'admin user');
  await must(service.from('organization_members').insert({ organization_id: org.id, user_id: adminId, role_id: role.data.id, is_owner: true, is_active: true }), 'membership');
  const anon = createClient(apiUrl, anonKey, options);
  assert.equal((await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword })).error, null);
  const event = await must(service.from('events').insert({ organization_id: org.id, name: 'Evento TIEVENT', year: 2033,
    slug: `evento-tievent-${suffix}`, is_active: true, registration_enabled: true, starts_at: '2033-10-10T12:00:00Z', min_age: 0 }).select('id').single(), 'event');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, is_active: true }).select('id').single(), 'category');
  const batch = await must(service.from('registration_batches').insert({ event_id: event.id, name: 'Lote', sequence_number: 1,
    male_price: 150, female_price: 150, max_confirmed_registrations: 100, is_active: true }).select('id').single(), 'registration batch');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 150, female_price: 150 }), 'price');
  return { adminId, anon, org, event, category, batch };
}

function normalizedDataFor({ fullName, cpf, email, batchId, categoryId }) {
  return {
    full_name: fullName, cpf, cpf_input: cpf, email, birth_date: '1991-03-15', gender: 'male',
    phone: '11988887777', city: 'Sao Paulo', shirt_type: null, shirt_size: null,
    resolved_batch_id: batchId, resolved_category_id: categoryId, payment_method: 'pix',
  };
}

async function insertReviewRow({ importBatchId, fullName, cpf, email, batchId, categoryId, rejectedCandidateId, reason, rowNumber = 1 }) {
  return must(service.from('import_batch_rows').insert({
    import_batch_id: importBatchId, row_number: rowNumber, status: 'review_required', resolution: 'pending',
    raw_data: { linha: `${fullName},${cpf ?? ''},${email ?? ''}` },
    normalized_data: normalizedDataFor({ fullName, cpf, email, batchId, categoryId }),
    data_issues: [],
    identity_match_details: { reason, candidates: rejectedCandidateId ? [{ registration_contact_id: rejectedCandidateId, full_name: 'Candidato antigo', reason }] : [] },
  }).select('id').single(), 'review row');
}

test('TIEVENT: "Outra pessoa / criar novo" materializa cadastro/participant/order/order_item de verdade', async () => {
  const suffix = Date.now();
  const { adminId, anon, org, event, category, batch } = await setupOrgAndEvent(suffix);

  // Simula o caso real: um cadastro ANTIGO existe (renomeado, ex.: "TIEVENTold01"),
  // e uma nova linha importada chamada "TIEVENT" caiu em revisao por sugestao
  // de nome (candidato = o cadastro antigo). O administrador rejeita e pede
  // "criar novo".
  const oldContact = await must(service.from('registration_contacts').insert({
    organization_id: org.id, full_name: 'TIEVENTold01', cpf: freshCpf(), birth_date: '1985-01-01',
    gender: 'male', phone: '11900000000', email: `tieventold01-${suffix}@example.test`, city: 'Curitiba',
  }).select('id').single(), 'old renamed contact');

  const importBatch = await must(service.from('import_batches').insert({
    import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id, imported_by: adminId,
    file_name: 'tievent.csv', total_rows: 1, status: 'processing', payment_mode_original: 'pending',
  }).select('id').single(), 'import batch');

  const newCpf = freshCpf();
  const newEmail = `tievent-new-${suffix}@example.test`;
  const row = await insertReviewRow({
    importBatchId: importBatch.id, fullName: 'TIEVENT', cpf: newCpf, email: newEmail,
    batchId: batch.id, categoryId: category.id, rejectedCandidateId: oldContact.id, reason: 'name_only_suggestion',
  });

  const before = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id);

  const review = await anon.rpc('resolve_import_batch_row_review', { p_row_id: row.id, p_decision: 'create_new', p_registration_contact_id: null });
  assert.equal(review.error, null, review.error?.message);
  assert.equal(review.data.success, true);
  assert.equal(review.data.status, 'imported', 'a linha deve sair como materializada, nunca como falso sucesso sem cadastro');
  assert.ok(review.data.registration_contact_id, 'RPC devolve o registration_contact_id recem-criado');

  const after = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id);
  assert.equal(after.count, (before.count ?? 0) + 1, 'exatamente 1 novo cadastro criado');

  // #1, #3, #4: novo registration_contact + participant + order/order_item.
  const newContact = await must(service.from('registration_contacts').select('id,full_name,cpf,email').eq('id', review.data.registration_contact_id).single(), 'new contact');
  assert.equal(newContact.full_name, 'TIEVENT');
  assert.notEqual(newContact.id, oldContact.id, 'candidato rejeitado nunca e reutilizado (#10)');

  const participant = await must(service.from('participants').select('id,registration_contact_id,event_id').eq('id', review.data.participant_id).single(), 'participant');
  assert.equal(participant.registration_contact_id, newContact.id);
  assert.equal(participant.event_id, event.id);

  const orderItem = await must(service.from('order_items').select('id,order_id,registration_contact_id,participant_id,item_kind,status').eq('id', review.data.order_item_id).single(), 'order item');
  assert.equal(orderItem.item_kind, 'ticket');
  assert.equal(orderItem.registration_contact_id, newContact.id);
  assert.equal(orderItem.participant_id, participant.id);

  const order = await must(service.from('orders').select('id,participant_id,event_id').eq('id', review.data.order_id).single(), 'order');
  assert.equal(order.participant_id, participant.id);

  // #2: aparece na MESMA fonte usada por Administracao -> Cadastros
  // (src/app/cadastros/page.tsx: select direto em registration_contacts por
  // organization_id, sem exigir ticket/participant/order algum).
  const cadastrosQuery = await must(service.from('registration_contacts').select('id,full_name').eq('organization_id', org.id).order('created_at', { ascending: false }), 'cadastros listing source');
  assert.ok(cadastrosQuery.some((contact) => contact.id === newContact.id), 'novo cadastro aparece imediatamente na consulta que alimenta Administracao -> Cadastros');

  // #6: a linha so sai da revisao depois da materializacao completa.
  const rowAfter = await must(service.from('import_batch_rows').select('status,resolution,order_item_id').eq('id', row.id).single(), 'row after decision');
  assert.equal(rowAfter.status, 'imported');
  assert.equal(rowAfter.order_item_id, review.data.order_item_id);

  // #17: batch so vira completed quando nao ha revisao pendente restante.
  const batchAfter = await must(service.from('import_batches').select('status').eq('id', importBatch.id).single(), 'batch after decision');
  assert.equal(batchAfter.status, 'completed');

  // #18: auditoria registra decisao e ator corretos.
  const audit = await must(service.from('audit_logs').select('action,details').eq('action', 'import_row_review_resolved').eq('entity_id', row.id), 'audit log');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.actor_user_id, adminId);
  assert.equal(audit[0].details.decision, 'create_new');

  // #9: repetir create_new e' idempotente -- nao duplica cadastro/participant/order.
  const repeated = await anon.rpc('resolve_import_batch_row_review', { p_row_id: row.id, p_decision: 'create_new', p_registration_contact_id: null });
  assert.equal(repeated.error, null, repeated.error?.message);
  assert.equal(repeated.data.changed, false);
  const afterRepeat = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id);
  assert.equal(afterRepeat.count, after.count, 'repetir create_new nao cria segundo cadastro');
  const ordersForParticipant = await service.from('orders').select('id', { count: 'exact', head: true }).eq('participant_id', participant.id);
  assert.equal(ordersForParticipant.count, 1, 'repetir create_new nao cria segundo pedido');

  // #19: apos create_new, primeiro acesso simulado (dados validos, sem
  // issue bloqueante) -- a reconciliacao canonica tenta emitir, sem
  // reimplementar a regra em TypeScript. Lote e' 'pending': fica retida ate
  // a confirmacao financeira administrativa (regra ja validada pela tarefa
  // anterior, nunca burlada por esta correcao).
  const reconciledBeforePayment = await anon.rpc('reconcile_imported_ticket_issuance_for_participant', { p_participant_id: participant.id });
  assert.equal(reconciledBeforePayment.error, null, reconciledBeforePayment.error?.message);
  assert.equal(reconciledBeforePayment.data.attempted, 1);
  assert.equal(reconciledBeforePayment.data.results[0].finalization, 'payment_pending');
  assert.equal((await service.from('tickets').select('id', { count: 'exact', head: true }).eq('order_item_id', orderItem.id)).count, 0);

  const paymentRow = await must(service.from('payments').select('id').eq('participant_id', participant.id).single(), 'payment row');
  const confirmed = await anon.rpc('confirm_imported_pending_payment_and_reconcile', { p_payment_id: paymentRow.id, p_reason: 'Pagamento confirmado no teste TIEVENT' });
  assert.equal(confirmed.error, null, confirmed.error?.message);
  assert.equal(confirmed.data.success, true);

  const ticket = await must(service.from('tickets').select('id,participant_id,order_item_id').eq('order_item_id', orderItem.id).single(), 'issued ticket');
  assert.equal(ticket.participant_id, participant.id);
});

test('falha durante a materializacao mantem a revisao pendente e nao retorna sucesso falso', async () => {
  const suffix = Date.now() + 1;
  const { adminId, anon, org, event } = await setupOrgAndEvent(suffix);

  const importBatch = await must(service.from('import_batches').insert({
    import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id, imported_by: adminId,
    file_name: 'falha.csv', total_rows: 1, status: 'processing', payment_mode_original: 'pending',
  }).select('id').single(), 'import batch');

  // Lote e categoria de OUTRO evento -- import_current_event_contact_first
  // deve rejeitar ("Lote nao pertence ao evento"), simulando uma falha real
  // de materializacao.
  const otherEvent = await must(service.from('events').insert({ organization_id: org.id, name: 'Outro evento', year: 2034,
    slug: `outro-evento-${suffix}`, is_active: true, registration_enabled: true, starts_at: '2034-01-01T12:00:00Z', min_age: 0 }).select('id').single(), 'other event');
  const otherCategory = await must(service.from('ticket_categories').insert({ event_id: otherEvent.id, name: 'Geral', slug: `geral-outro-${suffix}`, is_active: true }).select('id').single(), 'other category');
  const otherBatch = await must(service.from('registration_batches').insert({ event_id: otherEvent.id, name: 'Lote outro', sequence_number: 1,
    male_price: 50, female_price: 50, max_confirmed_registrations: 10, is_active: true }).select('id').single(), 'other batch');

  const row = await insertReviewRow({
    importBatchId: importBatch.id, fullName: 'Falha Materializacao', cpf: freshCpf(), email: `falha-${suffix}@example.test`,
    batchId: otherBatch.id, categoryId: otherCategory.id, rejectedCandidateId: null, reason: 'name_only_suggestion',
  });

  const contactsBefore = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id);

  const review = await anon.rpc('resolve_import_batch_row_review', { p_row_id: row.id, p_decision: 'create_new', p_registration_contact_id: null });
  assert.notEqual(review.error, null, 'materializacao invalida deve falhar explicitamente, nunca devolver sucesso falso (#8)');

  // #7: linha continua/reaparece como revisao pendente.
  const rowAfter = await must(service.from('import_batch_rows').select('status,resolution,order_item_id,registration_contact_id').eq('id', row.id).single(), 'row after failed decision');
  assert.equal(rowAfter.status, 'review_required');
  assert.equal(rowAfter.resolution, 'pending');
  assert.equal(rowAfter.order_item_id, null);
  assert.equal(rowAfter.registration_contact_id, null);

  const queueCount = await service.from('import_batch_rows').select('id', { count: 'exact', head: true })
    .eq('import_batch_id', importBatch.id).eq('status', 'review_required').eq('resolution', 'pending');
  assert.equal(queueCount.count, 1, 'linha reaparece na fila de revisao apos falha');

  const contactsAfter = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id);
  assert.equal(contactsAfter.count, contactsBefore.count, 'nenhum cadastro parcial e deixado para tras');

  const batchAfter = await must(service.from('import_batches').select('status').eq('id', importBatch.id).single(), 'batch after failed decision');
  assert.notEqual(batchAfter.status, 'completed', 'lote nunca vira completed com revisao realmente pendente');
});

test('produto no mesmo pedido nunca gera ticket na reconciliacao apos create_new', async () => {
  const suffix = Date.now() + 2;
  const { adminId, anon, org, event, category, batch } = await setupOrgAndEvent(suffix);
  const product = await must(service.from('store_items').insert({ organization_id: org.id, event_id: event.id, name: 'Produto junto',
    slug: `produto-junto-${suffix}`, price: 30, is_active: true, supply_mode: 'made_to_order' }).select('id').single(), 'product');

  const importBatch = await must(service.from('import_batches').insert({
    import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id, imported_by: adminId,
    file_name: 'produto.csv', total_rows: 1, status: 'processing', payment_mode_original: 'confirm_all',
  }).select('id').single(), 'import batch');

  const row = await insertReviewRow({
    importBatchId: importBatch.id, fullName: 'Pessoa Produto Junto', cpf: freshCpf(), email: `produto-${suffix}@example.test`,
    batchId: batch.id, categoryId: category.id, rejectedCandidateId: null, reason: 'name_only_suggestion',
  });

  const review = await anon.rpc('resolve_import_batch_row_review', { p_row_id: row.id, p_decision: 'create_new', p_registration_contact_id: null });
  assert.equal(review.error, null, review.error?.message);

  await must(service.from('order_items').insert({ order_id: review.data.order_id, event_id: event.id, item_kind: 'product', store_item_id: product.id,
    quantity: 1, unit_price: 30, discount_amount: 0, final_amount: 30, status: 'reserved' }), 'product item in same order');

  // Lote confirm_all: a propria resolucao da revisao ja emitiu o ticket do
  // item de ingresso de imediato (sem issue bloqueante) -- reconciliar de
  // novo depois de anexar o produto no mesmo pedido nao encontra mais nada
  // pendente (o produto, item_kind='product', nunca entra no filtro da
  // reconciliacao).
  const reconciled = await anon.rpc('reconcile_imported_ticket_issuance_for_participant', { p_participant_id: review.data.participant_id });
  assert.equal(reconciled.error, null, reconciled.error?.message);
  assert.equal(reconciled.data.attempted, 0, 'ticket do ingresso ja foi emitido na propria resolucao da revisao (confirm_all); produto nunca entra no loop');
  const ticketsForOrder = await service.from('tickets').select('id', { count: 'exact', head: true }).eq('order_id', review.data.order_id);
  assert.equal(ticketsForOrder.count, 1, 'exatamente 1 ticket (do item de ingresso); produto nunca gera ticket');
});

test('link_existing usa o cadastro escolhido com dados ATUAIS, nunca a projecao legada stale de participants, e materializa uma unica vez', async () => {
  const suffix = Date.now() + 3;
  const { adminId, anon, org, event, category, batch } = await setupOrgAndEvent(suffix);

  // Cadastro candidato existe e sera' escolhido -- mas seu nome/e-mail
  // mudaram DEPOIS que a projecao legada "participants" foi criada, exatamente
  // como no caso real TIEVENT. p_expected_registration_contact_id forca
  // import_current_event_contact_first a ler o registro ATUAL de
  // registration_contacts (nunca uma copia antiga).
  const candidate = await must(service.from('registration_contacts').insert({
    organization_id: org.id, full_name: 'Nome Atualizado Depois', cpf: freshCpf(), birth_date: '1988-02-02',
    gender: 'female', phone: '11977776666', email: `atual-${suffix}@example.test`, city: 'Curitiba',
  }).select('id').single(), 'link candidate');

  const rejectedContact = await must(service.from('registration_contacts').insert({
    organization_id: org.id, full_name: 'Pessoa Rejeitada', cpf: freshCpf(), birth_date: '1980-01-01',
    gender: 'male', phone: '11955554444', email: `rejeitado-${suffix}@example.test`, city: 'Recife',
  }).select('id').single(), 'rejected candidate (nao escolhido)');

  const importBatch = await must(service.from('import_batches').insert({
    import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id, imported_by: adminId,
    file_name: 'link-existing.csv', total_rows: 1, status: 'processing', payment_mode_original: 'pending',
  }).select('id').single(), 'import batch');

  const row = await must(service.from('import_batch_rows').insert({
    import_batch_id: importBatch.id, row_number: 1, status: 'review_required', resolution: 'pending',
    raw_data: { linha: 'Nome Importado Diferente' },
    normalized_data: normalizedDataFor({ fullName: 'Nome Importado Diferente', cpf: null, email: `atual-${suffix}@example.test`, batchId: batch.id, categoryId: category.id }),
    data_issues: [],
    identity_match_details: {
      reason: 'email_exact_requires_review',
      candidates: [
        { registration_contact_id: candidate.id, full_name: candidate.full_name, email: candidate.email, reason: 'email_exact' },
        { registration_contact_id: rejectedContact.id, full_name: rejectedContact.full_name, email: rejectedContact.email, reason: 'email_exact' },
      ],
    },
  }).select('id').single(), 'review row');

  const contactsBefore = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id);

  const review = await anon.rpc('resolve_import_batch_row_review', { p_row_id: row.id, p_decision: 'link_existing', p_registration_contact_id: candidate.id });
  assert.equal(review.error, null, review.error?.message);
  assert.equal(review.data.registration_contact_id, candidate.id, 'usa exatamente o cadastro escolhido pelo administrador');

  const contactsAfter = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id);
  assert.equal(contactsAfter.count, contactsBefore.count, 'link_existing nunca cria novo cadastro');

  const orderItem = await must(service.from('order_items').select('registration_contact_id,holder_full_name').eq('id', review.data.order_item_id).single(), 'order item');
  assert.equal(orderItem.registration_contact_id, candidate.id);
  // O nome gravado no titular vem do cadastro ATUAL (candidate.full_name),
  // nunca de um nome antigo/projetado -- prova que a materializacao leu o
  // registro vivo, nao uma copia obsoleta.
  assert.equal(orderItem.holder_full_name, 'Nome Atualizado Depois');

  const participant = await must(service.from('participants').select('registration_contact_id,full_name').eq('id', review.data.participant_id).single(), 'participant');
  assert.equal(participant.registration_contact_id, candidate.id);
  assert.notEqual(participant.registration_contact_id, rejectedContact.id, 'candidato nao escolhido nunca e usado');

  // Materializa uma unica vez: repetir a mesma decisao nao cria segunda order/order_item.
  const repeated = await anon.rpc('resolve_import_batch_row_review', { p_row_id: row.id, p_decision: 'link_existing', p_registration_contact_id: candidate.id });
  assert.equal(repeated.error, null, repeated.error?.message);
  assert.equal(repeated.data.changed, false);
  const ordersForParticipant = await service.from('orders').select('id', { count: 'exact', head: true }).eq('participant_id', review.data.participant_id);
  assert.equal(ordersForParticipant.count, 1, 'link_existing repetido nao duplica pedido');
});

test('ignore: nao cria nenhuma entidade, sai da fila, audita corretamente e recalcula o batch', async () => {
  const suffix = Date.now() + 4;
  const { adminId, anon, org, event, category, batch } = await setupOrgAndEvent(suffix);

  const importBatch = await must(service.from('import_batches').insert({
    import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id, imported_by: adminId,
    file_name: 'ignore.csv', total_rows: 1, status: 'processing', payment_mode_original: 'pending',
  }).select('id').single(), 'import batch');

  const row = await insertReviewRow({
    importBatchId: importBatch.id, fullName: 'Pessoa Ignorada', cpf: freshCpf(), email: `ignorada-${suffix}@example.test`,
    batchId: batch.id, categoryId: category.id, rejectedCandidateId: null, reason: 'name_only_suggestion',
  });

  const contactsBefore = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id);
  const ordersBefore = await service.from('orders').select('id', { count: 'exact', head: true }).eq('event_id', event.id);

  const review = await anon.rpc('resolve_import_batch_row_review', { p_row_id: row.id, p_decision: 'ignore', p_registration_contact_id: null });
  assert.equal(review.error, null, review.error?.message);
  assert.equal(review.data.success, true);
  assert.equal(review.data.status, 'skipped');
  assert.equal(review.data.resolution, 'ignore');

  const contactsAfter = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id);
  assert.equal(contactsAfter.count, contactsBefore.count, 'ignore nunca cria registration_contact');
  const ordersAfter = await service.from('orders').select('id', { count: 'exact', head: true }).eq('event_id', event.id);
  assert.equal(ordersAfter.count, ordersBefore.count, 'ignore nunca cria order/payment/order_item');

  const rowAfter = await must(service.from('import_batch_rows').select('status,resolution,registration_contact_id,order_item_id,matched_participant_id').eq('id', row.id).single(), 'row after ignore');
  assert.equal(rowAfter.status, 'skipped');
  assert.equal(rowAfter.resolution, 'ignore');
  assert.equal(rowAfter.registration_contact_id, null);
  assert.equal(rowAfter.order_item_id, null);

  const queueCount = await service.from('import_batch_rows').select('id', { count: 'exact', head: true })
    .eq('import_batch_id', importBatch.id).eq('status', 'review_required').eq('resolution', 'pending');
  assert.equal(queueCount.count, 0, 'linha ignorada sai da fila de revisao');

  const audit = await must(service.from('audit_logs').select('details').eq('action', 'import_row_review_resolved').eq('entity_id', row.id), 'audit');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.actor_user_id, adminId);
  assert.equal(audit[0].details.decision, 'ignore');

  const batchAfter = await must(service.from('import_batches').select('status,imported_rows,error_rows,skipped_rows').eq('id', importBatch.id).single(), 'batch after ignore');
  assert.equal(batchAfter.status, 'completed', 'batch fecha: nenhuma revisao pendente restante');
  assert.equal(batchAfter.skipped_rows, 1);
  assert.equal(batchAfter.imported_rows, 0);
});

test('batch misto: create_new + link_existing + ignore na mesma importacao recalculam contadores e status corretamente', async () => {
  const suffix = Date.now() + 5;
  const { adminId, anon, org, event, category, batch } = await setupOrgAndEvent(suffix);
  const linkCandidate = await must(service.from('registration_contacts').insert({
    organization_id: org.id, full_name: 'Candidato Vinculavel', cpf: freshCpf(), birth_date: '1992-06-06',
    gender: 'male', phone: '11933332222', email: `vinculavel-${suffix}@example.test`, city: 'Belo Horizonte',
  }).select('id').single(), 'link candidate');

  const importBatch = await must(service.from('import_batches').insert({
    import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id, imported_by: adminId,
    file_name: 'misto.csv', total_rows: 3, status: 'processing', payment_mode_original: 'pending',
  }).select('id').single(), 'import batch');

  const rowCreateNew = await insertReviewRow({
    importBatchId: importBatch.id, fullName: 'Pessoa Nova Misto', cpf: freshCpf(), email: `nova-misto-${suffix}@example.test`,
    batchId: batch.id, categoryId: category.id, rejectedCandidateId: null, reason: 'name_only_suggestion', rowNumber: 1,
  });
  const rowLinkExisting = await must(service.from('import_batch_rows').insert({
    import_batch_id: importBatch.id, row_number: 2, status: 'review_required', resolution: 'pending',
    raw_data: { linha: 'Candidato Vinculavel' },
    normalized_data: normalizedDataFor({ fullName: 'Candidato Vinculavel', cpf: null, email: `vinculavel-${suffix}@example.test`, batchId: batch.id, categoryId: category.id }),
    data_issues: [],
    identity_match_details: { reason: 'email_exact_requires_review', candidates: [{ registration_contact_id: linkCandidate.id, full_name: linkCandidate.full_name, email: linkCandidate.email, reason: 'email_exact' }] },
  }).select('id').single(), 'row link existing');
  const rowIgnored = await insertReviewRow({
    importBatchId: importBatch.id, fullName: 'Pessoa Ignorada Misto', cpf: freshCpf(), email: `ignorada-misto-${suffix}@example.test`,
    batchId: batch.id, categoryId: category.id, rejectedCandidateId: null, reason: 'name_only_suggestion', rowNumber: 3,
  });

  await must(anon.rpc('resolve_import_batch_row_review', { p_row_id: rowCreateNew.id, p_decision: 'create_new', p_registration_contact_id: null }), 'decide create_new');
  const batchMid = await must(service.from('import_batches').select('status').eq('id', importBatch.id).single(), 'batch mid');
  assert.equal(batchMid.status, 'ready_for_review', 'ainda restam 2 revisoes pendentes -- batch nao pode fechar');

  await must(anon.rpc('resolve_import_batch_row_review', { p_row_id: rowLinkExisting.id, p_decision: 'link_existing', p_registration_contact_id: linkCandidate.id }), 'decide link_existing');
  const batchMid2 = await must(service.from('import_batches').select('status').eq('id', importBatch.id).single(), 'batch mid 2');
  assert.equal(batchMid2.status, 'ready_for_review', 'ainda resta 1 revisao pendente -- batch nao pode fechar');

  await must(anon.rpc('resolve_import_batch_row_review', { p_row_id: rowIgnored.id, p_decision: 'ignore', p_registration_contact_id: null }), 'decide ignore');

  const batchFinal = await must(service.from('import_batches').select('status,imported_rows,error_rows,skipped_rows').eq('id', importBatch.id).single(), 'batch final');
  assert.equal(batchFinal.status, 'completed', 'todas as 3 revisoes decididas -- batch fecha');
  assert.equal(batchFinal.imported_rows, 2, 'create_new + link_existing = 2 linhas importadas');
  assert.equal(batchFinal.skipped_rows, 1, 'ignore = 1 linha pulada');
  assert.equal(batchFinal.error_rows, 0);

  const queueCount = await service.from('import_batch_rows').select('id', { count: 'exact', head: true })
    .eq('import_batch_id', importBatch.id).eq('status', 'review_required').eq('resolution', 'pending');
  assert.equal(queueCount.count, 0, 'fila vazia para este batch');
});

test('reprocessamento no nivel da RPC canonica: chamar import_current_event_contact_first de novo numa linha ja materializada nunca duplica pedido/pagamento/participante', async () => {
  const suffix = Date.now() + 6;
  const { adminId, anon, org, event, category, batch } = await setupOrgAndEvent(suffix);

  const importBatch = await must(service.from('import_batches').insert({
    import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id, imported_by: adminId,
    file_name: 'reprocess.csv', total_rows: 1, status: 'processing', payment_mode_original: 'pending',
  }).select('id').single(), 'import batch');

  const cpf = freshCpf();
  const email = `reprocess-${suffix}@example.test`;
  const row = await insertReviewRow({
    importBatchId: importBatch.id, fullName: 'Pessoa Reprocessada', cpf, email,
    batchId: batch.id, categoryId: category.id, rejectedCandidateId: null, reason: 'name_only_suggestion',
  });

  const review = await anon.rpc('resolve_import_batch_row_review', { p_row_id: row.id, p_decision: 'create_new', p_registration_contact_id: null });
  assert.equal(review.error, null, review.error?.message);

  // Simula exatamente o que "Abrir e reprocessar batch" fazia antes da
  // correcao: chamar import_current_event_contact_first de novo, direto,
  // para a MESMA linha ja materializada (sem passar pela RPC de revisao).
  // A guarda de idempotencia adicionada em 20260943000000 devolve o
  // resultado ja existente, sem inserir order/payment/participant novos.
  const rowSnapshot = await must(service.from('import_batch_rows').select('*').eq('id', row.id).single(), 'row snapshot');
  const normalized = rowSnapshot.normalized_data;
  const reprocessed = await anon.rpc('import_current_event_contact_first', {
    p_import_batch_id: importBatch.id, p_import_batch_row_id: row.id, p_expected_registration_contact_id: null,
    p_full_name: normalized.full_name, p_cpf: normalized.cpf_input, p_birth_date: normalized.birth_date, p_gender: normalized.gender,
    p_phone: normalized.phone, p_email: normalized.email, p_city: normalized.city, p_shirt_type: normalized.shirt_type, p_shirt_size: normalized.shirt_size,
    p_registration_batch_id: normalized.resolved_batch_id, p_ticket_category_id: normalized.resolved_category_id,
    p_payment_method: normalized.payment_method, p_import_issues: [], p_assign_holder: true,
  });
  assert.equal(reprocessed.error, null, reprocessed.error?.message);
  assert.equal(reprocessed.data.order_item_id, review.data.order_item_id, 'devolve o MESMO order_item ja existente');
  assert.equal(reprocessed.data.participant_id, review.data.participant_id);
  assert.equal(reprocessed.data.created_contact, false);
  assert.equal(reprocessed.data.created_participant_projection, false);

  const ordersForParticipant = await service.from('orders').select('id', { count: 'exact', head: true }).eq('participant_id', review.data.participant_id);
  assert.equal(ordersForParticipant.count, 1, 'reprocessar a linha ja materializada nunca cria segundo pedido');
  const paymentsForParticipant = await service.from('payments').select('id', { count: 'exact', head: true }).eq('participant_id', review.data.participant_id);
  assert.equal(paymentsForParticipant.count, 1, 'reprocessar a linha ja materializada nunca cria segundo pagamento');
  const contactsWithSameCpf = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', org.id).eq('cpf', cpf);
  assert.equal(contactsWithSameCpf.count, 1, 'reprocessar a linha ja materializada nunca cria segundo cadastro');
});
