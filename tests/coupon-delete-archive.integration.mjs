import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

async function environment() {
  const text = await readFile(new URL('../.env.local', import.meta.url), 'utf8').catch(() => '');
  const local = Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
  }));
  return {
    url: 'http://127.0.0.1:54321',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
    ...local,
  };
}

async function buildFixture() {
  const env = await environment();
  const service = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anonKey = env.anonKey;

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }
  async function clientFor(email, password) {
    const client = createClient(env.url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`login ${email}: ${signIn.error.message}`);
    return client;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';
  let ownerRole = (await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle()).data;
  if (!ownerRole) ownerRole = await must(service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single(), 'owner role');

  async function makeOrgAndAdmin(label) {
    const org = await must(service.from('organizations').insert({ name: `Coupon Delete ${label} ${suffix}`, slug: `coupon-delete-${label}-${suffix}` }).select('id').single(), `org ${label}`);
    const email = `coupon-delete-${label}-${suffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `create ${label}`);
    await must(service.from('organization_members').insert({ organization_id: org.id, user_id: created.user.id, is_owner: true, is_active: true }), `${label} member`);
    await must(service.from('admin_users').insert({ user_id: created.user.id, role_id: ownerRole.id, is_active: true }), `admin_users ${label}`);
    await must(service.from('customer_profiles').upsert({ user_id: created.user.id, cpf: '52998224725', full_name: label, birth_date: '1985-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), `${label} profile`);
    const admin = await clientFor(email, password);
    return { org, admin };
  }

  const a = await makeOrgAndAdmin('a');
  const b = await makeOrgAndAdmin('b');

  const event = await must(service.from('events').insert({
    organization_id: a.org.id, name: `Coupon Delete Evento ${suffix}`, year: 2026, slug: `coupon-delete-evento-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100 }), 'price');

  const buyerEmail = `coupon-delete-buyer-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'create buyer');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: '11144477735', full_name: 'Buyer', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');
  const buyer = await clientFor(buyerEmail, password);

  async function createCoupon(admin, orgId, overrides) {
    const { data, error } = await admin.rpc('create_organization_coupon', {
      p_organization_id: orgId, p_code: overrides.code, p_discount_type: 'percentage', p_discount_value: 10,
      p_applies_to_tickets: true, p_applies_to_products: false, p_max_uses: null, p_valid_from: null, p_valid_until: null,
      p_notes: null, p_is_active: true, p_event_ids: [], p_ticket_category_ids: [], p_store_item_ids: [],
    });
    if (error) throw new Error(`create coupon ${overrides.code}: ${JSON.stringify(error)}`);
    return data;
  }

  async function createTicketOrder() {
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: 1,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer', p_buyer_cpf: '11144477735',
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: [{ ownership_mode: 'self' }], p_client_request_id: `coupon-delete-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  return { service, a, b, event, category, buyer, createCoupon, createTicketOrder, must };
}

const fx = await buildFixture();

test('cupom nunca utilizado: exclusao definitiva remove a linha', async () => {
  const code = `NEVERUSED-${Date.now()}`;
  const couponId = await fx.createCoupon(fx.a.admin, fx.a.org.id, { code });

  const result = await fx.a.admin.rpc('delete_or_archive_coupon', { p_coupon_id: couponId });
  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.data.action, 'deleted');

  const check = await fx.service.from('coupons').select('id').eq('id', couponId).maybeSingle();
  assert.equal(check.data, null, 'cupom nao deve mais existir apos exclusao definitiva');
});

test('cupom ja utilizado em pedido: arquiva em vez de excluir, sem alterar o pedido antigo', async () => {
  const code = `USED-${Date.now()}`;
  const couponId = await fx.createCoupon(fx.a.admin, fx.a.org.id, { code });

  const orderId = await fx.createTicketOrder();
  await fx.must(fx.service.from('orders').update({ applied_coupon_id: couponId, discount_amount: 10 }).eq('id', orderId), 'apply coupon to order');
  await fx.must(fx.service.from('coupons').update({ used_count: 1 }).eq('id', couponId), 'bump used_count');

  const before = await fx.must(fx.service.from('orders').select('applied_coupon_id,discount_amount').eq('id', orderId).single(), 'order before');

  const result = await fx.a.admin.rpc('delete_or_archive_coupon', { p_coupon_id: couponId });
  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.data.action, 'archived');

  const coupon = await fx.must(fx.service.from('coupons').select('id,is_active,archived_at,archived_by').eq('id', couponId).single(), 'coupon after archive');
  assert.ok(coupon.archived_at, 'archived_at deve estar preenchido');
  assert.equal(coupon.is_active, false);

  const after = await fx.must(fx.service.from('orders').select('applied_coupon_id,discount_amount').eq('id', orderId).single(), 'order after');
  assert.deepEqual(after, before, 'pedido antigo nao deve ser alterado pelo arquivamento do cupom');
});

test('cupom arquivado nao pode ser aplicado em novas compras', async () => {
  const code = `ARCHIVEDCANTAPPLY-${Date.now()}`;
  const couponId = await fx.createCoupon(fx.a.admin, fx.a.org.id, { code });
  await fx.must(fx.service.from('coupons').update({ archived_at: new Date().toISOString(), is_active: false }).eq('id', couponId), 'force archive');

  const orderId = await fx.createTicketOrder();
  const result = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: code });
  assert.ok(result.error, 'cupom arquivado deve ser rejeitado na aplicacao');
});

test('cupom arquivado nao pode ser editado nem reativado', async () => {
  const code = `ARCHIVEDNOEDIT-${Date.now()}`;
  const couponId = await fx.createCoupon(fx.a.admin, fx.a.org.id, { code });
  await fx.must(fx.service.from('coupons').update({ archived_at: new Date().toISOString(), is_active: false }).eq('id', couponId), 'force archive');

  const updateResult = await fx.a.admin.rpc('update_organization_coupon', {
    p_coupon_id: couponId, p_code: code, p_discount_type: 'percentage', p_discount_value: 20,
    p_applies_to_tickets: true, p_applies_to_products: false, p_is_active: true,
    p_event_ids: [], p_ticket_category_ids: [], p_store_item_ids: [],
  });
  assert.ok(updateResult.error, 'edicao de cupom arquivado deve ser rejeitada');

  const activateResult = await fx.a.admin.rpc('set_coupon_active', { p_coupon_id: couponId, p_is_active: true });
  assert.ok(activateResult.error, 'reativacao de cupom arquivado deve ser rejeitada');
});

test('filtro de listagem: arquivado some da lista padrao (ativos) e aparece so em arquivados', async () => {
  const code = `LISTFILTER-${Date.now()}`;
  const couponId = await fx.createCoupon(fx.a.admin, fx.a.org.id, { code });
  await fx.must(fx.service.from('coupons').update({ archived_at: new Date().toISOString(), is_active: false }).eq('id', couponId), 'force archive');

  const activeList = await fx.must(fx.a.admin.rpc('list_organization_coupons', { p_organization_id: fx.a.org.id, p_status: 'active' }), 'active list');
  assert.ok(!activeList.some((c) => c.id === couponId), 'cupom arquivado nao deve aparecer na lista de ativos');

  const inactiveList = await fx.must(fx.a.admin.rpc('list_organization_coupons', { p_organization_id: fx.a.org.id, p_status: 'inactive' }), 'inactive list');
  assert.ok(!inactiveList.some((c) => c.id === couponId), 'cupom arquivado nao deve aparecer na lista de inativos');

  const archivedList = await fx.must(fx.a.admin.rpc('list_organization_coupons', { p_organization_id: fx.a.org.id, p_status: 'archived' }), 'archived list');
  const found = archivedList.find((c) => c.id === couponId);
  assert.ok(found, 'cupom arquivado deve aparecer na lista de arquivados');
  assert.equal(found.has_usage, false);
});

test('list_organization_coupons: has_usage reflete pedido aplicado mesmo sem used_count', async () => {
  const code = `HASUSAGE-${Date.now()}`;
  const couponId = await fx.createCoupon(fx.a.admin, fx.a.org.id, { code });
  const orderId = await fx.createTicketOrder();
  await fx.must(fx.service.from('orders').update({ applied_coupon_id: couponId }).eq('id', orderId), 'apply coupon to order (sem bump de used_count)');

  const activeList = await fx.must(fx.a.admin.rpc('list_organization_coupons', { p_organization_id: fx.a.org.id, p_status: 'active' }), 'active list');
  const found = activeList.find((c) => c.id === couponId);
  assert.ok(found);
  assert.equal(found.has_usage, true, 'has_usage deve ser true mesmo com used_count zerado, pela referencia em orders.applied_coupon_id');
});

test('isolamento entre organizacoes: admin da org B nao exclui, arquiva nem lista cupom da org A', async () => {
  const code = `CROSSORG-${Date.now()}`;
  const couponId = await fx.createCoupon(fx.a.admin, fx.a.org.id, { code });

  const deleteResult = await fx.b.admin.rpc('delete_or_archive_coupon', { p_coupon_id: couponId });
  assert.ok(deleteResult.error, 'org B nao deve conseguir excluir/arquivar cupom da org A');

  const listResult = await fx.b.admin.rpc('list_organization_coupons', { p_organization_id: fx.a.org.id, p_status: 'active' });
  assert.ok(listResult.error, 'org B nao deve conseguir listar cupons da org A');

  const stillThere = await fx.must(fx.service.from('coupons').select('id,archived_at').eq('id', couponId).single(), 'coupon still exists');
  assert.equal(stillThere.archived_at, null, 'cupom da org A nao deve ter sido alterado pela tentativa da org B');
});
