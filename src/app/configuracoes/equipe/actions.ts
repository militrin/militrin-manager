"use server";

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const overrideSchema = z.object({
  permission_code: z.string().min(1),
  effect: z.enum(['allow', 'deny']),
});

const saveSchema = z.object({
  targetUserId: z.string().uuid(),
  roleId: z.string().uuid().nullable(),
  isActive: z.boolean(),
  internalNote: z.string().max(2000).nullable(),
  reason: z.string().max(500).nullable(),
  overrides: z.array(overrideSchema),
});

export async function loadUserOverridesAction(sourceUserId: string) {
  await assertPermission('team.view');

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('list_override_state_for_user', {
    p_user_id: sourceUserId,
  });

  if (error) {
    return { success: false, message: error.message, overrides: [] as Array<{ permission_code: string; effect: 'allow' | 'deny' }> };
  }

  const overrides = (data ?? [])
    .map((item: Record<string, unknown>) => ({
      permission_code: String(item.permission_code ?? ''),
      effect: String(item.effect ?? '') === 'deny' ? 'deny' : 'allow',
    }))
    .filter((item: { permission_code: string; effect: 'allow' | 'deny' }) => item.permission_code);

  return { success: true, overrides };
}

export async function saveTeamAccessAction(input: {
  targetUserId: string;
  roleId: string | null;
  isActive: boolean;
  internalNote: string | null;
  reason: string | null;
  overrides: Array<{ permission_code: string; effect: 'allow' | 'deny' }>;
}) {
  await assertPermission('team.edit_permissions');

  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: 'Dados invalidos para salvar permissoes.' };
  }

  const payload = parsed.data;
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase.rpc('upsert_admin_user_access', {
    p_target_user_id: payload.targetUserId,
    p_role_id: payload.roleId,
    p_is_active: payload.isActive,
    p_internal_note: payload.internalNote,
    p_reason: payload.reason,
    p_overrides: payload.overrides,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  const addedPermissions = Array.isArray(data?.added_permissions)
    ? data.added_permissions.map((item: unknown) => String(item))
    : [];
  const removedPermissions = Array.isArray(data?.removed_permissions)
    ? data.removed_permissions.map((item: unknown) => String(item))
    : [];

  revalidatePath('/configuracoes/equipe');
  revalidatePath(`/configuracoes/equipe/${payload.targetUserId}`);

  const additions = addedPermissions.length ? `+ ${addedPermissions.join(', ')}` : '';
  const removals = removedPermissions.length ? `- ${removedPermissions.join(', ')}` : '';
  const summary = [additions, removals].filter(Boolean).join(' | ') || 'Sem alteracoes efetivas de permissao.';

  return {
    success: true,
    message: `Permissoes atualizadas. ${summary}`,
    addedPermissions,
    removedPermissions,
  };
}
