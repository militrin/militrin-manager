export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export function getHeader(headers: HeaderBag, key: string): string | null {
  if (headers instanceof Headers) return headers.get(key);
  const value = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
