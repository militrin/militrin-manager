import { redirect } from 'next/navigation';
import { isEmailConfirmed } from '@/lib/account/email-confirmation';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export type PermissionCode = string;

export class PermissionDeniedError extends Error {
  code: PermissionCode;

  constructor(code: PermissionCode, message?: string) {
    super(message ?? `Permissao negada: ${code}`);
    this.name = 'PermissionDeniedError';
    this.code = code;
  }
}

export async function hasPermission(permissionCode: PermissionCode, userId?: string) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const actorUserId = user?.id ?? null;
  if (!actorUserId || !isEmailConfirmed(user)) return false;

  if (userId && userId !== actorUserId) {
    const { data, error } = await supabase.rpc('user_has_permission', {
      p_user_id: userId,
      p_permission_code: permissionCode,
    });

    if (error) return false;
    return Boolean(data);
  }

  const { data, error } = await supabase.rpc('current_user_has_permission', {
    p_permission_code: permissionCode,
  });

  if (error) return false;
  return Boolean(data);
}

export async function requirePermission(permissionCode: PermissionCode) {
  const allowed = await hasPermission(permissionCode);
  if (!allowed) {
    redirect('/acesso-negado');
  }
}

export async function requireAnyPermission(permissionCodes: PermissionCode[]) {
  for (const code of permissionCodes) {
    if (await hasPermission(code)) return;
  }
  redirect('/acesso-negado');
}

export async function assertPermission(permissionCode: PermissionCode) {
  const allowed = await hasPermission(permissionCode);
  if (!allowed) {
    throw new PermissionDeniedError(permissionCode);
  }
}

export async function getCurrentPermissionMap(permissionCodes: PermissionCode[]) {
  const map: Record<string, boolean> = {};
  await Promise.all(
    permissionCodes.map(async (code) => {
      map[code] = await hasPermission(code);
    }),
  );
  return map;
}
