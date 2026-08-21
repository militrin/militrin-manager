import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/20260859000000_store_orders_contact_first_grants.sql", import.meta.url);
const pageUrl = new URL("../src/app/cadastros/[id]/page.tsx", import.meta.url);
const actionsUrl = new URL("../src/app/cadastros/actions.ts", import.meta.url);
const buttonUrl = new URL("../src/app/cadastros/contact-store-items.tsx", import.meta.url);
const modalUrl = new URL("../src/app/operacoes/components/GrantStoreItemModal.tsx", import.meta.url);

function extractFunction(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} deve existir`);
  const end = sql.indexOf("end; $$;", start);
  assert.notEqual(end, -1, `${name} deve ter corpo completo`);
  return sql.slice(start, end + 8);
}

test("store_orders passa a aceitar identidade contact-first sem conta ou ingresso", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /alter column user_id drop not null/);
  assert.match(sql, /registration_contact_id uuid references public\.registration_contacts/);
  const canonical = extractFunction(sql, "admin_grant_store_item_to_contact");
  assert.match(canonical, /insert into public\.store_orders[\s\S]*registration_contact_id/);
  assert.doesNotMatch(canonical, /insert into public\.tickets|insert into public\.participants/);
});

test("pessoa com ou sem participant usa a mesma RPC canonica", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const canonical = extractFunction(sql, "admin_grant_store_item_to_contact");
  assert.match(canonical, /select p\.id, p\.user_id into v_participant_id, v_user_id/);
  assert.match(canonical, /v_contact\.id/);
  assert.doesNotMatch(canonical, /if v_participant_id is null then raise/);
});

test("permissao de concessao e validada na UI, action e RPC", async () => {
  const [page, actions, sql] = await Promise.all([readFile(pageUrl, "utf8"), readFile(actionsUrl, "utf8"), readFile(migrationUrl, "utf8")]);
  assert.match(page, /hasPermission\("store\.grant_items"\)/);
  assert.match(page, /hasPermission\("store\.manage"\)/);
  assert.match(page, /canGrantStoreItems \? <ContactGrantStoreItemButton/);
  assert.doesNotMatch(page, /hasPermission\("store\.deliver"\)/);
  assert.match(actions, /grantStoreItemToContactAction[\s\S]*await assertStoreGrantPermission\(\)/);
  const canonical = extractFunction(sql, "admin_grant_store_item_to_contact");
  assert.match(canonical, /current_user_has_permission\('store\.grant_items'\)/);
  assert.match(canonical, /current_user_has_permission\('store\.manage'\)/);
  assert.doesNotMatch(canonical, /store\.deliver|checkin/);
});

test("RPC bloqueia cross-organization em cadastro, evento e produto", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const canonical = extractFunction(sql, "admin_grant_store_item_to_contact");
  assert.match(canonical, /user_can_access_organization\(v_actor, v_contact\.organization_id\)/);
  assert.match(canonical, /v_event\.organization_id <> v_contact\.organization_id/);
  assert.match(canonical, /organization_id = v_contact\.organization_id[\s\S]*event_id = p_event_id or event_id is null/);
});

test("estoque proprio e estoque vinculado ao kit reutilizam o helper canonico", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const canonical = extractFunction(sql, "admin_grant_store_item_to_contact");
  assert.match(canonical, /perform public\.reserve_store_item_stock\(v_store_item\.id, p_variant_id, p_quantity\)/);
  assert.match(sql, /store_item_inventory[\s\S]*event_kit_item_variant_inventory/);
});

test("wrapper por ticket resolve registration_contact e delega para a RPC canonica", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const wrapper = extractFunction(sql, "admin_grant_store_item");
  assert.match(wrapper, /v_oi\.registration_contact_id/);
  assert.match(wrapper, /p\.registration_contact_id/);
  assert.match(wrapper, /admin_grant_store_item_to_contact\(v_contact_id, v_ticket\.event_id/);
});

test("Ficha Global mostra botao no cabecalho, seleciona evento e lista itens separados", async () => {
  const [page, button, modal] = await Promise.all([readFile(pageUrl, "utf8"), readFile(buttonUrl, "utf8"), readFile(modalUrl, "utf8")]);
  const header = page.slice(page.indexOf("Dados globais"), page.indexOf("<dl"));
  assert.match(header, /Editar cadastro/);
  assert.match(header, /Emitir ingresso/);
  assert.match(header, /ContactGrantStoreItemButton/);
  assert.match(button, /\+ Adicionar item/);
  assert.match(modal, />Evento</);
  assert.match(page, /Itens adicionais/);
  assert.match(page, /registration_contact_id/);
  assert.match(button, /router\.refresh\(\)/);
});

test("concessao contact-first nao cria nem depende de ticket", async () => {
  const [sql, actions] = await Promise.all([readFile(migrationUrl, "utf8"), readFile(actionsUrl, "utf8")]);
  const canonical = extractFunction(sql, "admin_grant_store_item_to_contact");
  const actionStart = actions.indexOf("export async function grantStoreItemToContactAction");
  const actionEnd = actions.indexOf("\nexport async function", actionStart + 10);
  const action = actions.slice(actionStart, actionEnd === -1 ? undefined : actionEnd);
  assert.doesNotMatch(canonical, /p_ticket_id|public\.tickets/);
  assert.doesNotMatch(action, /ticketId|admin_grant_store_item"/);
  assert.match(action, /admin_grant_store_item_to_contact/);
});
