import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

const apiUrl = 'http://127.0.0.1:54321';
const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYm8tZGVtbyIsInJvbGUiOiJhbm9uIiwiZXhwIjoxOTgzODEyOTk2fQ.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const serviceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(apiUrl, serviceKey, options);
const anon = createClient(apiUrl, anonKey, options);

async function must(query, label) {
  const result = await query;
  assert.equal(result.error, null, `${label}: ${result.error?.message}`);
  return result.data;
}

test('CSV revisado percorre onboarding completo nos modos pending e confirm_all', async () => {
  const suffix = Date.now();
  const adminEmail = `e2e-import-admin-${suffix}@example.test`;
  const adminPassword = 'E2E-import-admin-123!';
  const adminCreated = await service.auth.admin.createUser({ email: adminEmail, password: adminPassword, email_confirm: true });
  assert.equal(adminCreated.error, null, adminCreated.error?.message);
  const adminId = adminCreated.data.user.id;
  const org = await must(service.from('organizations').insert({ name: 'Import E2E', slug: `import-e2e-${suffix}`, status: 'active' }).select('id').single(), 'organization');
  let role = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  assert.equal(role.error, null, role.error?.message);
  if (!role.data) role = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  assert.equal(role.error, null, role.error?.message);
  await must(service.from('admin_users').insert({ user_id: adminId, role_id: role.data.id, is_active: true }), 'admin user');
  await must(service.from('organization_members').insert({ organization_id: org.id, user_id: adminId, role_id: role.data.id, is_owner: true, is_active: true }), 'membership');
  assert.equal((await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword })).error, null);

  const event = await must(service.from('events').insert({ organization_id: org.id, name: 'Evento Import E2E', year: 2032,
    slug: `evento-import-e2e-${suffix}`, is_active: true, registration_enabled: true, starts_at: '2032-10-10T12:00:00Z', min_age: 0 }).select('id').single(), 'event');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, is_active: true }).select('id').single(), 'category');
  const batch = await must(service.from('registration_batches').insert({ event_id: event.id, name: 'Lote E2E', sequence_number: 1,
    male_price: 100, female_price: 100, max_confirmed_registrations: 100, is_active: true }).select('id').single(), 'registration batch');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100 }), 'price');
  const product = await must(service.from('store_items').insert({ organization_id: org.id, event_id: event.id, name: 'Produto junto',
    slug: `produto-junto-${suffix}`, price: 20, is_active: true, supply_mode: 'made_to_order' }).select('id').single(), 'product');

  async function scenario(mode, index) {
    const cpf = index === 1 ? '52998224725' : '11144477735';
    const email = `holder-${mode}-${suffix}@example.test`;
    const candidate = await must(service.from('registration_contacts').insert({ organization_id: org.id, full_name: `Pessoa ${mode}`,
      cpf, birth_date: '1990-05-10', gender: 'female', phone: '11999998888', email, city: null }).select('id').single(), 'candidate contact');
    const importBatch = await must(service.from('import_batches').insert({ import_type: 'current_event_registrations', event_id: event.id,
      organization_id: org.id, imported_by: adminId, file_name: `import-${mode}.csv`, total_rows: 1, status: 'processing',
      payment_mode_original: mode }).select('id').single(), 'import batch');

    // Representa a linha normalizada da previa CSV: e-mail exato e' uma
    // possivel correspondencia, nunca um vinculo automatico.
    const row = await must(service.from('import_batch_rows').insert({ import_batch_id: importBatch.id, row_number: 2,
      status: 'review_required', resolution: 'pending', raw_data: { linha: `Pessoa ${mode},${cpf},${email}` },
      normalized_data: { full_name: `Pessoa ${mode}`, cpf, email }, registration_contact_id: candidate.id,
      identity_match_details: { reason: 'email_exact_requires_review', candidates: [{ registration_contact_id: candidate.id, full_name: `Pessoa ${mode}`, cpf, email, reason: 'email_exact' }] }
    }).select('id').single(), 'CSV review row');
    assert.equal((await service.from('tickets').select('id', { count: 'exact', head: true }).eq('event_id', event.id)).count, index === 1 ? 0 : 1);

    const review = await anon.rpc('resolve_import_batch_row_review', { p_row_id: row.id, p_decision: 'link_existing', p_registration_contact_id: candidate.id });
    assert.equal(review.error, null, review.error?.message);
    assert.equal(review.data.changed, true);
    const queueCount = await service.from('import_batch_rows').select('id', { count: 'exact', head: true })
      .eq('import_batch_id', importBatch.id).eq('status', 'review_required').eq('resolution', 'pending');
    assert.equal(queueCount.count, 0, 'revisao resolvida deve sair da fila');

    const imported = await anon.rpc('import_current_event_contact_first', {
      p_import_batch_id: importBatch.id, p_import_batch_row_id: row.id, p_expected_registration_contact_id: candidate.id,
      p_full_name: `Pessoa ${mode}`, p_cpf: cpf, p_birth_date: '1990-05-10', p_gender: 'female', p_phone: '11999998888',
      p_email: email, p_city: null, p_shirt_type: null, p_shirt_size: null, p_registration_batch_id: batch.id,
      p_ticket_category_id: category.id, p_payment_method: 'pix', p_import_issues: [{ field_code: 'city', issue_type: 'missing',
        message: 'Cidade obrigatoria', blocks_payment: false, blocks_ticket_issuance: true }], p_assign_holder: true,
    });
    assert.equal(imported.error, null, imported.error?.message);
    await must(service.from('import_batches').update({ status: 'completed', imported_rows: 1, completed_at: new Date().toISOString() }).eq('id', importBatch.id), 'complete batch');
    await must(service.from('order_items').insert({ order_id: imported.data.order_id, event_id: event.id, item_kind: 'product', store_item_id: product.id,
      quantity: 1, unit_price: 20, discount_amount: 0, final_amount: 20, status: 'reserved' }), 'product in same order');

    const invite = await anon.rpc('prepare_registration_contact_account_invite', { p_registration_contact_id: candidate.id });
    assert.equal(invite.error, null, invite.error?.message);
    const inviteRow = Array.isArray(invite.data) ? invite.data[0] : invite.data;
    const holderPassword = 'E2E-import-holder-123!';
    const holderCreated = await service.auth.admin.createUser({ email, password: holderPassword, email_confirm: true });
    assert.equal(holderCreated.error, null, holderCreated.error?.message);
    const holderId = holderCreated.data.user.id;
    await must(service.from('participant_account_invites').update({ auth_user_id: holderId }).eq('id', inviteRow.invite_id), 'correlate invite');
    const holder = createClient(apiUrl, anonKey, options);
    assert.equal((await holder.auth.signInWithPassword({ email, password: holderPassword })).error, null);
    assert.equal((await holder.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteRow.invite_id })).error, null);

    const issues = await must(service.from('participant_data_issues').select('id').eq('order_item_id', imported.data.order_item_id).eq('status', 'open'), 'open issues');
    assert.equal(issues.length, 1);
    const corrected = await holder.rpc('resolve_ticket_data_issues', { p_order_item_id: imported.data.order_item_id,
      p_expected_issue_ids: issues.map((issue) => issue.id), p_values: { city: 'Sao Paulo' } });
    assert.equal(corrected.error, null, corrected.error?.message);
    const reconciled = await holder.rpc('reconcile_imported_ticket_issuance_for_user', { p_user_id: holderId });
    assert.equal(reconciled.error, null, reconciled.error?.message);

    const beforeFinancial = await service.from('tickets').select('id', { count: 'exact', head: true }).eq('order_item_id', imported.data.order_item_id);
    if (mode === 'pending') {
      assert.equal(beforeFinancial.count, 0, 'pending nao pode emitir antes da confirmacao financeira');
      assert.equal(reconciled.data.results.at(-1).finalization, 'payment_pending');
      const confirmed = await anon.rpc('confirm_imported_pending_payment_and_reconcile', { p_payment_id: imported.data.payment_id, p_reason: 'Pagamento confirmado no E2E' });
      assert.equal(confirmed.error, null, confirmed.error?.message);
      assert.equal(confirmed.data.success, true);
      const repeated = await anon.rpc('confirm_imported_pending_payment_and_reconcile', { p_payment_id: imported.data.payment_id, p_reason: 'Repeticao idempotente E2E' });
      assert.equal(repeated.error, null, repeated.error?.message);
      assert.equal((await holder.rpc('reconcile_imported_ticket_issuance_for_user', { p_user_id: holderId })).error, null);
    } else {
      assert.equal(beforeFinancial.count, 1, 'confirm_all deve emitir na reconciliacao do primeiro acesso');
    }

    const tickets = await must(service.from('tickets').select('id,owner_user_id,participant_id,order_item_id').eq('order_item_id', imported.data.order_item_id), 'tickets');
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].owner_user_id, holderId);
    assert.equal(tickets[0].participant_id, imported.data.participant_id);
    assert.equal((await service.from('tickets').select('id', { count: 'exact', head: true }).eq('order_id', imported.data.order_id)).count, 1, 'produto nao gera ticket');
    const [orderState, paymentState, itemState, batchState, audit] = await Promise.all([
      must(service.from('orders').select('status').eq('id', imported.data.order_id).single(), 'order state'),
      must(service.from('payments').select('payment_status,paid_at').eq('id', imported.data.payment_id).single(), 'payment state'),
      must(service.from('order_items').select('status').eq('id', imported.data.order_item_id).single(), 'item state'),
      must(service.from('import_batches').select('status,imported_rows,completed_at').eq('id', importBatch.id).single(), 'batch state'),
      must(service.from('audit_logs').select('action,details').in('action', ['import_row_review_resolved','imported_payment_confirmed']).eq('event_id', event.id), 'audit'),
    ]);
    assert.equal(orderState.status, 'confirmed'); assert.equal(paymentState.payment_status, 'paid'); assert.ok(paymentState.paid_at);
    assert.equal(itemState.status, 'confirmed'); assert.equal(batchState.status, 'completed'); assert.equal(batchState.imported_rows, 1); assert.ok(batchState.completed_at);
    assert.ok(audit.some((entry) => entry.action === 'import_row_review_resolved' && entry.details.actor_user_id === adminId));
    if (mode === 'pending') assert.ok(audit.some((entry) => entry.action === 'imported_payment_confirmed' && entry.details.actor_user_id === adminId));
    await service.auth.admin.deleteUser(holderId);
    return { imported, importBatch };
  }

  await scenario('pending', 1);
  await scenario('confirm_all', 2);
  await service.auth.admin.deleteUser(adminId);
});
