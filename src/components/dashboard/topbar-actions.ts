"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveParticipantInitials } from "@/lib/account/participant-identity";

function fallbackNameFromEmail(email: string | null | undefined) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized.includes("@")) return "Usuário";
  return normalized.split("@")[0] || "Usuário";
}

export async function getTopbarIdentityAction() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return {
      success: true as const,
      identity: {
        initials: "--",
        fullName: "Usuário",
        roleName: "Sem função",
      },
    };
  }

  const [{ data: profile }, { data: adminAccess }] = await Promise.all([
    supabase
      .from("customer_profiles")
      .select("full_name")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("admin_users")
      .select("is_active, admin_roles(name)")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const profileName = String(profile?.full_name ?? "").trim();
  const fullName = profileName || fallbackNameFromEmail(user.email);
  const roleObj = Array.isArray(adminAccess?.admin_roles) ? adminAccess.admin_roles[0] : adminAccess?.admin_roles;
  const roleName = adminAccess?.is_active ? String(roleObj?.name ?? "Sem função") : "Sem função";

  return {
    success: true as const,
    identity: {
      initials: resolveParticipantInitials(fullName),
      fullName,
      roleName,
    },
  };
}
