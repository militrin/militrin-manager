import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const integrityPage = await readFile(new URL('../src/app/painel/integridade/page.tsx', import.meta.url), 'utf8');
const integrityActions = await readFile(new URL('../src/app/painel/integridade/actions.ts', import.meta.url), 'utf8');
const panel = await readFile(new URL('../src/app/painel/integridade/paid-orders-awaiting-issue.tsx', import.meta.url), 'utf8');
const wizard = await readFile(new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url), 'utf8');
const pixCard = await readFile(new URL('../src/app/inscricao/[eventSlug]/pix-payment-card.tsx', import.meta.url), 'utf8');
const minhaConta = await readFile(new URL('../src/app/minha-conta/compras/[orderId]/page.tsx', import.meta.url), 'utf8');
const watcher = await readFile(new URL('../src/app/minha-conta/compras/[orderId]/pending-pix-payment-watcher.tsx', import.meta.url), 'utf8');
const webhook = await readFile(new URL('../src/app/api/webhooks/asaas/route.ts', import.meta.url), 'utf8');
const menu = await readFile(new URL('../src/lib/navigation/admin-menu.ts', import.meta.url), 'utf8');
const confirmAction = await readFile(new URL('../src/app/inscricoes/actions.ts', import.meta.url), 'utf8');

test('admin encontra a fila de pagamento pago sem ingresso na Integridade', () => {
  assert.match(integrityPage, /PaidOrdersAwaitingIssuePanel/);
  assert.match(panel, /Pagamentos confirmados aguardando emissão/);
  assert.match(panel, /Emitir ingressos/);
  assert.match(integrityActions, /admin_issue_tickets_for_paid_order/);
  assert.match(integrityActions, /requirePermission\('finance.confirm_payment'\)/);
});

test('menu Integridade e descobrivel para quem confirma pagamento', () => {
  assert.match(menu, /finance\.confirm_payment/);
});

test('comprador encontra PIX, continua pagamento e percebe confirmacao sem URL oculta', () => {
  assert.match(wizard, /PixPaymentCard/);
  assert.match(pixCard, /Gerar pagamento PIX|Gerar novo pagamento/);
  assert.match(pixCard, /Copiar/);
  assert.match(minhaConta, /Continuar pagamento/);
  assert.match(minhaConta, /PendingPixPaymentWatcher/);
  assert.match(watcher, /getPublicOrderPaymentStatusAction/);
  assert.match(watcher, /4000/);
  assert.match(wizard, /getPublicOrderPaymentStatusAction/);
});

test('webhook nao persiste payload cru do Asaas', () => {
  assert.match(webhook, /sanitizePaymentGatewayEventPayload/);
  assert.doesNotMatch(webhook, /p_payload: event\.rawPayload/);
});

test('claim recusado de evento ainda processing devolve 503 para o Asaas retentar', () => {
  assert.match(webhook, /status: 503/);
  assert.match(webhook, /Evento em processamento/);
  assert.match(webhook, /processed.*ignored|ignored.*processed/);
});

test('confirmacao administrativa de Central nao depende so de payments.participant_id', () => {
  const fn = confirmAction.slice(confirmAction.indexOf('export async function confirmParticipantPaymentAction'));
  assert.match(fn, /\.eq\("order_id", orderId\)/);
  assert.match(fn, /Administração → Integridade/);
});
