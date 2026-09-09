'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { mapNotificationRow, type OrganizationNotificationRow } from '@/lib/notifications/types';

const listSchema = z.object({
  readState: z.enum(['all', 'unread', 'read']).default('all'),
  type: z.enum(['CHANGE_REQUEST_CREATED', 'FEEDBACK_CREATED', 'PAYMENT_REFUNDED', 'PAYMENT_REFUND_FAILED']).optional().nullable(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export async function listOrganizationNotificationsAction(payload: z.infer<typeof listSchema>): Promise<{
  success: boolean;
  message?: string;
  notifications: OrganizationNotificationRow[];
  totalCount: number;
}> {
  const parsed = listSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? 'Filtro inválido.', notifications: [], totalCount: 0 };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc('list_organization_notifications', {
      p_read_state: parsed.data.readState,
      p_type: parsed.data.type ?? null,
      p_limit: parsed.data.limit,
      p_offset: parsed.data.offset,
    });

    if (error) {
      return { success: false, message: error.message, notifications: [], totalCount: 0 };
    }

    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const notifications = rows.map(mapNotificationRow);
    const totalCount = Number(rows[0]?.total_count ?? notifications.length);
    return { success: true, notifications, totalCount };
  } catch {
    return { success: false, message: 'Não foi possível carregar as notificações agora.', notifications: [], totalCount: 0 };
  }
}

export async function countUnreadOrganizationNotificationsAction() {
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc('count_unread_organization_notifications');
    if (error) return { success: false as const, count: 0, message: error.message };
    return { success: true as const, count: Number(data ?? 0) };
  } catch {
    return { success: false as const, count: 0, message: 'Não foi possível carregar as notificações agora.' };
  }
}

export async function markOrganizationNotificationReadAction(notificationId: string) {
  const parsed = z.string().uuid().safeParse(notificationId);
  if (!parsed.success) return { success: false as const, message: 'Notificação inválida.' };
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('mark_organization_notification_read', { p_notification_id: parsed.data });
    if (error) return { success: false as const, message: error.message };
    try {
      revalidatePath('/notificacoes');
    } catch {
      // Falha de revalidação não pode derrubar a página.
    }
    return { success: true as const };
  } catch {
    return { success: false as const, message: 'Não foi possível atualizar a notificação.' };
  }
}

export async function markAllOrganizationNotificationsReadAction() {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('mark_all_organization_notifications_read');
    if (error) return { success: false as const, message: error.message };
    try {
      revalidatePath('/notificacoes');
    } catch {
      // Falha de revalidação não pode derrubar a página.
    }
    return { success: true as const };
  } catch {
    return { success: false as const, message: 'Não foi possível atualizar as notificações.' };
  }
}
