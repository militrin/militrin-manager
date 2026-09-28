/**
 * Unwrap de QR/URL para o identificador canônico (token do ingresso ou
 * código cru da pulseira). Mesma regra do scanner operacional: query
 * `token`, último segmento do path, ou o texto cru.
 *
 * Buscar ≠ operar: este parser só normaliza a entrada.
 */
export function parseTokenCandidate(rawValue: string) {
  const value = rawValue.trim();
  if (!value) return "";

  try {
    const url = new URL(value);
    return url.searchParams.get("token") ?? url.pathname.split("/").filter(Boolean).pop() ?? value;
  } catch {
    return value;
  }
}
