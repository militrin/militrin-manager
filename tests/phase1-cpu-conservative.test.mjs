import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('root layout nao usa cookies nem client autenticado', async () => {
  const layout = await read('src/app/layout.tsx');
  const theme = await read('src/lib/theme/get-brand-theme.ts');
  const homeButton = await read('src/components/HomeButton.tsx');
  assert.doesNotMatch(layout, /cookies\(/);
  assert.doesNotMatch(layout, /createServerSupabaseClient/);
  assert.match(layout, /getBrandTheme/);
  assert.match(layout, /HomeButton/);
  assert.match(theme, /next: \{ revalidate: 3600, tags: \[BRAND_THEME_CACHE_TAG\] \}/);
  assert.doesNotMatch(theme, /createServerSupabaseClient/);
  assert.match(homeButton, /'use client'/);
  assert.match(homeButton, /pathRequiresAuth/);
});

test('prefetch desligado so nas rotas dinamicas pesadas da fase 1', async () => {
  const cadastroList = await read('src/app/cadastros/cadastro-list.tsx');
  const eventPage = await read('src/app/eventos/[eventSlug]/page.tsx');
  const landing = await read('src/components/public/PublicLanding.tsx');
  const loginForm = await read('src/components/public/PublicLoginForm.tsx');
  const carousel = await read('src/app/minha-conta/home-ticket-carousel.tsx');
  const featured = await read('src/app/minha-conta/home-featured-events.tsx');
  assert.match(cadastroList, /href=\{`\/cadastros\/\$\{row\.id\}`\} prefetch=\{false\}/);
  assert.match(eventPage, /prefetch=\{false\}/);
  assert.match(eventPage, /\/inscricao\/\$\{event\.slug\}/);
  assert.match(landing, /href=\{PUBLIC_LOGIN_PATH\} prefetch=\{false\}/);
  assert.match(landing, /href=\{PUBLIC_SIGNUP_PATH\} prefetch=\{false\}/);
  assert.match(loginForm, /href=\{createAccountHref\}/);
  assert.match(loginForm, /prefetch=\{false\}/);
  assert.match(carousel, /prefetch=\{false\}/);
  assert.match(featured, /prefetch=\{false\}/);
});

test('minha-conta reutiliza perfil, categorias, order_items e events no mesmo request', async () => {
  const layout = await read('src/app/minha-conta/layout.tsx');
  const page = await read('src/app/minha-conta/page.tsx');
  const cards = await read('src/lib/account/home-ticket-cards.ts');
  const profile = await read('src/lib/account/profile-completion.ts');
  const categories = await read('src/lib/account/event-ticket-categories.ts');
  const landing = await read('src/lib/navigation/admin-landing.ts');

  assert.match(profile, /export const getCustomerProfileRow = cache\(/);
  assert.match(layout, /getCustomerProfileRow\(user\.id\)/);
  assert.match(page, /getCustomerProfileRow\(user\?\.id\)/);
  assert.doesNotMatch(layout, /rpc\('get_customer_profile'/);
  assert.doesNotMatch(page, /rpc\('get_customer_profile'/);

  assert.match(categories, /export const getEventTicketCategories = cache\(/);
  assert.match(cards, /getEventTicketCategories\(eventId\)/);
  assert.match(page, /getEventTicketCategories\(event\.id\)/);
  assert.doesNotMatch(cards, /rpc\('get_event_ticket_categories'/);
  assert.doesNotMatch(page, /rpc\('get_event_ticket_categories'/);

  assert.match(page, /orderItems: ticketScope\.orderItems/);
  assert.match(page, /getAccountHomeEventsByIds/);
  assert.match(landing, /organization_members/);
  assert.match(landing, /if \(!member && !platformUser\) return null/);
});
