import { redirect } from 'next/navigation';
import { cache } from 'react';
import { isEmailConfirmed } from '@/lib/account/email-confirmation';
import { getCurrentUser, getRequestAuthMetrics, logRequestAuthMetrics } from '@/lib/auth/request-auth';
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

type GrantedPermissionState =
  | { status: 'ok'; codes: Set<string> }
  | { status: 'empty' }
  | { status: 'error' };

const loadGrantedPermissionState = cache(async (): Promise<GrantedPermissionState> => {
  const metrics = getRequestAuthMetrics();
  const user = await getCurrentUser();
  if (!user?.id || !isEmailConfirmed(user)) return { status: 'empty' };

  metrics.permissionRpcCount += 1;
  const started = Date.now();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('current_user_permission_codes');
  metrics.permissionMapMs += Date.now() - started;
  logRequestAuthMetrics();

  if (error) return { status: 'error' };
  const codes = Array.isArray(data) ? data.filter((code): code is string => typeof code === 'string') : [];
  return { status: 'ok', codes: new Set(codes) };
});

export async function getGrantedPermissionCodes() {
  const state = await loadGrantedPermissionState();
  if (state.status !== 'ok') return new Set<string>();
  return state.codes;
}

function isGranted(state: GrantedPermissionState, permissionCode: PermissionCode) {
  if (state.status !== 'ok') return false;
  return state.codes.has(permissionCode);
}

export async function hasPermission(permissionCode: PermissionCode, userId?: string) {
  const user = await getCurrentUser();
  const actorUserId = user?.id ?? null;
  if (!actorUserId || !isEmailConfirmed(user)) return false;

  if (userId && userId !== actorUserId) {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc('user_has_permission', {
      p_user_id: userId,
      p_permission_code: permissionCode,
    });
    if (error) return false;
    return Boolean(data);
  }

  const state = await loadGrantedPermissionState();
  return isGranted(state, permissionCode);
}

export async function requirePermission(permissionCode: PermissionCode) {
  const allowed = await hasPermission(permissionCode);
  if (!allowed) {
    redirect('/acesso-negado');
  }
}

export async function requireAnyPermission(permissionCodes: PermissionCode[]) {
  const state = await loadGrantedPermissionState();
  if (state.status === 'ok' && permissionCodes.some((code) => state.codes.has(code))) return;
  redirect('/acesso-negado');
}

export async function assertPermission(permissionCode: PermissionCode) {
  const allowed = await hasPermission(permissionCode);
  if (!allowed) {
    throw new PermissionDeniedError(permissionCode);
  }
}

export async function getCurrentPermissionMap(permissionCodes: PermissionCode[]) {
  const state = await loadGrantedPermissionState();
  const map: Record<string, boolean> = {};
  for (const code of permissionCodes) {
    map[code] = isGranted(state, code);
  }
  return map;
}
