import { isGatewayTimeoutError } from "./gateway-timeout.ts";

export class AsaasApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(path: string, status: number, message: string, body: unknown = null) {
    super(`Asaas API error (${path}): ${message}`);
    this.name = "AsaasApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asaasErrorStatus(error: unknown): number | null {
  if (error instanceof AsaasApiError) return error.status;
  const match = errorText(error).match(/HTTP (\d{3})/);
  return match ? Number(match[1]) : null;
}

export function isAsaasNotFoundError(error: unknown): boolean {
  if (asaasErrorStatus(error) === 404) return true;
  return /not found|n[aã]o encontrado|does not exist/i.test(errorText(error));
}

export function isAsaasPaymentAlreadyDeletedError(error: unknown): boolean {
  if (isAsaasNotFoundError(error)) return true;
  return /already deleted|j[aá] (foi )?(removid|exclu[ií]d)|payment deleted/i.test(errorText(error));
}

export function isAsaasPaymentNotDeletableError(error: unknown): boolean {
  const status = asaasErrorStatus(error);
  const text = errorText(error);
  if (status !== 400 && status !== 409) {
    return /received|recebid|confirmad|j[aá] (foi )?paga|cannot be (deleted|removed)|n[aã]o [eé] poss[ií]vel remover/i.test(text);
  }
  return /received|recebid|confirmad|paid|invalid_action|cannot be (deleted|removed)|n[aã]o [eé] poss[ií]vel remover/i.test(text);
}

export function isAsaasRetryableError(error: unknown): boolean {
  if (isGatewayTimeoutError(error)) return true;
  const status = asaasErrorStatus(error);
  if (status === 429 || (status != null && status >= 500)) return true;
  return /ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network|indispon|socket/i.test(errorText(error));
}
