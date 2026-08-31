// Selecao aleatoria segura do ganhador. Nunca usar Math.random() aqui --
// crypto.getRandomValues() com rejection sampling evita o viés de módulo.
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error("maxExclusive precisa ser um inteiro positivo");
  }

  const array = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  let value: number;
  do {
    crypto.getRandomValues(array);
    value = array[0];
  } while (value >= limit);

  return value % maxExclusive;
}

export function pickSecureRandomEntry<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error("Não há participantes elegíveis para o sorteio.");
  return items[secureRandomInt(items.length)];
}
