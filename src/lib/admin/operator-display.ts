const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidLike(value: string | null | undefined): boolean {
  return Boolean(value && UUID_RE.test(String(value).trim()));
}

export function maskOperatorEmail(value: unknown): string | null {
  const email = String(value ?? "").trim();
  const at = email.indexOf("@");
  if (at <= 0) return null;
  return `${email.slice(0, 2)}***@${email.slice(at + 1)}`;
}

/**
 * Rótulo operacional de um ator humano.
 * Prioridade: nome resolvido → e-mail mascarado → "Operador".
 * Nunca devolve UUID cru. Sem ator identificado, "Sistema".
 */
export function formatOperatorDisplayName(input: {
  resolvedName?: string | null;
  actorEmail?: string | null;
  actorUserId?: string | null;
  actorOrigin?: string | null;
}): string {
  const name = String(input.resolvedName ?? "").trim();
  if (name && !isUuidLike(name)) return name;
  const masked = maskOperatorEmail(input.actorEmail);
  if (masked) return masked;
  if (input.actorOrigin === "portal") return "Titular autenticado";
  if (input.actorUserId) return "Operador";
  return "Sistema";
}
