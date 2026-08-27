// Fecha o gap de teste identificado na revisao do fluxo de primeiro
// acesso/importados: nenhum teste real (contra Postgres) exercitava as
// garantias de banco de check_participant_account_invite_eligibility /
// prepare_participant_account_invite / claim_participant_account_invite --
// so havia asserçoes estaticas (regex sobre o codigo-fonte) em
// tests/participant-first-access-invite.test.mjs.
//
// Este arquivo testa exclusivamente a camada de RPC (nao simula o envio real
// do e-mail de convite): o auth.users que normalmente seria criado por
// inviteUserByEmail() e criado aqui diretamente via admin.createUser + a
// mesma correlacao por auth_user_id que a Server Action
// (dispatchFirstAccessEmail/inviteCadastroFirstAccessAction,
// src/app/cadastros/actions.ts) ja faz depois que o provider aceita o envio.
// O objetivo e comprovar as garantias de banco (elegibilidade, criacao do
// convite, claim valido/expirado/reutilizado/de outra conta), nao testar
// entrega SMTP.
//
// Roda contra o Supabase local (`supabase start` / `supabase db reset`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

function generateValidCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  function checkDigit(nums) {
    let sum = 0;
    let weight = nums.length + 1;
    for (const n of nums) { sum += n * weight; weight -= 1; }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  }
  const d1 = checkDigit(base);
  const d2 = checkDigit([...base, d1]);
  return [...base, d1, d2].join('');
}

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
  const org = await must(service.from('organizations').insert({ name: 'Invite Claim Test', slug: `invite-claim-${suffix}` }).select('id').single(), 'org');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Invite Claim', year: 2026, slug: `invite-claim-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');

  let userCount = 0;
  async function makeAuthUser(label) {
    userCount += 1;
    const email = `invite-claim-${label}-${suffix}-${userCount}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `create ${label}`);
    return { userId: created.user.id, email, client: await clientFor(email, password) };
  }

  async function makeAdmin(label) {
    const account = await makeAuthUser(label);
    await must(service.from('customer_profiles').upsert({ user_id: account.userId, cpf: generateValidCpf(), full_name: label, birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), `${label} profile`);
    const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
    await must(service.from('organization_members').insert({ organization_id: org.id, user_id: account.userId, is_owner: true, is_active: true }), `${label} org member`);
    await must(service.from('admin_users').insert({ user_id: account.userId, role_id: ownerRole.id, is_active: true }), `${label} admin_users`);
    return account.client;
  }

  // Reproduz um cadastro nascido de importacao: participants + uma linha de
  // participation_history com source='import' pra esse participante/evento
  // -- e exatamente essa combinacao que prepare_participant_account_invite
  // usa pra decidir requires_password_setup=true (20260815001914_remote_schema.sql:9078-9081).
  let participantCount = 0;
  async function createImportedParticipant(label) {
    participantCount += 1;
    const email = `imported-${label}-${suffix}-${participantCount}@qa.local`;
    const cpf = generateValidCpf();
    const participant = await must(service.from('participants').insert({
      full_name: label, cpf, email, registration_status: 'confirmed',
      organization_id: org.id, event_id: event.id,
    }).select('id').single(), `participant ${label}`);
    await must(service.from('participation_history').insert({
      event_id: event.id, participant_id: participant.id, event_year: 2026,
      full_name: label, cpf, email, status: 'confirmed', source: 'import',
    }), `participation_history ${label}`);
    return { id: participant.id, email, cpf };
  }

  async function checkEligibility(admin, participantId) {
    const result = await admin.rpc('check_participant_account_invite_eligibility', { p_participant_id: participantId });
    if (result.error) throw new Error(`eligibility: ${JSON.stringify(result.error)}`);
    return Array.isArray(result.data) ? result.data[0] : result.data;
  }

  async function prepareInvite(admin, participantId) {
    const result = await admin.rpc('prepare_participant_account_invite', { p_participant_id: participantId });
    if (result.error) throw new Error(`prepare invite: ${JSON.stringify(result.error)}`);
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    return row;
  }

  async function inviteRow(inviteId) {
    return must(service.from('participant_account_invites').select('*').eq('id', inviteId).single(), 'invite row');
  }

  async function participantRow(participantId) {
    return must(service.from('participants').select('user_id').eq('id', participantId).single(), 'participant row');
  }

  // Passo que, no fluxo real, acontece dentro de dispatchFirstAccessEmail +
  // inviteCadastroFirstAccessAction (src/app/cadastros/actions.ts) depois que
  // inviteUserByEmail() cria a conta e devolve o id: correlaciona o convite
  // ao auth.users pelo auth_user_id. Aqui criamos essa conta diretamente
  // (sem enviar e-mail de verdade) e replicamos so essa correlacao -- e o
  // unico passo de aplicacao fora da RPC que o claim depende (auth_user_id +
  // e-mail precisam bater com a sessao que reivindica).
  async function correlateInviteToNewAccount(inviteId, email, label) {
    const account = await makeAuthUser(label);
    await must(service.auth.admin.updateUserById(account.userId, { email }), `update email ${label}`);
    await must(service.from('participant_account_invites').update({ auth_user_id: account.userId }).eq('id', inviteId), 'correlate invite');
    return clientFor(email, password);
  }

  return {
    service, org, event, must, makeAdmin, makeAuthUser, createImportedParticipant,
    checkEligibility, prepareInvite, inviteRow, participantRow, correlateInviteToNewAccount, suffix,
    url: env.url, anonKey,
  };
}

const fx = await buildFixture();

test('cadastro importado e elegivel; convite real e preparado via RPC canonica com requires_password_setup', async () => {
  const admin = await fx.makeAdmin('admin1');
  const participant = await fx.createImportedParticipant('joao1');

  const eligibility = await fx.checkEligibility(admin, participant.id);
  assert.equal(eligibility.eligible, true, eligibility.reason_message);
  assert.equal(eligibility.reason_code, 'eligible');
  assert.equal(eligibility.email, participant.email);

  const prepared = await fx.prepareInvite(admin, participant.id);
  assert.ok(prepared?.invite_id, 'deve retornar o id do convite criado');
  assert.equal(prepared.email, participant.email);

  const invite = await fx.inviteRow(prepared.invite_id);
  assert.equal(invite.status, 'pending');
  assert.equal(invite.participant_id, participant.id);
  assert.equal(invite.requires_password_setup, true, 'origem import deve exigir definicao de senha');
  assert.equal(invite.claimed_user_id, null);
  assert.equal(invite.password_setup_completed_at, null);
  assert.ok(new Date(invite.expires_at).getTime() > Date.now(), 'convite novo deve estar dentro da validade');
});

test('convite pendente e dentro da validade e reivindicado pela conta correta, materializando o vinculo', async () => {
  const admin = await fx.makeAdmin('admin2');
  const participant = await fx.createImportedParticipant('joao2');
  const prepared = await fx.prepareInvite(admin, participant.id);
  const holder = await fx.correlateInviteToNewAccount(prepared.invite_id, participant.email, 'holder2');

  const before = await fx.participantRow(participant.id);
  assert.equal(before.user_id, null);

  const claim = await holder.rpc('claim_participant_account_invite', { p_invite_id: prepared.invite_id });
  assert.equal(claim.error, null, claim.error?.message);
  assert.equal(claim.data, participant.id, 'RPC deve retornar o id do participante reivindicado');

  const after = await fx.participantRow(participant.id);
  assert.notEqual(after.user_id, null, 'participants.user_id deve ficar vinculado ao ator');

  const invite = await fx.inviteRow(prepared.invite_id);
  assert.equal(invite.status, 'claimed');
  assert.notEqual(invite.claimed_user_id, null);
  assert.notEqual(invite.claimed_at, null);
  assert.equal(invite.password_setup_completed_at, null, 'a RPC de claim nunca mexe nisso -- e um passo posterior da Server Action, depois da senha');

  const { data: history } = await fx.service.from('participation_history').select('user_id,status').eq('participant_id', participant.id).eq('event_id', fx.event.id).single();
  assert.notEqual(history.user_id, null, 'participation_history tambem deve ficar vinculado ao ator');
  assert.equal(history.status, 'confirmed');
});

test('convite expirado e rejeitado e nao altera vinculo nem estado do convite', async () => {
  const admin = await fx.makeAdmin('admin3');
  const participant = await fx.createImportedParticipant('joao3');
  const prepared = await fx.prepareInvite(admin, participant.id);
  const holder = await fx.correlateInviteToNewAccount(prepared.invite_id, participant.email, 'holder3');

  await fx.must(fx.service.from('participant_account_invites').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', prepared.invite_id), 'backdate expiration');

  const claim = await holder.rpc('claim_participant_account_invite', { p_invite_id: prepared.invite_id });
  assert.ok(claim.error, 'convite expirado nao pode ser reivindicado');
  assert.match(claim.error.message, /expirado/i);

  const after = await fx.participantRow(participant.id);
  assert.equal(after.user_id, null, 'nenhum vinculo deve ser criado quando o convite esta expirado');
  const invite = await fx.inviteRow(prepared.invite_id);
  assert.equal(invite.status, 'pending', 'status do convite nao deve mudar so por tentar reivindicar expirado');
  assert.equal(invite.claimed_user_id, null);
  assert.equal(invite.password_setup_completed_at, null);
});

test('convite ja utilizado e rejeitado para outra conta, mas continua idempotente para quem ja reivindicou', async () => {
  const admin = await fx.makeAdmin('admin4');
  const participant = await fx.createImportedParticipant('joao4');
  const prepared = await fx.prepareInvite(admin, participant.id);
  const holder = await fx.correlateInviteToNewAccount(prepared.invite_id, participant.email, 'holder4');

  const firstClaim = await holder.rpc('claim_participant_account_invite', { p_invite_id: prepared.invite_id });
  assert.equal(firstClaim.error, null, firstClaim.error?.message);
  const { user_id: originalHolderId } = await fx.participantRow(participant.id);

  const outsider = await fx.makeAuthUser('outsider4');
  const outsiderResult = await outsider.client.rpc('claim_participant_account_invite', { p_invite_id: prepared.invite_id });
  assert.ok(outsiderResult.error, 'outra conta nao pode reivindicar um convite ja usado por alguem');
  assert.match(outsiderResult.error.message, /reivindicado por outra conta/i);

  const afterOutsiderAttempt = await fx.participantRow(participant.id);
  assert.equal(afterOutsiderAttempt.user_id, originalHolderId, 'a tentativa de outra conta nao pode roubar/alterar o vinculo existente');

  const retry = await holder.rpc('claim_participant_account_invite', { p_invite_id: prepared.invite_id });
  assert.equal(retry.error, null, 'a mesma conta que ja reivindicou pode repetir a chamada sem erro (idempotente)');
  assert.equal(retry.data, participant.id);
});

test('conta com e-mail/auth_user_id diferente nao pode reivindicar convite de outra pessoa', async () => {
  const admin = await fx.makeAdmin('admin5');
  const participant = await fx.createImportedParticipant('joao5');
  const prepared = await fx.prepareInvite(admin, participant.id);
  // Convite NUNCA correlacionado a nenhuma conta -- simula alguem tentando
  // adivinhar/reusar um invite_id de outra pessoa com a propria sessao.
  const stranger = await fx.makeAuthUser('stranger5');

  const claim = await stranger.client.rpc('claim_participant_account_invite', { p_invite_id: prepared.invite_id });
  assert.ok(claim.error, 'conta sem correlacao com o convite nao pode reivindica-lo');
  assert.match(claim.error.message, /nao esta correlacionado a esta conta/i);

  const after = await fx.participantRow(participant.id);
  assert.equal(after.user_id, null, 'nenhum vinculo deve ser criado');
  const invite = await fx.inviteRow(prepared.invite_id);
  assert.equal(invite.status, 'pending');
  assert.equal(invite.claimed_user_id, null);
  assert.equal(invite.password_setup_completed_at, null);
});

test('usuario nao autenticado nao consegue chamar a RPC de claim diretamente', async () => {
  const admin = await fx.makeAdmin('admin6');
  const participant = await fx.createImportedParticipant('joao6');
  const prepared = await fx.prepareInvite(admin, participant.id);

  const anon = createClient(fx.url, fx.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const claim = await anon.rpc('claim_participant_account_invite', { p_invite_id: prepared.invite_id });
  assert.ok(claim.error, 'chamada anonima deve ser recusada pela propria RPC');
});
