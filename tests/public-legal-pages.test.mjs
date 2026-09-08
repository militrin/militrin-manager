import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getMilitrinContactEmail,
  MILITRIN_CONTACT_EMAIL,
} from '../src/lib/public/legal.ts';
import {
  normalizeDataDeletionRequest,
  validateDataDeletionRequest,
} from '../src/lib/public/data-deletion-request.ts';

const middlewarePath = new URL('../middleware.ts', import.meta.url);
const privacyPagePath = new URL('../src/app/politica-de-privacidade/page.tsx', import.meta.url);
const deletionPagePath = new URL('../src/app/exclusao-de-dados/page.tsx', import.meta.url);
const deletionFormPath = new URL('../src/app/exclusao-de-dados/deletion-request-form.tsx', import.meta.url);
const deletionActionsPath = new URL('../src/app/exclusao-de-dados/actions.ts', import.meta.url);
const footerPath = new URL('../src/components/public/PublicSiteFooter.tsx', import.meta.url);
const legalPath = new URL('../src/lib/public/legal.ts', import.meta.url);
const migrationPath = new URL('../supabase/migrations/20261001000000_data_deletion_requests.sql', import.meta.url);
const homePath = new URL('../src/app/page.tsx', import.meta.url);
const criarContaPath = new URL('../src/app/criar-conta/page.tsx', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);

const secretPatterns = [
  /META_INSTAGRAM_APP_SECRET/,
  /INSTAGRAM_TOKEN_ENCRYPTION_KEY/,
  /access_token/,
  /App Secret/,
];

test('rotas legais nao exigem autenticacao no middleware', async () => {
  const source = await readFile(middlewarePath, 'utf8');
  const protectedList = source.slice(source.indexOf('const protectedPrefixes'), source.indexOf('const requiresAuth'));
  assert.doesNotMatch(protectedList, /politica-de-privacidade/);
  assert.doesNotMatch(protectedList, /exclusao-de-dados/);
});

test('paginas legais exportam metadata e nao expõem segredos', async () => {
  const privacy = await readFile(privacyPagePath, 'utf8');
  const deletion = await readFile(deletionPagePath, 'utf8');
  const legal = await readFile(legalPath, 'utf8');

  assert.match(privacy, /title: 'Política de Privacidade \| Militrin'/);
  assert.match(deletion, /title: 'Exclusão de Dados \| Militrin'/);
  assert.match(privacy, /Integração com Instagram\/Meta/);
  assert.match(privacy, /Sorteios realizados através do Instagram/);
  assert.match(privacy, /href=\{DATA_DELETION_PATH\}/);
  assert.match(privacy, /Última atualização/);
  assert.match(legal, /LEGAL_LAST_UPDATED_LABEL = '7 de setembro de 2026'/);
  assert.match(legal, /NEXT_PUBLIC_MILITRIN_CONTACT_EMAIL/);
  assert.match(legal, /oktoberfest\.militrin@gmail\.com/);
  assert.match(privacy, /getMilitrinContactEmail/);
  assert.match(privacy, /mailto:\$\{contactEmail\}/);
  assert.match(deletion, /getMilitrinContactEmail/);
  assert.match(deletion, /mailto:\$\{contactEmail\}/);
  assert.doesNotMatch(privacy, /Canal de e-mail institucional pendente/);
  assert.doesNotMatch(privacy, /ainda não está publicado/);
  assert.doesNotMatch(deletion, /Canal de e-mail institucional pendente/);
  assert.doesNotMatch(privacy, /contato@militrin/);
  assert.doesNotMatch(deletion, /contato@militrin/);
  assert.doesNotMatch(privacy, /CNPJ/);
  assert.doesNotMatch(privacy, /DPO/);

  const readme = await readFile(readmePath, 'utf8');
  assert.match(readme, /NEXT_PUBLIC_MILITRIN_CONTACT_EMAIL=/);

  for (const pattern of secretPatterns) {
    assert.doesNotMatch(privacy, pattern);
    assert.doesNotMatch(deletion, pattern);
  }
});

test('e-mail institucional temporario e o canal publico de contato', () => {
  const previous = process.env.NEXT_PUBLIC_MILITRIN_CONTACT_EMAIL;
  try {
    process.env.NEXT_PUBLIC_MILITRIN_CONTACT_EMAIL = 'oktoberfest.militrin@gmail.com';
    assert.equal(getMilitrinContactEmail(), 'oktoberfest.militrin@gmail.com');
    delete process.env.NEXT_PUBLIC_MILITRIN_CONTACT_EMAIL;
    assert.equal(getMilitrinContactEmail(), MILITRIN_CONTACT_EMAIL);
    assert.equal(MILITRIN_CONTACT_EMAIL, 'oktoberfest.militrin@gmail.com');
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_MILITRIN_CONTACT_EMAIL;
    else process.env.NEXT_PUBLIC_MILITRIN_CONTACT_EMAIL = previous;
  }
});

test('footer publico aponta para as duas paginas legais', async () => {
  const footer = await readFile(footerPath, 'utf8');
  const home = await readFile(homePath, 'utf8');
  assert.match(footer, /Política de Privacidade/);
  assert.match(footer, /Exclusão de Dados/);
  assert.match(footer, /PRIVACY_POLICY_PATH/);
  assert.match(footer, /DATA_DELETION_PATH/);
  assert.match(home, /<PublicSiteFooter \/>/);
});

test('criar conta liga a politica de privacidade existente', async () => {
  const source = await readFile(criarContaPath, 'utf8');
  assert.match(source, /href="\/politica-de-privacidade"/);
  assert.match(source, /<PublicSiteFooter \/>/);
});

test('solicitacao de exclusao e pedido, nao apaga dados', async () => {
  const migration = await readFile(migrationPath, 'utf8');
  const actions = await readFile(deletionActionsPath, 'utf8');
  const form = await readFile(deletionFormPath, 'utf8');

  assert.match(migration, /create table if not exists public\.data_deletion_requests/);
  assert.match(migration, /create or replace function public\.submit_data_deletion_request/);
  assert.match(migration, /grant execute on function public\.submit_data_deletion_request/);
  assert.match(migration, /to anon, authenticated/);
  assert.doesNotMatch(migration, /delete from public\.(tickets|orders|participants|users)/i);
  assert.match(migration, /honeypot/i);
  assert.match(migration, /interval '24 hours'/);
  assert.match(actions, /submit_data_deletion_request/);
  assert.doesNotMatch(actions, /delete\(/);
  assert.match(actions, /isInfrastructureError/);
  assert.match(form, /company_website/);
  assert.match(form, /Confirmo que sou a pessoa titular/);
});

test('validacao do formulario rejeita envio incompleto e normaliza handle', () => {
  assert.equal(validateDataDeletionRequest({
    fullName: ' ',
    email: 'invalido',
    confirmed: false,
  }), 'Informe seu nome completo.');

  assert.equal(validateDataDeletionRequest({
    fullName: 'Maria Silva',
    email: 'invalido',
    confirmed: true,
  }), 'Informe um e-mail válido.');

  assert.equal(validateDataDeletionRequest({
    fullName: 'Maria Silva',
    email: 'maria@example.com',
    instagramHandle: '!!!',
    confirmed: true,
  }), 'Informe um usuário do Instagram válido, ou deixe o campo em branco.');

  assert.equal(validateDataDeletionRequest({
    fullName: 'Maria Silva',
    email: 'maria@example.com',
    confirmed: false,
  }), 'Confirme que deseja solicitar a exclusão dos dados.');

  assert.equal(validateDataDeletionRequest({
    fullName: 'Maria Silva',
    email: 'maria@example.com',
    instagramHandle: '@MilitrinOktober',
    confirmed: true,
  }), null);

  const normalized = normalizeDataDeletionRequest({
    fullName: '  Maria   Silva  ',
    email: 'Maria@Example.COM',
    instagramHandle: '@MilitrinOktober',
    notes: '  quero exclusao  ',
    confirmed: true,
    website: '',
  });
  assert.equal(normalized.fullName, 'Maria Silva');
  assert.equal(normalized.email, 'maria@example.com');
  assert.equal(normalized.instagramHandle, 'MilitrinOktober');
  assert.equal(normalized.notes, 'quero exclusao');
});
