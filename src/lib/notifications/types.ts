export const ORGANIZATION_NOTIFICATION_TYPES = [
  'CHANGE_REQUEST_CREATED',
  'FEEDBACK_CREATED',
] as const;

export type OrganizationNotificationType = (typeof ORGANIZATION_NOTIFICATION_TYPES)[number];

export type OrganizationNotificationRow = {
  notificationId: string;
  type: OrganizationNotificationType | string;
  title: string;
  body: string;
  actionHref: string;
  entityType: string | null;
  entityId: string | null;
  eventId: string | null;
  createdAt: string;
  readAt: string | null;
  isUnread: boolean;
};

export function notificationTypeLabel(type: string) {
  if (type === 'CHANGE_REQUEST_CREATED') return 'Solicitações';
  if (type === 'FEEDBACK_CREATED') return 'Feedbacks';
  return type;
}

export function mapNotificationRow(row: Record<string, unknown>): OrganizationNotificationRow {
  return {
    notificationId: String(row.notification_id ?? row.id ?? ''),
    type: String(row.type ?? ''),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    actionHref: String(row.action_href ?? '/notificacoes'),
    entityType: row.entity_type ? String(row.entity_type) : null,
    entityId: row.entity_id ? String(row.entity_id) : null,
    eventId: row.event_id ? String(row.event_id) : null,
    createdAt: String(row.created_at ?? ''),
    readAt: row.read_at ? String(row.read_at) : null,
    isUnread: Boolean(row.is_unread ?? !row.read_at),
  };
}
