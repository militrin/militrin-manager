type RpcErrorLike = { code?: string | null; message?: string | null } | null | undefined;

export function isUndefinedDatabaseFunction(error: RpcErrorLike, functionName: string) {
  if (!error) return false;

  const code = String(error.code ?? "");
  const message = String(error.message ?? "");
  const normalizedMessage = message.toLowerCase();
  const normalizedName = functionName.toLowerCase();

  if (!normalizedName || !normalizedMessage.includes(normalizedName)) return false;
  if (code === "42501" || code === "P0001") return false;
  if (/permission|sem permiss[aã]o|acesso negado|not authorized|jwt/i.test(message)) return false;

  return code === "42883"
    || code === "PGRST202"
    || /could not find the function|does not exist/i.test(message);
}
