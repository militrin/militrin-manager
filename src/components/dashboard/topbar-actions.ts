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

  // admin_users/admin_roles tem RLS habilitado SEM NENHUMA policy -- RLS
  // ligado + zero policies = a role "authenticated" nunca enxerga nenhuma
  // linha nessas duas tabelas via .from(...), pra ninguem. Nunca ler essas
  // tabelas direto; sempre por RPC SECURITY DEFINER (mesma fonte de verdade
  // usada em Equipe/permissões).
  //
  // get_current_admin_role() (migration 20260886000000, local, NAO aplicada
  // ainda) e a fonte canonica: autoconsulta via auth.uid(), sem parametro de
  // outro usuario, resolve os 6 papeis (Owner/Administrador/Operacional/
  // Financeiro/Marketing/Visualizador) igual. Enquanto a migration nao for
  // aplicada, a chamada falha (funcao inexistente) e cai no fallback abaixo
  // -- get_admin_user_profile, que já está em produção mas exige 'team.view'
  // (só Owner via bypass e Administrador via preset "todas as permissões"
  // resolvem por ela; os outros 4 papéis continuam em "Sem função" até a
  // migration ser aplicada). Sem regressão em nenhum dos dois estados.
  const [{ data: profile }, selfRoleResult] = await Promise.all([
    supabase
      .from("customer_profiles")
      .select("full_name")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.rpc("get_current_admin_role"),
  ]);

  const profileName = String(profile?.full_name ?? "").trim();
  const fullName = profileName || fallbackNameFromEmail(user.email);

  let roleName = "Sem função";
  const selfRole = Array.isArray(selfRoleResult.data) ? selfRoleResult.data[0] : selfRoleResult.data;
  if (!selfRoleResult.error && selfRole?.is_active && selfRole.role_name) {
    roleName = String(selfRole.role_name);
  } else {
    const fallbackResult = await supabase.rpc("get_admin_user_profile", { p_user_id: user.id });
    const adminProfile = Array.isArray(fallbackResult.data) ? fallbackResult.data[0] : fallbackResult.data;
    if (!fallbackResult.error && adminProfile?.is_active && adminProfile.role_name) {
      roleName = String(adminProfile.role_name);
    }
  }

  return {
    success: true as const,
    identity: {
      initials: resolveParticipantInitials(fullName),
      fullName,
      roleName,
    },
  };
}
