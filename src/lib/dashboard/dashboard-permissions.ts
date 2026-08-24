import { hasPermission, requireAnyPermission } from '@/lib/admin/permissions';

export const DASHBOARD_SECTION_PERMISSIONS = {
  integrity: 'dashboard.integrity.view',
  people: 'dashboard.people.view',
  operations: 'dashboard.operations.view',
  inventory: 'dashboard.inventory.view',
  finance: 'dashboard.finance.view',
} as const;

export type DashboardSection = keyof typeof DASHBOARD_SECTION_PERMISSIONS;

export const DASHBOARD_SECTION_PERMISSION_CODES = Object.values(DASHBOARD_SECTION_PERMISSIONS);

export async function requireDashboardAccess() {
  await requireAnyPermission(DASHBOARD_SECTION_PERMISSION_CODES);
}

export async function getDashboardSectionAccess(): Promise<Record<DashboardSection, boolean>> {
  const entries = await Promise.all(
    Object.entries(DASHBOARD_SECTION_PERMISSIONS).map(async ([section, permission]) =>
      [section, await hasPermission(permission)] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<DashboardSection, boolean>;
}

export const DASHBOARD_METRIC_SECTIONS = {
  people: 'people', registrations: 'people', confirmed: 'people', pending: 'people', cancelled: 'people',
  tickets: 'operations', checkins: 'operations', complete_kits: 'operations', shirt_coherence: 'operations',
  shirts_received: 'inventory', shirts_reserved: 'inventory', shirts_delivered: 'inventory', shirts_available: 'inventory', shirts_deficit: 'inventory',
  revenue_confirmed: 'finance', revenue_pending: 'finance', pix: 'finance', card: 'finance', courtesy: 'finance',
} as const satisfies Record<string, DashboardSection>;
