import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Achado: sponsors.view e feedback.view sao paginas DENTRO de /painel/*, que o
// layout (src/app/painel/layout.tsx) protege com requireAdministrativePanelAccess()
// -- um guard AMPLO e ANTERIOR ao guard especifico da propria pagina. Se o
// codigo do modulo nao estiver em ADMINISTRATIVE_PANEL_PERMISSION_CODES, o
// layout redireciona para /acesso-negado antes mesmo da pagina rodar seu
// proprio requirePermission -- ou seja, um usuario com so essa permissao
// nunca chega a ver o proprio requirePermission passar. store.view (loja)
// fica FORA de /painel/*, com layout proprio, entao nunca sofreu esse
// bloqueio especifico -- foi incluido na lista mesmo assim por consistencia
// (a lista tambem controla o link "Painel administrativo" e outras leituras
// de "e um usuario com algum acesso operacional", nao so o guard de /painel/*).
test('guard amplo de /painel inclui os 3 modulos auditados (sponsors/store/feedback)', async () => {
  const policy = await readFile(new URL('../src/lib/admin/panel-access.ts', import.meta.url), 'utf8');
  assert.match(policy, /'sponsors\.view'/);
  assert.match(policy, /'store\.view'/);
  assert.match(policy, /'feedback\.view'/);
});

test('guard continua sendo uma lista curada fixa (nao vira "qualquer permissao libera")', async () => {
  const policy = await readFile(new URL('../src/lib/admin/panel-access.ts', import.meta.url), 'utf8');
  // A logica permanece "usuario tem alguma das permissoes desta lista fixa" --
  // nunca "usuario tem alguma permissao qualquer no sistema".
  assert.match(policy, /ADMINISTRATIVE_PANEL_PERMISSION_CODES\.map\(\(code\) => hasPermission\(code, userId\)\)/);
  assert.match(policy, /results\.some\(Boolean\)/);
  assert.doesNotMatch(policy, /admin_permissions|listAllPermissions|getAllPermissionCodes/);
});

test('/painel/patrocinadores continua exigindo sponsors.view especificamente (RBAC da pagina e a autoridade final)', async () => {
  const page = await readFile(new URL('../src/app/painel/patrocinadores/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /requirePermission\('sponsors\.view'\)/);
});

test('/loja continua exigindo store.view especificamente', async () => {
  const page = await readFile(new URL('../src/app/loja/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /requirePermission\("store\.view"\)/);
});

test('/painel/feedbacks continua exigindo feedback.view especificamente', async () => {
  const page = await readFile(new URL('../src/app/painel/feedbacks/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /requirePermission\('feedback\.view'\)/);
});

test('usuario so com sponsors.view nao ganha acesso a feedbacks so por estar na lista ampla (paginas usam codigos distintos)', async () => {
  const sponsorsPage = await readFile(new URL('../src/app/painel/patrocinadores/page.tsx', import.meta.url), 'utf8');
  const feedbackPage = await readFile(new URL('../src/app/painel/feedbacks/page.tsx', import.meta.url), 'utf8');
  const sponsorsCode = sponsorsPage.match(/requirePermission\('([\w.]+)'\)/)?.[1];
  const feedbackCode = feedbackPage.match(/requirePermission\('([\w.]+)'\)/)?.[1];
  assert.equal(sponsorsCode, 'sponsors.view');
  assert.equal(feedbackCode, 'feedback.view');
  assert.notEqual(sponsorsCode, feedbackCode, 'cada pagina precisa do seu proprio codigo -- estar na lista ampla nunca substitui o RBAC da pagina');
});

test('/painel/layout.tsx continua aplicando o guard amplo antes de qualquer pagina do painel', async () => {
  const layout = await readFile(new URL('../src/app/painel/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /requireAdministrativePanelAccess\(\)/);
});

test('store.view (loja) nunca dependeu do guard amplo para a propria pagina -- vive fora de /painel/*', async () => {
  const lojaLayout = await readFile(new URL('../src/app/loja/page.tsx', import.meta.url), 'utf8').catch(() => null);
  assert.ok(lojaLayout, 'src/app/loja/page.tsx deve existir');
  // Confirma que loja/ nao tem layout.tsx proprio aplicando requireAdministrativePanelAccess
  // (ou seja, o unico guard amplo do sistema continua sendo painel/layout.tsx).
  const lojaHasOwnLayout = await readFile(new URL('../src/app/loja/layout.tsx', import.meta.url), 'utf8').catch(() => null);
  assert.equal(lojaHasOwnLayout, null, 'loja/ nao deveria ter layout proprio aplicando o guard administrativo amplo');
});

// "usuario sem permissao administrativa continua fora" ja e coberto por
// tests/import-phase1.test.mjs ("portal — participante comum nao recebe
// acesso operacional por identidade"), que confirma results.some(Boolean)
// e a unica logica (sem bypass por email/metadata/cargo). Aqui so
// confirmamos que a expansao da lista nao alterou esse mecanismo.
test('mecanismo de bloqueio para quem nao tem nenhuma permissao da lista permanece intacto', async () => {
  const policy = await readFile(new URL('../src/lib/admin/panel-access.ts', import.meta.url), 'utf8');
  assert.match(policy, /if \(!await canAccessAdministrativePanel\(\)\) redirect\('\/acesso-negado'\);/);
});
