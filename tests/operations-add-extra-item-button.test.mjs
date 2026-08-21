import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailsUrl = new URL("../src/app/operacoes/components/ExpandedTicketDetails.tsx", import.meta.url);
const actionsUrl = new URL("../src/app/operacoes/actions.ts", import.meta.url);
const pageUrl = new URL("../src/app/operacoes/page.tsx", import.meta.url);

const [details, actions, page] = await Promise.all([
  readFile(detailsUrl, "utf8"),
  readFile(actionsUrl, "utf8"),
  readFile(pageUrl, "utf8"),
]);

test("botao de adicionar item extra pertence ao cabecalho da secao e nao depende da lista estar preenchida", () => {
  const sectionStart = details.indexOf("Itens adicionais");
  const emptyListBranch = details.indexOf("detail.additional_items.length === 0", sectionStart);
  const button = details.indexOf("Adicionar item extra", sectionStart);

  assert.notEqual(sectionStart, -1);
  assert.ok(button > sectionStart && button < emptyListBranch);
  assert.match(details.slice(sectionStart, emptyListBranch), /capabilities\.canGrantStoreItems/);
  assert.match(details, /Nenhum item adicional vinculado\./);
});

test("botao abre exclusivamente o GrantStoreItemModal existente", () => {
  assert.match(details, /onClick=\{\(\) => setShowGrantStoreItem\(true\)\}/);
  assert.match(details, /showGrantStoreItem\s*\?\s*\(\s*<GrantStoreItemModal/);
  assert.match(details, /eventId=\{detail\.event_id\}/);
  assert.match(details, /onSubmit=\{onGrantStoreItem\}/);
});

test("a permissao de concessao e carregada para a UI e revalidada no backend", () => {
  assert.match(actions, /canGrantStoreItems/);
  assert.match(actions, /hasPermission\("store\.grant_items"\)/);
  assert.match(actions, /hasPermission\("store\.manage"\)/);
  assert.match(actions, /getGrantableStoreItemsAction[\s\S]*?assertStoreGrantPermission\(\)/);
  assert.match(actions, /grantStoreItemAction[\s\S]*?assertStoreGrantPermission\(\)/);
  assert.match(page, /canGrantStoreItems:\s*false/);
});

test("concessao atualiza a mesma ficha pelo ticket sem navegar ou criar ingresso", () => {
  assert.match(page, /handleGrantStoreItem\([\s\S]*?runAction\(ticketId, \(\) => grantStoreItemAction\(\{ ticketId, \.\.\.payload \}\)\)/);
  assert.match(page, /if \(response\.success[\s\S]*?await refreshTicket\(ticketId\)/);

  const grantAction = actions.slice(
    actions.indexOf("export async function grantStoreItemAction"),
    actions.indexOf("export async function deliverAdditionalStoreItemAction"),
  );
  assert.match(grantAction, /admin_grant_store_item/);
  assert.doesNotMatch(grantAction, /\.from\("tickets"\)\.insert|\.from\("participant_kit_items"\)|checkin|wristband/);
});

test("consulta administrativa inclui produtos admin_only", () => {
  const grantableAction = actions.slice(
    actions.indexOf("export async function getGrantableStoreItemsAction"),
    actions.indexOf("export async function grantStoreItemAction"),
  );
  assert.match(grantableAction, /\.from\("store_items"\)/);
  assert.match(grantableAction, /\.eq\("is_active", true\)/);
  assert.doesNotMatch(grantableAction, /\.eq\("visibility",\s*"public"\)|\.rpc\("list_store_items_for_event"/);
});
