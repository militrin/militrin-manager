/**
 * Gera no maximo `maxDots` posicoes-alvo representativas para os indicadores
 * de um carrossel, mesmo quando o total de itens e muito maior que isso
 * (ex.: 20 ingressos nao viram 20 bolinhas). Distribuidas uniformemente do
 * primeiro ao ultimo item; clicar num indicador pula para o item mais
 * proximo daquela posicao.
 */
export function buildCarouselDotTargets(total: number, maxDots = 5): number[] {
  if (total <= 0) return [];
  if (total <= maxDots) return Array.from({ length: total }, (_, index) => index);

  return Array.from({ length: maxDots }, (_, dotIndex) => Math.round((dotIndex * (total - 1)) / (maxDots - 1)));
}

/** Indice do indicador cujo alvo esta mais proximo do indice atual do carrossel. */
export function findActiveDotIndex(targets: number[], currentIndex: number): number {
  if (targets.length === 0) return -1;
  let closest = 0;
  let smallestDistance = Math.abs(targets[0] - currentIndex);
  for (let i = 1; i < targets.length; i += 1) {
    const distance = Math.abs(targets[i] - currentIndex);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      closest = i;
    }
  }
  return closest;
}
