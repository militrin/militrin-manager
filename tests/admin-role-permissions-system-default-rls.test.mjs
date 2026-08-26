import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

// Correcao minima e cirurgica do achado do Security Advisor
// (rls_disabled_in_public) para public.admin_role_permissions_system_default,
// confirmado por auditoria somente leitura: RLS nunca foi habilitada nessa
// tabela e a chave anon conseguia ler as 271 linhas diretamente via
// PostgREST. Estes testes sao estaticos (leem o texto das migrations e do
// codigo-fonte) -- a prova de comportamento em runtime (anon/authenticated
// bloqueados, RPCs de Owner continuando a funcionar) esta em
// tests/admin-role-permissions-system-default-rls.integration.mjs.

function stripSqlComments(source) {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const fixMigrationPath = new URL("../supabase/migrations/20260899000000_admin_role_permissions_system_default_rls.sql", import.meta.url);
const fixMigrationFull = await readFile(fixMigrationPath, "utf8");
const fixMigration = stripSqlComments(fixMigrationFull);
const creatingMigration = await readFile(new URL("../supabase/migrations/20260868000000_admin_role_permissions_manual_editor.sql", import.meta.url), "utf8");

test("a migration de correcao habilita RLS e revoga anon/authenticated na tabela snapshot -- nada mais", () => {
  assert.match(fixMigration, /alter table public\.admin_role_permissions_system_default enable row level security;/);
  assert.match(fixMigration, /revoke all on public\.admin_role_permissions_system_default from anon, authenticated;/);
});

test("a correcao NAO usa FORCE ROW LEVEL SECURITY (quebraria as RPCs SECURITY DEFINER que leem a tabela)", () => {
  assert.doesNotMatch(fixMigration, /force row level security/i);
});

test("a correcao NAO cria nenhuma policy USING (true) so pra silenciar o Advisor", () => {
  assert.doesNotMatch(fixMigration, /create policy/i);
  assert.doesNotMatch(fixMigration, /using\s*\(\s*true\s*\)/i);
});

test("a correcao nao concede nem revoga nada de service_role -- so anon/authenticated -- e nao toca em nenhuma outra tabela", () => {
  assert.doesNotMatch(fixMigration, /service_role/i);
  const statements = fixMigration.split(";").map((s) => s.trim()).filter(Boolean).filter((s) => !/^(begin|commit)$/i.test(s));
  assert.equal(statements.length, 2, `esperava exatamente 2 statements executaveis (enable rls + revoke), encontrou ${statements.length}`);
});

test("migrations ja aplicadas nao sao alteradas -- a correcao vive isolada em migration nova", async () => {
  // A tabela continua sendo criada exatamente como antes em 20260868000000 --
  // nenhuma ALTER/ENABLE ROW LEVEL SECURITY foi retroativamente inserida la.
  assert.doesNotMatch(creatingMigration, /enable row level security/i);
  assert.match(creatingMigration, /create table if not exists public\.admin_role_permissions_system_default/);
});

test("os dois unicos leitores legitimos da tabela snapshot sao RPCs SECURITY DEFINER, nao acesso direto", () => {
  assert.match(creatingMigration, /create or replace function public\.list_admin_role_permissions\(p_role_id uuid\)[\s\S]*?security definer/);
  assert.match(creatingMigration, /create or replace function public\.restore_admin_role_permissions_default\(p_role_id uuid, p_reason text default null\)[\s\S]*?security definer/);
});

test("nenhum arquivo em src/ acessa admin_role_permissions_system_default diretamente (zero consumidores client-side)", async () => {
  const { readdir } = await import("node:fs/promises");
  const srcRoot = new URL("../src/", import.meta.url);

  const offenders = [];
  async function walk(dirUrl) {
    const entries = await readdir(dirUrl, { withFileTypes: true });
    for (const entry of entries) {
      const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
      if (entry.isDirectory()) {
        await walk(entryUrl);
      } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        const content = await readFileRaw(entryUrl, "utf8");
        if (content.includes("admin_role_permissions_system_default")) offenders.push(entryUrl.pathname);
      }
    }
  }
  await walk(srcRoot);

  assert.deepEqual(offenders, [], "nenhum arquivo em src/ deveria referenciar a tabela snapshot diretamente");
});
