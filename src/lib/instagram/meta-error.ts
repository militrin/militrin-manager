type MetaErrorShape = {
  error?: {
    code?: number | string;
    error_subcode?: number | string;
    type?: string;
    message?: string;
  };
  error_type?: string;
  error_message?: string;
  code?: number | string;
};

export function sanitizeMetaErrorMessage(message: unknown) {
  if (typeof message !== "string" || !message.trim()) return "operacao_meta_falhou";
  return message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(access_token|client_secret|app_secret|code|signed_request)=[^&\s]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]")
    .slice(0, 180);
}

export function readMetaError(status: number, body: unknown) {
  const record = body && typeof body === "object" ? (body as MetaErrorShape) : {};
  const nested = record.error && typeof record.error === "object" ? record.error : null;
  const errorCode = nested?.code ?? nested?.error_subcode ?? record.code;
  const errorType = nested?.type ?? record.error_type;
  const message = nested?.message ?? record.error_message;
  return {
    httpStatus: status,
    errorCode: errorCode == null ? undefined : errorCode,
    errorType: typeof errorType === "string" && errorType.trim() ? errorType : undefined,
    sanitizedMessage: sanitizeMetaErrorMessage(message),
  };
}
