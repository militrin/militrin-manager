import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wizardPath = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);
const summaryCardPath = new URL('../src/app/painel/eventos/[id]/event-summary-card.tsx', import.meta.url);
const buyerPreviewPath = new URL('../src/app/painel/eventos/[id]/buyer-presentation-preview.tsx', import.meta.url);
const categoriesUiPath = new URL('../src/app/categorias/ui.tsx', import.meta.url);
const pagePath = new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url);

async function source(url) {
  return readFile(url, 'utf8');
}

test('checkout publico usa a regra compartilhada de apresentacao (nao reimplementa o corte 0/1/2+)', async () => {
  const src = await source(wizardPath);
  assert.match(src, /import \{ resolveTicketPresentationMode \} from '@\/lib\/checkout\/ticket-presentation';/);
  assert.match(src, /const ticketPresentationMode = resolveTicketPresentationMode\(activeCategories\.length\);/);
});

test('preview administrativo usa a MESMA funcao compartilhada que o checkout (mesma regra, mesma fonte)', async () => {
  const src = await source(buyerPreviewPath);
  assert.match(src, /import \{ resolveTicketPresentationMode \} from "@\/lib\/checkout\/ticket-presentation";/);
  assert.match(src, /const mode = resolveTicketPresentationMode\(activeCategories\.length\);/);
});

test('1 categoria ativa: checkout esconde o nome da categoria e mostra so o lote', async () => {
  const src = await source(wizardPath);
  assert.match(src, /const shouldShowCategoryLabel = ticketPresentationMode === 'category_visible';/);
  // As linhas de "Categoria:"/"Tipo:" ficam condicionadas a shouldShowCategoryLabel
  // em todos os resumos (mobile, lateral, etapa 1, pagamento, confirmacao final).
  const guardedOccurrences = (src.match(/shouldShowCategoryLabel \?/g) ?? []).length;
  assert.ok(guardedOccurrences >= 5, `esperava pelo menos 5 pontos condicionados por shouldShowCategoryLabel, achou ${guardedOccurrences}`);
});

test('2+ categorias: checkout mostra categoria e lote juntos (nenhuma linha suprimida)', async () => {
  const src = await source(wizardPath);
  // Em category_visible, shouldShowCategoryLabel e true, entao as linhas de
  // categoria voltam a aparecer ao lado das linhas de lote (que nunca sao
  // condicionadas por shouldShowCategoryLabel).
  assert.match(src, /\{isSingleTicketEvent \? 'Ingresso' : 'Lote'\}: \{batchDisplayLabel\}/);
});

test('preview administrativo: 1 categoria mostra so o lote (sem nome de categoria), 2+ mostram categoria e lote', async () => {
  const src = await source(buyerPreviewPath);
  assert.match(src, /mode === "category_hidden"[\s\S]*?current_batch_name/);
  assert.match(src, /activeCategories\.map\(\(category\) => \([\s\S]*?category\.name[\s\S]*?current_batch_name/);
});

test('preview administrativo nunca infere preco de lote inexistente como zero: mostra estado explicito quando nao confirmado', async () => {
  const src = await source(buyerPreviewPath);
  assert.match(src, /singleTicketPrice\?\.price_confirmed \?/);
  assert.match(src, /ainda não configurado/);
});

test('banner pertence ao card do evento, nunca a categoria', async () => {
  const summarySrc = await source(summaryCardPath);
  assert.match(summarySrc, /banner_card_url \|\| event\.banner_hero_url/);

  const categoriesSrc = await source(categoriesUiPath);
  assert.doesNotMatch(categoriesSrc, /banner_card_url|banner_hero_url|<img/);
});

test('descricao do evento e compacta (line-clamp) e expande ao clicar', async () => {
  const src = await source(summaryCardPath);
  assert.match(src, /const \[expanded, setExpanded\] = useState\(false\);/);
  assert.match(src, /line-clamp-2/);
  assert.match(src, /onClick=\{\(\) => setExpanded\(\(prev\) => !prev\)\}/);
});

test('card do evento e reutilizado na pagina administrativa sem duplicar dados (mesmo objeto event)', async () => {
  const src = await source(pagePath);
  assert.match(src, /<EventSummaryCard\s*\n\s*event=\{\{/);
  assert.match(src, /name: event\.name,/);
  assert.match(src, /banner_card_url: event\.banner_card_url,/);
});

test('preview administrativo e o checkout recebem exatamente os mesmos dados de categoria/lote do backend (get_event_ticket_categories)', async () => {
  const src = await source(pagePath);
  assert.match(src, /current_batch_name: row\.current_batch_name/);
  assert.match(src, /current_male_price: row\.current_male_price/);
  assert.match(src, /<BuyerPresentationPreview/);
});
