import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const menu = await readFile(new URL('../src/lib/navigation/admin-menu.ts', import.meta.url), 'utf8');
const serverResolver = await readFile(new URL('../src/lib/navigation/admin-landing.ts', import.meta.url), 'utf8');
const accountNav = await readFile(new URL('../src/app/minha-conta/account-nav.tsx', import.meta.url), 'utf8');
const accountLayout = await readFile(new URL('../src/app/minha-conta/layout.tsx', import.meta.url), 'utf8');
const profilePage = await readFile(new URL('../src/app/minha-conta/dados/page.tsx', import.meta.url), 'utf8');
const firstAccessPage = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');

function priorityForHref(href) {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = menu.match(new RegExp(`href: ["']${escaped}["'][\\s\\S]*?landingPriority: (\\d+)`));
  assert.ok(match, `item de landing nao encontrado: ${href}`);
  return Number(match[1]);
}

test('prioridade canonica cobre os principais perfis administrativos', () => {
  assert.deepEqual(
    ['/painel', '/operacoes', '/operacoes/turbo', '/cadastros', '/painel/eventos', '/pedidos', '/financeiro', '/camisetas', '/loja', '/relatorios', '/painel/configuracoes/equipe'].map(priorityForHref),
    [10, 20, 21, 30, 40, 50, 60, 70, 80, 90, 100],
  );
});

test('resolver usa a mesma visibilidade do menu e retorna null sem item permitido', () => {
  assert.match(menu, /isAdminNavItemVisible\(item, permissionMap, capabilities\)/);
  assert.match(menu, /return firstVisible\?\.item\.href \?\? null/);
  assert.match(serverResolver, /getCurrentPermissionMap\(ADMIN_NAV_PERMISSION_CODES\)/);
  assert.match(serverResolver, /getOrganizationEventCapabilities\(\)/);
});

test('atalhos desktop, mobile e perfil usam o mesmo href resolvido', () => {
  assert.match(accountLayout, /const administrativeLandingPage = await resolveAdministrativeLandingPage\(\)/);
  assert.match(accountLayout, /AccountSidebarNav administrativeLandingPage={administrativeLandingPage}/);
  assert.match(accountLayout, /AccountMobileNav administrativeLandingPage={administrativeLandingPage}/);
  assert.match(accountNav, /if \(!administrativeLandingPage && !isSponsorUser\) return null/);
  assert.match(accountNav, /href={administrativeLandingPage}/);
  assert.match(profilePage, /href={administrativeLandingPage}/);
  assert.doesNotMatch(accountNav, /href=["']\/painel["']/);
});

test('redirect administrativo pos-primeiro-acesso usa o resolver canonico', () => {
  assert.match(firstAccessPage, /await resolveAdministrativeLandingPage\(\)/);
  assert.match(firstAccessPage, /redirect\(administrativeLandingPage\)/);
  assert.doesNotMatch(firstAccessPage, /redirect\(["']\/painel["']\)/);
});
