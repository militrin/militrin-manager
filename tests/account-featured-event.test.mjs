import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  isAccountHeaderEventEligible,
  resolveAccountHeaderCta,
} from '../src/lib/account/account-header-rules.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const now = new Date('2026-09-12T15:00:00.000Z');

function event(overrides = {}) {
  return {
    name: 'Militrin',
    slug: 'militrin',
    starts_at: '2026-10-10T19:00:00.000Z',
    ends_at: '2026-10-10T22:30:00.000Z',
    location: 'Parque',
    is_active: true,
    archived_at: null,
    featured_on_account: true,
    registration_enabled: true,
    registration_open_at: '2026-01-01T00:00:00.000Z',
    registration_close_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

test('evento ativo e destacado é elegível para o cabeçalho', () => {
  assert.equal(isAccountHeaderEventEligible(event(), now), true);
});

test('evento inativo não aparece no cabeçalho mesmo destacado', () => {
  assert.equal(isAccountHeaderEventEligible(event({ is_active: false }), now), false);
});

test('sem evento elegível não há cabeçalho (não featured)', () => {
  assert.equal(isAccountHeaderEventEligible(event({ featured_on_account: false }), now), false);
});

test('evento encerrado (ends_at no passado) não aparece', () => {
  assert.equal(isAccountHeaderEventEligible(event({
    starts_at: '2026-08-01T19:00:00.000Z',
    ends_at: '2026-08-01T22:00:00.000Z',
  }), now), false);
});

test('venda ativa oferece Comprar ingresso; venda encerrada não inventa CTA', () => {
  const open = resolveAccountHeaderCta(event({
    registration_enabled: true,
    registration_open_at: '2026-01-01T00:00:00.000Z',
    registration_close_at: '2099-01-01T00:00:00.000Z',
  }), now);
  assert.deepEqual(open, { showBuyButton: true, buyHref: '/inscricao/militrin' });

  const closed = resolveAccountHeaderCta(event({
    registration_enabled: false,
  }), now);
  assert.equal(closed.showBuyButton, false);

  const noSlug = resolveAccountHeaderCta(event({ slug: '' }), now);
  assert.equal(noSlug.showBuyButton, false);
});

test('admin expõe Destacar na Minha Conta e a RPC garante um destaque por org', async () => {
  const toggle = await read('src/app/painel/eventos/[id]/account-header-featured-toggle.tsx');
  const page = await read('src/app/painel/eventos/[id]/page.tsx');
  const header = await read('src/lib/account/header-event.ts');
  const migration = await read('supabase/migrations/20261023000000_event_featured_on_account.sql');
  const militrinHeader = await read('src/components/militrin/MilitrinHeader.tsx');

  assert.match(toggle, /Destacar na Minha Conta/);
  assert.match(toggle, /Evento em destaque na Minha Conta/);
  assert.match(page, /AccountHeaderFeaturedToggle/);
  assert.match(header, /featured_on_account/);
  assert.match(header, /isAccountHeaderEventEligible/);
  assert.match(header, /account-header-rules/);
  assert.match(migration, /events_one_featured_on_account_per_org/);
  assert.match(migration, /set_event_featured_on_account/);
  assert.match(migration, /America\/Sao_Paulo/);
  assert.doesNotMatch(militrinHeader, /Militrin<\/p>/);
  assert.doesNotMatch(militrinHeader, />2026</);
});
