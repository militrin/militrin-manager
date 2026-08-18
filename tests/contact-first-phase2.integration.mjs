import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

async function clients() {
  const apiUrl = 'http://127.0.0.1:54321';
  const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
  const serviceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  return {
    service: createClient(apiUrl, serviceKey, options),
    anon: createClient(apiUrl, anonKey, options),
  };
}

test('fluxo integrado contact-first preserva pessoa, ingressos e entidades canonicas', async () => {
  const { service, anon } = await clients();
  const email = `phase2-${Date.now()}@example.test`;
  const password = 'Phase2-local-only-123!';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const userId = created.data.user.id;

  const suffix = Date.now();
  const org = await service.from('organizations').insert({ name: 'Phase 2 Local', slug: `phase2-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(org.error, null, org.error?.message); const organizationId = org.data.id;
  const eventRows = [1, 2].map((number) => ({ organization_id: organizationId, name: `Evento Phase 2 ${number}`, year: 2030,
    slug: `evento-phase2-${suffix}-${number}`, is_active: number === 1, registration_enabled: true,
    starts_at: '2030-10-10T12:00:00Z', min_age: 0 }));
  const insertedEvents = await service.from('events').insert(eventRows).select('id');
  assert.equal(insertedEvents.error, null, insertedEvents.error?.message); const [eventA, eventB] = insertedEvents.data.map((event) => event.id);
  const categories = await service.from('ticket_categories').insert([eventA, eventB].map((eventId, index) => ({ event_id: eventId,
    name: 'Geral', slug: `geral-phase2-${index + 1}`, is_active: true }))).select('id,event_id');
  assert.equal(categories.error, null, categories.error?.message);
  const batches = await service.from('registration_batches').insert([eventA, eventB].map((eventId) => ({ event_id: eventId,
    name: 'Lote 1', sequence_number: 1, male_price: 100, female_price: 90, max_confirmed_registrations: 100, is_active: true }))).select('id,event_id');
  assert.equal(batches.error, null, batches.error?.message);
  const candidates = [eventA, eventB].map((eventId) => ({ batch_id: batches.data.find((batch) => batch.event_id === eventId).id,
    ticket_category_id: categories.data.find((category) => category.event_id === eventId).id,
    registration_batches: { event_id: eventId, is_active: true }, ticket_categories: { event_id: eventId, is_active: true } }));
  const insertedPrices = await service.from('registration_batch_prices').insert(candidates.map((row) => ({ batch_id: row.batch_id,
    ticket_category_id: row.ticket_category_id, male_price: 100, female_price: 90 })));
  assert.equal(insertedPrices.error, null, insertedPrices.error?.message);
  const kitItem = await service.from('event_kit_items').insert({ organization_id: organizationId, event_id: eventA,
    name: 'Camiseta', slug: `camiseta-phase2-${suffix}`, item_type: 'shirt', requires_variant: true,
    is_required: true, is_active: true, shirt_supply_mode: 'made_to_order' }).select('id').single();
  assert.equal(kitItem.error, null, kitItem.error?.message);
  const kitVariant = await service.from('event_kit_item_variants').insert({ kit_item_id: kitItem.data.id,
    name: 'Babylook', value: 'M', is_active: true }).select('id').single();
  assert.equal(kitVariant.error, null, kitVariant.error?.message);
  let role = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  if (!role.data) role = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  assert.equal(role.error, null, role.error?.message);
  const adminUser = await service.from('admin_users').insert({ user_id: userId, role_id: role.data.id, is_active: true });
  assert.equal(adminUser.error, null, adminUser.error?.message);
  const membership = await service.from('organization_members').insert({ organization_id: organizationId, user_id: userId, role_id: role.data.id, is_owner: true, is_active: true });
  assert.equal(membership.error, null, membership.error?.message);
  const session = await anon.auth.signInWithPassword({ email, password });
  assert.equal(session.error, null, session.error?.message);

  async function importLine(eventId, rowNumber, identity = {}) {
    const config = candidates.find((row) => String(row.registration_batches.event_id) === eventId);
    assert.ok(config);
    const batch = await service.from('import_batches').insert({ import_type: 'current_event_registrations', event_id: eventId,
      organization_id: organizationId, imported_by: userId, total_rows: 1, status: 'processing' }).select('id').single();
    assert.equal(batch.error, null, batch.error?.message);
    const row = await service.from('import_batch_rows').insert({ import_batch_id: batch.data.id, row_number: rowNumber,
      status: 'ready', resolution: 'create_new', normalized_data: {}, raw_data: {} }).select('id').single();
    assert.equal(row.error, null, row.error?.message);
    const result = await anon.rpc('import_current_event_contact_first', {
      p_import_batch_id: batch.data.id, p_import_batch_row_id: row.data.id, p_expected_registration_contact_id: null,
      p_full_name: identity.fullName ?? 'Pessoa Fase Dois', p_cpf: identity.cpf ?? '52998224725', p_birth_date: '1990-05-10', p_gender: 'female',
      p_phone: '11999998888', p_email: identity.email ?? 'original@example.test', p_city: 'Sao Paulo', p_shirt_type: 'Babylook',
      p_shirt_size: 'M', p_registration_batch_id: config.batch_id, p_ticket_category_id: config.ticket_category_id,
      p_payment_method: 'pix', p_import_issues: [{ field_code: 'shirt_selection', issue_type: 'test', message: 'Camiseta em revisao', blocks_kit_delivery: true }],
      p_assign_holder: true,
    });
    assert.equal(result.error, null, result.error?.message);
    return { ...result.data, importBatchId: batch.data.id };
  }

  const first = await importLine(eventA, 1);
  const otherEvent = await importLine(eventB, 2);
  const secondSameEvent = await importLine(eventA, 3);
  assert.equal(first.registration_contact_id, otherEvent.registration_contact_id);
  assert.equal(first.registration_contact_id, secondSameEvent.registration_contact_id);
  assert.notEqual(first.participant_id, otherEvent.participant_id);
  assert.equal(first.holder_assigned, true);
  assert.equal(secondSameEvent.holder_assigned, false);
  assert.notEqual(first.order_item_id, secondSameEvent.order_item_id);

  const alternate = await importLine(eventA, 4, { fullName: 'Outra Pessoa', cpf: '11144477735', email: 'outra@example.test' });
  const assigned = await anon.rpc('assign_order_item_participant', {
    p_order_item_id: secondSameEvent.order_item_id, p_participant_id: alternate.participant_id,
  });
  assert.equal(assigned.error, null, assigned.error?.message);
  const assignedItem = await service.from('order_items').select('participant_id,registration_contact_id,ownership_status')
    .eq('id', secondSameEvent.order_item_id).single();
  assert.equal(assignedItem.data.participant_id, alternate.participant_id);
  assert.equal(assignedItem.data.registration_contact_id, alternate.registration_contact_id);
  assert.equal(assignedItem.data.ownership_status, 'assigned');
  const paymentChange = await anon.rpc('admin_update_payment_status', { p_payment_id: secondSameEvent.payment_id,
    p_participant_id: secondSameEvent.participant_id, p_expected_current_status: 'pending', p_new_status: 'cancelled', p_reason: 'Teste integrado' });
  assert.equal(paymentChange.error, null, paymentChange.error?.message);
  assert.equal(paymentChange.data.success, true);

  const item = await service.from('order_items').select('ticket_category_id,batch_id,shirt_type,shirt_size,registration_contact_id').eq('id', first.order_item_id).single();
  assert.equal(item.error, null, item.error?.message);
  assert.ok(item.data.ticket_category_id); assert.ok(item.data.batch_id); assert.equal(item.data.registration_contact_id, first.registration_contact_id);
  const order = await service.from('orders').select('id,status,buyer_type,import_batch_id').eq('id', first.order_id).single();
  const payment = await service.from('payments').select('id,payment_status,payment_method,order_id').eq('id', first.payment_id).single();
  assert.equal(order.data.buyer_type, 'imported_holder'); assert.equal(payment.data.order_id, order.data.id);

  const issues = await service.from('participant_data_issues').select('id,registration_contact_id,order_item_id,ticket_id').eq('order_item_id', first.order_item_id).eq('status', 'open');
  assert.equal(issues.error, null, issues.error?.message); assert.ok(issues.data.length);
  assert.equal(issues.data[0].registration_contact_id, first.registration_contact_id); assert.equal(issues.data[0].ticket_id, null);
  const correction = await anon.rpc('resolve_ticket_data_issues', { p_order_item_id: first.order_item_id,
    p_expected_issue_ids: issues.data.map((issue) => issue.id), p_values: { email: 'corrected@example.test', shirt_type: 'Babylook', shirt_size: 'M' } });
  assert.equal(correction.error, null, correction.error?.message);
  const contact = await service.from('registration_contacts').select('email').eq('id', first.registration_contact_id).single();
  const projection = await service.from('participants').select('email,shirt_type,shirt_size').eq('id', first.participant_id).single();
  assert.equal(contact.data.email, 'corrected@example.test');
  assert.equal(projection.data.email, 'original@example.test');
  assert.equal(projection.data.shirt_type, null); assert.equal(projection.data.shirt_size, null);

  const finalized = await anon.rpc('finalize_imported_ticket_after_issue_resolution', { p_order_item_id: first.order_item_id, p_resolved_fields: ['email', 'shirt_selection'], p_force_confirm: true });
  assert.equal(finalized.error, null, finalized.error?.message); assert.ok(finalized.data.ticket_id);
  const ticket = await service.from('tickets').select('id,status,order_item_id').eq('id', finalized.data.ticket_id).single();
  assert.equal(ticket.data.order_item_id, first.order_item_id); assert.equal(ticket.data.status, 'active');
  const linkedIssues = await service.from('participant_data_issues').select('ticket_id').eq('order_item_id', first.order_item_id);
  assert.ok(linkedIssues.data.every((issue) => issue.ticket_id === ticket.data.id));
  const ensuredKit = await anon.rpc('ensure_ticket_kit_items', { p_ticket_id: ticket.data.id });
  assert.equal(ensuredKit.error, null, ensuredKit.error?.message);
  const kit = await service.from('participant_kit_items').select('ticket_id,order_item_id,variant_data').eq('ticket_id', ticket.data.id);
  assert.equal(kit.error, null, kit.error?.message);
  assert.equal(kit.data.length, 1);
  assert.equal(kit.data[0].order_item_id, first.order_item_id);
  assert.equal(kit.data[0].variant_data.variant_id, kitVariant.data.id);

  const coupon = await service.from('coupons').insert({ organization_id: organizationId, code: `COURTESY-${suffix}`, discount_type: 'percentage',
    discount_value: 100, applies_to_tickets: true, max_uses: 1, used_count: 0, is_active: true }).select('id').single();
  assert.equal(coupon.error, null, coupon.error?.message);
  const redeemed = await anon.rpc('redeem_coupon', { p_coupon_id: coupon.data.id, p_participant_id: otherEvent.participant_id,
    p_event_id: eventB, p_original_amount: 90 });
  assert.equal(redeemed.error, null, redeemed.error?.message);
  assert.equal(redeemed.data[0].payment_status, 'paid');
  const couponPayment = await service.from('payments').select('payment_status,discount_amount,final_amount').eq('id', otherEvent.payment_id).single();
  const couponOrder = await service.from('orders').select('status,discount_amount,final_amount').eq('id', otherEvent.order_id).single();
  assert.equal(couponPayment.data.payment_status, 'paid'); assert.equal(Number(couponPayment.data.final_amount), 0);
  assert.equal(couponOrder.data.status, 'confirmed'); assert.equal(Number(couponOrder.data.final_amount), 0);
  const couponTicket = await service.from('tickets').select('id,status').eq('order_item_id', otherEvent.order_item_id).single();
  const checkedIn = await anon.rpc('checkin_ticket_entry', { p_ticket_id: couponTicket.data.id });
  assert.equal(checkedIn.error, null, checkedIn.error?.message); assert.equal(checkedIn.data, true);

  const manual = await anon.rpc('create_manual_registration_order', { p_event_id: eventA,
    p_ticket_category_id: candidates.find((row) => row.registration_batches.event_id === eventA).ticket_category_id,
    p_batch_id: candidates.find((row) => row.registration_batches.event_id === eventA).batch_id,
    p_full_name: 'Pessoa Manual', p_cpf: '12345678909', p_birth_date: '1988-01-01', p_gender: 'female',
    p_phone: '11988887777', p_email: 'manual@example.test', p_city: 'Sao Paulo', p_shirt_type: 'Babylook',
    p_shirt_size: 'M', p_payment_method: 'courtesy', p_notes: 'Teste integrado' });
  assert.equal(manual.error, null, manual.error?.message);
  const manualItem = await service.from('order_items').select('shirt_type,shirt_size,registration_contact_id').eq('id', manual.data[0].order_item_id).single();
  const manualKit = await service.from('participant_kit_items').select('variant_data').eq('ticket_id', manual.data[0].ticket_id).single();
  assert.equal(manualItem.data.shirt_type, 'Babylook'); assert.ok(manualItem.data.registration_contact_id);
  assert.equal(manualKit.data.variant_data.variant_id, kitVariant.data.id);

  await service.auth.admin.deleteUser(userId);
});
