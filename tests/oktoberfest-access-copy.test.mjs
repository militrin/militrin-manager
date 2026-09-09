import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OKTOBERFEST_ACCESS_NOTICE } from '../src/lib/public/oktoberfest-access-notice.ts';

test('aviso Oktoberfest centralizado tem titulo e textos canonicos', () => {
  assert.match(OKTOBERFEST_ACCESS_NOTICE.title, /Ingresso da Oktoberfest não incluso/i);
  assert.match(OKTOBERFEST_ACCESS_NOTICE.full, /pacote Militrin não inclui/i);
  assert.match(OKTOBERFEST_ACCESS_NOTICE.short, /Ala Jovem/i);
});

test('Event Pass, PDF e PNG compartilham a mesma comunicacao de kit e aviso', async () => {
  const format = await readFile(new URL('../src/components/ticket-pass/ticket-pass-format.ts', import.meta.url), 'utf8');
  const qr = await readFile(new URL('../src/components/ticket-pass/TicketQRCode.tsx', import.meta.url), 'utf8');
  const exportSource = await readFile(new URL('../src/components/ticket-pass/ticket-pass-export.ts', import.meta.url), 'utf8');

  assert.match(format, /eyebrow:\s*'Acesso Militrin'/);
  assert.match(format, /qrPurpose:\s*'QR para retirada do kit'/);
  assert.match(format, /no ponto de retirada do Militrin/);
  assert.doesNotMatch(format, /na entrada do evento/);
  assert.match(format, /oktoberfestNoticeTitle/);
  assert.match(format, /oktoberfestNoticeBody/);

  assert.match(qr, /TICKET_PASS_COPY\.qrPurpose/);
  assert.match(qr, /OktoberfestTicketNotice/);
  assert.doesNotMatch(qr, /entrada do evento/);

  assert.match(exportSource, /TICKET_PASS_COPY\.qrPurpose/);
  assert.match(exportSource, /TICKET_PASS_COPY\.oktoberfestNoticeTitle/);
  assert.match(exportSource, /TICKET_PASS_COPY\.oktoberfestNoticeBody/);
  assert.doesNotMatch(exportSource, /entrada do evento/);
});

test('checkout e confirmacao do participante exibem o aviso antes/depois da compra', async () => {
  const wizard = await readFile(new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url), 'utf8');
  const pix = await readFile(new URL('../src/app/inscricao/[eventSlug]/pix-payment-card.tsx', import.meta.url), 'utf8');
  const retorno = await readFile(new URL('../src/app/pagamento/retorno/payment-return-client.tsx', import.meta.url), 'utf8');
  const nav = await readFile(new URL('../src/app/minha-conta/account-nav.tsx', import.meta.url), 'utf8');
  const ingressos = await readFile(new URL('../src/app/minha-conta/ingressos/page.tsx', import.meta.url), 'utf8');

  assert.match(wizard, /OktoberfestTicketNotice/);
  assert.match(wizard, /variant="checkout"/);
  assert.match(wizard, /accessConfirmed|pacote Militrin está confirmado/);
  assert.doesNotMatch(wizard, /Seu ingresso para o evento está confirmado/);

  assert.match(pix, /pacote Militrin/);
  assert.match(pix, /Ala Jovem/);
  assert.match(retorno, /Ver meus acessos/);
  assert.match(nav, /Meus acessos/);
  assert.match(ingressos, /Meus acessos e QR Codes/);
  assert.doesNotMatch(ingressos, /Ver ingresso/);
});
