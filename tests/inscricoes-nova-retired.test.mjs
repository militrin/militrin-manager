import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const militrinEventId = '17e8ecdd-5acf-4048-bc52-b47817d42e23';

test('A. /inscricoes/nova nao renderiza mais checkout', async () => {
  const page = await read('../src/app/inscricoes/nova/page.tsx');
  assert.equal(existsSync(new URL('../src/app/inscricoes/nova/actions.ts', import.meta.url)), false);
  assert.match(page, /redirect\(`\/ingressos\/emitir\?eventId=\$\{encodeURIComponent\(eventId\)\}`\)/);
  assert.match(page, /redirect\("\/ingressos\/emitir"\)/);
  assert.doesNotMatch(page, /use client/);
  assert.doesNotMatch(page, /createRegistrationAction|generatePixPaymentAction|simulatePaymentAction|validateCouponAction/);
  assert.doesNotMatch(page, /paymentMethods|coupon_code|credit_card|"cash"|Cortesia/);
  assert.doesNotMatch(page, /create_manual_registration_order/);
});

test('B. deep link com eventId UUID preserva o mesmo evento', async () => {
  const page = await read('../src/app/inscricoes/nova/page.tsx');
  assert.match(page, /if \(eventId && uuid\.test\(eventId\)\)/);
  assert.match(page, /redirect\(`\/ingressos\/emitir\?eventId=\$\{encodeURIComponent\(eventId\)\}`\)/);
  const emitir = await read('../src/app/ingressos/emitir/page.tsx');
  assert.match(emitir, /query\.eventId && uuid\.test\(query\.eventId\)/);
  assert.match(emitir, /initialEventId=\{initialEventId\}/);
  assert.match(emitir, /selectedEventName \?\? "Ingressos"/);
  const form = await read('../src/app/ingressos/emitir/issue-ticket-form.tsx');
  assert.match(form, /initialEventId/);
  assert.match(form, /events\.some\(\(event\) => event\.id === initialEventId\) \? initialEventId : ""/);
  assert.ok(militrinEventId);
});

test('C. deep link sem eventId ou com valor invalido vai para Emitir sem param', async () => {
  const page = await read('../src/app/inscricoes/nova/page.tsx');
  const redirectWithoutEvent = page.indexOf('redirect("/ingressos/emitir")');
  const redirectWithEvent = page.indexOf('redirect(`/ingressos/emitir?eventId=');
  assert.ok(redirectWithEvent >= 0);
  assert.ok(redirectWithoutEvent > redirectWithEvent);
});

test('D. usuario sem participants.create nao emite', async () => {
  const [emitir, action] = await Promise.all([
    read('../src/app/ingressos/emitir/page.tsx'),
    read('../src/app/ingressos/emitir/actions.ts'),
  ]);
  assert.match(emitir, /hasPermission\("participants.create"\)/);
  assert.match(emitir, /if \(!canIssue\) redirect\("\/acesso-negado"\)/);
  assert.match(action, /assertPermission\("participants.create"\)/);
  const novaLayout = await read('../src/app/inscricoes/layout.tsx');
  assert.match(novaLayout, /requirePermission\("participants.view"\)/);
  assert.doesNotMatch(novaLayout, /participants.create/);
});

test('E-F. Emitir ingresso e cortesia individual permanecem o fluxo canonico', async () => {
  const [form, action] = await Promise.all([
    read('../src/app/ingressos/emitir/issue-ticket-form.tsx'),
    read('../src/app/ingressos/emitir/actions.ts'),
  ]);
  assert.match(form, /issueTicketAction/);
  assert.match(form, /<option value="courtesy">Cortesia<\/option>/);
  assert.match(form, /Criar novo cadastro/);
  assert.match(form, /newContactHref/);
  assert.match(form, /\/cadastros\/novo/);
  assert.match(action, /issue_manual_ticket_batch/);
  assert.doesNotMatch(form, /paymentMethods/);
  assert.doesNotMatch(form, /value="pix"|value="credit_card"|value="cash"/);
  assert.doesNotMatch(form, /coupon_code|Cupom/);
});

test('G-H. RPCs canônicas intactas: wrapper Emitir continua usando create_manual_registration_order', async () => {
  const [action, batchSql] = await Promise.all([
    read('../src/app/ingressos/emitir/actions.ts'),
    read('../supabase/migrations/20261108000000_payment_amount_guard_and_idempotency.sql'),
  ]);
  assert.match(action, /supabase\.rpc\("issue_manual_ticket_batch"/);
  assert.doesNotMatch(action, /create_manual_registration_order/);
  assert.match(batchSql, /create or replace function public.issue_manual_ticket_batch/);
  assert.match(batchSql, /create_manual_registration_order/);
});

test('I. checkout publico continua intacto', async () => {
  const checkout = await read('../src/app/inscricao/actions.ts');
  assert.match(checkout, /create_multi_ticket_order_checkout/);
  assert.doesNotMatch(checkout, /create_manual_registration_order/);
  assert.doesNotMatch(checkout, /issue_manual_ticket_batch/);
});

test('J. gate de seguranca: nenhuma action TS recria pagamento paid R$0 via checkout administrativo', async () => {
  const [novaPage, emitirAction, emitirForm, validation] = await Promise.all([
    read('../src/app/inscricoes/nova/page.tsx'),
    read('../src/app/ingressos/emitir/actions.ts'),
    read('../src/app/ingressos/emitir/issue-ticket-form.tsx'),
    read('../src/lib/validation/registration.ts'),
  ]);
  for (const source of [novaPage, emitirAction, emitirForm, validation]) {
    assert.doesNotMatch(source, /createRegistrationAction/);
    assert.doesNotMatch(source, /generatePixPaymentAction/);
    assert.doesNotMatch(source, /simulatePaymentAction/);
    assert.doesNotMatch(source, /cancelRegistrationPaymentAction/);
    assert.doesNotMatch(source, /validateCouponAction/);
  }
  assert.doesNotMatch(validation, /registrationSchema|coupon_code|payment_method/);
  assert.doesNotMatch(emitirAction, /p_payment_method: ['"]pix['"]|p_payment_method: ['"]cash['"]|p_payment_method: ['"]credit_card['"]/);
});
