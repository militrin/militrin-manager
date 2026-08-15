import { createServerSupabaseClient } from '@/lib/supabase/server';

/** Retorna true se o usuário autenticado é um platform_user ativo. */
export async function isPlatformUser(userId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('is_platform_user', { p_user_id: userId });
  return Boolean(data);
}

/** Retorna true se o usuário autenticado é um platform owner ativo. */
export async function isPlatformOwner(userId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('is_platform_owner', { p_user_id: userId });
  return Boolean(data);
}

/** Retorna true se o usuário é membro ativo da organização informada. */
export async function isOrganizationMember(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('is_organization_member', {
    p_user_id: userId,
    p_organization_id: organizationId,
  });
  return Boolean(data);
}

/** Retorna true se o usuário é owner da organização informada. */
export async function isOrganizationOwner(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('is_organization_owner', {
    p_user_id: userId,
    p_organization_id: organizationId,
  });
  return Boolean(data);
}

/**
 * Redireciona para /acesso-negado se o usuário não for platform_user ativo.
 * Use em layouts de rotas da plataforma.
 */
export async function requirePlatformAccess(): Promise<string> {
  const { redirect } = await import('next/navigation');
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/entrar?next=/plataforma');

  const allowed = await isPlatformUser(user!.id);
  if (!allowed) redirect('/acesso-negado');

  return user!.id;
}
