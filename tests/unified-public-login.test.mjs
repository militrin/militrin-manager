import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  sanitizeInternalNextPath,
  sanitizePostFirstAccessNextPath,
  resolvePostAuthDestination,
} from '../src/lib/utils/safe-navigation.ts';

// Unificacao do login publico: /minha-conta, /painel e demais rotas
// protegidas deslogadas devem cair na experiencia de login nova (/entrar,
// que agora compartilha identidade visual e o mesmo formulario da home /),
// preservando a rota de retorno (?next=) e rejeitando destinos externos.

test('sanitizeInternalNextPath aceita caminhos internos e rejeita open redirect', () => {
  assert.equal(sanitizeInternalNextPath('/minha-conta/ingressos/XYZ'), '/minha-conta/ingressos/XYZ');
  assert.equal(sanitizeInternalNextPath('/painel/eventos/123?tab=lotes'), '/painel/eventos/123?tab=lotes');

  // Externo/malicioso -> cai no fallback, nunca no destino informado.
  assert.equal(sanitizeInternalNextPath('https://evil.example/phish'), '/minha-conta');
  assert.equal(sanitizeInternalNextPath('http://evil.example'), '/minha-conta');
  assert.equal(sanitizeInternalNextPath('//evil.example'), '/minha-conta');
  assert.equal(sanitizeInternalNextPath('/\\evil.example'), '/minha-conta');
  assert.equal(sanitizeInternalNextPath('javascript:alert(1)'), '/minha-conta');
  assert.equal(sanitizeInternalNextPath('/javascript:alert(1)'), '/minha-conta');
  assert.equal(sanitizeInternalNextPath(null), '/minha-conta');
  assert.equal(sanitizeInternalNextPath(''), '/minha-conta');
  assert.equal(sanitizeInternalNextPath('   '), '/minha-conta');

  assert.equal(sanitizeInternalNextPath('/painel', '/painel-fallback'), '/painel');
  assert.equal(sanitizeInternalNextPath('relative/no-slash', '/fallback'), '/fallback');
});

test('sanitizePostFirstAccessNextPath nunca devolve para dentro do proprio wizard de primeiro acesso', () => {
  assert.equal(sanitizePostFirstAccessNextPath('/primeiro-acesso'), '/minha-conta');
  assert.equal(sanitizePostFirstAccessNextPath('/primeiro-acesso/pendencias'), '/minha-conta');
  assert.equal(sanitizePostFirstAccessNextPath('/minha-conta/ingressos/XYZ'), '/minha-conta/ingressos/XYZ');
  assert.equal(sanitizePostFirstAccessNextPath('https://evil.example'), '/minha-conta');
});

test('resolvePostAuthDestination prioriza next da querystring sobre o wizard salvo, e sempre sanitiza', () => {
  assert.equal(
    resolvePostAuthDestination({ nextPath: '/minha-conta/ingressos/XYZ', wizardPath: '/inscricao/evento-x' }),
    '/minha-conta/ingressos/XYZ',
  );
  assert.equal(
    resolvePostAuthDestination({ nextPath: null, wizardPath: '/inscricao/evento-x' }),
    '/inscricao/evento-x',
  );
  // next invalido nao cai para o wizard salvo -- vai direto para o fallback
  // seguro, sem tentar "adivinhar" outro destino a partir de entrada suspeita.
  assert.equal(
    resolvePostAuthDestination({ nextPath: 'https://evil.example', wizardPath: '/inscricao/evento-x' }),
    '/minha-conta',
  );
  assert.equal(resolvePostAuthDestination({}), '/minha-conta');
  assert.equal(resolvePostAuthDestination({ fallback: '/painel' }), '/painel');
});

test('middleware trata /minha-conta, /painel e as demais rotas protegidas como uma unica porta de entrada para /entrar, preservando o destino e sem loop', async () => {
  const source = await readFile(new URL('../middleware.ts', import.meta.url), 'utf8');

  // Um unico ponto redireciona rotas protegidas deslogadas -- nao ha um
  // redirect('/entrar') espalhado e divergente por rota.
  assert.match(source, /pathname\.startsWith\(`\$\{prefix\}\/`\)/);
  for (const prefix of ['/minha-conta', '/painel', '/importacoes', '/primeiro-acesso', '/cupons', '/plataforma']) {
    assert.match(source, new RegExp(`'${prefix.replace('/', '\\/')}'`), `middleware deve proteger ${prefix}`);
  }

  // /entrar nao esta na lista de prefixos protegidos: se estivesse, redirect
  // para /entrar?next=/entrar cairia num loop. Pode aparecer no matcher.
  const protectedList = source.slice(source.indexOf('const protectedPrefixes'), source.indexOf('const isPublicFirstAccessResend'));
  assert.doesNotMatch(protectedList, /'\/entrar'/);

  // Deslogado numa rota protegida -> vai para /entrar preservando pathname+search como next.
  assert.match(source, /loginRedirect\.pathname\s*=\s*'\/entrar'/);
  assert.match(source, /loginRedirect\.searchParams\.set\('next',\s*`\$\{pathname\}\$\{search\}`\)/);
  assert.match(source, /if \(requiresAuth && !user\)/);

  // Logado acessando /entrar diretamente nao fica preso la -- sai para o next
  // sanitizado (ou /minha-conta), nunca fica plantado na tela de login.
  assert.match(source, /pathname === '\/entrar' && user/);
  assert.match(source, /sanitizePostFirstAccessNextPath\(request\.nextUrl\.searchParams\.get\('next'\), '\/minha-conta'\)/);
});

test('/entrar continua sendo a porta de login; a home publica aponta para ela sem duplicar o formulario', async () => {
  const entrarPage = await readFile(new URL('../src/app/entrar/page.tsx', import.meta.url), 'utf8');
  assert.match(entrarPage, /ParticipantAuthCard/);

  const authCard = await readFile(new URL('../src/components/public/ParticipantAuthCard.tsx', import.meta.url), 'utf8');
  const home = await readFile(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
  const landing = await readFile(new URL('../src/components/public/PublicLanding.tsx', import.meta.url), 'utf8');

  assert.match(authCard, /var\(--brand-glow\)/);
  assert.match(authCard, /PublicBrandMark/);
  assert.match(authCard, /PublicLoginForm/);
  assert.match(home, /redirect\('\/minha-conta'\)/);
  assert.match(home, /PublicLanding/);
  assert.doesNotMatch(home, /PublicLoginForm/);
  assert.doesNotMatch(landing, /PublicLoginForm/);
  assert.match(landing, /href=\{PUBLIC_LOGIN_PATH\}/);
  assert.match(landing, /PUBLIC_LOGIN_PATH = '\/entrar'/);
  assert.match(landing, /FIRST_ACCESS_PATH = '\/primeiro-acesso\/reenviar'/);
});

test('PublicLoginForm resolve o destino pos-login a partir do ?next da propria pagina, com fallback seguro', async () => {
  const form = await readFile(new URL('../src/components/public/PublicLoginForm.tsx', import.meta.url), 'utf8');
  assert.match(form, /window\.location\.search/);
  assert.match(form, /resolvePostAuthDestination/);
  assert.match(form, /next_path:\s*nextFromQuery/);
  assert.match(form, /result\.redirect_to \|\| fallbackDestination/);
});
