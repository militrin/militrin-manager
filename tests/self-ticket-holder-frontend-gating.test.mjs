import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wizardPath = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const actionsPath = new URL('../src/app/inscricao/actions.ts', import.meta.url);
const migrationPath = new URL('../supabase/migrations/20260815006400_atomic_self_ticket_holder_uniqueness.sql', import.meta.url);

test('wizard consulta o status canonico de titularidade do comprador assim que o evento carrega', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /getPublicBuyerTicketHolderStatusAction\(event\.id\)/);
  assert.match(source, /const \[buyerAlreadyHoldsActiveTicket, setBuyerAlreadyHoldsActiveTicket\] = useState<boolean \| null>\(null\)/);
});

test('usuario sem ingresso ativo: "Este ingresso e para mim" fica disponivel (nao bloqueado por padrao apos a checagem)', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /const selfOwnershipBlocked = buyerAlreadyHoldsActiveTicket !== false;/);
});

test('usuario ja titular: opcao "self" fica desabilitada, nunca auto-selecionada, com a mensagem exigida', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /disabled=\{selfOptionDisabled\}/);
  assert.match(source, /Você já possui um ingresso neste evento\./);
  assert.match(source, /computeSyncedItems\(targetQuantity, source, normalizePricingGenderInput\(form\.gender\), buyerAlreadyHoldsActiveTicket === false\)/);
});

test('dentro do mesmo checkout, selecionar "self" em um item desabilita a opcao nos demais imediatamente', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /const anotherItemIsSelf = activeCheckoutItems\.some\(\(other, otherIndex\) => otherIndex !== index && other\.ownershipMode === 'self'\);/);
  assert.match(source, /const selfOptionDisabled = item\.ownershipMode !== 'self' && \(selfOwnershipBlocked \|\| anotherItemIsSelf\);/);
});

test('"Definir depois" e "Informar titular agora" continuam disponiveis mesmo quando "self" esta bloqueado', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /Definir depois/);
  assert.match(source, /Informar titular agora/);
});

test('migration BUG 1 reusa a checagem canonica atomica ja usada pelos fluxos administrativos, nao uma comparacao por nome/email/telefone', async () => {
  const source = await readFile(migrationPath, 'utf8');
  // p_ticket_id NUNCA pode ser null aqui: reproduzido ao vivo (npx supabase db
  // reset + chamada direta da RPC) que, para pagamento courtesy/gratuito (ticket
  // ja emitido por confirm_order_item_and_issue_ticket antes deste ponto), o
  // trigger BEFORE INSERT trg_sync_participant_registration_contact ja grava
  // participants.registration_contact_id = v_contact.id no momento em que o
  // participante-ancora e criado, dentro de create_multi_ticket_order_checkout_legacy
  // -- bem antes desta chamada. Sem excluir o ticket deste PROPRIO item
  // (select id into v_ticket_id from tickets where order_item_id=v_item.id),
  // registration_contact_has_active_ticket encontra esse ticket como se fosse
  // "outro" ingresso do mesmo titular e rejeita com HOLDER_ALREADY_HAS_TICKET_FOR_EVENT
  // ja na primeira compra self de qualquer pessoa.
  assert.match(source, /select id into v_ticket_id from public\.tickets where order_item_id=v_item\.id;/);
  assert.match(source, /perform public\.assert_ticket_holder_contact_available\(v_ticket_id,v_order\.event_id,v_contact\.id\);/);
  assert.match(source, /pg_advisory_xact_lock\(hashtextextended\(v_order\.organization_id::text\|\|':cpf:'\|\|v_cpf,0\)\)/);
  assert.doesNotMatch(source, /where[^;]*full_name\s*=/is);
  assert.doesNotMatch(source, /where[^;]*email\s*=/is);
});

test('migration BUG 1 resolve/cria o registration_contacts do comprador por (organization_id, cpf), ancorando order_items e participants', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /where organization_id=v_order\.organization_id and cpf=v_cpf for update;/);
  assert.match(source, /update public\.order_items set registration_contact_id=v_contact\.id/);
  assert.match(source, /update public\.participants set registration_contact_id=v_contact\.id/);
});

test('get_public_buyer_ticket_holder_status e exposta apenas para authenticated e resolve por cpf, nunca por nome/email', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /grant execute on function public\.get_public_buyer_ticket_holder_status\(uuid\) to authenticated;/);
  assert.match(source, /revoke all on function public\.get_public_buyer_ticket_holder_status\(uuid\) from public,anon;/);
});

test('actions.ts traduz HOLDER_ALREADY_HAS_TICKET_FOR_EVENT para a mensagem amigavel exigida', async () => {
  const source = await readFile(actionsPath, 'utf8');
  assert.match(source, /holder_already_has_ticket_for_event/);
  assert.match(source, /Você já possui um ingresso neste evento\./);
});

test('erro de precificacao preserva a mensagem/codigo original do RPC no log do servidor, nao so uma mensagem generica', async () => {
  const source = await readFile(actionsPath, 'utf8');
  assert.match(source, /getPublicPricingPreviewAction.*falhou|RPC get_registration_pricing_preview falhou/s);
  assert.match(source, /code: error\.code \?\? null/);
});
