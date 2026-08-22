import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

// Regressao do bug reportado em producao: criar o Primeiro Lote de ingresso
// unico num evento que ja tinha o Segundo Lote cadastrado disparava
//   duplicate key value violates unique constraint "ux_registration_batches_single_active"
// porque um indice unico legado (event_id) WHERE is_active ainda so permitia
// 1 lote ativo por evento, mesmo depois de 20260865000000 ter introduzido
// multiplos lotes de ingresso unico simultaneos. Corrigido por
// 20260866000000 (indice novo restrito ao fluxo COM categoria).
const apiUrl = 'http://127.0.0.1:54321';
const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/); return match ? [[match[1], match[2]]] : []; }));
const options = { auth: { persistSession: false, autoRefreshToken: false } };

test('multiplos lotes de ingresso unico coexistem ativos e o checkout escolhe o mais barato disponivel por genero', async () => {
  const service = createClient(apiUrl, localEnvironment.SERVICE_ROLE_KEY, options);
  const suffix = Date.now();

  async function createBuyer(label) {
    const email = `multi-batch-${label}-${suffix}@example.test`;
    const created = await service.auth.admin.createUser({ email, password: 'MultiBatch-local-123!', email_confirm: true });
    assert.equal(created.error, null, created.error?.message);
    const client = createClient(apiUrl, localEnvironment.ANON_KEY, options);
    const signedIn = await client.auth.signInWithPassword({ email, password: 'MultiBatch-local-123!' });
    assert.equal(signedIn.error, null, signedIn.error?.message);
    return { client, email, userId: created.data.user.id };
  }

  const owner = await createBuyer('owner');
  const organization = await service.from('organizations').insert({ name: 'Multi Lote', slug: `multi-batch-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(organization.error, null, organization.error?.message);
  let ownerRole = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  if (!ownerRole.data) ownerRole = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  assert.equal(ownerRole.error, null, ownerRole.error?.message);
  assert.equal((await service.from('admin_users').insert({ user_id: owner.userId, role_id: ownerRole.data.id, is_active: true })).error, null);
  assert.equal((await service.from('organization_members').insert({ organization_id: organization.data.id, user_id: owner.userId, role_id: ownerRole.data.id, is_owner: true, is_active: true })).error, null);

  const event = await service.from('events').insert({
    organization_id: organization.data.id, name: 'Evento Multi Lote', year: 2033,
    slug: `multi-batch-${suffix}`, is_active: true, registration_enabled: true,
    starts_at: '2033-10-10T12:00:00Z', min_age: 0,
  }).select('id').single();
  assert.equal(event.error, null, event.error?.message);
  const eventId = event.data.id;

  // Simula o estado relatado em producao: Segundo Lote ja existe quando o
  // Primeiro Lote e criado.
  const segundo = await owner.client.rpc('create_single_ticket_batch', {
    p_event_id: eventId, p_name: 'Segundo Lote', p_sequence_number: 2,
    p_male_price: 200, p_female_price: 170, p_male_max: 200, p_female_max: 200,
  });
  assert.equal(segundo.error, null, segundo.error?.message);
  const segundoId = segundo.data;

  const primeiro = await owner.client.rpc('create_single_ticket_batch', {
    p_event_id: eventId, p_name: 'Primeiro Lote', p_sequence_number: 1,
    p_male_price: 180, p_female_price: 150, p_male_max: 200, p_female_max: 200,
  });
  assert.equal(primeiro.error, null, primeiro.error?.message, 'criar o Primeiro Lote com o Segundo ja ativo nao pode mais violar ux_registration_batches_single_active');
  const primeiroId = primeiro.data;

  const terceiro = await owner.client.rpc('create_single_ticket_batch', {
    p_event_id: eventId, p_name: 'Terceiro Lote', p_sequence_number: 3,
    p_male_price: 220, p_female_price: 190, p_male_max: 200, p_female_max: 200,
  });
  assert.equal(terceiro.error, null, terceiro.error?.message);

  const quarto = await owner.client.rpc('create_single_ticket_batch', {
    p_event_id: eventId, p_name: 'Quarto Lote', p_sequence_number: 4,
    p_male_price: 240, p_female_price: 210, p_male_max: 200, p_female_max: 200,
  });
  assert.equal(quarto.error, null, quarto.error?.message);

  const listed = await owner.client.rpc('list_single_ticket_batches', { p_event_id: eventId });
  assert.equal(listed.error, null, listed.error?.message);
  assert.equal(listed.data.length, 4);

  // Esgota/encerra apenas o genero masculino do Primeiro Lote. O feminino do
  // Primeiro Lote continua disponivel.
  const closeMale = await owner.client.rpc('set_single_ticket_batch_gender_closed', {
    p_batch_id: primeiroId, p_gender: 'male', p_closed: true,
  });
  assert.equal(closeMale.error, null, closeMale.error?.message);

  const current = await owner.client.rpc('get_single_ticket_current_batches', { p_event_id: eventId });
  assert.equal(current.error, null, current.error?.message);
  const currentMale = current.data.find((row) => row.gender === 'male');
  const currentFemale = current.data.find((row) => row.gender === 'female');
  assert.equal(currentMale.batch_id, segundoId, 'masculino esgotado no Primeiro deve virar automaticamente o Segundo Lote');
  assert.equal(currentFemale.batch_id, primeiroId, 'feminino continua disponivel no Primeiro Lote');

  const maleBuyer = await createBuyer('male');
  const maleCheckout = await maleBuyer.client.rpc('create_multi_ticket_order_checkout', {
    p_event_id: eventId, p_ticket_category_id: null, p_quantity: 1, p_gender: 'male', p_payment_method: 'courtesy',
    p_buyer_full_name: 'Comprador Masculino', p_buyer_cpf: '52998224725', p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'male',
    p_buyer_phone: '11999990000', p_buyer_email: maleBuyer.email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
    p_assign_first_to_buyer: true, p_client_request_id: `multi-batch-male-${suffix}`, p_items: [{ pricing_gender: 'male', ownership_mode: 'self' }],
  });
  assert.equal(maleCheckout.error, null, maleCheckout.error?.message);
  const maleItem = await service.from('order_items').select('batch_id,pricing_gender').eq('order_id', maleCheckout.data[0].order_id).single();
  assert.equal(maleItem.error, null, maleItem.error?.message);
  assert.equal(maleItem.data.batch_id, segundoId, 'checkout masculino deve usar o Segundo Lote');

  const femaleBuyer = await createBuyer('female');
  const femaleCheckout = await femaleBuyer.client.rpc('create_multi_ticket_order_checkout', {
    p_event_id: eventId, p_ticket_category_id: null, p_quantity: 1, p_gender: 'female', p_payment_method: 'courtesy',
    p_buyer_full_name: 'Compradora Feminina', p_buyer_cpf: '11144477735', p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'female',
    p_buyer_phone: '11999990001', p_buyer_email: femaleBuyer.email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
    p_assign_first_to_buyer: true, p_client_request_id: `multi-batch-female-${suffix}`, p_items: [{ pricing_gender: 'female', ownership_mode: 'self' }],
  });
  assert.equal(femaleCheckout.error, null, femaleCheckout.error?.message);
  const femaleItem = await service.from('order_items').select('batch_id,pricing_gender').eq('order_id', femaleCheckout.data[0].order_id).single();
  assert.equal(femaleItem.error, null, femaleItem.error?.message);
  assert.equal(femaleItem.data.batch_id, primeiroId, 'checkout feminino deve usar o Primeiro Lote');
});

test('o fluxo COM categoria continua restrito a 1 lote ativo por evento (rede de seguranca do banco)', async () => {
  const service = createClient(apiUrl, localEnvironment.SERVICE_ROLE_KEY, options);
  const suffix = Date.now();

  const organization = await service.from('organizations').insert({ name: 'Categoria Unica Ativa', slug: `single-active-cat-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(organization.error, null, organization.error?.message);

  const event = await service.from('events').insert({
    organization_id: organization.data.id, name: 'Evento Categoria', year: 2033,
    slug: `single-active-cat-${suffix}`, is_active: true, registration_enabled: true,
    starts_at: '2033-10-10T12:00:00Z', min_age: 0,
  }).select('id').single();
  assert.equal(event.error, null, event.error?.message);

  // Insercao direta (bypassando create_registration_batch, que ja desativa os
  // demais lotes por conta propria) para provar que a INVARIANTE do fluxo COM
  // categoria ("no maximo 1 lote ativo por evento") continua garantida pelo
  // proprio banco, e nao so pela disciplina da RPC.
  const first = await service.from('registration_batches').insert({
    event_id: event.data.id, name: 'Lote A', sequence_number: 1,
    male_price: 100, female_price: 90, max_confirmed_registrations: 50, is_active: true,
  }).select('id').single();
  assert.equal(first.error, null, first.error?.message);

  const second = await service.from('registration_batches').insert({
    event_id: event.data.id, name: 'Lote B', sequence_number: 2,
    male_price: 110, female_price: 95, max_confirmed_registrations: 50, is_active: true,
  }).select('id').single();
  assert.ok(second.error, 'um segundo lote do fluxo COM categoria ativo ao mesmo tempo deve continuar sendo rejeitado pelo banco');
  assert.equal(second.error.code, '23505');
  assert.match(second.error.message, /ux_registration_batches_single_active_categorized/);
});
