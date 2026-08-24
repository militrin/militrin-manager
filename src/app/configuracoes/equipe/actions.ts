"use server";

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function searchPromotableUsersAction(term: string) {
  await assertPermission('team.edit_permissions');

  const parsed = z.string().trim().min(3).max(200).safeParse(term);
  if (!parsed.success) {
    return { success: false, message: 'Informe ao menos 3 caracteres para buscar.', results: [] as Array<{ userId: string; fullName: string; maskedEmail: string }> };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('search_promotable_admin_users', { p_term: parsed.data });

  if (error) {
    return { success: false, message: error.message, results: [] as Array<{ userId: string; fullName: string; maskedEmail: string }> };
  }

  const results = (data ?? []).map((row: Record<string, unknown>) => ({
    userId: String(row.user_id),
    fullName: String(row.full_name ?? ''),
    maskedEmail: String(row.masked_email ?? ''),
  }));

  return { success: true, results };
}

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
  isActive: z.boolean().optional(),
  internalNote: z.string().max(2000).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
  contactId: z.string().uuid().optional(),
});

// Unico ponto de escrita de "promover conta existente a membro da equipe" --
// tanto o modal de Equipe ("+ Adicionar membro") quanto o botao "Adicionar
// à equipe" na ficha de Cadastros chamam esta MESMA action (nunca uma copia
// paralela), que por sua vez reusa o RPC canonico upsert_admin_user_access
// (o mesmo do editor completo de acesso). isActive/internalNote/reason sao
// opcionais para nao quebrar o caller mais antigo (modal de Equipe, que so
// pede a funcao base) -- quando omitidos, mantem exatamente o
// comportamento historico (ativo, sem nota, motivo padrao).
export async function addTeamMemberAction(input: {
  userId: string;
  roleId: string;
  isActive?: boolean;
  internalNote?: string | null;
  reason?: string | null;
  contactId?: string;
}) {
  await assertPermission('team.edit_permissions');

  const parsed = addMemberSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: 'Selecione um usuário e uma função válidos.' };
  }

  const supabase = await createServerSupabaseClient();

  // "Nao permitir promover a propria conta de forma incoerente" -- o RPC de
  // busca ja exclui o proprio ator dos resultados (quem chega aqui com
  // permissao pra isso ja e um admin_users ativo, entao nunca apareceria
  // como "promovivel"), mas o guard fica explicito aqui tambem: nenhum
  // caminho, direto ou pela UI, adiciona a propria conta por este fluxo.
  const {
    data: { user: actor },
  } = await supabase.auth.getUser();
  if (actor && actor.id === parsed.data.userId) {
    return { success: false, message: 'Você já tem acesso à equipe -- não é possível se adicionar por este fluxo.' };
  }

  // Reaproveita o RPC canonico existente (mesmo caminho do editor completo
  // de acesso) -- nenhum sistema de permissao novo, nenhuma segunda logica
  // de upsert em admin_users.
  const { error } = await supabase.rpc('upsert_admin_user_access', {
    p_target_user_id: parsed.data.userId,
    p_role_id: parsed.data.roleId,
    p_is_active: parsed.data.isActive ?? true,
    p_internal_note: parsed.data.internalNote ?? null,
    p_overrides: [],
    p_reason: parsed.data.reason?.trim() || 'Adicionado via fluxo "Adicionar membro"',
  });

  if (error) {
    return { success: false, message: error.message };
  }

  revalidatePath('/painel/configuracoes/equipe');
  revalidatePath('/configuracoes/equipe');
  if (parsed.data.contactId) {
    revalidatePath(`/cadastros/${parsed.data.contactId}`);
  }

  return { success: true, message: 'Membro adicionado com sucesso.' };
}

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

  revalidatePath('/painel/configuracoes/equipe');
  revalidatePath(`/painel/configuracoes/equipe/${payload.targetUserId}`);
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

const saveRolePermissionsSchema = z.object({
  roleId: z.string().uuid(),
  permissionCodes: z.array(z.string().min(1)),
  reason: z.string().max(500).nullable(),
});

function summarizeRolePermissionChange(addedPermissions: string[], removedPermissions: string[]) {
  const additions = addedPermissions.length ? `+ ${addedPermissions.join(', ')}` : '';
  const removals = removedPermissions.length ? `- ${removedPermissions.join(', ')}` : '';
  return [additions, removals].filter(Boolean).join(' | ') || 'Sem alteracoes efetivas de permissao.';
}

// Mutacao real (validacao de permissao, escalada de privilegio, protecao da
// funcao Owner e da "ultima pessoa que administra equipe") mora inteira no
// RPC upsert_admin_role_permissions -- este action so e a ponte HTTP+auth de
// pagina, exatamente como saveTeamAccessAction ja faz pro editor individual.
export async function saveRolePermissionsAction(input: { roleId: string; permissionCodes: string[]; reason: string | null }) {
  await assertPermission('team.edit_permissions');

  const parsed = saveRolePermissionsSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: 'Dados invalidos para salvar as permissoes da funcao.' };
  }

  const payload = parsed.data;
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase.rpc('upsert_admin_role_permissions', {
    p_role_id: payload.roleId,
    p_permission_codes: payload.permissionCodes,
    p_reason: payload.reason,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  const addedPermissions = Array.isArray(data?.added_permissions) ? data.added_permissions.map((item: unknown) => String(item)) : [];
  const removedPermissions = Array.isArray(data?.removed_permissions) ? data.removed_permissions.map((item: unknown) => String(item)) : [];

  revalidatePath('/painel/configuracoes/equipe');
  revalidatePath(`/painel/configuracoes/equipe/funcoes/${payload.roleId}`);
  revalidatePath('/configuracoes/equipe');
  revalidatePath(`/configuracoes/equipe/funcoes/${payload.roleId}`);

  return {
    success: true,
    message: `Permissoes da funcao atualizadas. ${summarizeRolePermissionChange(addedPermissions, removedPermissions)}`,
    addedPermissions,
    removedPermissions,
  };
}

export async function restoreRolePermissionsDefaultAction(input: { roleId: string; reason: string | null }) {
  await assertPermission('team.edit_permissions');

  const parsed = z.object({ roleId: z.string().uuid(), reason: z.string().max(500).nullable() }).safeParse(input);
  if (!parsed.success) {
    return { success: false, message: 'Dados invalidos para restaurar as permissoes da funcao.' };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('restore_admin_role_permissions_default', {
    p_role_id: parsed.data.roleId,
    p_reason: parsed.data.reason,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  const addedPermissions = Array.isArray(data?.added_permissions) ? data.added_permissions.map((item: unknown) => String(item)) : [];
  const removedPermissions = Array.isArray(data?.removed_permissions) ? data.removed_permissions.map((item: unknown) => String(item)) : [];

  revalidatePath('/painel/configuracoes/equipe');
  revalidatePath(`/painel/configuracoes/equipe/funcoes/${parsed.data.roleId}`);
  revalidatePath('/configuracoes/equipe');
  revalidatePath(`/configuracoes/equipe/funcoes/${parsed.data.roleId}`);

  return {
    success: true,
    message: `Permissoes restauradas para o padrao do sistema. ${summarizeRolePermissionChange(addedPermissions, removedPermissions)}`,
    addedPermissions,
    removedPermissions,
  };
}
