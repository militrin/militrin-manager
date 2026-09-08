import { isInstagramOAuthReason, type InstagramOAuthReason } from "./oauth-errors.ts";

export const INSTAGRAM_OAUTH_SUCCESS_MESSAGE = "Instagram conectado com sucesso.";
export const INSTAGRAM_OAUTH_ERROR_MESSAGE = "Não foi possível concluir a conexão com o Instagram. Tente novamente.";

export type InstagramOAuthFeedback = {
  status: "connected" | "error";
  reason?: InstagramOAuthReason;
  message: string;
};

export function resolveInstagramOAuthFeedback(
  instagram: string | null | undefined,
  reason: string | null | undefined,
): InstagramOAuthFeedback | null {
  if (instagram === "connected") {
    return { status: "connected", message: INSTAGRAM_OAUTH_SUCCESS_MESSAGE };
  }
  if (instagram === "error") {
    return {
      status: "error",
      reason: isInstagramOAuthReason(reason) ? reason : "unknown",
      message: INSTAGRAM_OAUTH_ERROR_MESSAGE,
    };
  }
  return null;
}

export function instagramOAuthRedirectSearch(result: { instagram: "connected" } | { instagram: "error"; reason: InstagramOAuthReason }) {
  if (result.instagram === "connected") return "instagram=connected";
  return `instagram=error&reason=${result.reason}`;
}
