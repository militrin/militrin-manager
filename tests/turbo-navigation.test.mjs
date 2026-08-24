import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

// Normaliza CRLF->LF (ver mesmo comentario em turbo-qr-camera-fallback.test.mjs).
async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

const sidebar = await readFile(new URL("../src/components/dashboard/Sidebar.tsx", import.meta.url), "utf8");
const adminMenu = await readFile(new URL("../src/lib/navigation/admin-menu.ts", import.meta.url), "utf8");
const sidebarActions = await readFile(new URL("../src/components/dashboard/sidebar-actions.ts", import.meta.url), "utf8");
const layout = await readFile(new URL("../src/app/operacoes/layout.tsx", import.meta.url), "utf8");
const turboPage = await readFile(new URL("../src/app/operacoes/turbo/page.tsx", import.meta.url), "utf8");
const turboClient = await readFile(new URL("../src/app/operacoes/turbo/TurboRouteClient.tsx", import.meta.url), "utf8");
const pulseiraPage = await readFile(new URL("../src/app/operacoes/pulseira/page.tsx", import.meta.url), "utf8");
const pulseiraClient = await readFile(new URL("../src/app/operacoes/pulseira/WristbandLookupClient.tsx", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../src/app/operacoes/page.tsx", import.meta.url), "utf8");
const turboMode = await readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url), "utf8");

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  return source.slice(start, end === -1 ? undefined : end);
}

// ============================================================
// 1. Menu lateral -- ordem e presenca dos 4 itens
//
// A fonte de dados (adminNavGroups) foi extraida de Sidebar.tsx pra
// src/lib/navigation/admin-menu.ts (pra ser compartilhada com o header/
// drawer/bottom nav moveis, ver secao 6 abaixo) -- os testes de conteudo do
// menu leem esse arquivo agora; os de COMPORTAMENTO (active state, render)
// continuam lendo Sidebar.tsx.
// ============================================================

test("grupo Operacao tem os 4 itens na ordem pedida: Central, Modo Turbo, Ver pulseira vinculada, Cronograma", () => {
  const group = slice(adminMenu, 'label: "Operação"', 'label: "Administração"');
  const central = group.indexOf('label: "Central de Operações"');
  const turbo = group.indexOf('label: "Modo Turbo"');
  const pulseira = group.indexOf('label: "Ver pulseira vinculada"');
  const cronograma = group.indexOf('label: "Cronograma"');
  assert.ok(central !== -1 && turbo !== -1 && pulseira !== -1 && cronograma !== -1, "os 4 itens precisam existir no grupo Operação");
  assert.ok(central < turbo && turbo < pulseira && pulseira < cronograma, "ordem incorreta no menu");
});

test("Modo Turbo aponta pra /operacoes/turbo, usa icone de raio, e Ver pulseira vinculada aponta pra /operacoes/pulseira", () => {
  const turboItem = slice(adminMenu, 'label: "Modo Turbo"', 'label: "Ver pulseira vinculada"');
  assert.match(turboItem, /href:\s*"\/operacoes\/turbo"/);
  assert.match(turboItem, /icon:\s*Bolt/);
  const pulseiraItem = slice(adminMenu, 'label: "Ver pulseira vinculada"', 'label: "Cronograma"');
  assert.match(pulseiraItem, /href:\s*"\/operacoes\/pulseira"/);
});

test("Sidebar (desktop) e a navegacao movel nova (header/drawer/bottom nav) importam adminNavGroups/isAdminNavItemVisible do MESMO modulo -- nenhuma lista de rotas/permissoes duplicada", () => {
  assert.match(sidebar, /adminNavGroups as groups/);
  assert.match(sidebar, /isAdminNavItemVisible as isItemVisible/);
  assert.match(sidebar, /from "@\/lib\/navigation\/admin-menu"/);
  assert.doesNotMatch(sidebar, /const groups: (AdminNavGroup|NavGroup)\[\] = \[/);
});

// ============================================================
// 2. Active state -- Central nao fica ativa junto da subarea
// ============================================================

test("active state usa match EXATO quando algum item do menu bate exatamente com o pathname (evita Central ativa junto com Turbo/pulseira)", () => {
  const helper = slice(sidebar, "function isActivePath", "function eventScopedHref");
  assert.match(helper, /if \(hasExactMatch\) return pathname === href;/);
  const component = slice(sidebar, "function SidebarContent", "export function Sidebar");
  assert.match(component, /hasExactMatch/);
  assert.match(component, /isActivePath\(pathname, item\.href, hasExactMatch\)/);
});

test("eventScopedHref inclui /operacoes/turbo e /operacoes/pulseira (evento selecionado propaga pro Turbo/pulseira)", () => {
  assert.match(sidebar, /"\/operacoes\/turbo"/);
  assert.match(sidebar, /"\/operacoes\/pulseira"/);
});

// ============================================================
// 3. Permissoes -- menu E rota/server-side
// ============================================================

test("Modo Turbo no menu exige as permissoes minimas de operacao Turbo (kits.deliver/checkin.scan/store.deliver)", () => {
  const turboItem = slice(adminMenu, 'label: "Modo Turbo"', 'label: "Ver pulseira vinculada"');
  assert.match(turboItem, /permissionAny:\s*\["kits\.deliver",\s*"checkin\.scan",\s*"store\.deliver"\]/);
});

test("toda permissao usada em permissionAny do menu e derivada pelo contexto da Sidebar", () => {
  assert.match(sidebarActions, /getCurrentPermissionMap\(ADMIN_NAV_PERMISSION_CODES\)/);
  assert.match(adminMenu, /ADMIN_NAV_PERMISSION_CODES = Array\.from/);

  const usedCodes = new Set([...adminMenu.matchAll(/permissionAny:\s*\[([^\]]+)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((mm) => mm[1])));

  for (const code of ["kits.deliver", "checkin.scan", "store.deliver"]) {
    assert.ok(usedCodes.has(code), `permissionAny precisa incluir '${code}' pro Modo Turbo aparecer`);
  }
});

test("Ver pulseira vinculada no menu exige wristbands.view", () => {
  const pulseiraItem = slice(adminMenu, 'label: "Ver pulseira vinculada"', 'label: "Cronograma"');
  assert.match(pulseiraItem, /permissionAny:\s*\["wristbands\.view"\]/);
});

test("protecao existe tambem no server -- /operacoes/turbo/page.tsx e /operacoes/pulseira/page.tsx checam permissao antes de renderizar, nao so o menu esconde o item", () => {
  assert.match(turboPage, /await requireAnyPermission\(\["kits\.deliver", "checkin\.scan", "store\.deliver"\]\)/);
  assert.match(pulseiraPage, /await requirePermission\("wristbands\.view"\)/);
});

test("layout de /operacoes ampliado pra requireAnyPermission (nao bloqueia wristbands.view-only ou store.deliver-only nas subareas)", () => {
  assert.match(layout, /await requireAnyPermission\(\[/);
  assert.match(layout, /"wristbands\.view"/);
  assert.match(layout, /"kits\.deliver"/);
  assert.match(layout, /"store\.deliver"/);
  assert.doesNotMatch(layout, /await requirePermission\("participants\.view"\)/);
});

test("getTurboEventsAction usa gate proprio (nao participants.view) -- operador so-de-loja consegue listar eventos pro Turbo", () => {
  const fn = slice(actions, "export async function getTurboEventsAction", "export async function getKitMaterializationPreviewAction");
  assert.match(fn, /await assertAnyPermission\(TURBO_ENTRY_PERMISSIONS\)/);
  assert.doesNotMatch(fn, /assertPermission\("participants\.view"\)/);
});

test("lookupWristbandByQrAction exige exclusivamente wristbands.view (nunca participants.view) pra funcionar pra um operador so-de-pulseira", () => {
  const fn = slice(actions, "export async function lookupWristbandByQrAction", "// ============================================================");
  const firstAssert = fn.match(/await assertPermission\("([^"]+)"\)/);
  assert.ok(firstAssert, "precisa ter um assertPermission logo no inicio da action");
  assert.equal(firstAssert[1], "wristbands.view");
  assert.doesNotMatch(fn, /getOperationTicketDetailsAction|buildTicketDetails/);
});

// ============================================================
// 4. Modo Turbo reaproveitado (rota dedicada, sem duplicacao)
// ============================================================

test("/operacoes/turbo reaproveita o MESMO componente TurboMode (import direto, nenhuma copia/reimplementacao)", () => {
  assert.match(turboClient, /import \{ TurboMode \} from "\.\.\/components\/TurboMode"/);
  assert.match(turboClient, /<TurboMode event={selectedEvent} onExit={handleExit} \/>/);
});

test("Sair do Modo Turbo (rota dedicada) navega de volta pra /operacoes preservando eventId e o ticket em foco", () => {
  const fn = slice(turboClient, "function handleExit");
  assert.match(fn, /query\.set\("eventId", selectedEvent\.id\)/);
  assert.match(fn, /query\.set\("focusTicket", focusTicketId\)/);
  assert.match(fn, /router\.push\(/);
});

test("/operacoes volta a expandir e rolar ate o ticket quando chega via ?focusTicket= (equivalente ao antigo onExit local)", () => {
  assert.match(page, /searchParams\.get\("focusTicket"\)/);
  assert.match(page, /insertAndFocusTicket/);
});

// ============================================================
// 5. Ver pulseira vinculada
// ============================================================

test("Ver pulseira vinculada abre o leitor de QR imediatamente (nao exige selecionar evento antes)", () => {
  const scannerBlock = slice(pulseiraClient, "<QrScanner", "/>");
  assert.match(scannerBlock, /key={scannerKey}/);
  assert.match(scannerBlock, /title="Escaneie a pulseira"/);
  assert.match(scannerBlock, /onRead={handleRead}/);
  assert.match(scannerBlock, /guideLabel="Aproxime a pulseira até o QR ocupar boa parte da área"/);
  assert.match(scannerBlock, /helpMessage="Aproxime a pulseira da câmera e evite reflexos\."/);
});

test("Modo Turbo tambem mostra a guia visual e a dica ao escanear pulseira (mesmo problema relatado: QR de pulseira e mais dificil de reconhecer que o de ingresso)", () => {
  const wristbandScanner = slice(turboMode, 'title="Escaneie a pulseira"', "/>");
  assert.match(wristbandScanner, /guideLabel="Aproxime a pulseira até o QR ocupar boa parte da área"/);
  assert.match(wristbandScanner, /helpMessage="Aproxime a pulseira da câmera e evite reflexos\."/);
});

test("Ver pulseira vinculada reusa QrScanner (useQrCameraScanner com fallback jsQR), nao reimplementa camera", () => {
  assert.match(pulseiraClient, /import \{ QrScanner \} from "\.\.\/components\/QrScanner"/);
  assert.doesNotMatch(pulseiraClient, /getUserMedia|BarcodeDetector/);
});

test("tela de resultado mostra comprador, titular, evento, categoria, status do ingresso e status/vinculo da pulseira", () => {
  const resultCard = slice(pulseiraClient, "function WristbandResultCard");
  assert.match(resultCard, /Comprador/);
  assert.match(resultCard, /Titular do ingresso/);
  assert.match(resultCard, /Evento/);
  assert.match(resultCard, /Categoria/);
  assert.match(resultCard, /Status do ingresso/);
  assert.match(resultCard, /result\.wristband\.status/);
  assert.match(resultCard, /result\.wristband\.linked_at/);
});

test("botoes Ler outra pulseira e Fechar / voltar existem no resultado", () => {
  const resultCard = slice(pulseiraClient, "function WristbandResultCard");
  assert.match(resultCard, /Ler outra pulseira/);
  assert.match(resultCard, /Fechar \/ voltar/);
  assert.match(resultCard, /href="\/operacoes"/);
});

test("consulta de pulseira usa participant_wristbands.code (nao inventa tabela nova) e get_operation_buyers (mesmo caminho canonico de resolucao de comprador ja usado em listOperationTicketsAction/buildTicketDetails)", () => {
  const fn = slice(actions, "export async function lookupWristbandByQrAction");
  assert.match(fn, /\.from\("participant_wristbands"\)/);
  assert.match(fn, /\.rpc\("get_operation_buyers"/);
});
