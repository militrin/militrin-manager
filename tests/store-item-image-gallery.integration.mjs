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
  const orgA = await must(service.from('organizations').insert({ name: 'Gallery Test A', slug: `gallery-test-a-${suffix}` }).select('id').single(), 'orgA');
  const orgB = await must(service.from('organizations').insert({ name: 'Gallery Test B', slug: `gallery-test-b-${suffix}` }).select('id').single(), 'orgB');

  const password = 'SenhaForte!123';
  let ownerRole = (await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle()).data;
  if (!ownerRole) ownerRole = await must(service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single(), 'owner role');

  async function makeAdmin(orgId, label) {
    const email = `gallery-${label}-${suffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `create ${label}`);
    await must(service.from('organization_members').insert({ organization_id: orgId, user_id: created.user.id, is_owner: true, is_active: true }), `${label} member`);
    await must(service.from('admin_users').insert({ user_id: created.user.id, role_id: ownerRole.id, is_active: true }), `admin_users ${label}`);
    await must(service.from('customer_profiles').upsert({ user_id: created.user.id, cpf: '52998224725', full_name: label, birth_date: '1985-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), `${label} profile`);
    return clientFor(email, password);
  }

  const adminA = await makeAdmin(orgA.id, 'admin-a');
  const adminB = await makeAdmin(orgB.id, 'admin-b');

  async function makeEvent(orgId, name) {
    return must(service.from('events').insert({
      organization_id: orgId, name, year: 2026, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix}`,
      is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
    }).select('id').single(), `event ${name}`);
  }

  const eventA = await makeEvent(orgA.id, 'Gallery Evento A');
  const eventB = await makeEvent(orgB.id, 'Gallery Evento B');

  async function makeItem(admin, eventId, name) {
    const { data, error } = await admin.rpc('upsert_store_item', {
      p_id: null, p_event_id: eventId, p_name: name, p_slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix}`,
      p_description: null, p_price: 50, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
      p_supply_mode: 'stock', p_available_all_events: false,
    });
    if (error) throw new Error(`create item ${name}: ${JSON.stringify(error)}`);
    return data;
  }

  const itemA = await makeItem(adminA, eventA.id, `Item A ${suffix}`);
  const itemB = await makeItem(adminB, eventB.id, `Item B ${suffix}`);

  return { service, adminA, adminB, orgA, orgB, eventA, eventB, itemA, itemB, must };
}

const fx = await buildFixture();

function fakeUrl(label) {
  return `https://example.invalid/store-item-images/${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
}

test('item sem imagem: images vazio e image_url nulo', async () => {
  const { data, error } = await fx.service.rpc('list_store_items_for_event', { p_event_id: fx.eventA.id });
  assert.equal(error, null, error?.message);
  const row = data.find((r) => r.store_item_id === fx.itemA);
  assert.ok(row);
  assert.equal(row.image_url, null);
  assert.deepEqual(row.images, []);
});

test('adicionar 1 imagem: vira principal automaticamente', async () => {
  const url = fakeUrl('one');
  const { data: imageId, error } = await fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: url });
  assert.equal(error, null, error?.message);
  assert.ok(imageId);

  const { data } = await fx.service.rpc('list_store_items_for_event', { p_event_id: fx.eventA.id });
  const row = data.find((r) => r.store_item_id === fx.itemA);
  assert.equal(row.image_url, url);
  assert.equal(row.images.length, 1);
  assert.equal(row.images[0].is_primary, true);

  // limpa para o proximo teste comecar de 0 imagens
  await fx.adminA.rpc('remove_store_item_image', { p_image_id: imageId });
});

test('2 imagens: a segunda nao vira principal sozinha', async () => {
  const first = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('a') }), 'add first');
  const second = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('b') }), 'add second');

  const { data: images } = await fx.service.from('store_item_images').select('id,is_primary,sort_order').eq('store_item_id', fx.itemA).order('sort_order');
  assert.equal(images.length, 2);
  assert.equal(images.find((i) => i.id === first).is_primary, true);
  assert.equal(images.find((i) => i.id === second).is_primary, false);

  await fx.adminA.rpc('remove_store_item_image', { p_image_id: first });
  await fx.adminA.rpc('remove_store_item_image', { p_image_id: second });
});

test('5 imagens: todas presentes, ordenadas, galeria completa no RPC de listagem', async () => {
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl(`multi-${i}`) }), `add ${i}`));
  }

  const { data } = await fx.service.rpc('list_store_items_for_event', { p_event_id: fx.eventA.id });
  const row = data.find((r) => r.store_item_id === fx.itemA);
  assert.equal(row.images.length, 5);
  assert.equal(row.images.filter((i) => i.is_primary).length, 1);

  for (const id of ids) await fx.adminA.rpc('remove_store_item_image', { p_image_id: id });
});

test('trocar imagem principal: set_store_item_primary_image move o marcador sem duplicar', async () => {
  const first = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('p1') }), 'add p1');
  const second = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('p2') }), 'add p2');

  const { error } = await fx.adminA.rpc('set_store_item_primary_image', { p_image_id: second });
  assert.equal(error, null, error?.message);

  const { data: images } = await fx.service.from('store_item_images').select('id,is_primary').eq('store_item_id', fx.itemA);
  assert.equal(images.filter((i) => i.is_primary).length, 1, 'so 1 imagem principal por item');
  assert.equal(images.find((i) => i.id === second).is_primary, true);
  assert.equal(images.find((i) => i.id === first).is_primary, false);

  await fx.adminA.rpc('remove_store_item_image', { p_image_id: first });
  await fx.adminA.rpc('remove_store_item_image', { p_image_id: second });
});

test('reordenar imagens: reorder_store_item_images aplica a nova ordem', async () => {
  const a = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('r1') }), 'add r1');
  const b = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('r2') }), 'add r2');
  const c = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('r3') }), 'add r3');

  const { error } = await fx.adminA.rpc('reorder_store_item_images', { p_store_item_id: fx.itemA, p_image_ids: [c, a, b] });
  assert.equal(error, null, error?.message);

  const { data: images } = await fx.service.from('store_item_images').select('id,sort_order').eq('store_item_id', fx.itemA).order('sort_order');
  assert.deepEqual(images.map((i) => i.id), [c, a, b]);

  for (const id of [a, b, c]) await fx.adminA.rpc('remove_store_item_image', { p_image_id: id });
});

test('remover a imagem principal promove a proxima da ordem', async () => {
  const a = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('d1') }), 'add d1');
  const b = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('d2') }), 'add d2');

  const { error } = await fx.adminA.rpc('remove_store_item_image', { p_image_id: a });
  assert.equal(error, null, error?.message);

  const { data: images } = await fx.service.from('store_item_images').select('id,is_primary').eq('store_item_id', fx.itemA);
  assert.equal(images.length, 1);
  assert.equal(images[0].id, b);
  assert.equal(images[0].is_primary, true, 'imagem restante deve virar principal automaticamente');

  await fx.adminA.rpc('remove_store_item_image', { p_image_id: b });
});

test('isolamento entre organizacoes: admin da org B nao gerencia imagem de item da org A', async () => {
  const imageId = await fx.must(fx.adminA.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('iso') }), 'add iso');

  const addResult = await fx.adminB.rpc('add_store_item_image', { p_store_item_id: fx.itemA, p_image_url: fakeUrl('hack') });
  assert.ok(addResult.error, 'org B nao deve conseguir adicionar imagem no item da org A');

  const removeResult = await fx.adminB.rpc('remove_store_item_image', { p_image_id: imageId });
  assert.ok(removeResult.error, 'org B nao deve conseguir remover imagem do item da org A');

  const primaryResult = await fx.adminB.rpc('set_store_item_primary_image', { p_image_id: imageId });
  assert.ok(primaryResult.error, 'org B nao deve conseguir trocar a principal do item da org A');

  const reorderResult = await fx.adminB.rpc('reorder_store_item_images', { p_store_item_id: fx.itemA, p_image_ids: [imageId] });
  assert.ok(reorderResult.error, 'org B nao deve conseguir reordenar imagens do item da org A');

  await fx.adminA.rpc('remove_store_item_image', { p_image_id: imageId });
});

test('isolamento no storage: policy de upload/update/delete exige item de organizacao acessivel pelo ator', async () => {
  const path = `${fx.itemA}/${Date.now()}-cross-org.png`;
  const tinyPng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));

  const uploadAsB = await fx.adminB.storage.from('store-item-images').upload(path, tinyPng, { contentType: 'image/png' });
  assert.ok(uploadAsB.error, 'org B nao deve conseguir escrever na pasta de um item da org A');

  const uploadAsA = await fx.adminA.storage.from('store-item-images').upload(path, tinyPng, { contentType: 'image/png' });
  assert.equal(uploadAsA.error, null, uploadAsA.error?.message);

  const deleteAsB = await fx.adminB.storage.from('store-item-images').remove([path]);
  const stillThere = await fx.service.storage.from('store-item-images').download(path);
  assert.equal(stillThere.error, null, 'arquivo deve continuar existindo apos tentativa de delete pela org B');
  assert.ok(!deleteAsB.error || (await fx.service.storage.from('store-item-images').download(path)).data, 'delete da org B nao deve remover o arquivo');

  const deleteAsA = await fx.adminA.storage.from('store-item-images').remove([path]);
  assert.equal(deleteAsA.error, null, deleteAsA.error?.message);
});

test('upsert_store_item nao aceita mais p_image_url (imagem passou a ser so via store_item_images)', async () => {
  const { error } = await fx.adminA.rpc('upsert_store_item', {
    p_id: fx.itemA, p_event_id: fx.eventA.id, p_name: 'Item A renomeado', p_slug: `item-a-renomeado-${Date.now()}`,
    p_description: null, p_image_url: 'https://example.invalid/should-not-exist.jpg', p_price: 60,
    p_requires_variant: false, p_is_active: true, p_sort_order: 0, p_supply_mode: 'stock', p_available_all_events: false,
  });
  assert.ok(error, 'RPC com assinatura antiga (incluindo p_image_url) nao deve mais existir');
});
