import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20260858000000_store_grant_items_permission.sql", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url), "utf8");
const details = await readFile(new URL("../src/app/operacoes/components/ExpandedTicketDetails.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../src/app/operacoes/page.tsx", import.meta.url), "utf8");
const cadastro = await readFile(new URL("../src/app/cadastros/[id]/page.tsx", import.meta.url), "utf8");

test("permissao dedicada existe e so administrator a recebe por padrao", () => {
  assert.match(migration, /'store\.grant_items'/);
  assert.match(migration, /where role\.code = 'administrator'/);
  assert.doesNotMatch(migration, /role\.code\s+in\s*\([^)]*(operator|checkin|deliver)/i);
});

test("check-in e entrega nao habilitam concessao na UI", () => {
  const capabilityBlock = actions.slice(actions.indexOf("export async function getRetiradaCapabilitiesAction"), actions.indexOf("export async function getPickupEventsAction"));
  assert.match(capabilityBlock, /canGrantStoreItems/);
  assert.match(capabilityBlock, /hasPermission\("store\.grant_items"\)/);
  assert.match(capabilityBlock, /hasPermission\("store\.manage"\)/);
  assert.doesNotMatch(capabilityBlock, /canGrantStoreItems\s*:\s*(canDeliver|canCheckin)/);
  assert.match(page, /canGrantStoreItems:\s*false/);
  assert.match(details, /capabilities\.canGrantStoreItems \? \(/);
});

test("server actions aceitam grant_items ou manage e nunca store.deliver", () => {
  const helper = actions.slice(actions.indexOf("async function assertStoreGrantPermission"), actions.indexOf("export async function getGrantableStoreItemsAction"));
  assert.match(helper, /hasPermission\("store\.grant_items"\)/);
  assert.match(helper, /assertPermission\("store\.manage"\)/);
  assert.doesNotMatch(helper, /store\.deliver|checkin\.scan|kits\.deliver/);
  assert.match(actions, /getGrantableStoreItemsAction[\s\S]*?await assertStoreGrantPermission\(\)/);
  assert.match(actions, /grantStoreItemAction[\s\S]*?await assertStoreGrantPermission\(\)/);
});

test("RPC rejeita chamada direta sem grant_items nem manage", () => {
  const rpc = migration.slice(migration.indexOf("create or replace function public.admin_grant_store_item"));
  assert.match(rpc, /current_user_has_permission\('store\.grant_items'\)[\s\S]*?or public\.current_user_has_permission\('store\.manage'\)/);
  assert.match(rpc, /raise exception 'Sem permissao para conceder itens da loja\.'/);
  assert.doesNotMatch(rpc, /current_user_has_permission\('store\.deliver'\)/);
});

test("Ficha Global expoe o botao somente pela capacidade de concessao", () => {
  assert.match(cadastro, /canGrantStoreItems \? <ContactGrantStoreItemButton/);
  assert.match(cadastro, /hasPermission\("store\.grant_items"\)/);
  assert.match(cadastro, /hasPermission\("store\.manage"\)/);
  assert.doesNotMatch(cadastro, /hasPermission\("store\.deliver"\)/);
});
