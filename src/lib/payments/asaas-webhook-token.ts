import { getHeader, type HeaderBag } from "./http-headers.ts";

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function verifyAsaasWebhookToken(input: {
  headers: HeaderBag;
  webhookToken: string;
  previousWebhookToken?: string | null;
}): boolean {
  const token = getHeader(input.headers, "asaas-access-token");
  if (!token) return false;
  if (timingSafeEqualString(token, input.webhookToken)) return true;
  const previous = input.previousWebhookToken?.trim() || null;
  if (previous && timingSafeEqualString(token, previous)) return true;
  return false;
}
