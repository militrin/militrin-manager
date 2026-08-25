const PRODUCTION_APP_ORIGIN = 'https://www.militrin.com.br';

export function appBaseUrl() {
  if (process.env.NODE_ENV === 'production') return PRODUCTION_APP_ORIGIN;

  const configured = String(process.env.NEXT_PUBLIC_APP_URL ?? '').trim();
  if (!configured) return 'http://localhost:3000';

  try {
    const parsed = new URL(configured);
    return parsed.origin;
  } catch {
    return 'http://localhost:3000';
  }
}

export { PRODUCTION_APP_ORIGIN };
