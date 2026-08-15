const EMPTY_PRESENTATION_VALUES = new Set([
  '',
  '-',
  'n/a',
  'sem camiseta',
  'sem kit',
]);

export function optionalDisplayValue(value: unknown) {
  const text = String(value ?? '').trim();
  return EMPTY_PRESENTATION_VALUES.has(text.toLowerCase()) ? null : text;
}
