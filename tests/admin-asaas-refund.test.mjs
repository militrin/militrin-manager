import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_REFUND_BLOCK_MESSAGES,
  evaluateAdminRefundEligibility,
  validateAdminRefundReason,
} from '../src/lib/payments/admin-refund-eligibility.ts';
import { executeAdminPaymentRefund } from '../src/lib/payments/admin-refund.ts';
import { classifyAdminRefundTicket, defaultCancelTicketsChecked } from '../src/lib/payments/admin-refund-tickets.ts';
import { GatewayTimeoutError } from '../src/lib/payments/gateway-timeout.ts';
import { isAsaasAlreadyRefundedError } from '../src/lib/payments/asaas-provider.ts';
import {
  shouldIncludeInConfirmedRevenue,
  shouldIncludeInRefundedRevenue,
} from '../src/lib/finance/confirmed-revenue.ts';

const eligiblePayment = {
  id: 'pay_internal_1',
  organization_id: 'org_1',
  order_id: 'order_1',
  provider: 'asaas',
  payment_status: 'paid',
  payment_method: 'pix',
  price_origin: 'catalog',
  gateway_payment_id: 'pay_asaas_abc',
  gateway_account_key: 'asaas-conta-live-01',
  gateway_environment: 'production',
  final_amount: 200,
  refund_status: null,
};

function eligibility(overrides = {}) {
  return evaluateAdminRefundEligibility({ ...eligiblePayment, ...overrides }, { accountKeyConfigured: true });
}

test('admin elegivel: asaas paid com gateway, conta e ambiente', () => {
  const result = eligibility();
  assert.equal(result.eligible, true);
  assert.match(result.needsConfirmPhrase ?? '', /Confirmo o estorno de R\$\s*200,00/);
});

test('nao autorizado nao e testado na eligibility — so no orchestrator', () => {
  assert.equal(eligibility().eligible, true);
});

test('pending bloqueado', () => {
  const result = eligibility({ payment_status: 'pending' });
  assert.equal(result.eligible, false);
  assert.equal(result.blockCode, 'pending');
});

test('refunded bloqueado', () => {
  const result = eligibility({ payment_status: 'refunded' });
  assert.equal(result.eligible, false);
  assert.equal(result.blockCode, 'already_refunded');
});

test('fake bloqueado', () => {
  const result = eligibility({ provider: 'fake', gateway_payment_id: 'fake_1' });
  assert.equal(result.eligible, false);
  assert.equal(result.blockCode, 'fake');
});

test('legacy_unknown bloqueado', () => {
  const result = eligibility({ price_origin: 'legacy_unknown' });
  assert.equal(result.eligible, false);
  assert.equal(result.blockCode, 'legacy_unknown');
});

test('cortesia bloqueada', () => {
  const result = eligibility({ payment_method: 'courtesy' });
  assert.equal(result.eligible, false);
  assert.equal(result.blockCode, 'courtesy');
});

test('sem gateway bloqueado', () => {
  const result = eligibility({ gateway_payment_id: null });
  assert.equal(result.eligible, false);
  assert.equal(result.blockCode, 'missing_gateway_id');
});

test('account_key ausente ou nao configurada bloqueia', () => {
  assert.equal(eligibility({ gateway_account_key: null }).blockCode, 'unknown_account_key');
  assert.equal(evaluateAdminRefundEligibility(eligiblePayment, { accountKeyConfigured: false }).blockCode, 'unknown_account_key');
});

test('environment desconhecido bloqueia', () => {
  const result = eligibility({ gateway_account_key: 'conta-desconhecida', gateway_environment: null });
  assert.equal(result.eligible, false);
  assert.equal(result.blockCode, 'unknown_environment');
});

test('motivo Outro exige texto', () => {
  assert.equal(validateAdminRefundReason('other', ''), 'Descreva o motivo do estorno.');
  assert.equal(validateAdminRefundReason('customer_request', ''), null);
});

test('ticket usado / check-in / kit entregue nao sao cancelaveis; kit nao entregue e ja cancelado sao tratados', () => {
  const used = classifyAdminRefundTicket({ id: 't1', status: 'used', usedAt: '2026-01-01' });
  const checkin = classifyAdminRefundTicket({ id: 't2', status: 'active', usedAt: '2026-01-01' });
  const kit = classifyAdminRefundTicket({ id: 't3', status: 'active', kitStatuses: ['delivered'] });
  const undelivered = classifyAdminRefundTicket({ id: 't4', status: 'active', kitStatuses: ['pending'] });
  const already = classifyAdminRefundTicket({ id: 't5', status: 'cancelled' });
  assert.equal(used.blocker, 'used');
  assert.equal(used.cancellable, false);
  assert.equal(checkin.blocker, 'checkin');
  assert.equal(kit.blocker, 'kit_delivered');
  assert.equal(undelivered.cancellable, true);
  assert.equal(already.cancellable, false);
  assert.equal(defaultCancelTicketsChecked([used, kit]), false);
  assert.equal(defaultCancelTicketsChecked([undelivered]), true);
});

test('LIVE paid entra em Confirmada; LIVE refunded sai e entra em Estornada', () => {
  assert.equal(shouldIncludeInConfirmedRevenue(eligiblePayment), true);
  assert.equal(shouldIncludeInRefundedRevenue({ ...eligiblePayment, payment_status: 'refunded' }), true);
  assert.equal(shouldIncludeInConfirmedRevenue({ ...eligiblePayment, payment_status: 'refunded' }), false);
});

function mockDeps(options = {}) {
  const calls = {
    refund: [],
    get: [],
    begin: 0,
    apply: [],
    mark: [],
    notifyFailure: 0,
    fetch: 0,
  };
  const gateway = {
    refundPayment: async (input) => {
      calls.refund.push(input);
      if (options.refundError) throw options.refundError;
    },
    getPayment: async (input) => {
      calls.get.push(input);
      if (options.getError) throw options.getError;
      return options.snapshot ?? {
        providerPaymentId: input.providerPaymentId,
        status: 'refunded',
        providerStatus: 'REFUNDED',
        paidAt: null,
        feeAmount: null,
        netAmount: null,
      };
    },
  };
  return {
    calls,
    deps: {
      assertAuthorized: options.assertAuthorized ?? (async () => {}),
      accountKeyConfigured: () => options.accountConfigured ?? true,
      loadPayment: async () => options.payment ?? eligiblePayment,
      beginAttempt: async () => {
        calls.begin += 1;
        return options.begin ?? {
          success: true,
          already_open: false,
          attempt_id: 'attempt_1',
          gateway_payment_id: 'pay_asaas_abc',
          account_key: 'asaas-conta-live-01',
          organization_id: 'org_1',
          attempt_status: 'requested',
        };
      },
      markAttempt: async (id, status) => { calls.mark.push({ id, status }); },
      applyGatewayStatus: async (input) => { calls.apply.push(input); },
      notifyFailure: async () => { calls.notifyFailure += 1; },
      getGateway: () => gateway,
    },
  };
}

const confirm = evaluateAdminRefundEligibility(eligiblePayment, { accountKeyConfigured: true }).needsConfirmPhrase ?? '';
const baseInput = {
  paymentId: 'pay_internal_1',
  reasonCode: 'customer_request',
  cancelTickets: false,
  confirmPhrase: confirm,
};

test('admin autorizado chama o client Asaas com o payment correto e sucesso aplica refunded', async () => {
  const { deps, calls } = mockDeps();
  const result = await executeAdminPaymentRefund(baseInput, deps);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.externalHttp, false);
  assert.equal(calls.refund.length, 1);
  assert.equal(calls.refund[0].providerPaymentId, 'pay_asaas_abc');
  assert.equal(calls.refund[0].amount, undefined);
  assert.equal(calls.apply[0].expectedAccountKey, 'asaas-conta-live-01');
  assert.equal(calls.apply[0].eventType, 'PAYMENT_REFUNDED');
  assert.equal(calls.fetch, 0);
});

test('nao autorizado nao chama gateway', async () => {
  const denied = new Error('denied');
  denied.name = 'PermissionDeniedError';
  const { deps, calls } = mockDeps({
    assertAuthorized: async () => { throw denied; },
  });
  const result = await executeAdminPaymentRefund(baseInput, deps);
  assert.equal(result.status, 'forbidden');
  assert.equal(calls.refund.length, 0);
  assert.equal(calls.get.length, 0);
  assert.equal(calls.begin, 0);
});

test('erro de refund marca falha e notifica', async () => {
  const { deps, calls } = mockDeps({ refundError: new Error('Asaas API error (/payments/x/refund): boom') });
  const result = await executeAdminPaymentRefund(baseInput, deps);
  assert.equal(result.status, 'failed');
  assert.equal(calls.notifyFailure, 1);
  assert.equal(calls.mark.some((row) => row.status === 'failed'), true);
});

test('timeout nao assume falha definitiva', async () => {
  const { deps, calls } = mockDeps({ refundError: new GatewayTimeoutError() });
  const result = await executeAdminPaymentRefund(baseInput, deps);
  assert.equal(result.status, 'uncertain');
  assert.equal(calls.notifyFailure, 0);
  assert.equal(calls.mark.some((row) => row.status === 'uncertain'), true);
});

test('retry/duplo clique com tentativa pending nao dispara segundo refund', async () => {
  const { deps, calls } = mockDeps({
    payment: { ...eligiblePayment, refund_status: 'pending' },
    begin: {
      success: true,
      already_open: true,
      attempt_id: 'attempt_1',
      attempt_status: 'pending',
      gateway_payment_id: 'pay_asaas_abc',
      account_key: 'asaas-conta-live-01',
      organization_id: 'org_1',
    },
    snapshot: {
      providerPaymentId: 'pay_asaas_abc',
      status: 'paid',
      providerStatus: 'RECEIVED',
      paidAt: null,
      feeAmount: null,
      netAmount: null,
    },
  });
  const result = await executeAdminPaymentRefund({ ...baseInput, mode: 'reconcile' }, deps);
  assert.equal(result.status, 'pending');
  assert.equal(calls.refund.length, 0);
  assert.equal(calls.get.length, 1);
});

test('conciliacao encontra refunded sem chamar refund de novo', async () => {
  const { deps, calls } = mockDeps({
    payment: { ...eligiblePayment, refund_status: 'uncertain' },
    begin: {
      success: true,
      already_open: true,
      attempt_id: 'attempt_1',
      attempt_status: 'uncertain',
      gateway_payment_id: 'pay_asaas_abc',
      account_key: 'asaas-conta-live-01',
      organization_id: 'org_1',
    },
  });
  const result = await executeAdminPaymentRefund({ ...baseInput, mode: 'reconcile' }, deps);
  assert.equal(result.status, 'completed');
  assert.equal(calls.refund.length, 0);
  assert.equal(calls.apply.length, 1);
});

test('confirmacao forte incorreta bloqueia', async () => {
  const { deps, calls } = mockDeps();
  const result = await executeAdminPaymentRefund({ ...baseInput, confirmPhrase: 'ok' }, deps);
  assert.equal(result.status, 'blocked');
  assert.equal(calls.refund.length, 0);
});

test('ja refunded no Asaas e tratado como sucesso idempotente no client', () => {
  assert.equal(isAsaasAlreadyRefundedError(new Error('Asaas API error: already refunded')), true);
  assert.equal(ADMIN_REFUND_BLOCK_MESSAGES.fake.length > 0, true);
});
