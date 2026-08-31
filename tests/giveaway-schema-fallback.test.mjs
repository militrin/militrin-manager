import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isMissingGiveawaySchemaError, resolveOptionalGiveawaySchema } from "../src/lib/instagram/database-readiness.ts";

test("ausencia de public.giveaways ativa fallback sem sessao persistida", () => {
  const error = { code: "PGRST205", message: "Could not find the table 'public.giveaways' in the schema cache" };
  assert.equal(isMissingGiveawaySchemaError(error), true);
  assert.deepEqual(resolveOptionalGiveawaySchema(null, error), { databaseReady: false, data: null });
});

test("outras tabelas opcionais do modulo tambem ativam o fallback", () => {
  assert.equal(isMissingGiveawaySchemaError({ code: "42P01", message: 'relation "public.giveaway_entries" does not exist' }), true);
  assert.equal(isMissingGiveawaySchemaError({ code: "PGRST205", message: "Could not find public.instagram_integrations" }), true);
});

test("erro nao relacionado ao schema continua sendo erro real", () => {
  const error = { code: "PGRST301", message: "JWT expired" };
  assert.equal(isMissingGiveawaySchemaError(error), false);
  assert.throws(() => resolveOptionalGiveawaySchema(null, error), (thrown) => thrown === error);
  assert.equal(isMissingGiveawaySchemaError({ code: "PGRST205", message: "Could not find public.orders" }), false);
});

test("modo local preserva importador CSV quando persistencia esta indisponivel", () => {
  const app = readFileSync(new URL("../src/components/sorteios/SorteioApp.tsx", import.meta.url), "utf8");
  const instagram = readFileSync(new URL("../src/components/sorteios/InstagramImport.tsx", import.meta.url), "utf8");
  assert.match(app, /if \(!persistenceAvailable\)/);
  assert.match(app, /parseSorteioCsv/);
  assert.match(instagram, /O sorteio por CSV continua disponível/);
});
