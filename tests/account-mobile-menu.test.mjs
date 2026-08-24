import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

// Normaliza CRLF->LF (mesmo motivo dos outros testes de contrato deste
// projeto: o ambiente Windows pode salvar arquivos-fonte com CRLF
// independente do que a ferramenta escreveu, e os marcadores de slice()
// abaixo usam \n literal).
async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

const accountNav = await readFile(new URL("../src/app/minha-conta/account-nav.tsx", import.meta.url), "utf8");
const layout = await readFile(new URL("../src/app/minha-conta/layout.tsx", import.meta.url), "utf8");
const homePage = await readFile(new URL("../src/app/minha-conta/page.tsx", import.meta.url), "utf8");

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.notEqual(end, -1, `marcador de fim nao encontrado: ${endMarker}`);
  return source.slice(start, end);
}

test("bottom nav do usuario tem exatamente 5 slots, nesta ordem: Inicio / Eventos / Loja / Carrinho / Menu", () => {
  const fn = slice(accountNav, "export function AccountMobileNav", null);
  const ul = slice(fn, "<ul className=\"grid grid-cols-5", "</ul>");
  const order = ["Início", "Eventos", "Loja", "MobileCartLink", "Menu"];
  const indices = order.map((needle) => ul.indexOf(needle));
  assert.ok(indices.every((index) => index !== -1), `todos os 5 slots precisam existir: ${JSON.stringify(indices)}`);
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i - 1] < indices[i], `ordem incorreta -- ${order[i - 1]} precisa vir antes de ${order[i]}`);
  }
  assert.match(ul, /href="\/minha-conta"[^>]*label="Início"/s);
  assert.match(ul, /href="\/minha-conta\/comprar"[^>]*label="Eventos"/s);
  assert.match(ul, /href="\/minha-conta\/loja"[^>]*label="Loja"/s);
  assert.match(ul, /<MobileCartLink/);
});

test("Perfil NAO e mais item principal da bottom nav -- vira acesso secundario dentro do Menu", () => {
  const fn = slice(accountNav, "export function AccountMobileNav", null);
  const ul = slice(fn, "<ul className=\"grid grid-cols-5", "</ul>");
  assert.doesNotMatch(ul, /label="Perfil"/);
  assert.doesNotMatch(ul, /\/minha-conta\/dados/);
});

test("botao Menu abre o MenuSheet (bottom sheet), nunca navega direto pra uma rota", () => {
  const fn = slice(accountNav, "export function AccountMobileNav", null);
  const menuButton = slice(fn, "onClick={() => setMenuOpen(true)}", "</button>");
  assert.match(menuButton, /Menu/);
  assert.doesNotMatch(menuButton, /href=/);
  assert.match(fn, /<MenuSheet/);
});

test("MenuSheet da conta contem acesso as funcoes secundarias: ingressos, compras, carrinho, perfil, fotos, historico, categoria e Sair", () => {
  const sheetFn = slice(accountNav, "function MenuSheet(", "function MobileNavLink");
  assert.match(sheetFn, /navigationGroups\.map/);
  assert.match(sheetFn, /<form action={signOutAccountAction}>/);
  assert.match(sheetFn, /Sair/);
  // navigationGroups (fonte compartilhada com o desktop) precisa cobrir os
  // itens sugeridos pelo AJUSTE MOBILE item 1.
  assert.match(accountNav, /label: 'Meus ingressos'/);
  assert.match(accountNav, /label: 'Minhas compras'/);
  assert.match(accountNav, /label: 'Carrinho de Compras'/);
  assert.match(accountNav, /label: 'Meu perfil'/);
  assert.match(accountNav, /href: '\/fotos'/);
  assert.match(accountNav, /label: 'Histórico'/);
  assert.match(accountNav, /label: 'Minha categoria - Em breve'/);
});

test("MenuSheet mostra Painel administrativo/Area do patrocinador reaproveitando o MESMO destino administrativo do desktop", () => {
  assert.match(accountNav, /function AdminAndSponsorShortcuts\(/);
  // AccountSidebarNav (desktop) e AccountMobileNav (mobile, via MenuSheet)
  // usam o MESMO componente de atalhos -- uma unica leitura de
  // administrativeLandingPage/isSponsorUser, nunca reimplementada duas vezes.
  const sidebarFn = slice(accountNav, "export function AccountSidebarNav", "// ── \"Menu\" mobile");
  assert.match(sidebarFn, /<AdminAndSponsorShortcuts administrativeLandingPage={administrativeLandingPage} isSponsorUser={isSponsorUser} pathname={pathname} \/>/);
  const sheetFn = slice(accountNav, "function MenuSheet(", "function MobileNavLink");
  assert.match(sheetFn, /<AdminAndSponsorShortcuts/);
  assert.match(sheetFn, /administrativeLandingPage={administrativeLandingPage}/);
  assert.match(sheetFn, /isSponsorUser={isSponsorUser}/);
});

test("AccountMobileNav recebe o destino administrativo como prop -- layout.tsx repassa o MESMO valor usado no desktop", () => {
  assert.match(accountNav, /export function AccountMobileNav\({ administrativeLandingPage, isSponsorUser }/);
  assert.match(layout, /<AccountSidebarNav administrativeLandingPage={administrativeLandingPage} isSponsorUser={isSponsorUser} \/>/);
  assert.match(layout, /<AccountMobileNav administrativeLandingPage={administrativeLandingPage} isSponsorUser={isSponsorUser} \/>/);
});

test("home da Minha Conta destaca Eventos e Loja perto do topo (cards visuais com CTA), antes da secao 'Seus ingressos'", () => {
  const highlightIdx = homePage.indexOf('href="/minha-conta/comprar"');
  const lojaHighlightIdx = homePage.indexOf('href="/minha-conta/loja"');
  const seusIngressosIdx = homePage.indexOf("/>Seus ingressos");
  assert.ok(highlightIdx !== -1 && lojaHighlightIdx !== -1, "os 2 cards de destaque (Eventos e Loja) precisam existir na home");
  assert.ok(highlightIdx < seusIngressosIdx && lojaHighlightIdx < seusIngressosIdx, "os cards de destaque precisam vir ANTES de 'Seus ingressos', perto do topo");
  assert.match(homePage, /Próximos eventos/);
  assert.match(homePage, /Ver eventos/);
  assert.match(homePage, /Loja Militrin/);
  assert.match(homePage, /Ir para a loja/);
});

test("card de Loja na home usa imagem de um item REAL (mesma fonte que /minha-conta/loja: eventos aos quais o usuario tem ingresso), com fallback quando nao ha imagem -- nunca card vazio", () => {
  assert.match(homePage, /import { getStoreItemsForEvents } from '@\/lib\/store\/get-store-items'/);
  assert.match(homePage, /storeHighlightItem/);
  assert.match(homePage, /ticketScope\.ownedEventIds/);
  const card = slice(homePage, 'href="/minha-conta/loja"', "</Link>");
  assert.match(card, /storeHighlightItem\?\.imageUrl/);
  assert.match(card, /bg-linear-to-br from-amber-500\/40/);
});
