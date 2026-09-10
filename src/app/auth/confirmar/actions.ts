"use server";

import { redirect } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { safeAuthDestination } from "@/lib/auth/callback-destinations";
import { categorizeInviteError, logSanitizedAuthLinkFailure, type InviteLinkKind } from "@/lib/auth/invite-error-copy";
import { createPasswordRecoveryState } from "@/lib/account/password-recovery-state";
import { markFirstAccessAuthConfirmed } from "@/lib/account/first-access-invite-dispatch";

const allowedOtpTypes = new Set<EmailOtpType>(["invite", "signup", "magiclink", "recovery", "email", "email_change"]);

function linkKindFor(type: string | null): InviteLinkKind {
  if (type === "recovery") return "recovery";
  if (type === "signup" || type === "email" || type === "email_change") return "signup";
  if (type === "magiclink") return "magiclink";
  return "invite";
}

export async function confirmFirstAccessOtpAction(formData: FormData) {
  const tokenHash = String(formData.get("token_hash") ?? "");
  const typeParam = String(formData.get("type") ?? "");
  const nextParam = String(formData.get("next") ?? "");
  const kind = linkKindFor(typeParam);
  const fallbackDestination = kind === "recovery" ? "/redefinir-senha" : "/primeiro-acesso";
  const destination = safeAuthDestination(nextParam || null, fallbackDestination);

  if (!tokenHash || !allowedOtpTypes.has(typeParam as EmailOtpType)) {
    logSanitizedAuthLinkFailure({ kind, category: "invalid", rawCode: "missing_or_unsupported_type" });
    redirect(`/auth/callback?linkError=invalid&kind=${kind}`);
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.verifyOtp({
    type: typeParam as EmailOtpType,
    token_hash: tokenHash,
  });

  if (error) {
    const category = categorizeInviteError({ message: error.message, code: (error as { code?: string }).code ?? null });
    logSanitizedAuthLinkFailure({ kind, category, rawCode: (error as { code?: string }).code ?? null });
    redirect(`/auth/callback?linkError=${category}&kind=${kind}`);
  }

  const userId = data.user?.id;
  if (userId && kind !== "recovery") {
    const inviteId = typeof data.user?.user_metadata?.participant_invite_id === "string"
      ? data.user.user_metadata.participant_invite_id
      : null;
    await markFirstAccessAuthConfirmed(userId, inviteId);
  }

  if (kind === "recovery") {
    const email = data.user?.email ?? "";
    const recoveryState = createPasswordRecoveryState(email);
    redirect(`/redefinir-senha?recovery=${encodeURIComponent(recoveryState)}`);
  }

  redirect(destination);
}
