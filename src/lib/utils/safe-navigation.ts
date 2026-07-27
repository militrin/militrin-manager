export function sanitizeInternalNextPath(input: string | null | undefined, fallback = '/minha-conta') {
  const raw = String(input ?? '').trim();
  if (!raw) return fallback;

  // Only allow same-origin relative paths.
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  if (raw.includes('\\')) return fallback;

  const lower = raw.toLowerCase();
  if (lower.startsWith('/http:') || lower.startsWith('/https:') || lower.startsWith('/javascript:') || lower.startsWith('/data:')) {
    return fallback;
  }

  try {
    const parsed = new URL(raw, 'http://localhost');
    const result = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return result.startsWith('/') ? result : fallback;
  } catch {
    return fallback;
  }
}

export function resolvePostAuthDestination(input: {
  nextPath?: string | null;
  wizardPath?: string | null;
  fallback?: string;
}) {
  const fallback = input.fallback ?? '/minha-conta';

  if (input.nextPath) {
    return sanitizeInternalNextPath(input.nextPath, fallback);
  }

  if (input.wizardPath) {
    return sanitizeInternalNextPath(input.wizardPath, fallback);
  }

  return fallback;
}

export function sanitizePostFirstAccessNextPath(input: string | null | undefined, fallback = '/minha-conta') {
  const safe = sanitizeInternalNextPath(input, fallback);
  if (safe === '/primeiro-acesso' || safe.startsWith('/primeiro-acesso?') || safe.startsWith('/primeiro-acesso/')) {
    return fallback;
  }
  return safe;
}
