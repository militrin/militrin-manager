import assert from 'node:assert/strict';
import { readFile as readFileRaw } from 'node:fs/promises';
import test from 'node:test';

async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, '\n');
}

// UX do pagamento PIX + simulacao segura no provider fake. Estes testes sao
// estaticos (leem o texto-fonte) -- a prova de comportamento em runtime
// (RPC recusando provider nao-fake, simulacao confirmando pagamento sem
// duplicar ticket) esta em tests/simulate-fake-gateway-payment.integration.mjs.

const pixCard = await readFile(new URL('../src/app/inscricao/[eventSlug]/pix-payment-card.tsx', import.meta.url), 'utf8');
const wizard = await readFile(new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/app/inscricao/[eventSlug]/page.tsx', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/inscricao/actions.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260902000000_simulate_fake_gateway_payment_paid.sql', import.meta.url), 'utf8');

test('o botao "Simular pagamento aprovado" so e renderizado quando isFakePaymentProvider e verdadeiro', () => {
  assert.match(pixCard, /Simular pagamento aprovado/);
  // O bloco inteiro do botao (incluindo o handler) fica atras de um `isFakePaymentProvider ?` --
  // garante que nao ha nenhum outro caminho (ex.: NODE_ENV) controlando a visibilidade.
  const simulateBlockStart = pixCard.indexOf('isFakePaymentProvider ?');
  const simulateButtonIndex = pixCard.indexOf('Simular pagamento aprovado');
  assert.ok(simulateBlockStart !== -1 && simulateBlockStart < simulateButtonIndex, 'o botao de simulacao deve estar dentro do bloco condicional isFakePaymentProvider');
});

test('nenhum gate por NODE_ENV sobrou no fluxo de pagamento (substituido pelo provider efetivo)', () => {
  assert.doesNotMatch(pixCard, /NODE_ENV/);
  assert.doesNotMatch(wizard, /canSimulatePayment/);
  assert.doesNotMatch(wizard, /NODE_ENV === 'development'/);
  assert.doesNotMatch(actions, /simulatePublicOrderPaymentAction/);
});

test('page.tsx (Server Component) calcula isFakePaymentProvider a partir do provider efetivo do servidor, nunca de uma env publica', () => {
  assert.match(page, /getPaymentGatewayProviderName\(\)\s*===\s*'fake'/);
  assert.doesNotMatch(page, /NEXT_PUBLIC.*PAYMENT_PROVIDER|NEXT_PUBLIC.*PROVIDER/i);
  assert.match(page, /isFakePaymentProvider=\{getPaymentGatewayProviderName\(\) === 'fake'\}/);
});

test('wizard.tsx repassa isFakePaymentProvider para PixPaymentCard (etapa 3 e etapa 4), sem reinventar a checagem', () => {
  const pixCards = wizard.match(/<PixPaymentCard/g) ?? [];
  assert.equal(pixCards.length, 2, 'esperava PixPaymentCard usado 2x (etapa 3 e etapa 4)');
  assert.match(wizard, /isFakePaymentProvider=\{isFakePaymentProvider\}/);
});

test('a tela nao usa mais textarea gigante como area principal do codigo PIX (bloco compacto com botao copiar)', () => {
  assert.doesNotMatch(wizard, /<textarea[^>]*pix_code/);
  assert.match(pixCard, /Copiar/);
  assert.match(pixCard, /navigator\.clipboard\.writeText/);
});

test('a Server Action de simulacao valida o provider efetivo no backend antes de qualquer round-trip (defesa em profundidade -- nao so a RPC)', () => {
  assert.match(actions, /export async function simulateFakeOrderPaymentAction/);
  const fnBody = actions.slice(actions.indexOf('export async function simulateFakeOrderPaymentAction'), actions.indexOf('export async function simulateFakeOrderPaymentAction') + 800);
  assert.match(fnBody, /getPaymentGatewayProviderName\(\)\s*!==\s*'fake'/);
});

test('a Server Action de simulacao reusa a RPC canonica (nao existe caminho paralelo de emissao de ticket)', () => {
  const fnBody = actions.slice(actions.indexOf('export async function simulateFakeOrderPaymentAction'), actions.indexOf('export async function simulateFakeOrderPaymentAction') + 800);
  assert.match(fnBody, /supabase\.rpc\('simulate_fake_gateway_payment_paid'/);
  assert.doesNotMatch(fnBody, /insert into.*tickets|confirm_order_item_and_issue_ticket/i);
});

test('a RPC simulate_fake_gateway_payment_paid valida o provider persistido no PAGAMENTO (nao confia em NODE_ENV nem em parametro do cliente) e reusa apply_gateway_payment_status', () => {
  const executableSql = migration.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.match(executableSql, /create or replace function public\.simulate_fake_gateway_payment_paid/);
  assert.match(executableSql, /v_payment\.provider is distinct from 'fake'/);
  assert.match(executableSql, /SIMULATION_NOT_ALLOWED/);
  assert.match(executableSql, /public\.apply_gateway_payment_status\(\s*\n?\s*'fake', v_payment\.gateway_payment_id/);
  assert.doesNotMatch(executableSql, /NODE_ENV/);
  assert.doesNotMatch(executableSql, /insert into public\.tickets/i);
});

test('a RPC de simulacao so e concedida para authenticated/service_role -- nunca anon', () => {
  assert.match(migration, /revoke all on function public\.simulate_fake_gateway_payment_paid\(uuid\) from public, anon;/);
  assert.match(migration, /grant execute on function public\.simulate_fake_gateway_payment_paid\(uuid\) to authenticated, service_role;/);
});

test('nenhuma migration ja aplicada (95-901) foi alterada -- a correcao vive isolada na migration 902', async () => {
  const priorMigrations = [
    '20260895000000_payment_gateway_provider_columns.sql',
    '20260896000000_payment_gateway_events.sql',
    '20260897000000_harden_ticket_reactivation_guard.sql',
    '20260898000000_order_payment_expiration_and_gateway_status.sql',
    '20260899000000_admin_role_permissions_system_default_rls.sql',
    '20260900000000_fix_ticket_holder_uniqueness_upsert_self_conflict.sql',
    '20260901000000_order_payer_details_for_gateway_checkout.sql',
  ];
  for (const name of priorMigrations) {
    const content = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(content, /simulate_fake_gateway_payment_paid/, `${name} nao deveria referenciar a funcao nova`);
  }
});
