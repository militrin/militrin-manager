#!/usr/bin/env node
// ============================================================================
// Remove contas ficticias de auth.users -- Militrin Manager
// ============================================================================
// NAO faz parte do app (nenhum import daqui, nenhum script do package.json
// chama este arquivo). Ferramenta manual de execucao unica.
//
// Por que nao e SQL: apagar linhas de auth.users direto via `DELETE FROM
// auth.users` nao e a forma suportada pelo Supabase (o schema auth tem
// tabelas internas relacionadas -- identities, sessions, refresh_tokens,
// mfa_factors etc. -- que a Auth Admin API sabe limpar corretamente e um
// DELETE cru pode deixar inconsistente). Este script usa
// `DELETE /auth/v1/admin/users/{id}`, a API administrativa oficial do
// GoTrue/Supabase Auth, com a service_role key.
//
// Lista fixa (nao dinamica de proposito -- resultado exato da auditoria
// somente-leitura feita em 2026-08-22, pra voce revisar cada linha antes de
// rodar, em vez de um "apague todo mundo menos X" que poderia pegar uma
// conta nova/legitima criada entre a auditoria e a execucao).
//
// MODO SEGURO POR PADRAO: sem a flag --confirm, o script so LISTA o que
// faria (nenhuma chamada de rede de escrita acontece). So deleta de verdade
// com `node delete_fictitious_auth_users.mjs --confirm`.
// ============================================================================
import fs from "node:fs";

const PROTECTED_EMAIL = "h.dogui@gmail.com";

// Resultado da auditoria somente-leitura (id + email conferidos manualmente
// contra auth.users em 2026-08-22). Editar esta lista se a auditoria for
// re-rodada e o resultado mudar.
const FICTITIOUS_ACCOUNTS = [
  { id: "186c6485-c5e5-40d6-8bf8-274a0eb98c81", email: "phase2-1786755469327@example.test" },
  { id: "bf8042cf-1830-42e0-bbb6-a331e79b690a", email: "hdogui+testedeimp@gmail.com" },
  { id: "549aac1f-84b0-42ca-b89b-62d0ead8627d", email: "hdogui@gmail.com" }, // SEM o ponto -- diferente da conta protegida
  { id: "84fc74b5-095a-466f-a4dc-c52e4f3f2681", email: "teste023@gmail.com" },
  { id: "ec189fe2-1a68-41fd-b4db-bbcf412feae6", email: "qa.portal.a.1785113977@outlook.com" },
];

const DRY_RUN = !process.argv.includes("--confirm");

const envRaw = fs.readFileSync("c:/Projetos/militrin-manager/.env.local", "utf8");
const env = Object.fromEntries(
  envRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const idx = line.indexOf("=");
    return [line.slice(0, idx), line.slice(idx + 1)];
  }),
);
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

// Guard: nenhuma entrada da lista fixa pode ser a conta protegida, mesmo
// que alguem edite o array acima por engano.
for (const account of FICTITIOUS_ACCOUNTS) {
  if (account.email.toLowerCase() === PROTECTED_EMAIL.toLowerCase()) {
    throw new Error(`GUARD FALHOU: ${PROTECTED_EMAIL} (conta protegida) apareceu na lista de contas a apagar. Abortando sem tocar em nada.`);
  }
}

console.log(DRY_RUN ? "=== MODO ENSAIO (nenhuma exclusao real) ===" : "=== MODO EXECUCAO -- vai apagar de verdade ===");
console.log(`Conta protegida (nunca tocada): ${PROTECTED_EMAIL}`);
console.log(`Contas a remover: ${FICTITIOUS_ACCOUNTS.length}\n`);

for (const account of FICTITIOUS_ACCOUNTS) {
  if (DRY_RUN) {
    console.log(`[ensaio] apagaria auth.users id=${account.id} email=${account.email}`);
    continue;
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${account.id}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`FALHOU: ${account.email} (${account.id}) -> ${res.status} ${body}`);
    process.exitCode = 1;
    continue;
  }

  console.log(`removido: ${account.email} (${account.id})`);
}

console.log(
  DRY_RUN
    ? "\nNenhuma alteracao foi feita. Rode com --confirm pra executar de verdade."
    : "\nConcluido. Rode audit-accounts novamente pra confirmar que so a conta protegida restou.",
);
