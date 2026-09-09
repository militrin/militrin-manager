import { cx } from './utils';

export const ADMIN_TABLE_ZEBRA_CLASS = 'admin-table-zebra';
export const ADMIN_LIST_ZEBRA_CLASS = 'admin-list-zebra';
export const ADMIN_LIST_ROW_CLASS = 'admin-list-row';

/**
 * Estados semânticos que vencem zebra e hover.
 * Hierarquia: estado semântico > selected > hover > zebra.
 */
export type AdminTableRowState =
  | 'error'
  | 'warning'
  | 'selected'
  | 'disabled'
  | 'cancelled'
  | 'pending'
  | 'paid'
  | 'refunded'
  | 'review_required';

export function adminTableRowStateFromStatus(status: string | null | undefined): AdminTableRowState | undefined {
  const value = String(status ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (['error', 'failed', 'blocked'].includes(value)) return 'error';
  if (['review_required', 'duplicate'].includes(value)) return 'review_required';
  if (['cancelled', 'canceled', 'expired', 'disqualified'].includes(value)) return 'cancelled';
  if (['refunded'].includes(value)) return 'refunded';
  if (['paid', 'confirmed', 'complete', 'delivered'].includes(value)) return 'paid';
  if (['pending', 'data_pending', 'awaiting'].includes(value)) return 'pending';
  if (['disabled', 'inactive', 'archived'].includes(value)) return 'disabled';
  if (['warning', 'low'].includes(value)) return 'warning';
  return undefined;
}

export function adminTableRowClass(options?: {
  selected?: boolean;
  state?: AdminTableRowState | null;
  groupStart?: boolean;
  className?: string;
}) {
  return cx(
    ADMIN_LIST_ROW_CLASS,
    options?.groupStart && 'admin-list-row-group-start',
    options?.className,
  );
}

export function adminTableRowProps(options?: {
  selected?: boolean;
  state?: AdminTableRowState | null;
  detail?: boolean;
  groupStart?: boolean;
}) {
  const state = options?.selected ? 'selected' : options?.state ?? undefined;
  return {
    ...(state ? { 'data-row-state': state } : {}),
    ...(options?.detail ? { 'data-row-detail': 'true' } : {}),
    ...(options?.groupStart ? { 'data-row-group-start': 'true' } : {}),
  };
}
