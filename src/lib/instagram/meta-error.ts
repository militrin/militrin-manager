type MetaErrorShape = {
  error?: {
    code?: number | string;
    error_subcode?: number | string;
    type?: string;
    message?: string;
    fbtrace_id?: string;
  };
  error_type?: string;
  error_message?: string;
  code?: number | string;
  fbtrace_id?: string;
};

const FORBIDDEN_LOG_KEYS = new Set([
  "access_token",
  "refresh_token",
  "token",
  "authorization",
  "code",
  "client_secret",
  "app_secret",
  "encryption_key",
  "signed_request",
  "encrypted_access_token",
  "cookie",
  "username",
  "iguserid",
  "url",
  "href",
]);

export type InstagramGraphFailureKind =
  | "permission"
  | "expired_token"
  | "rate_limit"
  | "media_not_found"
  | "network"
  | "timeout"
  | "invalid_response"
  | "unknown";

export type InstagramIntegrationSurface = "media" | "comments";

export type InstagramGraphErrorDetails = {
  httpStatus: number;
  errorCode?: number | string;
  errorSubcode?: number | string;
  errorType?: string;
  fbtraceId?: string;
  sanitizedMessage: string;
};

export type InstagramIntegrationUserCopy = {
  message: string;
  detail: string;
  reconnectRequired: boolean;
  canReconnect: boolean;
};

export function sanitizeMetaErrorMessage(message: unknown) {
  if (typeof message !== "string" || !message.trim()) return "operacao_meta_falhou";
  return message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(access_token|client_secret|app_secret|code|signed_request)=[^&\s]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]")
    .slice(0, 180);
}

function numericCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function readFbtraceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(trimmed)) return undefined;
  return trimmed;
}

export function readMetaError(status: number, body: unknown): InstagramGraphErrorDetails {
  const record = body && typeof body === "object" ? (body as MetaErrorShape) : {};
  const nested = record.error && typeof record.error === "object" ? record.error : null;
  const errorCode = nested?.code ?? record.code;
  const errorSubcode = nested?.error_subcode;
  const errorType = nested?.type ?? record.error_type;
  const message = nested?.message ?? record.error_message;
  return {
    httpStatus: status,
    errorCode: errorCode == null ? undefined : errorCode,
    errorSubcode: errorSubcode == null ? undefined : errorSubcode,
    errorType: typeof errorType === "string" && errorType.trim() ? errorType : undefined,
    fbtraceId: readFbtraceId(nested?.fbtrace_id ?? record.fbtrace_id),
    sanitizedMessage: sanitizeMetaErrorMessage(message),
  };
}

export function classifyInstagramGraphFailure(input: {
  httpStatus?: number;
  errorCode?: number | string;
  errorSubcode?: number | string;
  timedOut?: boolean;
  jsonParseFailed?: boolean;
  networkError?: boolean;
}): InstagramGraphFailureKind {
  if (input.timedOut) return "timeout";
  if (input.jsonParseFailed) return "invalid_response";
  if (input.networkError) return "network";
  const status = input.httpStatus ?? 0;
  const code = numericCode(input.errorCode);
  const subcode = numericCode(input.errorSubcode);
  if (code === 190 || subcode === 463 || subcode === 467 || status === 401) return "expired_token";
  if (code === 10 || code === 200 || subcode === 33) return "permission";
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) return "rate_limit";
  if (code === 100 || status === 404) return "media_not_found";
  if (status === 0) return "network";
  if (status >= 500) return "unknown";
  return "unknown";
}

export function reconnectRequiredForKind(kind: InstagramGraphFailureKind) {
  return kind === "permission" || kind === "expired_token";
}

export function instagramIntegrationUserCopy(
  surface: InstagramIntegrationSurface,
  kind: InstagramGraphFailureKind,
): InstagramIntegrationUserCopy {
  const message = surface === "comments"
    ? "Não foi possível sincronizar os comentários do Instagram."
    : "Não foi possível carregar as publicações do Instagram.";
  const reconnectRequired = reconnectRequiredForKind(kind);
  if (kind === "permission") {
    return {
      message,
      detail: "A Meta negou a permissão necessária para consultar esta conta.",
      reconnectRequired,
      canReconnect: reconnectRequired,
    };
  }
  if (kind === "expired_token") {
    return {
      message,
      detail: "A conexão com o Instagram expirou. Reconecte a conta.",
      reconnectRequired,
      canReconnect: reconnectRequired,
    };
  }
  if (kind === "rate_limit") {
    return {
      message,
      detail: "O limite temporário de chamadas da Meta foi atingido. Tente novamente mais tarde.",
      reconnectRequired,
      canReconnect: reconnectRequired,
    };
  }
  if (kind === "media_not_found") {
    return {
      message,
      detail: surface === "comments"
        ? "A publicação não foi encontrada ou não está acessível pela conta conectada."
        : "A Meta não encontrou publicações acessíveis para esta consulta.",
      reconnectRequired,
      canReconnect: reconnectRequired,
    };
  }
  if (kind === "timeout") {
    return {
      message,
      detail: "A consulta à Meta excedeu o tempo limite. Tente novamente.",
      reconnectRequired,
      canReconnect: reconnectRequired,
    };
  }
  if (kind === "network") {
    return {
      message,
      detail: "Não foi possível falar com a Meta. Verifique a conexão e tente novamente.",
      reconnectRequired,
      canReconnect: reconnectRequired,
    };
  }
  if (kind === "invalid_response") {
    return {
      message,
      detail: "A Meta devolveu uma resposta inválida. Tente novamente.",
      reconnectRequired,
      canReconnect: reconnectRequired,
    };
  }
  return {
    message,
    detail: "Não foi possível concluir a operação com o Instagram. Tente novamente.",
    reconnectRequired,
    canReconnect: reconnectRequired,
  };
}

export function instagramMediaLoadUserCopy(kind: InstagramGraphFailureKind) {
  return instagramIntegrationUserCopy("media", kind);
}

export function instagramCommentsSyncUserCopy(kind: InstagramGraphFailureKind) {
  return instagramIntegrationUserCopy("comments", kind);
}

export function logInstagramGraphEvent(payload: Record<string, unknown>) {
  const clean: Record<string, unknown> = { src: "instagram-graph" };
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_LOG_KEYS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    clean[key] = value;
  }
  console.info("[instagram-graph]", JSON.stringify(clean));
}
