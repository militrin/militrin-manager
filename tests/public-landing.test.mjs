import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { OKTOBERFEST_ACCESS_NOTICE } from '../src/lib/public/oktoberfest-access-notice.ts';
import { MILITRIN_INSTAGRAM_HANDLE, MILITRIN_INSTAGRAM_URL } from '../src/lib/public/legal.ts';

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('home deslogada e landing institucional e, se autenticado, continua indo para Minha conta', async () => {
  const home = await read('src/app/page.tsx');
  assert.match(home, /redirect\('\/minha-conta'\)/);
  assert.match(home, /PublicLanding/);
  assert.match(home, /getPublicEvents/);
  assert.match(home, /bannerHeroUrl: featured.bannerHeroUrl/);
  assert.match(home, /bannerCardUrl: featured.bannerCardUrl/);
  assert.doesNotMatch(home, /signInPublicAccountAction/);
  assert.doesNotMatch(home, /PublicLoginForm/);
});

test('CTAs da landing usam rotas reais ja existentes', async () => {
  const landing = await read('src/components/public/PublicLanding.tsx');
  assert.match(landing, /PUBLIC_LOGIN_PATH = '\/entrar'/);
  assert.match(landing, /FIRST_ACCESS_PATH = '\/primeiro-acesso\/reenviar'/);
  assert.match(landing, /FORGOT_PASSWORD_PATH = '\/esqueci-minha-senha'/);
  assert.match(landing, /href=\{PUBLIC_LOGIN_PATH\}/);
  assert.match(landing, /href=\{FIRST_ACCESS_PATH\}/);
  assert.match(landing, /href=\{FORGOT_PASSWORD_PATH\}/);
  assert.match(landing, /next=\/minha-conta\/ingressos/);
  assert.match(landing, /next=\/minha-conta\/compras/);
  assert.match(landing, /next=\/minha-conta\/dados/);
  assert.doesNotMatch(landing, /whatsapp/i);
  assert.doesNotMatch(landing, /wa\.me/);
});

test('landing reusa a copy canonica Militrin x Oktoberfest e nao vende ingresso da Ala Jovem', async () => {
  const landing = await read('src/components/public/PublicLanding.tsx');
  assert.match(landing, /OKTOBERFEST_ACCESS_NOTICE\.full/);
  assert.match(landing, /MILITRIN_PARTICIPANT_COPY/);
  assert.match(landing, /Pacote Militrin/);
  assert.match(landing, /MILITRIN_PARTICIPANT_COPY\.qrForKitPickup/);
  assert.doesNotMatch(landing, /OktoberfestTicketNotice/);
  assert.doesNotMatch(landing, /ingresso oficial da Ala Jovem inclus/);
  assert.equal(
    OKTOBERFEST_ACCESS_NOTICE.full.includes('não inclui o ingresso de acesso à Ala Jovem'),
    true,
  );
});

test('mockups da landing sao ilustracoes, sem print pessoal e sem QR operacional', async () => {
  const landing = await read('src/components/public/PublicLanding.tsx');
  const phones = await read('src/components/public/LandingPhones.tsx');
  assert.match(landing, /LandingPhones/);
  assert.match(phones, /Participante/);
  assert.match(phones, /IllustrationQr/);
  assert.doesNotMatch(phones, /douglas/i);
  assert.doesNotMatch(landing, /minha-conta\.webp/);
  assert.doesNotMatch(landing, /minhas-compras\.webp/);
  await access(new URL('../public/landing/evento-hero.webp', import.meta.url));
  await access(new URL('../public/landing/evento-card.webp', import.meta.url));
});

test('contato institucional usa e-mail publico e Instagram ja documentado', async () => {
  const landing = await read('src/components/public/PublicLanding.tsx');
  const footer = await read('src/components/public/PublicSiteFooter.tsx');
  assert.match(landing, /getMilitrinContactEmail/);
  assert.match(landing, /MILITRIN_INSTAGRAM_URL/);
  assert.match(footer, /MILITRIN_INSTAGRAM_URL/);
  assert.match(footer, /© 2026/);
  assert.equal(MILITRIN_INSTAGRAM_HANDLE, 'militrinoktober');
  assert.equal(MILITRIN_INSTAGRAM_URL, 'https://www.instagram.com/militrinoktober/');
});

test('landing respeita reduced motion e nao puxa lib de animacao', async () => {
  const landing = await read('src/components/public/PublicLanding.tsx');
  const css = await read('src/app/globals.css');
  assert.match(landing, /motion-reduce:transition-none/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(landing, /framer-motion/);
  assert.doesNotMatch(landing, /from 'gsap'/);
  assert.doesNotMatch(landing, /<video/);
});
