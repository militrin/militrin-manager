import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  DEFAULT_MAX_CARD_INSTALLMENTS,
  GATEWAY_MAX_CARD_INSTALLMENTS,
  cardInstallmentChoices,
  clampUiCardInstallments,
  eventOffersCardInstallments,
  filterInstallmentOptions,
  normalizeMaxCardInstallments,
  rejectCardInstallmentsIfOverLimit,
} from '../src/lib/payments/card-installments.ts';
import { AsaasPaymentProvider } from '../src/lib/payments/asaas-provider.ts';

const migrationsDirUrl = new URL('../supabase/migrations/', import.meta.url);
const migrationUrl = new URL('../supabase/migrations/20261022000000_event_max_card_installments.sql', import.meta.url);
const helperUrl = new URL('../src/lib/payments/card-installments.ts', import.meta.url);
const wizardUrl = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const inscricaoPageUrl = new URL('../src/app/inscricao/[eventSlug]/page.tsx', import.meta.url);
const inscricaoActionsUrl = new URL('../src/app/inscricao/actions.ts', import.meta.url);
const eventosActionsUrl = new URL('../src/app/eventos/actions.ts', import.meta.url);
const adminManagerUrl = new URL('../src/app/painel/eventos/[id]/payment-methods-manager.tsx', import.meta.url);
const adminPageUrl = new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url);
const asaasUrl = new URL('../src/lib/payments/asaas-provider.ts', import.meta.url);
const storeActionsUrl = new URL('../src/lib/store/actions.ts', import.meta.url);
const minhaContaOrderUrl = new URL('../src/app/minha-conta/compras/[orderId]/page.tsx', import.meta.url);
const continueCardUrl = new URL('../src/app/minha-conta/compras/[orderId]/continue-card-payment-button.tsx', import.meta.url);
const paymentReturnUrl = new URL('../src/app/pagamento/retorno/payment-return-client.tsx', import.meta.url);

async function resolveCurrentFunctionDefinition(functionName) {
  const files = (await fs.readdir(migrationsDirUrl)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const pattern = new RegExp(`create (?:or replace )?function public\\.${functionName}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  let source = null;
  let definedInFile = null;
  for (const file of files) {
    const sql = await fs.readFile(new URL(file, migrationsDirUrl), 'utf8');
    const match = sql.match(pattern);
    if (match) {
      source = match[0];
      definedInFile = file;
    }
  }
  if (!source) throw new Error(`funcao ${functionName} nunca foi definida em nenhuma migration`);
  return { source, definedInFile };
}

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

test('helper: default e teto do gateway sao 12, equivalente ao checkout atual', () => {
  assert.equal(DEFAULT_MAX_CARD_INSTALLMENTS, 12);
  assert.equal(GATEWAY_MAX_CARD_INSTALLMENTS, 12);
  assert.equal(normalizeMaxCardInstallments(undefined), 12);
  assert.equal(normalizeMaxCardInstallments(0), 1);
  assert.equal(normalizeMaxCardInstallments(99), 12);
});

test('evento com max 4x mostra 1-4 e rejeita 5x', () => {
  assert.deepEqual(cardInstallmentChoices(4), [1, 2, 3, 4]);
  assert.deepEqual(
    filterInstallmentOptions(
      [2, 3, 4, 5, 6].map((installments) => ({ installments })),
      4,
    ).map((row) => row.installments),
    [2, 3, 4],
  );
  assert.equal(rejectCardInstallmentsIfOverLimit(4, 4), null);
  assert.equal(rejectCardInstallmentsIfOverLimit(5, 4), 'Este evento permite pagamento em até 4x.');
  assert.equal(clampUiCardInstallments(12, 4), 4);
  assert.equal(eventOffersCardInstallments(true, 4), true);
});

test('evento com max 6x aceita 6 e ainda rejeita 7x', () => {
  assert.equal(rejectCardInstallmentsIfOverLimit(6, 6), null);
  assert.equal(rejectCardInstallmentsIfOverLimit(7, 6), 'Este evento permite pagamento em até 6x.');
  assert.deepEqual(
    filterInstallmentOptions(
      [2, 3, 4, 5, 6, 7, 8].map((installments) => ({ installments })),
      6,
    ).map((row) => row.installments),
    [2, 3, 4, 5, 6],
  );
});

test('evento com max 1x so aceita a vista', () => {
  assert.equal(rejectCardInstallmentsIfOverLimit(1, 1), null);
  assert.equal(rejectCardInstallmentsIfOverLimit(2, 1), 'Este evento permite pagamento em até 1x.');
  assert.equal(eventOffersCardInstallments(true, 1), false);
  assert.deepEqual(filterInstallmentOptions([{ installments: 2 }, { installments: 3 }], 1), []);
});

test('backend rejeita payload adulterado: nunca reduz silenciosamente', () => {
  assert.equal(rejectCardInstallmentsIfOverLimit(12, 4), 'Este evento permite pagamento em até 4x.');
  assert.equal(rejectCardInstallmentsIfOverLimit('12', 4), 'Este evento permite pagamento em até 4x.');
  assert.notEqual(rejectCardInstallmentsIfOverLimit(12, 4), null);
});

test('migration: coluna em events, default 12, check 1..12, idempotente', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  assert.match(sql, /add column if not exists max_card_installments integer not null default 12/);
  assert.match(sql, /drop constraint if exists events_max_card_installments_check/);
  assert.match(sql, /check \(max_card_installments >= 1 and max_card_installments <= 12\)/);
  assert.doesNotMatch(sql, /update public\.events set max_card_installments = \d+/);
});

test('SQL vigente rejeita acima do limite com a mensagem canonica e nao reduz', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('assert_card_installments_allowed');
  assert.equal(definedInFile, '20261022000000_event_max_card_installments.sql');
  assert.match(source, /if v_requested > v_allowed then/);
  assert.match(source, /Este evento permite pagamento em até %x\./);
  assert.doesNotMatch(source, /least\(v_requested,\s*v_allowed\)/);
});

test('finalize_cart_order_payment vigente chama assert_card_installments_allowed antes de gravar cartao', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('finalize_cart_order_payment');
  assert.equal(definedInFile, '20261022000000_event_max_card_installments.sql');
  const assertIdx = source.indexOf('public.assert_card_installments_allowed');
  const updateIdx = source.indexOf('update public.payments set');
  assert.ok(assertIdx !== -1 && updateIdx !== -1 && assertIdx < updateIdx);
});

test('preview vigente so itera 2..v_max do evento; max=1 nao oferece parcelado', async () => {
  const { source } = await resolveCurrentFunctionDefinition('preview_event_payment_fees');
  assert.match(source, /if v_max >= 2 then/);
  assert.match(source, /for v_n in 2\.\.v_max loop/);
  assert.doesNotMatch(source, /for v_n in 2\.\.12 loop/);
});

test('get_event_payment_methods_setup devolve max_card_installments do evento', async () => {
  const { source } = await resolveCurrentFunctionDefinition('get_event_payment_methods_setup');
  assert.match(source, /max_card_installments integer/);
  assert.match(source, /coalesce\(e\.max_card_installments, 12\)/);
});

test('upsert_event_payment_methods persiste p_max_card_installments em events', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  assert.match(sql, /drop function if exists public\.upsert_event_payment_methods\(uuid, boolean, boolean, boolean, text, numeric, numeric, numeric, text, numeric, numeric, numeric, text, numeric, jsonb\);/);
  const fn = extractFunction(sql, 'upsert_event_payment_methods');
  assert.match(fn, /p_max_card_installments integer default 12/);
  assert.match(fn, /update public\.events\s+set max_card_installments = v_max/);
  assert.match(fn, /O maximo de parcelas no cartao deve ser entre 1x e 12x/);
});

test('admin: controle visivel Maximo de parcelas no cartao, select 1x-12x, texto auxiliar e persistencia', async () => {
  const manager = await fs.readFile(adminManagerUrl, 'utf8');
  const page = await fs.readFile(adminPageUrl, 'utf8');
  const actions = await fs.readFile(eventosActionsUrl, 'utf8');
  assert.match(manager, /Máximo de parcelas no cartão/);
  assert.match(manager, /Define o número máximo de parcelas disponíveis no pagamento por cartão deste evento\./);
  assert.match(manager, /cardInstallmentChoices\(MAX_INSTALLMENTS\)/);
  assert.match(manager, /p_max_card_installments|max_card_installments:/);
  assert.match(manager, /type: "success"/);
  assert.match(page, /max_card_installments: Number\(paymentMethodsRow\?\.max_card_installments \?\? 12\)/);
  assert.match(actions, /max_card_installments: z\.number\(\)\.int\(\)\.min\(1/);
  assert.match(actions, /p_max_card_installments: parsed\.data\.max_card_installments/);
});

test('checkout publico: EventData carrega o limite e a UI filtra opcoes pelo evento', async () => {
  const page = await fs.readFile(inscricaoPageUrl, 'utf8');
  const wizard = await fs.readFile(wizardUrl, 'utf8');
  assert.match(page, /max_card_installments: Number\(paymentMethodsRow\?\.max_card_installments \?\? 12\)/);
  assert.match(page, /max_card_installments: paymentMethods\.max_card_installments/);
  assert.match(wizard, /filterInstallmentOptions/);
  assert.match(wizard, /eventAllowsCardInstallments\(event\)/);
  assert.match(wizard, /installmentPreviewOptions\(feePreview, event\)/);
  assert.match(wizard, /clampUiCardInstallments\(parsed\.form\.installments, event\.max_card_installments\)/);
});

test('finalizeCartOrderAction rejeita payload adulterado antes da RPC', async () => {
  const source = await fs.readFile(inscricaoActionsUrl, 'utf8');
  const fnMatch = source.match(/export async function finalizeCartOrderAction[\s\S]*?\n}/);
  assert.ok(fnMatch, 'finalizeCartOrderAction nao encontrada');
  assert.match(fnMatch[0], /rejectCardInstallmentsIfOverLimit\(resolvedInstallments, paymentConfig\.config\.max_card_installments\)/);
  assert.match(fnMatch[0], /return \{ success: false as const, message: overLimit \}/);
  assert.doesNotMatch(fnMatch[0], /Math\.min\(.*max_card_installments/);
});

test('retomada de cartao: cobranca reutilizavel/paga nao e alterada; nova cobranca respeita o limite atual', async () => {
  const source = await fs.readFile(inscricaoActionsUrl, 'utf8');
  const fnMatch = source.match(/export async function generatePublicOrderCardAction[\s\S]*?(?=\nexport async function )/);
  assert.ok(fnMatch);
  const fn = fnMatch[0];
  const paidIdx = fn.indexOf("payment.payment_status === 'paid'");
  const reuseIdx = fn.indexOf('isReusableLiveGatewayCharge(payment)');
  const rejectIdx = fn.indexOf('rejectCardInstallmentsIfOverLimit(installments, paymentConfig.config.max_card_installments)');
  const createIdx = fn.indexOf('gateway.createCardPayment');
  assert.ok(paidIdx !== -1 && reuseIdx !== -1 && rejectIdx !== -1 && createIdx !== -1);
  assert.ok(paidIdx < rejectIdx, 'pedido pago retorna antes de validar/recriar cobranca');
  assert.ok(reuseIdx < rejectIdx, 'cobranca antiga reutilizavel retorna antes de validar/recriar');
  assert.ok(rejectIdx < createIdx, 'nova cobranca so e criada depois de rejeitar acima do limite');
  assert.doesNotMatch(fn, /update\(['"]payments['"]\)/);
});

test('Asaas recebe installmentCount exato; 1x nao envia o campo; 4x e 6x enviam o limite escolhido', async () => {
  const asaas = await fs.readFile(asaasUrl, 'utf8');
  assert.match(asaas, /body\.installmentCount = installments;/);
  assert.match(asaas, /nao Payment Link \/ maxInstallmentCount/);
  assert.doesNotMatch(asaas, /body\.maxInstallmentCount/);

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status });
  }

  async function postBodyFor(installments) {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ href, method: init?.method ?? 'GET', body });
      if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
      if (href.includes('/payments?externalReference=')) return json({ data: [] });
      if (href.endsWith('/payments') && (init?.method ?? 'GET') === 'POST') {
        return json({
          id: `pay_${installments}`,
          status: 'PENDING',
          value: 120,
          billingType: 'CREDIT_CARD',
          invoiceUrl: `https://sandbox.asaas.com/i/pay_${installments}`,
          installment: installments >= 2 ? `inst_${installments}` : null,
        });
      }
      if (href.includes('/installments/')) {
        const data = Array.from({ length: installments }, (_, index) => ({
          id: `pay_${installments}_${index + 1}`,
          status: 'PENDING',
          value: 120 / installments,
          installmentNumber: index + 1,
        }));
        return json({ data });
      }
      throw new Error(`fetch inesperado: ${href}`);
    };
    try {
      const provider = new AsaasPaymentProvider({
        apiKey: 'test-key',
        webhookToken: 'wh',
        environment: 'sandbox',
        accountKey: 'conta-card',
      });
      await provider.createCardPayment({
        organizationId: 'org',
        orderId: `order-${installments}x`,
        paymentId: 'pay-local',
        amount: 120,
        dueDate: '2026-09-04',
        installments,
        successUrl: `http://localhost:3000/pagamento/retorno?pedido=order-${installments}x`,
        payer: { name: 'Ana', email: 'ana@example.com', cpfCnpj: '52998224725' },
      });
      const create = requests.find((request) => request.href.endsWith('/payments') && request.method === 'POST');
      return create.body;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const one = await postBodyFor(1);
  assert.equal(one.installmentCount, undefined);
  const four = await postBodyFor(4);
  assert.equal(four.installmentCount, 4);
  const six = await postBodyFor(6);
  assert.equal(six.installmentCount, 6);
});

test('Minha Conta e retorno de pagamento reusam generatePublicOrderCardAction (mesmo gate de limite)', async () => {
  const page = await fs.readFile(minhaContaOrderUrl, 'utf8');
  const button = await fs.readFile(continueCardUrl, 'utf8');
  const paymentReturn = await fs.readFile(paymentReturnUrl, 'utf8');
  assert.match(page, /ContinueCardPaymentButton/);
  assert.match(page, /generatePublicOrderCardAction/);
  assert.match(button, /generatePublicOrderCardAction\(orderId\)/);
  assert.doesNotMatch(button, /createCardPayment/);
  assert.doesNotMatch(button, /max_card_installments/);
  assert.match(paymentReturn, /generatePublicOrderCardAction/);
});

test('Loja permanece fora do limite por evento: continua 1x hardcoded', async () => {
  const source = await fs.readFile(storeActionsUrl, 'utf8');
  assert.match(source, /installments:\s*1/);
  assert.doesNotMatch(source, /max_card_installments/);
});

test('helper canonico e a unica regra de mensagem no app layer', async () => {
  const helper = await fs.readFile(helperUrl, 'utf8');
  const actions = await fs.readFile(inscricaoActionsUrl, 'utf8');
  assert.match(helper, /Este evento permite pagamento em até \$\{normalizeMaxCardInstallments\(allowed\)\}x\./);
  assert.match(actions, /rejectCardInstallmentsIfOverLimit/);
});
