import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/20260815003331_contact_first_import_phase2.sql', import.meta.url);
const actionUrl = new URL('../src/app/importacoes/actions.ts', import.meta.url);
const issuesUrl = new URL('../src/app/inscricoes/actions.ts', import.meta.url);

test('importacao corrente resolve identidade pelo cadastro global e nao pelo evento do participant', async () => {
  const [migration, action] = await Promise.all([readFile(migrationUrl, 'utf8'), readFile(actionUrl, 'utf8')]);
  assert.match(action, /from\('registration_contacts'\)[\s\S]*eq\('organization_id'/);
  assert.doesNotMatch(action, /current_event_registrations'[\s\S]{0,500}from\('participants'\)[\s\S]{0,200}eq\('event_id'/);
  assert.match(migration, /regexp_replace\(coalesce\(rc\.cpf,''\),'\\D','','g'\)=v_cpf/);
  assert.match(migration, /Conflito de identidade: CPF possui mais de um cadastro/);
});

test('categoria lote camiseta e pagamento nascem nas entidades canonicas', async () => {
  const migration = await readFile(migrationUrl, 'utf8');
  assert.match(migration, /insert into public\.order_items[\s\S]*ticket_category_id,batch_id,shirt_type,shirt_size/);
  assert.match(migration, /insert into public\.payments[\s\S]*payment_method,payment_status/);
  const projectionInsert = migration.match(/insert into public\.participants[\s\S]*?returning \* into v_participant;/)?.[0] ?? '';
  assert.doesNotMatch(projectionInsert, /ticket_category_id|batch_id|shirt_type|shirt_size|payment_status|payment_method/);
});

test('multiplos ingressos reutilizam contato sem repetir titular implicitamente', async () => {
  const migration = await readFile(migrationUrl, 'utf8');
  assert.match(migration, /where oi\.event_id=v_event\.id and oi\.registration_contact_id=v_contact\.id/);
  assert.match(migration, /then v_assign_holder:=false/);
  assert.match(migration, /case when v_assign_holder then v_contact\.id end/);
});

test('pendencias e historico carregam vinculos canonicos', async () => {
  const migration = await readFile(migrationUrl, 'utf8');
  for (const column of ['registration_contact_id', 'order_item_id', 'ticket_id']) {
    assert.match(migration, new RegExp(`participant_data_issues[\\s\\S]*${column}`));
  }
  assert.match(migration, /participation_history[\s\S]*registration_contact_id/);
});

test('finalizacao e correcao usam order_item explicito e nunca ingresso mais recente', async () => {
  const [migration, action, issues] = await Promise.all([
    readFile(migrationUrl, 'utf8'), readFile(actionUrl, 'utf8'), readFile(issuesUrl, 'utf8'),
  ]);
  assert.match(action, /finalize_imported_ticket_after_issue_resolution/);
  assert.match(action, /p_order_item_id: orderItemId/);
  assert.match(issues, /resolve_ticket_data_issues/);
  assert.match(migration, /where id=p_order_item_id for update/);
  const finalizer = migration.match(/create or replace function public\.finalize_imported_ticket_after_issue_resolution[\s\S]*?end; \$\$;/)?.[0] ?? '';
  assert.doesNotMatch(finalizer, /order by (?:created_at|issued_at) desc limit 1/);
});

test('historico resolve cadastro da organizacao sem fundir por email telefone ou nome', async () => {
  const [migration, action] = await Promise.all([readFile(migrationUrl, 'utf8'), readFile(actionUrl, 'utf8')]);
  assert.match(action, /resolve_import_registration_contact/);
  assert.match(action, /registration_contact_id: historicalContactId/);
  const resolver = migration.match(/create or replace function public\.resolve_import_registration_contact[\s\S]*?end; \$\$;/)?.[0] ?? '';
  assert.match(resolver, /public\.is_valid_cpf\(v_cpf\)/);
  assert.doesNotMatch(resolver, /where[^;]*(email|phone|full_name)\s*=/i);
});

test('Central e Retirada permanecem ticket-first e preservam multiplos ingressos', async () => {
  const [operations, pickup] = await Promise.all([
    readFile(new URL('../src/app/operacoes/actions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/retirada/actions.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(operations, /\.from\("tickets"\)[\s\S]*\.eq\("event_id", eventId\)/);
  assert.match(operations, /const ticketId = String\(row\.id/);
  assert.match(pickup, /order_items"\)\.select\("id,registration_contact_id"/);
  assert.match(pickup, /\.in\("order_item_id", orderItemIds\)/);
  assert.match(pickup, /ticketsById = new Map/);
  assert.match(pickup, /Array\.from\(ticketsById\.values\(\)\)/);
});

test('nenhuma action normal grava entidade canonica diretamente em participants', async () => {
  const actionFiles = [
    '../src/app/importacoes/actions.ts', '../src/app/primeiro-acesso/actions.ts',
    '../src/app/minha-conta/actions.ts', '../src/app/inscricoes/actions.ts',
    '../src/app/inscricoes/[id]/editar/actions.ts', '../src/app/cadastros/actions.ts',
  ];
  const sources = await Promise.all(actionFiles.map((file) => readFile(new URL(file, import.meta.url), 'utf8')));
  for (const source of sources) {
    assert.doesNotMatch(source, /from\(["']participants["']\)[\s\S]{0,220}\.(?:insert|update|upsert)\(/);
  }
});
