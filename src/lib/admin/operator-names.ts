import "server-only";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { isUuidLike } from "@/lib/admin/operator-display";

/**
 * Resolve nomes de operador a partir de actor_user_id (auth.users.id).
 * admin_users nao guarda nome nenhum -- so role/status -- entao a cadeia e:
 * customer_profiles.full_name (cadastro do titular, quando o admin tambem e
 * um participante) -> nome/e-mail do Admin Auth API (fallback universal,
 * cobre qualquer admin autenticado) -> ausente (chamador decide o fallback,
 * normalmente "Operador administrativo").
 *
 * Nunca usar isto para decidir SE uma acao teve operador humano -- so para
 * resolver o NOME de um actor_user_id que ja se sabe existir. Uma acao sem
 * actor_user_id (self-service/automacao real) continua sendo "Sistema".
 */
export async function resolveOperatorNames(userIds: string[]): Promise<Map<string, string>> {
  const distinctIds = [...new Set(userIds.filter(Boolean))];
  const names = new Map<string, string>();
  if (!distinctIds.length) return names;

  const admin = createServiceRoleSupabaseClient();

  const { data: profiles } = await admin.from("customer_profiles").select("user_id,full_name").in("user_id", distinctIds);
  for (const profile of profiles ?? []) {
    const fullName = String(profile.full_name ?? "").trim();
    if (fullName) names.set(String(profile.user_id), fullName);
  }

  const missingIds = distinctIds.filter((id) => !names.has(id));
  if (missingIds.length) {
    const results = await Promise.all(
      missingIds.map(async (id) => {
        try {
          const { data } = await admin.auth.admin.getUserById(id);
          const user = data?.user;
          if (!user) return null;
          const metadataName = String((user.user_metadata as Record<string, unknown> | null)?.full_name ?? "").trim();
          const email = String(user.email ?? "").trim();
          const resolved = metadataName || (email ? email.split("@")[0] : "");
          return resolved ? ([id, resolved] as const) : null;
        } catch {
          return null;
        }
      }),
    );
    for (const entry of results) if (entry) names.set(entry[0], entry[1]);
  }

  return names;
}

/**
 * Rótulo da conta proprietária na ficha administrativa.
 * Usa o mesmo resolvedor de nomes da timeline (service role), porque o
 * client autenticado muitas vezes não lê customer_profiles do titular.
 */
export async function resolveLinkedAccountLabel(userId: string | null | undefined): Promise<string> {
  if (!userId) return "Proprietário não definido";
  const names = await resolveOperatorNames([userId]);
  const name = String(names.get(userId) ?? "").trim();
  if (name && !isUuidLike(name)) return name;
  return "Conta vinculada";
}
